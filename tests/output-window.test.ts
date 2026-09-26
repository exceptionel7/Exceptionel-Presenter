import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EXCEPTIONEL PRESENTER — invariants for the AUDIENCE OUTPUT renderer.
 *
 * WHAT THESE TESTS ARE. Assertions about source text, not about a running React tree — there is no
 * DOM and no Electron here, so mounting the real component is not possible. That makes them weaker
 * than a render test and they are not a substitute for one.
 *
 * WHY THEY ARE STILL WORTH HAVING. The output window is HIDDEN until Phase 7 assigns it to a
 * projector, and it is the only renderer that can receive a phone's camera. When it fails, it fails
 * invisibly: `OutputApp.tsx` once called `useWirelessCameraHost()` without importing it, so the
 * renderer threw on first render, mounted nothing, subscribed to no IPC events, and silently
 * absorbed every message main sent it. The entire Wireless Camera feature was dead and no screen and
 * no log line said so. These assertions pin the wiring that failure removed.
 */

/*
 * Resolved from the working directory rather than `import.meta.dirname`, because the test command
 * documented in docs/ENVIRONMENT.md is always run from the repository root and the local typecheck
 * shims deliberately do not model Node's `import.meta` extensions.
 */
const SRC = join(process.cwd(), 'src', 'renderer', 'output');
const read = (file: string): string => readFileSync(join(SRC, file), 'utf8');

test('THE OUTPUT WINDOW HOSTS PHONE CAMERA CONNECTIONS', () => {
  const source = read('OutputApp.tsx');

  // A MediaStream cannot cross a process boundary, so the renderer that will drive the projector
  // has to be the one that terminates the phone's peer connection. If this hook is not mounted
  // here, no phone can ever connect to anything.
  assert.match(source, /useWirelessCameraHost/, 'the host hook is used');
  assert.match(
    source,
    /import \{ useWirelessCameraHost \} from '\.\/useWirelessCameraHost\.ts'/,
    'AND it is imported — using it without importing it is the exact bug this guards',
  );
});

test('every hook and component the output window uses is imported', () => {
  /*
   * A narrow, mechanical version of what `tools/local-typecheck/check.mjs` proves properly via
   * TS2304. Repeated here because the typecheck is a separate command that a person has to
   * remember to run, whereas `npm test` runs in CI.
   */
  const source = read('OutputApp.tsx');

  const used = new Set<string>();
  for (const match of source.matchAll(/\b(use[A-Z]\w*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined) used.add(name);
  }

  assert.ok(used.size > 0, 'the component uses hooks at all');

  for (const hook of used) {
    // Declared locally, or imported. Anything else is a ReferenceError at render time.
    const declared = new RegExp(`(function|const)\\s+${hook}\\b`).test(source);
    const imported = new RegExp(`import[^;]*\\b${hook}\\b[^;]*from`, 's').test(source);
    assert.ok(declared || imported, `${hook} is used but neither declared nor imported`);
  }
});

test('the output renderer reports a real track rather than a peer state', () => {
  const source = read('useWirelessCameraHost.ts');

  // `connected` must be reachable only from real media. See wireless-camera-state.ts.
  assert.match(source, /client\.invoke\('wireless:track'/, 'the dedicated channel is used');
  assert.equal(
    /message: \{ kind: 'state', state: 'connected' \}/.test(source),
    false,
    'reporting a track as a peer state is what made `connected` unreachable',
  );
  assert.match(source, /onMedia/, 'and it is driven by the unmute callback, not by ontrack');
});

test('the receiver waits for media before claiming a camera works', () => {
  const source = read('wireless-receiver.ts');

  // ontrack fires when the ANSWER is applied, before any RTP exists. `unmute` is the first moment
  // a picture genuinely exists.
  assert.match(source, /addEventListener\('unmute'/);
  assert.match(source, /events\.onMedia\(sessionId\)/);

  // Early candidates must be queued, not dropped: with no STUN or TURN they are the only ones.
  assert.match(source, /pendingCandidates/);
  assert.match(source, /if \(!peer\.connection\.remoteDescription\)/);

  // LAN only.
  assert.match(source, /iceServers: \[\]/);
});
