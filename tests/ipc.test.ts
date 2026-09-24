import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { createLiveStateService, cuesFromServiceItems } from '../src/main/services/live-state-service.ts';
import { dispatch, isChannelAllowedForRole, type HandlerRegistry } from '../src/main/ipc/dispatcher.ts';
import { createHandlers } from '../src/main/ipc/handlers.ts';
import { IPC_CHANNELS, type AppInfo, type IpcResult } from '../src/shared/ipc-contract.ts';
import type { LiveState } from '../src/shared/domain/live-state.ts';

const APP_INFO: AppInfo = {
  name: 'Exceptionel Presenter',
  version: '0.2.0',
  electronVersion: 'test',
  chromeVersion: 'test',
  nodeVersion: process.versions['node'] ?? 'test',
  platform: 'linux',
  schemaVersion: 2,
  sqliteEngine: 'node:sqlite',
  userDataPath: '/tmp/exceptionel-test',
  isPackaged: false,
};

interface Harness {
  db: AppDatabase;
  handlers: HandlerRegistry;
  call: (channel: string, payload?: unknown, role?: 'operator' | 'output' | 'confidence') => Promise<IpcResult<unknown>>;
  live: ReturnType<typeof createLiveStateService>;
  quitCalls: number;
}

function harness(): Harness {
  const db = openDatabase({ path: ':memory:' });
  const live = createLiveStateService();
  const state = { quitCalls: 0 };
  const handlers = createHandlers({
    db,
    live,
    appInfo: () => APP_INFO,
    quit: () => {
      state.quitCalls += 1;
    },
  });
  return {
    db,
    handlers,
    live,
    get quitCalls() {
      return state.quitCalls;
    },
    call: (channel, payload, role = 'operator') => dispatch(channel, payload, role, { handlers }),
  };
}

const unwrap = <T>(result: IpcResult<unknown>): T => {
  assert.equal(result.ok, true, result.ok ? '' : `expected success, got ${result.failure.detail ?? result.failure.message}`);
  return (result as { ok: true; data: T }).data;
};

const expectFailure = (result: IpcResult<unknown>, code: string): void => {
  assert.equal(result.ok, false, 'expected a failure');
  assert.equal((result as { ok: false; failure: { code: string } }).failure.code, code);
};

// ── dispatcher security boundary ────────────────────────────────────────────────

test('an unknown channel is refused', async () => {
  const h = harness();
  expectFailure(await h.call('songs:dropEverything'), 'ipc/unknown-channel');
  h.db.close();
});

test('prototype keys are not mistaken for handlers', async () => {
  const h = harness();
  for (const channel of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    expectFailure(await h.call(channel), 'ipc/unknown-channel');
  }
  h.db.close();
});

test('a handler without a validator is refused — fail-closed', async () => {
  const h = harness();
  const handlers: HandlerRegistry = {
    ...h.handlers,
    // Deliberately register a channel that has no IPC_VALIDATORS entry.
    ['rogue:channel' as never]: () => 'should never run',
  };
  const result = await dispatch('rogue:channel', {}, 'operator', { handlers });
  expectFailure(result, 'ipc/no-validator');
  h.db.close();
});

test('an invalid payload is rejected before the handler runs', async () => {
  const h = harness();
  const before = h.db.songs.list({}).length;
  const result = await h.call('songs:save', { title: '', sections: [] });
  expectFailure(result, 'ipc/invalid-payload');
  assert.equal(h.db.songs.list({}).length, before, 'nothing may be written on a rejected payload');
  h.db.close();
});

test('the failure detail names the offending field', async () => {
  const h = harness();
  const result = await h.call('songs:save', {
    title: 'T',
    sections: [{ kind: 'nonsense', label: 'X', sortOrder: 0, lyrics: '', slideBreakMode: 'blank-line' }],
  });
  assert.equal(result.ok, false);
  const detail = (result as { ok: false; failure: { detail?: string } }).failure.detail ?? '';
  assert.match(detail, /sections\.0\.kind/);
  h.db.close();
});

