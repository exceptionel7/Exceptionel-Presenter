import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave, type Clock } from '../src/main/services/autosave.ts';

/** Deterministic clock so debounce behaviour is tested without real waiting. */
function fakeClock(): Clock & { tick(ms: number): void; pendingTimers(): number } {
  interface Entry {
    fn: () => void;
    due: number;
    intervalMs: number | null;
    id: number;
  }
  let now = 0;
  let nextId = 1;
  const entries = new Map<number, Entry>();

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      entries.set(id, { fn, due: now + ms, intervalMs: null, id });
      return id;
    },
    clearTimeout(handle) {
      entries.delete(handle as number);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      entries.set(id, { fn, due: now + ms, intervalMs: ms, id });
      return id;
    },
    clearInterval(handle) {
      entries.delete(handle as number);
    },
    tick(ms) {
      const target = now + ms;
      // Loop so an interval can fire several times within one tick.
      for (;;) {
        const due = [...entries.values()].filter((e) => e.due <= target).sort((a, b) => a.due - b.due);
        if (due.length === 0) break;
        const entry = due[0]!;
        now = entry.due;
        if (entry.intervalMs === null) entries.delete(entry.id);
        else entry.due = now + entry.intervalMs;
        entry.fn();
      }
      now = target;
    },
    pendingTimers: () => entries.size,
  };
}

interface Recorder {
  commits: [string, unknown][];
  heartbeats: number;
  errors: [string, unknown][];
  committed: string[];
}

function setup(overrides: { commit?: (key: string, payload: unknown) => void; heartbeat?: () => void } = {}) {
  const clock = fakeClock();
  const rec: Recorder = { commits: [], heartbeats: 0, errors: [], committed: [] };
  const autosave = createAutosave({
    clock,
    debounceMs: 400,
    heartbeatMs: 5_000,
    commit: (key, payload) => {
      rec.commits.push([key, payload]);
      overrides.commit?.(key, payload);
    },
    heartbeat: () => {
      rec.heartbeats += 1;
      overrides.heartbeat?.();
    },
    onCommitted: (key) => rec.committed.push(key),
    onError: (key, error) => rec.errors.push([key, error]),
  });
  return { clock, rec, autosave };
}

test('a queued write commits after the debounce window', () => {
  const { clock, rec, autosave } = setup();
  autosave.queue('setting:app.theme', 'dark');

  clock.tick(399);
  assert.deepEqual(rec.commits, [], 'must not commit early');

  clock.tick(1);
  assert.deepEqual(rec.commits, [['setting:app.theme', 'dark']]);
  assert.deepEqual(rec.committed, ['setting:app.theme'], 'the UI is told it saved');
});

test('rapid edits to one key collapse into a single write', () => {
  const { clock, rec, autosave } = setup();
  // Simulates typing in a lyric editor.
  for (const value of ['W', 'Wa', 'Way', 'Way ', 'Way M']) {
    autosave.queue('song:1', value);
    clock.tick(50);
  }
  assert.deepEqual(rec.commits, [], 'still debouncing while keystrokes continue');

  clock.tick(400);
  assert.equal(rec.commits.length, 1, 'one write, not five');
  assert.deepEqual(rec.commits[0], ['song:1', 'Way M'], 'and it is the latest value');
});

test('different keys debounce independently', () => {
  const { clock, rec, autosave } = setup();
  autosave.queue('song:1', 'a');
  clock.tick(200);
  autosave.queue('service:1', 'b');
  clock.tick(200);

  assert.deepEqual(rec.commits, [['song:1', 'a']], 'song committed, service still pending');

  clock.tick(200);
  assert.equal(rec.commits.length, 2);
});

test('flush commits everything immediately — used on quit and explicit Save', () => {
  const { rec, autosave } = setup();
  autosave.queue('song:1', 'a');
  autosave.queue('service:1', 'b');
  assert.deepEqual(autosave.pendingKeys(), ['song:1', 'service:1']);

  autosave.flush();

  assert.equal(rec.commits.length, 2);
  assert.deepEqual(autosave.pendingKeys(), [], 'nothing left pending');
});

