import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWirelessCameraService,
  type WirelessCameraService,
} from '../src/main/services/wireless-camera-service.ts';
import {
  createCameraSourceRegistry,
  sourceIdForSession,
} from '../src/main/services/camera-source-registry.ts';
import { parsePairingUrl } from '../src/shared/domain/pairing.ts';
import type { InterfaceRecord } from '../src/main/services/network.ts';
import type { WirelessPhone, WirelessStatus } from '../src/shared/ipc-contract.ts';
import type { SignalMessage } from '../src/shared/domain/signaling.ts';

const LAN: InterfaceRecord[] = [
  { name: 'wlan0', address: '192.168.1.100', family: 'IPv4', internal: false },
];

interface Harness {
  service: WirelessCameraService;
  statuses: WirelessStatus[];
  signals: { sessionId: string; message: SignalMessage }[];
  dir: string;
  latest: () => WirelessStatus;
  cleanup: () => Promise<void>;
}

async function harness(interfaces: InterfaceRecord[] = LAN): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ep-wireless-'));
  const statuses: WirelessStatus[] = [];
  const signals: Harness['signals'] = [];

  const service = createWirelessCameraService({
    userDataDir: dir,
    // Port 0 so the OS assigns a free one and tests never collide.
    port: 0,
    // The fixture advertises a routable LAN address (so QR assertions stay meaningful) while
    // the socket binds loopback, which is the only address this machine can actually bind.
    bindAddress: '127.0.0.1',
    readInterfaces: () => interfaces,
    onStatus: (status) => statuses.push(status),
    onSignalToDesktop: (sessionId, message) => signals.push({ sessionId, message }),
  });

  return {
    service,
    statuses,
    signals,
    dir,
    latest: () => statuses[statuses.length - 1] ?? service.status(),
    cleanup: async () => {
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── startup ─────────────────────────────────────────────────────────────────────

test('the service starts, mints a certificate and reports a reachable origin', async () => {
  const h = await harness();
  try {
    const status = await h.service.start();
    assert.equal(status.running, true);
    assert.equal(status.lanAddress, '192.168.1.100');
    assert.equal(status.interfaceName, 'wlan0');
    assert.match(status.origin ?? '', /^https:\/\/192\.168\.1\.100:\d+$/);
    assert.match(status.certificateFingerprint ?? '', /^[0-9a-f]{64}$/);
    assert.equal(status.problem, null);
  } finally {
    await h.cleanup();
  }
});

test('starting twice is idempotent', async () => {
  const h = await harness();
  try {
    const first = await h.service.start();
    const second = await h.service.start();
    assert.equal(second.running, true);
    assert.equal(first.origin, second.origin, 'the same server, not a second one');
  } finally {
    await h.cleanup();
  }
});

test('WITH NO USABLE NETWORK IT REFUSES TO START AND EXPLAINS WHY', async () => {
  // Rather than listening on something a phone cannot reach.
  const h = await harness([{ name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true }]);
  try {
    const status = await h.service.start();
    assert.equal(status.running, false);
    assert.match(status.problem ?? '', /not.*connected to a network/i);
    assert.ok(status.remedies.length > 0);
  } finally {
    await h.cleanup();
  }
});

test('a session cannot be created before the service is running', async () => {
  const h = await harness();
  try {
    assert.throws(() => h.service.createSession('Phone'), /not running/);
  } finally {
    await h.cleanup();
  }
});

// ── the pairing ticket ──────────────────────────────────────────────────────────

test('THE QR PAYLOAD CONTAINS THE SESSION AND TOKEN BUT NEVER THE PIN', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Pastor Phone');

    const parsed = parsePairingUrl(ticket.pairingUrl);
    assert.ok(parsed, 'the QR payload must be a valid pairing URL');
    assert.equal(parsed?.sessionId, ticket.sessionId);
    assert.match(parsed?.token ?? '', /^[0-9a-f]{64}$/);

    // The decisive assertion: photographing the code is not enough to pair.
    assert.ok(!ticket.pairingUrl.includes(ticket.pin), 'the PIN must never be in the QR code');
    assert.match(ticket.pin, /^\d{6}$/, 'but it is available for the operator screen');
  } finally {
    await h.cleanup();
  }
});

test('the QR URL is https and points at the LAN address, not localhost', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    assert.match(ticket.pairingUrl, /^https:\/\/192\.168\.1\.100:\d+\/camera\?/);
    assert.doesNotMatch(ticket.pairingUrl, /localhost|127\.0\.0\.1/, 'a phone cannot reach localhost');
    assert.match(ticket.displayUrl, /^https:\/\/192\.168\.1\.100:\d+$/);
  } finally {
    await h.cleanup();
  }
});

