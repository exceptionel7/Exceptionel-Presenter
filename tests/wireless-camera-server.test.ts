import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSelfSignedCertificate } from '../src/main/services/certificate.ts';
import { createPairingRegistry } from '../src/main/services/pairing-registry.ts';
import { createWirelessCameraServer } from '../src/main/services/wireless-camera-server.ts';
import type { PeerState, SignalMessage } from '../src/shared/domain/signaling.ts';

/**
 * Every test here runs against a REAL HTTPS server over a real socket with a real TLS
 * handshake. Nothing is mocked. This is the only way to know the signaling actually works
 * before a phone is involved.
 */
interface Harness {
  base: string;
  registry: ReturnType<typeof createPairingRegistry>;
  server: ReturnType<typeof createWirelessCameraServer>;
  phoneMessages: { sessionId: string; message: SignalMessage }[];
  phoneStates: { sessionId: string; state: PeerState }[];
  stop: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const material = generateSelfSignedCertificate({ ipAddresses: ['127.0.0.1'], hostnames: ['localhost'] });
  const registry = createPairingRegistry();
  const phoneMessages: Harness['phoneMessages'] = [];
  const phoneStates: Harness['phoneStates'] = [];

  const server = createWirelessCameraServer({
    registry,
    certificatePem: material.certificatePem,
    privateKeyPem: material.privateKeyPem,
    host: '127.0.0.1',
    port: 0,
    onPhoneMessage: (sessionId, message) => phoneMessages.push({ sessionId, message }),
    onPhoneState: (sessionId, state) => phoneStates.push({ sessionId, state }),
  });

  const { port } = await server.start();

  return {
    base: `https://127.0.0.1:${port}`,
    registry,
    server,
    phoneMessages,
    phoneStates,
    stop: () => server.stop(),
  };
}

/** The certificate is self-signed, exactly as the phone sees it. */
function withTls<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  return fn().finally(() => {
    if (previous === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
  });
}

const claim = (
  base: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown>; cookie: string }> =>
  fetch(`${base}/pair/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => ({
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
    cookie: response.headers.get('set-cookie') ?? '',
  }));

// ── serving the phone page ──────────────────────────────────────────────────────

test('THE PHONE PAGE IS SERVED OVER REAL HTTPS', async () => {
  const h = await harness();
  try {
    await withTls(async () => {
      const response = await fetch(`${h.base}/camera`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);

      const html = await response.text();
      assert.match(html, /WIRELESS CAMERA/);
      assert.match(html, /id="start"/, 'START CAMERA button');
      assert.match(html, /id="switch"/, 'SWITCH CAMERA button');
      assert.match(html, /id="stop"/, 'STOP CAMERA button');
      assert.match(html, /id="preview"/, 'video element');
      assert.match(html, /playsinline/, 'iOS requires playsinline or video goes fullscreen');
      assert.match(html, /camera\.js/);
    });
  } finally {
    await h.stop();
  }
});

test('the page assets are served with correct content types', async () => {
  const h = await harness();
  try {
    await withTls(async () => {
      const js = await fetch(`${h.base}/camera.js`);
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type') ?? '', /javascript/);
      const source = await js.text();
      assert.match(source, /getUserMedia/, 'the page must use the real camera API');
      assert.match(source, /RTCPeerConnection/, 'and real WebRTC');
      assert.match(source, /facingMode/, 'front/rear switching');

      const css = await fetch(`${h.base}/camera.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    });
  } finally {
    await h.stop();
  }
});

test('the phone page CSP forbids outbound connections beyond this origin', async () => {
  const h = await harness();
  try {
    await withTls(async () => {
      const csp = (await fetch(`${h.base}/camera`)).headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /connect-src 'self'/, 'the page must not be able to call out anywhere else');
      assert.match(csp, /media-src [^;]*mediastream:/, 'but it does need the camera stream');
      assert.doesNotMatch(csp, /unsafe-inline/, 'no inline script on the phone page');
    });
  } finally {
    await h.stop();
  }
});

