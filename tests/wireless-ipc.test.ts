import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { createLiveStateService } from '../src/main/services/live-state-service.ts';
import { createWirelessCameraService } from '../src/main/services/wireless-camera-service.ts';
import { createCameraSourceRegistry } from '../src/main/services/camera-source-registry.ts';
import { createHandlers } from '../src/main/ipc/handlers.ts';
import { dispatch, isChannelAllowedForRole, type HandlerRegistry, type WindowRole } from '../src/main/ipc/dispatcher.ts';
import { IPC_CHANNELS, OUTPUT_ALLOWED_CHANNELS, type AppInfo, type IpcResult } from '../src/shared/ipc-contract.ts';
import { validatorFor } from '../src/shared/validation/ipc-validators.ts';

const APP_INFO: AppInfo = {
  name: 'Exceptionel Presenter',
  version: '0.2.0',
  electronVersion: 'test',
  chromeVersion: 'test',
  nodeVersion: 'test',
  platform: 'linux',
  schemaVersion: 3,
  sqliteEngine: 'node:sqlite',
  userDataPath: '/tmp/ep',
  isPackaged: false,
};

interface Harness {
  db: AppDatabase;
  handlers: HandlerRegistry;
  call: (channel: string, payload?: unknown, role?: WindowRole) => Promise<IpcResult<unknown>>;
  service: ReturnType<typeof createWirelessCameraService>;
  relayed: { to: string; message: unknown }[];
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ep-wireless-ipc-'));
  const db = openDatabase({ path: ':memory:' });
  const live = createLiveStateService();
  const relayed: Harness['relayed'] = [];

  const cameras = createCameraSourceRegistry({ onChanged: () => undefined });
  const service = createWirelessCameraService({
    userDataDir: dir,
    port: 0,
    bindAddress: '127.0.0.1',
    readInterfaces: () => [{ name: 'wlan0', address: '192.168.1.100', family: 'IPv4', internal: false }],
    onStatus: () => undefined,
    onPhonesChanged: (phones) => cameras.syncWireless(phones),
    onSignalToDesktop: () => undefined,
  });

  const handlers = createHandlers({
    db,
    live,
    appInfo: () => APP_INFO,
    quit: () => undefined,
    wireless: service,
    relay: (to, message) => relayed.push({ to, message }),
    cameraSources: () => cameras.list(),
    assignCameraSource: (id, assignment) => cameras.assign(id, assignment),
  });