test('every pairing produces fresh credentials — no permanent camera URL', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const first = h.service.createSession('Phone 1');
    const second = h.service.createSession('Phone 2');
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.pairingUrl, second.pairingUrl);
    assert.notEqual(first.pin, second.pin);
  } finally {
    await h.cleanup();
  }
});

test('a new session enters the pairing state and exposes its expiry and PIN', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    const phone = h.latest().phones.find((candidate) => candidate.sessionId === ticket.sessionId);

    assert.equal(phone?.state, 'pairing');
    assert.equal(phone?.pin, ticket.pin, 'the operator needs the PIN while pairing');
    assert.equal(phone?.expiresAt, ticket.expiresAt);
    // Nothing is known about the picture yet, so nothing is claimed.
    assert.equal(phone?.resolution, null);
    assert.equal(phone?.fps, null);
    assert.equal(phone?.quality, null);
    assert.equal(phone?.latencyMs, null);
  } finally {
    await h.cleanup();
  }
});

// ── the state machine through the service ───────────────────────────────────────

test('A PHONE IS ONLY "connected" ONCE A REAL TRACK ARRIVES', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    const session = h.service.registry.get(ticket.sessionId)!;

    // Claim succeeds — the phone proved it knew the PIN. The HTTPS server reports the attempt,
    // which is what advances the machine out of `pairing`.
    const claim = h.service.registry.claim({
      sessionId: ticket.sessionId,
      token: session.pairing.token,
      pin: ticket.pin,
      deviceLabel: 'iPhone (Safari)',
    });
    assert.equal(claim.ok, true);
    h.service.notifyClaim(ticket.sessionId, true);

    const beforeTrack = h.service.status().phones[0];
    assert.equal(beforeTrack?.state, 'connecting');
    assert.notEqual(beforeTrack?.state, 'connected', 'a successful claim is not a picture');

    const afterTrack = h.service.markTrackReceived(ticket.sessionId);
    assert.equal(afterTrack.phones[0]?.state, 'connected');
  } finally {
    await h.cleanup();
  }
});

test('THE PAIRING CLAIM ADVANCES THE MACHINE OUT OF "pairing"', async () => {
  /*
   * Regression guard for a real bug. Pairing happens over HTTP rather than as a signalling
   * message, and the service originally had no callback for it — so the machine sat in `pairing`
   * forever and no phone could ever reach `connected`. The state machine correctly refused the
   * illegal jump, which is exactly how the bug surfaced.
   */
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    assert.equal(h.service.status().phones[0]?.state, 'pairing');

    h.service.notifyClaim(ticket.sessionId, true);
    assert.equal(h.service.status().phones[0]?.state, 'connecting');
  } finally {
    await h.cleanup();
  }
});

test('A REJECTED CLAIM RETURNS TO PAIRING so the QR code stays usable', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');

    h.service.notifyClaim(ticket.sessionId, false);
    assert.equal(h.service.status().phones[0]?.state, 'pairing', 'a mistyped PIN costs nothing');

    // And the phone can try again immediately.
    h.service.notifyClaim(ticket.sessionId, true);
    assert.equal(h.service.status().phones[0]?.state, 'connecting');
  } finally {
    await h.cleanup();
  }
});

test('metrics are reported only while a picture exists, and cleared otherwise', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    h.service.notifyClaim(ticket.sessionId, true);
    h.service.markTrackReceived(ticket.sessionId);

    h.service.reportStats(ticket.sessionId, { packetLoss: 0.001, rttMs: 40, jitterMs: 5, fps: 30 });
    let phone = h.service.status().phones[0];
    assert.equal(phone?.quality, 'excellent');
    assert.equal(phone?.latencyMs, 20, 'one-way latency is half the round trip');
    assert.equal(phone?.fps, 30);

    // Section 16: a disconnect must not leave yesterday's numbers on screen.
    h.service.disconnect(ticket.sessionId);
    phone = h.service.status().phones[0];
    assert.equal(phone?.state, 'stopped');
    assert.equal(phone?.quality, null);
    assert.equal(phone?.latencyMs, null);
    assert.equal(phone?.fps, null);
  } finally {
    await h.cleanup();
  }
});

test('stats arriving during a reconnection are ignored as already stale', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    h.service.notifyClaim(ticket.sessionId, true);
    h.service.markTrackReceived(ticket.sessionId);
    h.service.reportStats(ticket.sessionId, { packetLoss: 0, rttMs: 20, jitterMs: 2 });

    // A Wi-Fi drop noticed by the desktop peer, through the same seam the output window uses.
    h.service.notifyDesktopPeerState(ticket.sessionId, 'disconnected');
    assert.equal(h.service.status().phones[0]?.state, 'reconnecting');

    h.service.reportStats(ticket.sessionId, { packetLoss: 0, rttMs: 10, jitterMs: 1 });
    const phone = h.service.status().phones[0];
    // Numbers from a link that is already gone must not be presented as current.
    assert.equal(phone?.quality, null, 'stale metrics stay cleared during a reconnection');
    assert.equal(phone?.latencyMs, null);
  } finally {
    await h.cleanup();
  }
});