test('THE AUDIENCE OUTPUT WINDOW CANNOT MUTATE ANYTHING', async () => {
  const h = harness();
  const song = h.db.songs.save({ title: 'Way Maker', sections: [] });

  // Every mutating channel, attempted from the output window.
  const attempts: [string, unknown][] = [
    ['songs:delete', { id: song.id }],
    ['songs:save', { title: 'Injected', sections: [] }],
    ['songs:setFavorite', { id: song.id, isFavorite: true }],
    ['services:save', { name: 'Injected', items: [] }],
    ['services:delete', { id: song.id }],
    ['themes:delete', { id: 'theme-scripture' }],
    ['settings:set', { key: 'app.theme', value: 'light' }],
    ['shortcuts:resetDefaults', undefined],
    ['live:intent', { type: 'black' }],
    ['live:setCues', { cues: [] }],
    ['profile:save', { name: 'Hacked', timezone: 'UTC' }],
    ['app:quit', undefined],
    ['recovery:discard', { id: 'sess_x' }],
  ];

  for (const [channel, payload] of attempts) {
    const result = await h.call(channel, payload, 'output');
    expectFailure(result, 'ipc/forbidden-for-role');
  }

  // Nothing changed.
  assert.equal(h.db.songs.get(song.id)?.title, 'Way Maker');
  assert.equal(h.db.songs.get(song.id)?.isFavorite, false);
  assert.equal(h.db.services.list().length, 0);
  assert.equal(h.db.themes.list().length, 6);
  assert.equal(h.quitCalls, 0, 'the audience screen must not be able to quit the app');
  h.db.close();
});

test('the output window CAN read what it needs to render', async () => {
  const h = harness();
  assert.equal((await h.call('live:getState', undefined, 'output')).ok, true);
  assert.equal((await h.call('themes:list', undefined, 'output')).ok, true);
  h.db.close();
});

test('the confidence monitor can read service context but not mutate', async () => {
  const h = harness();
  const service = h.db.services.save({ name: 'Sunday', items: [] });
  assert.equal((await h.call('services:get', { id: service.id }, 'confidence')).ok, true);
  assert.equal((await h.call('settings:getAll', undefined, 'confidence')).ok, true);
  expectFailure(await h.call('services:save', { name: 'X', items: [] }, 'confidence'), 'ipc/forbidden-for-role');
  expectFailure(await h.call('live:intent', { type: 'next' }, 'confidence'), 'ipc/forbidden-for-role');
  h.db.close();
});

test('role allow-lists contain no mutating channel names', () => {
  for (const role of ['output', 'confidence'] as const) {
    for (const channel of IPC_CHANNELS) {
      if (!isChannelAllowedForRole(channel, role)) continue;
      assert.doesNotMatch(
        channel,
        /:(save|delete|set|setFavorite|import|assign|intent|restore|discard|quit|open|close|reorder|duplicate|resetDefaults|complete)$/,
        `${channel} must not be reachable from a ${role} window`,
      );
    }
  }
});

test('the operator window reaches every channel', () => {
  for (const channel of IPC_CHANNELS) {
    assert.equal(isChannelAllowedForRole(channel, 'operator'), true, channel);
  }
});

test('a throwing handler becomes a failure value, not a crash', async () => {
  const h = harness();
  const handlers: HandlerRegistry = {
    ...h.handlers,
    'songs:list': () => {
      throw new Error('simulated database explosion');
    },
  };
  const result = await dispatch('songs:list', {}, 'operator', { handlers });
  expectFailure(result, 'ipc/handler-failed');
  const f = (result as { ok: false; failure: { detail?: string; retryable: boolean } }).failure;
  assert.match(f.detail ?? '', /simulated database explosion/);
  assert.equal(f.retryable, true);
  h.db.close();
});

test('a structured AppFailure thrown by a handler reaches the UI intact', async () => {
  const h = harness();
  const result = await h.call('bible:lookup', { translationId: 'kjv', reference: 'John 3:16' });
  expectFailure(result, 'feature/not-implemented');
  const f = (result as { ok: false; failure: { message: string; remedies: string[]; severity: string } }).failure;
  assert.match(f.message, /NOT IMPLEMENTED/);
  assert.ok(f.remedies.some((r) => /Phase 4/.test(r)), 'must say which phase delivers it');
  assert.equal(f.severity, 'info');
  h.db.close();
});