test('flush is safe with nothing pending', () => {
  const { rec, autosave } = setup();
  assert.doesNotThrow(() => autosave.flush());
  assert.equal(rec.commits.length, 0);
});

test('a flushed key does not commit again when its timer would have fired', () => {
  const { clock, rec, autosave } = setup();
  autosave.queue('song:1', 'a');
  autosave.flush();
  clock.tick(1_000);
  assert.equal(rec.commits.length, 1, 'the pending timer must not double-write');
});

test('a failing commit is reported, never silently swallowed', () => {
  const { clock, rec, autosave } = setup({
    commit: (key) => {
      if (key === 'song:bad') throw new Error('disk full');
    },
  });
  autosave.queue('song:bad', 'x');
  clock.tick(400);

  assert.equal(rec.errors.length, 1, 'Section 39: never fail silently');
  assert.equal(rec.errors[0]?.[0], 'song:bad');
  assert.deepEqual(rec.committed, [], 'a failed write must not report success');
});

test('one persistently failing key cannot wedge later autosaves behind it', () => {
  const { clock, rec, autosave } = setup({
    commit: (key) => {
      if (key === 'song:bad') throw new Error('disk full');
    },
  });
  autosave.queue('song:bad', 'x');
  clock.tick(400);
  assert.equal(rec.errors.length, 1);

  autosave.queue('song:good', 'y');
  clock.tick(400);

  assert.deepEqual(
    rec.commits.map(([key]) => key),
    ['song:bad', 'song:good'],
    'the good write must still land',
  );
  assert.deepEqual(rec.committed, ['song:good']);
  assert.deepEqual(autosave.pendingKeys(), [], 'the failed payload is dropped, not retained forever');
});

test('the heartbeat runs on an interval once started', () => {
  const { clock, rec, autosave } = setup();
  autosave.start();

  clock.tick(4_999);
  assert.equal(rec.heartbeats, 0);

  clock.tick(1);
  assert.equal(rec.heartbeats, 1);

  clock.tick(15_000);
  assert.equal(rec.heartbeats, 4, 'and keeps running');
});

test('start is idempotent — no duplicate heartbeat intervals', () => {
  const { clock, rec, autosave } = setup();
  autosave.start();
  autosave.start();
  autosave.start();
  clock.tick(5_000);
  assert.equal(rec.heartbeats, 1, 'calling start twice must not double the heartbeat rate');
});

test('a throwing heartbeat is reported and does not stop the interval', () => {
  let calls = 0;
  const { clock, rec, autosave } = setup({
    heartbeat: () => {
      calls += 1;
      if (calls === 1) throw new Error('snapshot failed');
    },
  });
  autosave.start();

  clock.tick(5_000);
  assert.equal(rec.errors.length, 1);
  assert.equal(rec.errors[0]?.[0], 'session');

  clock.tick(5_000);
  assert.equal(calls, 2, 'the heartbeat must survive one bad snapshot');
});

test('stop clears the heartbeat and all pending debounce timers', () => {
  const { clock, rec, autosave } = setup();
  autosave.start();
  autosave.queue('song:1', 'a');

  autosave.stop();
  clock.tick(60_000);

  assert.equal(rec.heartbeats, 0);
  assert.equal(rec.commits.length, 0, 'stop cancels pending timers');
  assert.equal(clock.pendingTimers(), 0, 'no timer leaks');
});

test('stop is safe when never started', () => {
  const { autosave } = setup();
  assert.doesNotThrow(() => autosave.stop());
});

test('the realistic shutdown sequence loses nothing', () => {
  // Mirrors app.on('before-quit') in src/main/index.ts: stop, then flush.
  const { clock, rec, autosave } = setup();
  autosave.start();
  autosave.queue('setting:app.theme', 'dark');
  autosave.queue('service:1', { name: 'Sunday' });
  clock.tick(100); // quit arrives mid-debounce

  autosave.stop();
  autosave.flush();

  assert.equal(rec.commits.length, 2, 'both pending edits must be written on quit');
  assert.deepEqual(autosave.pendingKeys(), []);
});