test('security headers are present and unknown paths 404', async () => {
  const h = await harness();
  try {
    await withTls(async () => {
      const response = await fetch(`${h.base}/camera`);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      // No CORS: nothing but our own page should be able to use this server.
      assert.equal(response.headers.get('access-control-allow-origin'), null);

      assert.equal((await fetch(`${h.base}/nope`)).status, 404);
      assert.equal((await fetch(`${h.base}/../etc/passwd`)).status, 404);
    });
  } finally {
    await h.stop();
  }
});

// ── pairing over HTTP ───────────────────────────────────────────────────────────

test('A CORRECT TOKEN AND PIN PAIRS AND RECEIVES AN HttpOnly COOKIE', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Pastor Phone');
    await withTls(async () => {
      const result = await claim(h.base, {
        sessionId: session.pairing.id,
        token: session.pairing.token,
        pin: session.pairing.pin,
        deviceLabel: 'iPhone (Safari)',
      });

      assert.equal(result.status, 200);
      assert.equal(result.json['ok'], true);

      // The connection token must never be readable by page script.
      assert.match(result.cookie, /^ep_camera=/);
      assert.match(result.cookie, /HttpOnly/);
      assert.match(result.cookie, /Secure/);
      assert.match(result.cookie, /SameSite=Strict/);

      // And it must not be echoed in the response body either.
      assert.equal(result.json['connectionToken'], undefined);
    });
  } finally {
    await h.stop();
  }
});

test('a WRONG PIN is refused over HTTP', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    await withTls(async () => {
      const result = await claim(h.base, {
        sessionId: session.pairing.id,
        token: session.pairing.token,
        pin: session.pairing.pin === '000000' ? '111111' : '000000',
        deviceLabel: 'Attacker',
      });
      assert.equal(result.status, 401);
      assert.match(String(result.json['error']), /PIN is incorrect/i);
    });
  } finally {
    await h.stop();
  }
});

test('AN UNKNOWN SESSION ID IS INDISTINGUISHABLE FROM A WRONG PIN', async () => {
  // Otherwise the response enumerates which session ids exist.
  const h = await harness();
  try {
    await withTls(async () => {
      const result = await claim(h.base, {
        sessionId: 'ZZZZZZ',
        token: 'a'.repeat(64),
        pin: '123456',
        deviceLabel: 'Probe',
      });
      assert.equal(result.status, 401, 'same status as a bad credential');
    });
  } finally {
    await h.stop();
  }
});

test('malformed pairing payloads are rejected before reaching the registry', async () => {
  const h = await harness();
  try {
    await withTls(async () => {
      for (const body of [
        { sessionId: '../../etc', token: 'a'.repeat(64), pin: '123456' },
        { sessionId: 'ABC123', token: 'not-hex', pin: '123456' },
        { sessionId: 'ABC123', token: 'a'.repeat(64), pin: '12345' },
        { sessionId: 'ABC123', token: 'a'.repeat(64), pin: 'abcdef' },
        {},
      ]) {
        const result = await claim(h.base, body);
        assert.equal(result.status, 400, JSON.stringify(body));
      }

      const invalidJson = await fetch(`${h.base}/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(invalidJson.status, 400);
    });
  } finally {
    await h.stop();
  }
});

test('PIN LOCKOUT IS ENFORCED THROUGH THE HTTP LAYER', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    const wrong = session.pairing.pin === '000000' ? '111111' : '000000';

    await withTls(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await claim(h.base, {
          sessionId: session.pairing.id,
          token: session.pairing.token,
          pin: wrong,
          deviceLabel: 'Attacker',
        });
        assert.equal(result.status, 401);
      }

      // The correct PIN is now useless — the session burned.
      const afterLockout = await claim(h.base, {
        sessionId: session.pairing.id,
        token: session.pairing.token,
        pin: session.pairing.pin,
        deviceLabel: 'Real Phone',
      });
      assert.equal(afterLockout.status, 401);
      assert.equal(afterLockout.json['reason'], 'revoked');
    });
  } finally {
    await h.stop();
  }
});

test('a pairing token cannot be replayed by a second phone', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    const credentials = {
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
    };

    await withTls(async () => {
      const first = await claim(h.base, { ...credentials, deviceLabel: 'Real Phone' });
      assert.equal(first.status, 200);

      const second = await claim(h.base, { ...credentials, deviceLabel: 'Attacker' });
      assert.equal(second.status, 401);
      assert.equal(second.json['reason'], 'already-claimed');
    });
  } finally {
    await h.stop();
  }
});

// ── signaling requires authentication ───────────────────────────────────────────

test('AN UNAUTHENTICATED PHONE CANNOT REACH SIGNALING', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    await withTls(async () => {
      // No cookie, no bearer.
      assert.equal((await fetch(`${h.base}/signal/stream?s=${session.pairing.id}`)).status, 401);

      const send = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'state', state: 'connected' }),
      });
      assert.equal(send.status, 401);
    });
  } finally {
    await h.stop();
  }
});

test('a forged connection token is refused', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'Phone',
    });

    await withTls(async () => {
      const response = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${'0'.repeat(64)}` },
        body: JSON.stringify({ kind: 'state', state: 'connected' }),
      });
      assert.equal(response.status, 401);
    });
  } finally {
    await h.stop();
  }
});