test('every NOT IMPLEMENTED channel says so honestly, with a phase', async () => {
  const h = harness();
  const pending: [string, unknown][] = [
    ['media:list', {}],
    ['media:import', undefined],
    ['media:delete', { id: 'media_x' }],
    ['bible:translations', undefined],
    ['announcements:list', undefined],
    ['display:list', undefined],
    ['display:status', undefined],
    ['output:open', { role: 'presentation' }],
    ['camera:list', undefined],
    ['camera:profiles', undefined],
  ];
  for (const [channel, payload] of pending) {
    const result = await h.call(channel, payload);
    expectFailure(result, 'feature/not-implemented');
    const f = (result as { ok: false; failure: { remedies: string[] } }).failure;
    assert.ok(
      f.remedies.some((r) => /Phase \d/.test(r)),
      `${channel} must name the phase that delivers it`,
    );
  }
  h.db.close();
});

test('failures are reported to the onFailure sink for logging', async () => {
  const h = harness();
  const seen: string[] = [];
  await dispatch('nope:nope', undefined, 'operator', {
    handlers: h.handlers,
    onFailure: (notice) => seen.push(notice.code),
  });
  assert.deepEqual(seen, ['ipc/unknown-channel']);
  h.db.close();
});

test('error notices carry a unique id and a timestamp', async () => {
  const h = harness();
  const a = await h.call('nope:a');
  const b = await h.call('nope:b');
  const idA = (a as { ok: false; failure: { id: string; occurredAt: string } }).failure;
  const idB = (b as { ok: false; failure: { id: string } }).failure;
  assert.notEqual(idA.id, idB.id);
  assert.ok(!Number.isNaN(Date.parse(idA.occurredAt)));
  h.db.close();
});

// ── handlers over the real database ─────────────────────────────────────────────

test('app:info round-trips', async () => {
  const h = harness();
  const info = unwrap<AppInfo>(await h.call('app:info'));
  assert.equal(info.name, 'Exceptionel Presenter');
  assert.equal(info.schemaVersion, 2);
  h.db.close();
});

test('settings can be read and written through IPC', async () => {
  const h = harness();
  assert.equal(unwrap(await h.call('settings:get', { key: 'presentation.aspectRatio' })), '16:9');
  unwrap(await h.call('settings:set', { key: 'presentation.aspectRatio', value: '4:3' }));
  assert.equal(unwrap(await h.call('settings:get', { key: 'presentation.aspectRatio' })), '4:3');
  h.db.close();
});

test('a settings key that fails the naming pattern is rejected', async () => {
  const h = harness();
  expectFailure(await h.call('settings:set', { key: '../../etc/passwd', value: 1 }), 'ipc/invalid-payload');
  h.db.close();
});

test('the full song lifecycle works over IPC', async () => {
  const h = harness();
  const saved = unwrap<{ id: string; title: string }>(
    await h.call('songs:save', {
      title: 'Way Maker',
      artist: 'Sinach',
      sections: [
        { kind: 'chorus', label: 'Chorus', sortOrder: 0, lyrics: 'Way maker\nMiracle worker', slideBreakMode: 'blank-line' },
      ],
    }),
  );
  assert.equal(saved.title, 'Way Maker');

  const found = unwrap<{ id: string }[]>(await h.call('songs:list', { search: 'miracle' }));
  assert.equal(found.length, 1);

  const copy = unwrap<{ id: string; title: string }>(await h.call('songs:duplicate', { id: saved.id }));
  assert.equal(copy.title, 'Way Maker (Copy)');

  unwrap(await h.call('songs:setFavorite', { id: saved.id, isFavorite: true }));
  assert.equal(unwrap<{ isFavorite: boolean }[]>(await h.call('songs:list', { favoritesOnly: true })).length, 1);

  unwrap(await h.call('songs:delete', { id: saved.id }));
  assert.equal(unwrap(await h.call('songs:get', { id: saved.id })), null);
  h.db.close();
});

