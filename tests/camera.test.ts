import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignCamera,
  classifyConnectionQuality,
  createSource,
  describeQuality,
  describeSource,
  handleDisconnect,
  isUsable,
  liveCamera,
  shouldWarnOperator,
  statusForQuality,
  type CameraSource,
} from '../src/shared/domain/camera.ts';

const connected = (id: string, name: string, kind: CameraSource['kind'] = 'usb'): CameraSource => ({
  ...createSource({ id, name, kind, status: 'connected' }),
  resolution: { width: 1920, height: 1080 },
  fps: 30,
});

// ── usability ───────────────────────────────────────────────────────────────────

test('only connected or weak sources are usable', () => {
  assert.equal(isUsable(connected('a', 'A')), true);
  assert.equal(isUsable({ ...connected('a', 'A'), status: 'weak' }), true, 'weak still shows a picture');
  for (const status of ['available', 'pairing', 'connecting', 'disconnected', 'error', 'unavailable'] as const) {
    assert.equal(isUsable({ ...connected('a', 'A'), status }), false, status);
  }
});

// ── assignment (Sections 9 and 14) ──────────────────────────────────────────────

test('only one camera can be live at a time', () => {
  const sources = [connected('c1', 'Pastor'), connected('c2', 'Worship'), connected('c3', 'Audience')];
  const afterFirst = assignCamera(sources, 'c1', 'live');
  const afterSecond = assignCamera(afterFirst, 'c2', 'live');

  assert.equal(afterSecond.filter((s) => s.assignment === 'live').length, 1);
  assert.equal(liveCamera(afterSecond)?.id, 'c2');
});

test('the demoted camera drops to PREVIEW, not standby, so the operator can cut back', () => {
  const sources = [connected('c1', 'Pastor'), connected('c2', 'Worship')];
  const result = assignCamera(assignCamera(sources, 'c1', 'live'), 'c2', 'live');
  assert.equal(result.find((s) => s.id === 'c1')?.assignment, 'preview');
});

test('SWITCHING DOES NOT STOP THE OTHER CAMERAS', () => {
  // Section 14: standby cameras stay connected so switching back is instant rather than a
  // reconnect in the middle of a service.
  const sources = [connected('c1', 'Pastor'), connected('c2', 'Worship')];
  const result = assignCamera(assignCamera(sources, 'c1', 'live'), 'c2', 'live');
  for (const source of result) {
    assert.equal(source.status, 'connected', `${source.id} must stay connected`);
    assert.deepEqual(source.resolution, { width: 1920, height: 1080 });
  }
});

test('a DISCONNECTED camera cannot be put live — that would black the projector', () => {
  const sources = [connected('c1', 'Pastor'), { ...connected('c2', 'Worship'), status: 'disconnected' as const }];
  const result = assignCamera(sources, 'c2', 'live');
  assert.equal(liveCamera(result), null, 'the request must be refused');
  assert.equal(result.find((s) => s.id === 'c2')?.assignment, 'standby');
});

test('a weak camera CAN go live — a degraded picture beats no picture', () => {
  const sources = [{ ...connected('c1', 'Pastor'), status: 'weak' as const }];
  assert.equal(liveCamera(assignCamera(sources, 'c1', 'live'))?.id, 'c1');
});

test('assigning preview or standby does not disturb the live camera', () => {
  const sources = assignCamera([connected('c1', 'A'), connected('c2', 'B')], 'c1', 'live');
  const result = assignCamera(sources, 'c2', 'preview');
  assert.equal(liveCamera(result)?.id, 'c1', 'live must be untouched');
  assert.equal(result.find((s) => s.id === 'c2')?.assignment, 'preview');
});

test('an unknown id is ignored rather than throwing', () => {
  const sources = [connected('c1', 'A')];
  assert.deepEqual(assignCamera(sources, 'nope', 'live'), sources);
});

// ── disconnection ───────────────────────────────────────────────────────────────

test('losing the LIVE camera is reported so the caller can black the output', () => {
  const sources = assignCamera([connected('c1', 'Pastor'), connected('c2', 'Worship')], 'c1', 'live');
  const result = handleDisconnect(sources, 'c1', 'Wi-Fi lost');

  assert.equal(result.lostLive, true, 'the caller must know to black the screen');
  const dropped = result.sources.find((s) => s.id === 'c1');
  assert.equal(dropped?.status, 'disconnected');
  assert.equal(dropped?.assignment, 'standby');
  assert.equal(dropped?.unavailableReason, 'Wi-Fi lost');
  // Stale metrics must be cleared, or the panel keeps claiming 30 fps on a dead camera.
  assert.equal(dropped?.resolution, null);
  assert.equal(dropped?.fps, null);
  assert.equal(dropped?.latencyMs, null);
});

