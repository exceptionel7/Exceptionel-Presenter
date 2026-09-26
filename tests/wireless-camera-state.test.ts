import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WIRELESS_EVENTS,
  WIRELESS_STATES,
  allowedEvents,
  canGoLive,
  canTransition,
  describeWirelessState,
  eventForPeerState,
  hasStream,
  isTerminal,
  metricsAreStale,
  transition,
  wirelessStateTone,
  type WirelessEvent,
  type WirelessState,
} from '../src/shared/domain/wireless-camera-state.ts';

/** Drives a sequence of events, asserting each is accepted. */
function run(from: WirelessState, ...events: WirelessEvent[]): WirelessState {
  let state = from;
  for (const event of events) {
    const result = transition(state, event);
    assert.equal(result.rejected, null, `${event} was refused from ${state}`);
    state = result.state;
  }
  return state;
}

// ── the happy path from Section 12 ──────────────────────────────────────────────

test('THE DOCUMENTED HAPPY PATH WORKS END TO END', () => {
  const state = run(
    'disconnected',
    'beginPairing',
    'phoneClaiming',
    'claimAccepted',
    'trackReceived',
    'goLive',
  );
  assert.equal(state, 'live');
});

test('each step of the happy path lands on the documented state', () => {
  let state: WirelessState = 'disconnected';
  const expected: [WirelessEvent, WirelessState][] = [
    ['beginPairing', 'pairing'],
    ['phoneClaiming', 'authenticating'],
    ['claimAccepted', 'connecting'],
    ['trackReceived', 'connected'],
    ['goLive', 'live'],
  ];
  for (const [event, want] of expected) {
    state = transition(state, event).state;
    assert.equal(state, want, `after ${event}`);
  }
});

// ── the rule that matters most ──────────────────────────────────────────────────

test('ONLY A REAL TRACK CAN REACH "connected" — no fake connected state', () => {
  // Section 24: a completed handshake with no media must never present itself as a working
  // camera. trackReceived is the sole entry point.
  for (const state of WIRELESS_STATES) {
    for (const event of WIRELESS_EVENTS) {
      const result = transition(state, event);
      if (result.state === 'connected' && result.changed) {
        assert.ok(
          event === 'trackReceived' || event === 'connectionRestored' || event === 'leaveLive',
          `${event} from ${state} reached connected without a track`,
        );
      }
    }
  }
});

test('pairing cannot shortcut to connected or live', () => {
  assert.equal(canTransition('pairing', 'trackReceived'), false);
  assert.equal(canTransition('pairing', 'goLive'), false);
  assert.equal(canTransition('disconnected', 'goLive'), false);
  assert.equal(canTransition('disconnected', 'trackReceived'), false);
});

test('authenticating cannot go live without connecting first', () => {
  assert.equal(canTransition('authenticating', 'goLive'), false);
  assert.equal(canTransition('authenticating', 'trackReceived'), false);
});

// ── refusals ────────────────────────────────────────────────────────────────────

test('an invalid transition is REFUSED and reports why, leaving the state untouched', () => {
  const result = transition('disconnected', 'goLive');
  assert.equal(result.state, 'disconnected');
  assert.equal(result.changed, false);
  assert.match(result.rejected ?? '', /goLive is not valid from disconnected/);
});

test('a dead camera never silently revives', () => {
  // failed and stopped lead only to reset (and stop), so nothing resurrects a camera without
  // the operator explicitly clearing it.
  for (const state of ['failed', 'stopped'] as const) {
    assert.deepEqual(
      allowedEvents(state).sort(),
      state === 'failed' ? ['reset', 'stop'] : ['reset'],
      state,
    );
    assert.equal(canTransition(state, 'trackReceived'), false);
    assert.equal(canTransition(state, 'goLive'), false);
    assert.equal(canTransition(state, 'connectionRestored'), false);
  }
});

test('reset returns a finished camera to disconnected', () => {
  assert.equal(run('failed', 'reset'), 'disconnected');
  assert.equal(run('stopped', 'reset'), 'disconnected');
});