test('a repository error surfaces as a failure rather than a crash', async () => {
  const h = harness();
  const result = await h.call('themes:save', { id: 'theme-scripture', name: 'Hijacked', spec: {} });
  expectFailure(result, 'ipc/handler-failed');
  assert.match(
    (result as { ok: false; failure: { detail?: string } }).failure.detail ?? '',
    /built-in theme and cannot be modified/,
  );
  h.db.close();
});

// ── live state service ──────────────────────────────────────────────────────────

test('live intents flow through IPC and mutate authoritative state', async () => {
  const h = harness();
  h.live.setCues([
    { id: 'c1', kind: 'slide', itemId: 'i1', label: 'Welcome' },
    { id: 'c2', kind: 'lyric', itemId: 'i2', label: 'Verse 1' },
  ]);

  let state = unwrap<LiveState>(await h.call('live:intent', { type: 'goLive', cueId: 'c1' }));
  assert.equal(state.status, 'live');
  assert.equal(state.activeCueId, 'c1');

  state = unwrap<LiveState>(await h.call('live:intent', { type: 'next' }));
  assert.equal(state.activeCueId, 'c2');

  state = unwrap<LiveState>(await h.call('live:intent', { type: 'black' }));
  assert.equal(state.status, 'black');
  assert.equal(state.restoreCueId, 'c2');

  state = unwrap<LiveState>(await h.call('live:getState'));
  assert.equal(state.status, 'black', 'state is authoritative in main, not per-call');
  h.db.close();
});

test('subscribers receive current state immediately on subscribe', () => {
  const live = createLiveStateService();
  live.setCues([{ id: 'c1', kind: 'slide', itemId: 'i1', label: 'A' }]);
  live.apply({ type: 'goLive', cueId: 'c1' });

  const seen: LiveState[] = [];
  live.subscribe((s) => seen.push(s));
  assert.equal(seen.length, 1, 'a window opening mid-service must not wait for the next action');
  assert.equal(seen[0]?.activeCueId, 'c1');
});

test('broadcasts happen only on real change', () => {
  const live = createLiveStateService();
  live.setCues([{ id: 'c1', kind: 'slide', itemId: 'i1', label: 'A' }]);

  const seen: LiveState[] = [];
  live.subscribe((s) => seen.push(s));
  const initial = seen.length;

  live.apply({ type: 'goLive', cueId: 'c1' });
  assert.equal(seen.length, initial + 1);

  live.apply({ type: 'goLive', cueId: 'does-not-exist' });
  assert.equal(seen.length, initial + 1, 'a no-op intent must not broadcast');

  live.apply({ type: 'next' });
  assert.equal(seen.length, initial + 1, 'advancing past the end is also a no-op');
});

test('unsubscribing during a broadcast does not break iteration', () => {
  const live = createLiveStateService();
  live.setCues([{ id: 'c1', kind: 'slide', itemId: 'i1', label: 'A' }]);

  let bCalls = 0;
  let unsubscribeB: (() => void) | null = null;
  live.subscribe(() => unsubscribeB?.());
  unsubscribeB = live.subscribe(() => {
    bCalls += 1;
  });

  assert.doesNotThrow(() => live.apply({ type: 'goLive', cueId: 'c1' }));

  // Iterating a copy means a listener unsubscribed mid-broadcast still receives THAT
  // broadcast: 1 immediate push on subscribe + 1 in-flight event = 2. That is the
  // deliberate trade for not mutating the set under iteration, and it is why
  // WindowManager must guard every send with isDestroyed() — a closing window can be
  // handed one final event after unsubscribing.
  assert.equal(bCalls, 2);

  // But it receives nothing afterwards.
  live.apply({ type: 'black' });
  assert.equal(bCalls, 2, 'no further events after the in-flight one');
});