test('losing a standby camera does not disturb the live one', () => {
  const sources = assignCamera([connected('c1', 'Pastor'), connected('c2', 'Worship')], 'c1', 'live');
  const result = handleDisconnect(sources, 'c2', 'Phone locked');
  assert.equal(result.lostLive, false);
  assert.equal(liveCamera(result.sources)?.id, 'c1');
});

test('disconnecting an unknown camera is harmless', () => {
  const result = handleDisconnect([connected('c1', 'A')], 'nope', 'x');
  assert.equal(result.lostLive, false);
  assert.equal(result.sources.length, 1);
});

// ── connection quality (Section 18) ─────────────────────────────────────────────

test('a clean local network grades excellent', () => {
  assert.equal(classifyConnectionQuality({ packetLoss: 0, rttMs: 12, jitterMs: 3 }), 'excellent');
});

test('THE WORST METRIC DECIDES THE GRADE', () => {
  // Averaging would call this "good" while the projector shows visible breakup.
  assert.equal(
    classifyConnectionQuality({ packetLoss: 0.08, rttMs: 10, jitterMs: 2 }),
    'poor',
    'heavy packet loss must dominate a perfect RTT',
  );
  assert.equal(classifyConnectionQuality({ packetLoss: 0, rttMs: 10, jitterMs: 90 }), 'poor');
  assert.equal(classifyConnectionQuality({ packetLoss: 0, rttMs: 400, jitterMs: 1 }), 'poor');
});

test('each grade is reachable', () => {
  assert.equal(classifyConnectionQuality({ packetLoss: 0.001, rttMs: 30, jitterMs: 5 }), 'excellent');
  assert.equal(classifyConnectionQuality({ packetLoss: 0.01, rttMs: 100, jitterMs: 20 }), 'good');
  assert.equal(classifyConnectionQuality({ packetLoss: 0.04, rttMs: 200, jitterMs: 50 }), 'fair');
  assert.equal(classifyConnectionQuality({ packetLoss: 0.2, rttMs: 600, jitterMs: 200 }), 'poor');
});

test('negative or nonsense stats do not produce a better grade than reality', () => {
  assert.equal(classifyConnectionQuality({ packetLoss: -1, rttMs: -5, jitterMs: -2 }), 'excellent');
  assert.equal(classifyConnectionQuality({ packetLoss: 1, rttMs: 9999, jitterMs: 9999 }), 'poor');
});

test('the operator is warned on fair and poor, but never auto-disconnected', () => {
  assert.equal(shouldWarnOperator('excellent'), false);
  assert.equal(shouldWarnOperator('good'), false);
  assert.equal(shouldWarnOperator('fair'), true);
  assert.equal(shouldWarnOperator('poor'), true);

  // Section 18 is explicit: a poor connection stays usable. Only 'poor' downgrades the
  // status, and even then to 'weak', which isUsable() still accepts.
  assert.equal(statusForQuality('poor'), 'weak');
  assert.equal(isUsable({ ...connected('c1', 'A'), status: statusForQuality('poor') }), true);
  assert.equal(statusForQuality('fair'), 'connected');
});

test('quality labels match the words in the spec', () => {
  assert.deepEqual(
    (['excellent', 'good', 'fair', 'poor'] as const).map(describeQuality),
    ['Excellent', 'Good', 'Fair', 'Poor'],
  );
});

// ── display ─────────────────────────────────────────────────────────────────────

test('a source describes itself for the operator panel', () => {
  const source: CameraSource = { ...connected('c1', 'Phone 1', 'wireless'), latencyMs: 24.4 };
  assert.equal(describeSource(source), '1920×1080 · 30 fps · 24 ms');
});

test('a source with no signal says so rather than showing empty fields', () => {
  assert.equal(describeSource(createSource({ id: 'c1', name: 'A', kind: 'usb' })), 'No signal');
});

test('latency is omitted for sources that cannot measure it', () => {
  assert.equal(describeSource(connected('c1', 'Webcam')), '1920×1080 · 30 fps');
});

// ── construction ────────────────────────────────────────────────────────────────

test('wireless sources are flagged so the UI can show phone affordances', () => {
  assert.equal(createSource({ id: 'p1', name: 'Phone 1', kind: 'wireless' }).isWireless, true);
  assert.equal(createSource({ id: 'u1', name: 'Webcam', kind: 'usb' }).isWireless, false);
});

test('a new source starts on standby, never live', () => {
  const source = createSource({ id: 'p1', name: 'Phone 1', kind: 'wireless' });
  assert.equal(source.assignment, 'standby');
  assert.equal(source.audioEnabled, false, 'audio is opt-in');
});

test('an unavailable provider carries its reason', () => {
  const ndi = createSource({
    id: 'ndi',
    name: 'NDI',
    kind: 'ndi',
    status: 'unavailable',
    unavailableReason: 'NDI support is NOT IMPLEMENTED — requires the NDI SDK.',
  });
  assert.equal(isUsable(ndi), false);
  assert.match(ndi.unavailableReason ?? '', /NOT IMPLEMENTED/);
});
