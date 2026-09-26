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


// ── regressions from the first real-hardware run ────────────────────────────────

test('CANCELLING EMITS A SNAPSHOT WITHOUT THE PHONE, not one showing it stopped', async () => {
  /*
   * The bug: `apply(sessionId, 'stop')` emits on every state change, so cancelling broadcast a
   * snapshot that still contained the phone as `stopped` — and because the delete happened
   * afterwards with no further emit, that was the LAST status the UI ever received. A cancelled
   * phone sat in the operator's list permanently with no way to clear it.
   */
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    const before = h.statuses.length;

    h.service.cancelSession(ticket.sessionId);

    const emitted = h.statuses.slice(before);
    assert.ok(emitted.length > 0, 'cancelling must emit at least once');

    // Every snapshot emitted by the cancel must already be free of the phone.
    for (const status of emitted) {
      assert.equal(
        status.phones.some((phone) => phone.sessionId === ticket.sessionId),
        false,
        'no emitted snapshot may still contain the cancelled phone',
      );
    }
    assert.equal(h.service.status().phones.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('cancelling frees the slot IMMEDIATELY rather than after the linger window', async () => {
  /*
   * `revoke` keeps a record for 30 seconds so a connected phone can still collect its `bye` over
   * the open stream. Applying that to an explicit cancellation meant the slot stayed occupied, so
   * cancelling four QR codes in a row failed with "maximum reached" — which is why cancelSession
   * uses `remove` instead.
   */
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    assert.equal(h.service.registry.list().length, 1);

    h.service.cancelSession(ticket.sessionId);
    assert.equal(h.service.registry.list().length, 0, 'the slot must be free at once, not in 30s');
  } finally {
    await h.cleanup();
  }
});

test('PHONES WHOSE SESSION WAS PRUNED ARE DROPPED FROM THE LIST', async () => {
  // Otherwise the list self-perpetuates: expired QR codes vanish from the registry but their UI
  // records linger forever, showing phones that no longer exist.
  const h = await harness();
  try {
    await h.service.start();
    const stale = h.service.createSession('Stale Phone');
    assert.equal(h.service.status().phones.length, 1);

    // Simulate the registry pruning an abandoned session.
    h.service.registry.revoke(stale.sessionId, 'expired');
    h.service.registry.prune();
    while (h.service.registry.get(stale.sessionId)) {
      h.service.registry.prune();
      break;
    }

    // Creating the next session sweeps records with no surviving session.
    h.service.createSession('Fresh Phone');
    const labels = h.service.status().phones.map((phone) => phone.label);
    assert.ok(labels.includes('Fresh Phone'));
  } finally {
    await h.cleanup();
  }
});

test('a cancelled slot is released, so capacity is not leaked', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const max = h.service.status().maxPhones;

    // Fill every slot, then free one and confirm another can be created.
    const tickets = [];
    for (let i = 0; i < max; i++) tickets.push(h.service.createSession(`Phone ${i + 1}`));
    assert.throws(() => h.service.createSession('Overflow'), /Maximum of/);

    h.service.cancelSession(tickets[0]!.sessionId);
    assert.doesNotThrow(() => h.service.createSession('Replacement'));
  } finally {
    await h.cleanup();
  }
});


// ── the silent-renderer watchdog ────────────────────────────────────────────────

/**
 * Guards against the failure that produced total silence.
 *
 * `OutputApp.tsx` called `useWirelessCameraHost()` without importing it. The output renderer threw
 * on its first render, so it mounted no React tree and subscribed to no IPC events. Every message
 * main sent it was absorbed without error — `webContents.send` has no return value and no
 * acknowledgement — so the phone's `ready` vanished, no WebRTC offer was ever created, and the
 * entire Wireless Camera feature was dead. The window is hidden, so nothing was visible either.
 *
 * Every other line of the log looked correct. The absence of a line was the only evidence, and that
 * is precisely what a human does not notice. So the absence is now asserted on.
 */
async function watchdogHarness(): Promise<{
  service: WirelessCameraService;
  logs: string[];
  post: (sessionId: string, token: string, body: unknown) => Promise<number>;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'ep-watchdog-'));
  const logs: string[] = [];

  const service = createWirelessCameraService({
    userDataDir: dir,
    port: 0,
    bindAddress: '127.0.0.1',
    readInterfaces: () => LAN,
    onStatus: () => undefined,
    onSignalToDesktop: () => undefined,
    // Milliseconds, so the test does not wait five seconds for a timer.
    offerTimeoutMs: 60,
    onLog: (line) => logs.push(line),
  });

  const status = await service.start();
  const port = Number(/:(\d+)$/.exec(status.origin ?? '')?.[1] ?? '0');
  if (!Number.isInteger(port) || port <= 0) throw new Error(`no bound port in ${status.origin}`);

  const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  return {
    service,
    logs,
    post: (sessionId, token, body) =>
      fetch(`https://127.0.0.1:${port}/signal/send?s=${sessionId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.status),
    cleanup: async () => {
      await service.stop();
      if (previous === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const claimed = (service: WirelessCameraService, label = 'Phone'): { id: string; token: string } => {
  const ticket = service.createSession(label);
  const session = service.registry.get(ticket.sessionId);
  if (!session) throw new Error('the session must exist before it is claimed');

  const result = service.registry.claim({
    sessionId: ticket.sessionId,
    token: session.pairing.token,
    pin: ticket.pin,
    deviceLabel: 'Android (Chrome)',
  });
  if (!result.ok) throw new Error(`the claim was refused: ${result.reason}`);

  service.notifyClaim(ticket.sessionId, true);
  return { id: ticket.sessionId, token: result.session.connectionToken };
};

test('A PHONE THAT IS READY BUT NEVER OFFERED TO IS REPORTED, NOT LEFT SILENT', async () => {
  const h = await watchdogHarness();
  try {
    const phone = claimed(h.service);

    // The phone says it has a camera. Nothing answers — this is the output renderer having
    // crashed on mount.
    assert.equal(await h.post(phone.id, phone.token, { kind: 'ready', hasAudio: false }), 200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const complaint = h.logs.find((line) => line.includes('NO OFFER'));
    if (complaint === undefined) {
      throw new Error(`expected a NO OFFER diagnosis, got:\n${h.logs.join('\n')}`);
    }
    assert.match(complaint, new RegExp(phone.id), 'it names the session');
    assert.match(complaint, /not listening/, 'and says what is actually wrong');
  } finally {
    await h.cleanup();
  }
});

test('a phone that IS offered to produces no complaint', async () => {
  const h = await watchdogHarness();
  try {
    const phone = claimed(h.service);
    assert.equal(await h.post(phone.id, phone.token, { kind: 'ready', hasAudio: false }), 200);

    // The output window answers, which is the whole point of the watchdog.
    h.service.sendToPhone(phone.id, { kind: 'offer', sdp: 'v=0\r\n' });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      h.logs.some((line) => line.includes('NO OFFER')),
      false,
      'a working handshake must not produce a warning',
    );
  } finally {
    await h.cleanup();
  }
});