test('deleting the live cue stops output rather than showing a phantom slide', () => {
  const live = createLiveStateService();
  live.setCues([
    { id: 'c1', kind: 'slide', itemId: 'i1', label: 'A' },
    { id: 'c2', kind: 'slide', itemId: 'i2', label: 'B' },
  ]);
  live.apply({ type: 'goLive', cueId: 'c2' });

  live.setCues([{ id: 'c1', kind: 'slide', itemId: 'i1', label: 'A' }]);

  const state = live.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.activeCueId, null);
});

test('reordering above the live cue keeps the same slide on screen', () => {
  const live = createLiveStateService();
  live.setCues([
    { id: 'c1', kind: 'slide', itemId: 'i1', label: 'A' },
    { id: 'c2', kind: 'slide', itemId: 'i2', label: 'B' },
  ]);
  live.apply({ type: 'goLive', cueId: 'c2' });
  assert.equal(live.getState().cueIndex, 1);

  // An item is inserted above the live one.
  live.setCues([
    { id: 'c0', kind: 'slide', itemId: 'i0', label: 'New' },
    { id: 'c1', kind: 'slide', itemId: 'i1', label: 'A' },
    { id: 'c2', kind: 'slide', itemId: 'i2', label: 'B' },
  ]);

  const state = live.getState();
  assert.equal(state.activeCueId, 'c2', 'the audience must not see a jump');
  assert.equal(state.cueIndex, 2, 'but the index must track the new position');
  assert.equal(state.status, 'live');
});

test('cuesFromServiceItems skips headers and maps kinds', () => {
  const cues = cuesFromServiceItems([
    { id: 'i1', kind: 'header', label: 'Welcome' },
    { id: 'i2', kind: 'song', label: 'Way Maker' },
    { id: 'i3', kind: 'scripture', label: 'John 3:16' },
    { id: 'i4', kind: 'camera_scene', label: 'Pastor Camera' },
    { id: 'i5', kind: 'announcement', label: 'Youth Night' },
  ]);
  assert.equal(cues.length, 4, 'a header is an operator divider, not an audience cue');
  assert.deepEqual(cues.map((c) => c.kind), ['lyric', 'scripture', 'camera', 'announcement']);
  assert.equal(cues[0]?.itemId, 'i2');
});

test('speaker notes travel on the cue for the confidence monitor', () => {
  const cues = cuesFromServiceItems([
    { id: 'i1', kind: 'song', label: 'Way Maker', config: { notes: 'Key change after bridge' } },
    { id: 'i2', kind: 'song', label: 'No Notes' },
  ]);
  assert.equal(cues[0]?.notes, 'Key change after bridge');
  assert.equal(cues[1]?.notes, undefined);
});

// ── crash recovery through IPC ──────────────────────────────────────────────────

test('recovery:check reports nothing after a clean run', async () => {
  const h = harness();
  assert.equal(unwrap(await h.call('recovery:check')), null);
  h.db.close();
});

test('recovery:restore reopens the crashed service and loads its cues', async () => {
  const h = harness();
  const service = h.db.services.save({
    name: 'Sunday Service',
    items: [
      { kind: 'header', label: 'Welcome', sortOrder: 0 },
      { kind: 'song', label: 'Way Maker', sortOrder: 1 },
    ],
  });
  const session = h.db.recovery.beginSession(service.id, service.name);
  h.db.recovery.heartbeat(session, { cueIndex: 1 }, service.id, service.name);

  const found = unwrap<{ id: string; serviceName: string }>(await h.call('recovery:check'));
  assert.equal(found.serviceName, 'Sunday Service');

  const restored = unwrap<{ id: string; name: string }>(await h.call('recovery:restore', { id: found.id }));
  assert.equal(restored.name, 'Sunday Service');
  assert.equal(h.live.getCues().length, 1, 'the header must not become a cue');

  assert.equal(unwrap(await h.call('recovery:check')), null, 'restoring consumes the offer');
  h.db.close();
});

test('recovery:restore ignores an id that is not the current offer', async () => {
  const h = harness();
  const session = h.db.recovery.beginSession(null, 'Sunday');
  h.db.recovery.heartbeat(session, { x: 1 }, null, 'Sunday');
  assert.equal(unwrap(await h.call('recovery:restore', { id: 'sess_somethingelse' })), null);
  h.db.close();
});