// ── expiry (Section 12) ─────────────────────────────────────────────────────────

test('AN EXPIRED PAIRING RETURNS TO DISCONNECTED', () => {
  assert.equal(run('pairing', 'pairingExpired'), 'disconnected');
  assert.equal(run('authenticating', 'pairingExpired'), 'disconnected');
});

test('expiry cannot affect a camera that is already streaming', () => {
  // The two-minute window limits how long an unused QR code is valid. It must not cut off a
  // camera mid-sermon.
  for (const state of ['connected', 'live', 'reconnecting'] as const) {
    assert.equal(canTransition(state, 'pairingExpired'), false, state);
  }
});

// ── a wrong PIN ─────────────────────────────────────────────────────────────────

test('A REJECTED CLAIM RETURNS TO PAIRING, NOT TO DISCONNECTED', () => {
  // The QR code is still valid, so a mistyped PIN must not force the operator to generate a
  // new code.
  assert.equal(run('authenticating', 'claimRejected'), 'pairing');
  // And the phone can immediately try again.
  assert.equal(run('authenticating', 'claimRejected', 'phoneClaiming', 'claimAccepted'), 'connecting');
});

// ── interruption and recovery (Section 17) ──────────────────────────────────────

test('LIVE → RECONNECTING → CONNECTED, as documented', () => {
  assert.equal(run('live', 'connectionInterrupted'), 'reconnecting');
  assert.equal(run('live', 'connectionInterrupted', 'connectionRestored'), 'connected');
});

test('a recovered camera does NOT automatically return to live', () => {
  // Putting a camera back on the projector is the operator's call, not a side effect of Wi-Fi
  // recovering. They may have already cut to another source.
  const state = run('live', 'connectionInterrupted', 'connectionRestored');
  assert.equal(state, 'connected');
  assert.equal(canGoLive(state), true, 'but it is immediately available again');
});

test('a reconnection that gives up becomes failed', () => {
  assert.equal(run('live', 'connectionInterrupted', 'connectionFailed'), 'failed');
});

test('a track arriving during reconnection counts as recovery', () => {
  assert.equal(run('reconnecting', 'trackReceived'), 'connected');
});

test('A CAMERA THAT NEVER CONNECTED CANNOT SAY "RECONNECTING"', () => {
  /*
   * ICE reports `disconnected` routinely while it is still working through candidate pairs. Letting
   * that move `connecting` to `reconnecting` told the operator a picture had existed and was on its
   * way back, when the handshake had simply not finished — and it also hid the real problem behind a
   * reassuring label.
   */
  assert.equal(canTransition('connecting', 'connectionInterrupted'), false);

  const refused = transition('connecting', 'connectionInterrupted');
  assert.equal(refused.state, 'connecting', 'it stays honest');
  assert.equal(refused.changed, false);
  assert.ok(refused.rejected, 'and the refusal is logged rather than swallowed');

  // The two genuine outcomes of negotiation are still reachable.
  assert.equal(run('connecting', 'trackReceived'), 'connected');
  assert.equal(run('connecting', 'connectionFailed'), 'failed');

  // And reconnecting remains reachable from every state that really did have a picture.
  for (const state of ['connected', 'live'] as const) {
    assert.equal(canTransition(state, 'connectionInterrupted'), true, state);
  }
});

// ── going live (Section 13) ─────────────────────────────────────────────────────

test('only a camera with a stream can go live', () => {
  for (const state of WIRELESS_STATES) {
    if (canGoLive(state)) {
      assert.ok(hasStream(state), `${state} may go live, so it must have a stream`);
    }
  }
  assert.equal(canGoLive('connected'), true);
  assert.equal(canGoLive('live'), false, 'already live');
  assert.equal(canGoLive('connecting'), false);
  assert.equal(canGoLive('reconnecting'), false, 'wait for recovery before cutting to it');
});

test('leaving live keeps the camera connected rather than stopping it', () => {
  assert.equal(run('live', 'leaveLive'), 'connected');
});