test('the worst-of-three quality rule is used, not an average', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    h.service.notifyClaim(ticket.sessionId, true);
    h.service.markTrackReceived(ticket.sessionId);

    // Perfect RTT and jitter, heavy packet loss: averaging would call this good.
    h.service.reportStats(ticket.sessionId, { packetLoss: 0.09, rttMs: 10, jitterMs: 1 });
    assert.equal(h.service.status().phones[0]?.quality, 'poor');
  } finally {
    await h.cleanup();
  }
});

test('RECONNECTION RECOVERS WITHOUT RE-PAIRING (Section 17)', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    h.service.notifyClaim(ticket.sessionId, true);
    h.service.markTrackReceived(ticket.sessionId);
    assert.equal(h.service.status().phones[0]?.state, 'connected');

    h.service.notifyDesktopPeerState(ticket.sessionId, 'disconnected');
    assert.equal(h.service.status().phones[0]?.state, 'reconnecting');

    // Wi-Fi returns. The operator must NOT have to scan a new QR code.
    h.service.notifyDesktopPeerState(ticket.sessionId, 'connected');
    assert.equal(h.service.status().phones[0]?.state, 'connected');
  } finally {
    await h.cleanup();
  }
});

test('a connection that gives up becomes failed, not silently reconnecting forever', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    h.service.notifyClaim(ticket.sessionId, true);
    h.service.markTrackReceived(ticket.sessionId);

    h.service.notifyDesktopPeerState(ticket.sessionId, 'failed');
    assert.equal(h.service.status().phones[0]?.state, 'failed');
  } finally {
    await h.cleanup();
  }
});

test('DISCONNECT INVALIDATES THE SESSION CREDENTIALS', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    const session = h.service.registry.get(ticket.sessionId)!;
    h.service.registry.claim({
      sessionId: ticket.sessionId,
      token: session.pairing.token,
      pin: ticket.pin,
      deviceLabel: 'Phone',
    });
    const token = session.connectionToken;

    h.service.disconnect(ticket.sessionId);

    assert.equal(
      h.service.registry.authenticate(ticket.sessionId, token),
      null,
      'the bearer token must be dead immediately',
    );
  } finally {
    await h.cleanup();
  }
});

test('cancelling a pairing removes the phone entirely', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    const status = h.service.cancelSession(ticket.sessionId);
    assert.equal(status.phones.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('stopping the service clears every phone', async () => {
  const h = await harness();
  try {
    await h.service.start();
    h.service.createSession('Phone 1');
    h.service.createSession('Phone 2');
    assert.equal(h.service.status().phones.length, 2);

    const stopped = await h.service.stop();
    assert.equal(stopped.running, false);
    assert.equal(stopped.phones.length, 0);
    assert.equal(h.service.registry.list().length, 0);
  } finally {
    await h.cleanup();
  }
});

test('capacity is reported, and exceeding it is refused with a usable message', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const max = h.service.status().maxPhones;
    for (let i = 0; i < max; i++) h.service.createSession(`Phone ${i + 1}`);
    assert.throws(() => h.service.createSession('One too many'), /Maximum of \d+ phone cameras/);
  } finally {
    await h.cleanup();
  }
});

// ── camera source projection ────────────────────────────────────────────────────

test('phones become CameraSources of kind wireless', () => {
  const changes: number[] = [];
  const registry = createCameraSourceRegistry({ onChanged: (sources) => changes.push(sources.length) });

  const phone: WirelessPhone = {
    sessionId: 'ABC123',
    label: 'Pastor Phone',
    state: 'connected',
    deviceLabel: 'iPhone (Safari)',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    latencyMs: 24,
    quality: 'good',
    audioEnabled: false,
    expiresAt: null,
    pin: null,
  };

  const sources = registry.syncWireless([phone]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.kind, 'wireless');
  assert.equal(sources[0]?.isWireless, true);
  assert.equal(sources[0]?.name, 'Pastor Phone');
  assert.equal(sources[0]?.status, 'connected');
  assert.deepEqual(sources[0]?.resolution, { width: 1920, height: 1080 });
  assert.equal(sources[0]?.id, sourceIdForSession('ABC123'));
  assert.deepEqual(changes, [1], 'subscribers are notified once');
});

test('a poor connection reports WEAK, which is still usable', () => {
  const registry = createCameraSourceRegistry({ onChanged: () => undefined });
  const sources = registry.syncWireless([basePhone({ state: 'connected', quality: 'poor' })]);
  // Section 19: degraded, warned about, but never auto-disconnected.
  assert.equal(sources[0]?.status, 'weak');
});