  return {
    db,
    handlers,
    service,
    relayed,
    call: (channel, payload, role = 'operator') => dispatch(channel, payload, role, { handlers }),
    cleanup: async () => {
      await service.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const expectFailure = (result: IpcResult<unknown>, code: string): void => {
  assert.equal(result.ok, false, 'expected a failure');
  assert.equal((result as { ok: false; failure: { code: string } }).failure.code, code);
};

const unwrap = <T>(result: IpcResult<unknown>): T => {
  assert.equal(
    result.ok,
    true,
    result.ok ? '' : `expected success: ${(result as { failure: { detail?: string } }).failure.detail ?? ''}`,
  );
  return (result as { ok: true; data: T }).data;
};

// ── every new channel is guarded ────────────────────────────────────────────────

test('every wireless and camera channel has a validator — fail-closed', () => {
  for (const channel of IPC_CHANNELS) {
    if (!channel.startsWith('wireless:') && !channel.startsWith('camera:') && channel !== 'media:relay') continue;
    assert.ok(validatorFor(channel), `${channel} must have a validator or it is unreachable`);
  }
});

// ── role authorisation ──────────────────────────────────────────────────────────

test('THE AUDIENCE OUTPUT WINDOW CANNOT CONTROL WIRELESS CAMERAS', async () => {
  const h = await harness();
  try {
    for (const [channel, payload] of [
      ['wireless:start', undefined],
      ['wireless:stop', undefined],
      ['wireless:createSession', { label: 'Injected' }],
      ['wireless:cancelSession', { sessionId: 'ABC234' }],
      ['wireless:disconnect', { sessionId: 'ABC234' }],
      ['wireless:status', undefined],
      ['camera:assign', { id: 'phone:ABC234', assignment: 'live' }],
    ] as const) {
      expectFailure(await h.call(channel, payload, 'output'), 'ipc/forbidden-for-role');
    }
  } finally {
    await h.cleanup();
  }
});

test('the output window CAN do exactly the two things it needs, and nothing more', async () => {
  // It owns the phone's peer connection, so it must be able to answer the phone and republish to
  // the operator preview. Both are signalling only.
  assert.ok(OUTPUT_ALLOWED_CHANNELS.includes('wireless:signal'));
  assert.ok(OUTPUT_ALLOWED_CHANNELS.includes('media:relay'));

  for (const channel of OUTPUT_ALLOWED_CHANNELS) {
    assert.ok(
      channel === 'wireless:signal' ||
        channel === 'media:relay' ||
        channel === 'live:getState' ||
        channel === 'themes:list' ||
        channel === 'camera:profiles',
      `unexpected channel in the audience allow-list: ${channel}`,
    );
  }
});

test('the confidence monitor cannot touch cameras at all', async () => {
  const h = await harness();
  try {
    for (const channel of ['wireless:status', 'wireless:start', 'camera:sources', 'camera:assign', 'wireless:signal'] as const) {
      assert.equal(isChannelAllowedForRole(channel, 'confidence'), false, channel);
    }
    expectFailure(await h.call('wireless:status', undefined, 'confidence'), 'ipc/forbidden-for-role');
  } finally {
    await h.cleanup();
  }
});

// ── malformed input ─────────────────────────────────────────────────────────────

test('MALFORMED SESSION IDS ARE REJECTED BEFORE REACHING THE SERVICE', async () => {
  const h = await harness();
  try {
    for (const sessionId of [
      '../../etc/passwd',
      'ABC',
      'abc234',
      'ABC2345',
      '000000',
      "ABC'--",
      '',
    ]) {
      expectFailure(await h.call('wireless:disconnect', { sessionId }), 'ipc/invalid-payload');
      expectFailure(await h.call('wireless:cancelSession', { sessionId }), 'ipc/invalid-payload');
    }
  } finally {
    await h.cleanup();
  }
});

test('an empty or oversized camera label is rejected', async () => {
  const h = await harness();
  try {
    expectFailure(await h.call('wireless:createSession', { label: '' }), 'ipc/invalid-payload');
    expectFailure(await h.call('wireless:createSession', { label: 'x'.repeat(200) }), 'ipc/invalid-payload');
    expectFailure(await h.call('wireless:createSession', {}), 'ipc/invalid-payload');
  } finally {
    await h.cleanup();
  }
});

test('an unknown camera assignment is rejected', async () => {
  const h = await harness();
  try {
    expectFailure(await h.call('camera:assign', { id: 'phone:ABC234', assignment: 'broadcast' }), 'ipc/invalid-payload');
    expectFailure(await h.call('camera:assign', { id: '', assignment: 'live' }), 'ipc/invalid-payload');
  } finally {
    await h.cleanup();
  }
});

test('the media relay only accepts our two real window roles', async () => {
  const h = await harness();
  try {
    expectFailure(await h.call('media:relay', { to: 'attacker', message: {} }), 'ipc/invalid-payload');
    expectFailure(await h.call('media:relay', { to: 'confidence', message: {} }), 'ipc/invalid-payload');
    unwrap(await h.call('media:relay', { to: 'output', message: { loopback: 'end', id: 'x' } }));
    assert.equal(h.relayed.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('AN INVALID SIGNALLING MESSAGE IS REJECTED, NOT HANDED TO A PEER CONNECTION', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');

    for (const message of [
      { kind: 'answer', sdp: 'not sdp' },
      { kind: 'offer' },
      { kind: 'state', state: 'teleporting' },
      { kind: 'nonsense' },
      'a string',
      null,
    ]) {
      const result = await h.call('wireless:signal', { sessionId: ticket.sessionId, message });
      expectFailure(result, 'wireless/invalid-signal');
    }
  } finally {
    await h.cleanup();
  }
});

// ── behaviour through IPC ───────────────────────────────────────────────────────

test('the full pairing lifecycle works over IPC', async () => {
  const h = await harness();
  try {
    const started = unwrap<{ running: boolean }>(await h.call('wireless:start'));
    assert.equal(started.running, true);

    const ticket = unwrap<{ sessionId: string; pairingUrl: string; pin: string }>(
      await h.call('wireless:createSession', { label: 'Pastor Phone' }),
    );
    assert.match(ticket.pin, /^\d{6}$/);
    assert.ok(!ticket.pairingUrl.includes(ticket.pin), 'the PIN must never reach the QR payload');

    const status = unwrap<{ phones: { sessionId: string; state: string }[] }>(await h.call('wireless:status'));
    assert.equal(status.phones[0]?.state, 'pairing');

    const cancelled = unwrap<{ phones: unknown[] }>(
      await h.call('wireless:cancelSession', { sessionId: ticket.sessionId }),
    );
    assert.equal(cancelled.phones.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('CAMERA SOURCES CARRY NO MEDIASTREAM — the payload is JSON-safe', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Pastor Phone');
    h.service.notifyClaim(ticket.sessionId, true);
    h.service.markTrackReceived(ticket.sessionId);

    const sources = unwrap<Record<string, unknown>[]>(await h.call('camera:sources'));
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.['kind'], 'wireless');
    assert.equal(sources[0]?.['name'], 'Pastor Phone');
    assert.equal(sources[0]?.['status'], 'connected');

    // The decisive check: everything crossing IPC must survive serialisation. A MediaStream
    // would not, so its absence is what keeps runtime media inside its owning renderer.
    assert.ok(!('stream' in (sources[0] ?? {})), 'a CameraSource must never carry a stream');
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(sources)));
    assert.deepEqual(JSON.parse(JSON.stringify(sources)), sources);
  } finally {
    await h.cleanup();
  }
});

test('camera assignment goes through the tested switching rules', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const first = h.service.createSession('Phone 1');
    const second = h.service.createSession('Phone 2');
    for (const ticket of [first, second]) {
      h.service.notifyClaim(ticket.sessionId, true);
      h.service.markTrackReceived(ticket.sessionId);
    }

    unwrap(await h.call('camera:assign', { id: `phone:${first.sessionId}`, assignment: 'live' }));
    const sources = unwrap<{ id: string; assignment: string }[]>(
      await h.call('camera:assign', { id: `phone:${second.sessionId}`, assignment: 'live' }),
    );

    assert.equal(sources.filter((source) => source.assignment === 'live').length, 1);
    // The demoted camera goes to preview so the operator can cut straight back.
    assert.equal(sources.find((source) => source.id === `phone:${first.sessionId}`)?.assignment, 'preview');
  } finally {
    await h.cleanup();
  }
});

test('a camera with no stream cannot be put live through IPC either', async () => {
  const h = await harness();
  try {
    await h.service.start();
    const ticket = h.service.createSession('Phone');
    // Still pairing: no track has arrived.
    const sources = unwrap<{ assignment: string }[]>(
      await h.call('camera:assign', { id: `phone:${ticket.sessionId}`, assignment: 'live' }),
    );
    assert.equal(sources.filter((source) => source.assignment === 'live').length, 0);
  } finally {
    await h.cleanup();
  }
});

test('wireless channels fail cleanly when the service is absent', async () => {
  // The service needs the app data path, so it is constructed after the database. Anything that
  // arrives before it exists must report a real explanation rather than crashing.
  const db = openDatabase({ path: ':memory:' });
  const handlers = createHandlers({
    db,
    live: createLiveStateService(),
    appInfo: () => APP_INFO,
    quit: () => undefined,
  });
  try {
    const result = await dispatch('wireless:status', undefined, 'operator', { handlers });
    expectFailure(result, 'wireless/unavailable');
  } finally {
    db.close();
  }
});