test('a phone switching camera keeps its state', () => {
  // replaceTrack surfaces a new track on the same connection; that must not look like a
  // reconnect to the operator.
  assert.equal(run('connected', 'trackReceived'), 'connected');
  assert.equal(run('live', 'trackReceived'), 'live', 'switching camera while live stays live');
});

// ── stopping (Section 18) ───────────────────────────────────────────────────────

test('stop is reachable from every active state', () => {
  for (const state of WIRELESS_STATES) {
    if (state === 'disconnected' || state === 'stopped') continue;
    assert.equal(canTransition(state, 'stop'), true, `${state} must be stoppable`);
  }
});

test('stopping always lands on stopped', () => {
  for (const state of ['pairing', 'authenticating', 'connecting', 'connected', 'live', 'reconnecting'] as const) {
    assert.equal(run(state, 'stop'), 'stopped', state);
  }
});

// ── metrics hygiene (Sections 16, 18) ───────────────────────────────────────────

test('STALE METRICS ARE FLAGGED whenever there is no live picture', () => {
  // Section 16: never report old FPS, latency or quality after a disconnect.
  for (const state of ['disconnected', 'pairing', 'authenticating', 'connecting', 'failed', 'stopped'] as const) {
    assert.equal(metricsAreStale(state), true, state);
  }
  assert.equal(metricsAreStale('connected'), false);
  assert.equal(metricsAreStale('live'), false);
  // During a reconnection the last numbers are no longer true, even though a track exists.
  assert.equal(metricsAreStale('reconnecting'), true);
});

test('hasStream is true only where a track should exist', () => {
  assert.deepEqual(
    WIRELESS_STATES.filter(hasStream),
    ['connected', 'live', 'reconnecting'],
  );
});

// ── mapping from WebRTC ─────────────────────────────────────────────────────────

test('WebRTC disconnected maps to interruption, NOT failure', () => {
  // It fires routinely during a Wi-Fi roam and usually recovers on its own.
  assert.equal(eventForPeerState('disconnected'), 'connectionInterrupted');
  assert.equal(eventForPeerState('failed'), 'connectionFailed');
  assert.equal(eventForPeerState('connected'), 'connectionRestored');
  assert.equal(eventForPeerState('closed'), 'stop');
});

test('unmapped peer states produce no event rather than a wrong one', () => {
  assert.equal(eventForPeerState('new'), null);
  assert.equal(eventForPeerState('connecting'), null);
  assert.equal(eventForPeerState('nonsense'), null);
});

// ── presentation ────────────────────────────────────────────────────────────────

test('every state has a label and a tone', () => {
  for (const state of WIRELESS_STATES) {
    assert.ok(describeWirelessState(state).length > 0, state);
    assert.ok(['live', 'ok', 'ready', 'idle', 'error'].includes(wirelessStateTone(state)), state);
  }
});

test('only the live state uses the live tone', () => {
  const liveToned = WIRELESS_STATES.filter((state) => wirelessStateTone(state) === 'live');
  assert.deepEqual(liveToned, ['live'], 'red must mean on air and nothing else');
});

test('terminal states are identified', () => {
  assert.deepEqual(WIRELESS_STATES.filter(isTerminal), ['failed', 'stopped']);
});

// ── the table itself ────────────────────────────────────────────────────────────

test('every state is reachable from disconnected', () => {
  const reachable = new Set<WirelessState>(['disconnected']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const state of [...reachable]) {
      for (const event of allowedEvents(state)) {
        const next = transition(state, event).state;
        if (!reachable.has(next)) {
          reachable.add(next);
          grew = true;
        }
      }
    }
  }
  for (const state of WIRELESS_STATES) {
    assert.ok(reachable.has(state), `${state} is unreachable — dead code in the table`);
  }
});

test('no state is a dead end except by design', () => {
  for (const state of WIRELESS_STATES) {
    assert.ok(allowedEvents(state).length > 0, `${state} has no way out`);
  }
});