test('a pairing phone is not presented as a usable camera', () => {
  const registry = createCameraSourceRegistry({ onChanged: () => undefined });
  for (const [state, expected] of [
    ['pairing', 'pairing'],
    ['authenticating', 'connecting'],
    ['connecting', 'connecting'],
    ['failed', 'error'],
    ['stopped', 'disconnected'],
  ] as const) {
    const sources = registry.syncWireless([basePhone({ state })]);
    assert.equal(sources[0]?.status, expected, state);
  }
});

test('AN ASSIGNMENT SURVIVES A METRICS REFRESH', () => {
  // Without this, every two-second stats report would knock the live camera back to standby.
  const registry = createCameraSourceRegistry({ onChanged: () => undefined });
  registry.syncWireless([basePhone({ state: 'connected' })]);
  registry.assign(sourceIdForSession('ABC123'), 'live');
  assert.equal(registry.live()?.id, sourceIdForSession('ABC123'));

  registry.syncWireless([basePhone({ state: 'connected', fps: 29 })]);
  assert.equal(registry.live()?.id, sourceIdForSession('ABC123'), 'still live after a refresh');
});

test('the existing switching rules are reused, not reimplemented', () => {
  const registry = createCameraSourceRegistry({ onChanged: () => undefined });
  registry.syncWireless([
    basePhone({ sessionId: 'AAA111', state: 'connected' }),
    basePhone({ sessionId: 'BBB222', state: 'connected' }),
  ]);

  registry.assign(sourceIdForSession('AAA111'), 'live');
  registry.assign(sourceIdForSession('BBB222'), 'live');

  const sources = registry.list();
  assert.equal(sources.filter((source) => source.assignment === 'live').length, 1);
  assert.equal(registry.live()?.id, sourceIdForSession('BBB222'));
  // The demoted camera goes to PREVIEW so the operator can cut straight back.
  assert.equal(
    sources.find((source) => source.id === sourceIdForSession('AAA111'))?.assignment,
    'preview',
  );
});

test('a camera with no stream cannot be put live', () => {
  const registry = createCameraSourceRegistry({ onChanged: () => undefined });
  registry.syncWireless([basePhone({ state: 'pairing' })]);
  registry.assign(sourceIdForSession('ABC123'), 'live');
  assert.equal(registry.live(), null, 'going live with no picture would black the projector');
});

test('LOSING THE LIVE CAMERA IS REPORTED so the output can be blacked', () => {
  let lost: string | null = null;
  const registry = createCameraSourceRegistry({
    onChanged: () => undefined,
    onLiveLost: (source) => {
      lost = source.id;
    },
  });

  registry.syncWireless([basePhone({ state: 'connected' })]);
  registry.assign(sourceIdForSession('ABC123'), 'live');

  const result = registry.disconnect(sourceIdForSession('ABC123'), 'Wi-Fi lost');
  assert.equal(result.lostLive, true);
  assert.equal(lost, sourceIdForSession('ABC123'));

  const source = result.sources[0];
  assert.equal(source?.status, 'disconnected');
  // Stale metrics cleared, so the panel cannot keep claiming 30 fps on a dead camera.
  assert.equal(source?.fps, null);
  assert.equal(source?.latencyMs, null);
  assert.equal(source?.quality, null);
});

test('losing a standby camera does not disturb the live one', () => {
  const registry = createCameraSourceRegistry({ onChanged: () => undefined });
  registry.syncWireless([
    basePhone({ sessionId: 'AAA111', state: 'connected' }),
    basePhone({ sessionId: 'BBB222', state: 'connected' }),
  ]);
  registry.assign(sourceIdForSession('AAA111'), 'live');

  const result = registry.disconnect(sourceIdForSession('BBB222'), 'Phone locked');
  assert.equal(result.lostLive, false);
  assert.equal(registry.live()?.id, sourceIdForSession('AAA111'));
});

test('source ids map back to their session', () => {
  const registry = createCameraSourceRegistry({ onChanged: () => undefined });
  assert.equal(registry.sessionIdFor(sourceIdForSession('ABC123')), 'ABC123');
  assert.equal(registry.sessionIdFor('usb:0'), null, 'local cameras have no session');
});

function basePhone(overrides: Partial<WirelessPhone> = {}): WirelessPhone {
  return {
    sessionId: 'ABC123',
    label: 'Phone',
    state: 'connected',
    deviceLabel: null,
    resolution: null,
    fps: null,
    latencyMs: null,
    quality: null,
    audioEnabled: false,
    expiresAt: null,
    pin: null,
    ...overrides,
  };
}