// ── the full signaling exchange ─────────────────────────────────────────────────

const VALID_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';

test('SDP AND ICE FLOW FROM THE PHONE TO THE DESKTOP', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Pastor Phone');
    const claimed = h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'iPhone',
    });
    assert.equal(claimed.ok, true);
    const auth = { authorization: `Bearer ${session.connectionToken}`, 'content-type': 'application/json' };

    await withTls(async () => {
      const ready = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ kind: 'ready', width: 1920, height: 1080, frameRate: 30, hasAudio: false }),
      });
      assert.equal(ready.status, 200);

      const answer = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ kind: 'answer', sdp: VALID_SDP }),
      });
      assert.equal(answer.status, 200);

      const ice = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          kind: 'ice',
          candidate: 'candidate:1 1 UDP 2130706431 192.168.1.105 54321 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        }),
      });
      assert.equal(ice.status, 200);
    });

    const kinds = h.phoneMessages.map((entry) => entry.message.kind);
    assert.deepEqual(kinds, ['ready', 'answer', 'ice'], 'the desktop received all three, in order');

    // Media facts reported by the phone reach the session, for the operator panel.
    assert.deepEqual(h.registry.get(session.pairing.id)?.media, {
      width: 1920,
      height: 1080,
      frameRate: 30,
      hasAudio: false,
    });
  } finally {
    await h.stop();
  }
});

test('a malformed SDP is refused rather than handed to a peer connection', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'Phone',
    });
    const auth = { authorization: `Bearer ${session.connectionToken}`, 'content-type': 'application/json' };

    await withTls(async () => {
      for (const body of [
        { kind: 'answer', sdp: 'this is not sdp' },
        { kind: 'answer', sdp: '' },
        { kind: 'answer' },
        { kind: 'state', state: 'teleporting' },
        { kind: 'wat' },
      ]) {
        const response = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
    });

    assert.equal(h.phoneMessages.length, 0, 'nothing invalid reached the desktop');
  } finally {
    await h.stop();
  }
});

test('an oversized SDP is rejected, so a hostile client cannot exhaust memory', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'Phone',
    });

    await withTls(async () => {
      const response = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.connectionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'answer', sdp: `v=0\r\n${'a'.repeat(200_000)}` }),
      });
      assert.ok(response.status === 400 || response.status === 413, `got ${response.status}`);
    });
  } finally {
    await h.stop();
  }
});

test('THE DESKTOP OFFER REACHES THE PHONE OVER THE SSE STREAM', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'Phone',
    });

    await withTls(async () => {
      // Queue before the stream attaches, to prove nothing is lost in the gap between
      // pairing and the phone opening its EventSource.
      h.server.sendToPhone(session.pairing.id, { kind: 'offer', sdp: VALID_SDP });

      const response = await fetch(`${h.base}/signal/stream?s=${session.pairing.id}`, {
        headers: { cookie: `ep_camera=${session.connectionToken}` },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read until the queued offer arrives.
      for (let i = 0; i < 20 && !buffer.includes('"offer"'); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      assert.match(buffer, /data: /, 'an SSE data frame was received');
      assert.match(buffer, /"kind":"offer"/);
      assert.match(buffer, /v=0/, 'the SDP survived framing intact');

      await reader.cancel();
    });
  } finally {
    await h.stop();
  }
});

test('SDP NEWLINES SURVIVE SSE FRAMING', async () => {
  // SSE treats a bare newline as a field break, and SDP is full of them. Getting this wrong
  // truncates the handshake in a way that looks like a mysterious connection failure.
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'Phone',
    });

    await withTls(async () => {
      h.server.sendToPhone(session.pairing.id, { kind: 'offer', sdp: VALID_SDP });
      const response = await fetch(`${h.base}/signal/stream?s=${session.pairing.id}`, {
        headers: { cookie: `ep_camera=${session.connectionToken}` },
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (let i = 0; i < 20 && !buffer.includes('"offer"'); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }

      const line = buffer.split('\n').find((candidate) => candidate.startsWith('data: '));
      assert.ok(line, 'a single-line data frame');
      const parsed = JSON.parse(line!.slice(6)) as { sdp: string };
      assert.equal(parsed.sdp, VALID_SDP, 'the SDP round-tripped byte for byte');

      await reader.cancel();
    });
  } finally {
    await h.stop();
  }
});

// ── lifecycle ───────────────────────────────────────────────────────────────────

test('a phone reporting connected updates the session state', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'Phone',
    });

    await withTls(async () => {
      await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.connectionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'state', state: 'connected' }),
      });
    });

    assert.equal(h.registry.get(session.pairing.id)?.lifecycle.state, 'connected');
    assert.deepEqual(h.phoneStates.at(-1), { sessionId: session.pairing.id, state: 'connected' });
  } finally {
    await h.stop();
  }
});

test('A "bye" FROM THE PHONE REVOKES THE SESSION IMMEDIATELY', async () => {
  const h = await harness();
  try {
    const session = h.registry.create('Phone');
    h.registry.claim({
      sessionId: session.pairing.id,
      token: session.pairing.token,
      pin: session.pairing.pin,
      deviceLabel: 'Phone',
    });
    const token = session.connectionToken;

    await withTls(async () => {
      await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'bye', reason: 'Stopped on phone' }),
      });

      // Section 17: after stopping, the phone must not be able to resume.
      const afterBye = await fetch(`${h.base}/signal/send?s=${session.pairing.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'state', state: 'connected' }),
      });
      assert.equal(afterBye.status, 401, 'the token is dead the moment the session ends');
    });
  } finally {
    await h.stop();
  }
});

test('CLOSING THE SERVER TERMINATES EVERY SESSION (milestone test 12)', async () => {
  const h = await harness();
  const session = h.registry.create('Phone');
  h.registry.claim({
    sessionId: session.pairing.id,
    token: session.pairing.token,
    pin: session.pairing.pin,
    deviceLabel: 'Phone',
  });
  const token = session.connectionToken;
  const base = h.base;

  await h.stop();

  // The registry is emptied and every token invalidated.
  assert.equal(h.registry.list().length, 0);

  await withTls(async () => {
    await assert.rejects(
      () =>
        fetch(`${base}/signal/send?s=${session.pairing.id}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'state', state: 'connected' }),
        }),
      'the server must no longer be listening',
    );
  });
});

test('the health endpoint answers, for the desktop self-check', async () => {
  const h = await harness();
  try {
    await withTls(async () => {
      const response = await fetch(`${h.base}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, service: 'wireless-camera' });
    });
  } finally {
    await h.stop();
  }
});

test('the server binds only the interface it was given', async () => {
  const h = await harness();
  try {
    assert.equal(h.server.address?.host, '127.0.0.1');
  } finally {
    await h.stop();
  }
});
