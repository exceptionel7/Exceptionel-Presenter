import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAIRING_POLICY,
  buildPairingUrl,
  claimSession,
  constantTimeEquals,
  createPairingSession,
  describeClaimFailure,
  formatPin,
  isExpired,
  isPlausiblePin,
  isPlausibleSessionId,
  isPlausibleToken,
  markConnected,
  parsePairingUrl,
  remainingMs,
  revokeSession,
  type PairingRandom,
  type PairingSession,
} from '../src/shared/domain/pairing.ts';

/** Deterministic randomness so ids, tokens and PINs are reproducible in tests. */
const seededRandom = (seed = 1): PairingRandom => {
  let state = seed;
  return {
    bytes(count) {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        // xorshift — deterministic, adequate for fixtures.
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        out[i] = Math.abs(state) % 256;
      }
      return out;
    },
  };
};

const T0 = new Date('2026-09-27T10:00:00.000Z');
const at = (msAfter: number): Date => new Date(T0.getTime() + msAfter);

const session = (seed = 1): PairingSession =>
  createPairingSession({ now: T0, random: seededRandom(seed) });

const goodAttempt = (s: PairingSession, overrides: Partial<{ token: string; pin: string; now: Date }> = {}) => ({
  token: overrides.token ?? s.token,
  pin: overrides.pin ?? s.pin,
  deviceLabel: 'iPhone (Safari)',
  now: overrides.now ?? at(1_000),
});

// ── session creation ────────────────────────────────────────────────────────────

test('a new session is pending, with an id, token and PIN of the right shape', () => {
  const s = session();
  assert.equal(s.state, 'pending');
  assert.ok(isPlausibleSessionId(s.id), `bad id: ${s.id}`);
  assert.ok(isPlausibleToken(s.token), `bad token: ${s.token}`);
  assert.ok(isPlausiblePin(s.pin), `bad pin: ${s.pin}`);
  assert.equal(s.failedAttempts, 0);
  assert.equal(s.deviceLabel, null);
});

test('session ids avoid characters that are misread when spoken or typed', () => {
  // "Session ABC123" gets read across a noisy auditorium; 0/O and 1/I/L are a real problem.
  for (let seed = 1; seed < 60; seed++) {
    const id = session(seed).id;
    assert.doesNotMatch(id, /[01OILU]/, `ambiguous character in ${id}`);
  }
});

test('the token carries real entropy — 32 bytes, not a short code', () => {
  assert.equal(session().token.length, 64, '64 hex characters = 32 bytes');
});

test('different sessions get different credentials', () => {
  const a = session(1);
  const b = session(999);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.token, b.token);
});

test('expiry is short by default and counts down', () => {
  const s = session();
  assert.equal(DEFAULT_PAIRING_POLICY.ttlMs, 120_000, 'two minutes');
  assert.equal(isExpired(s, T0), false);
  assert.equal(remainingMs(s, at(30_000)), 90_000);
  assert.equal(isExpired(s, at(119_999)), false);
  assert.equal(isExpired(s, at(120_000)), true, 'expiry is inclusive');
  assert.equal(remainingMs(s, at(500_000)), 0, 'never negative');
});

// ── claiming ────────────────────────────────────────────────────────────────────

test('a correct token and PIN claims the session', () => {
  const s = session();
  const result = claimSession(s, goodAttempt(s));
  assert.equal(result.ok, true);
  assert.equal(result.session.state, 'claimed');
  assert.equal(result.session.deviceLabel, 'iPhone (Safari)');
  assert.ok(result.session.claimedAt);
});

test('THE TOKEN IS BLANKED ON CLAIM, so a leaked QR code becomes inert', () => {
  const s = session();
  const result = claimSession(s, goodAttempt(s));
  assert.equal(result.ok, true);
  assert.equal(result.session.token, '');
});

test('SINGLE USE — a second phone cannot replay the same QR code', () => {
  const s = session();
  const first = claimSession(s, goodAttempt(s));
  assert.equal(first.ok, true);

  // Someone photographed the operator's screen and tries the same link.
  const second = claimSession(first.session, { ...goodAttempt(s), deviceLabel: 'Attacker' });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, 'already-claimed');
  assert.equal(second.session.deviceLabel, 'iPhone (Safari)', 'the original phone keeps the session');
});

test('an expired session cannot be claimed even with correct credentials', () => {
  const s = session();
  const result = claimSession(s, goodAttempt(s, { now: at(120_001) }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'expired');
  assert.equal(result.session.state, 'expired');
});

test('a wrong token is rejected and counted', () => {
  const s = session();
  const result = claimSession(s, goodAttempt(s, { token: 'f'.repeat(64) }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-token');
  assert.equal(result.session.failedAttempts, 1);
  assert.equal(result.session.state, 'pending', 'still usable by the real phone');
});

test('a wrong PIN is rejected and counted', () => {
  const s = session();
  const wrong = s.pin === '000000' ? '111111' : '000000';
  const result = claimSession(s, goodAttempt(s, { pin: wrong }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad-pin');
  assert.equal(result.session.failedAttempts, 1);
});

test('PIN BRUTE FORCE IS CAPPED — this is what makes 6 digits safe on a shared LAN', () => {
  // 10^6 combinations is nothing over Wi-Fi without a cap.
  let current = session();
  const wrong = current.pin === '000000' ? '111111' : '000000';

  for (let attempt = 1; attempt <= DEFAULT_PAIRING_POLICY.maxFailedAttempts; attempt++) {
    const result = claimSession(current, goodAttempt(current, { pin: wrong }));
    assert.equal(result.ok, false);
    current = result.session;
  }

  assert.equal(current.state, 'revoked', 'the session burns rather than allowing more guesses');

  // Even the CORRECT PIN is now useless — the operator must issue a new QR code.
  const original = session();
  const afterLockout = claimSession(current, goodAttempt(original, { pin: original.pin }));
  assert.equal(afterLockout.ok, false);
  assert.equal(afterLockout.ok === false && afterLockout.reason, 'revoked');
});

test('a revoked session stays dead', () => {
  const s = revokeSession(session());
  assert.equal(s.token, '', 'revoking also destroys the token');
  const result = claimSession(s, goodAttempt(session()));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'revoked');
});

test('expiry is reported before credential errors, so a dead session leaks nothing', () => {
  // A wrong token on an expired session must report 'expired', not 'bad-token' — otherwise
  // the response tells an attacker whether their guess was structurally right.
  const s = session();
  const result = claimSession(s, goodAttempt(s, { token: 'a'.repeat(64), now: at(200_000) }));
  assert.equal(result.ok === false && result.reason, 'expired');
});

test('markConnected only promotes a claimed session', () => {
  const s = session();
  assert.equal(markConnected(s).state, 'pending', 'an unclaimed session cannot go live');

  const claimed = claimSession(s, goodAttempt(s));
  assert.equal(claimed.ok, true);
  assert.equal(markConnected(claimed.session).state, 'connected');

  assert.equal(markConnected(revokeSession(s)).state, 'revoked', 'revoked stays revoked');
});

test('every failure reason has operator-usable copy', () => {
  for (const reason of [
    'not-found',
    'expired',
    'revoked',
    'already-claimed',
    'bad-token',
    'bad-pin',
    'too-many-attempts',
  ] as const) {
    const text = describeClaimFailure(reason);
    assert.ok(text.length > 20, `${reason} needs a real explanation`);
    assert.doesNotMatch(text, /token|null|undefined/i, `${reason} must not leak internals`);
  }
});

// ── QR payload ──────────────────────────────────────────────────────────────────

const target = { scheme: 'https', host: '192.168.1.100', port: 8443 } as const;

test('the pairing URL round-trips', () => {
  const s = session();
  const url = buildPairingUrl(s, target);
  const parsed = parsePairingUrl(url);
  assert.ok(parsed);
  assert.equal(parsed?.sessionId, s.id);
  assert.equal(parsed?.token, s.token);
  assert.equal(parsed?.origin, 'https://192.168.1.100:8443');
});

test('THE QR CODE DOES NOT CONTAIN THE PIN', () => {
  // This is the point of having both factors: photographing the QR code is not enough,
  // because the PIN only exists on the operator's monitor.
  const s = session();
  const url = buildPairingUrl(s, target);
  assert.ok(!url.includes(s.pin), 'the PIN must never travel in the QR code');
});

test('a pairing URL is never permanent — it names one expiring session', () => {
  const a = buildPairingUrl(session(1), target);
  const b = buildPairingUrl(session(2), target);
  assert.notEqual(a, b, 'each pairing gets a fresh URL');
});

test('malformed and hostile URLs are refused', () => {
  const s = session();
  for (const bad of [
    'not a url',
    '',
    'javascript:alert(1)',
    'file:///etc/passwd',
    `https://192.168.1.100:8443/camera`, // no params
    `https://192.168.1.100:8443/camera?s=${s.id}`, // no token
    `https://192.168.1.100:8443/camera?t=${s.token}`, // no session
    `https://192.168.1.100:8443/other?s=${s.id}&t=${s.token}`, // wrong path
    `https://192.168.1.100:8443/camera?s=ABC&t=${s.token}`, // short id
    `https://192.168.1.100:8443/camera?s=${s.id}&t=abc`, // short token
    `https://192.168.1.100:8443/camera?s=000000&t=${s.token}`, // ambiguous chars not in alphabet
    `https://192.168.1.100:8443/camera?s=${s.id}&t=${'z'.repeat(64)}`, // non-hex token
  ]) {
    assert.equal(parsePairingUrl(bad), null, `must reject: ${bad}`);
  }
});

test('shape validators reject the obvious attacks', () => {
  assert.equal(isPlausibleSessionId("ABC12'"), false);
  assert.equal(isPlausibleSessionId('ABC12'), false, 'wrong length');
  assert.equal(isPlausibleToken('../../etc/passwd'), false);
  assert.equal(isPlausibleToken('A'.repeat(64)), false, 'uppercase is not lowercase hex');
  assert.equal(isPlausiblePin('12345'), false);
  assert.equal(isPlausiblePin('12345a'), false);
  assert.equal(isPlausiblePin('482731'), true);
});

// ── constant-time comparison ────────────────────────────────────────────────────

test('constantTimeEquals is correct', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abd'), false);
  assert.equal(constantTimeEquals('', ''), true);
  assert.equal(constantTimeEquals('abc', ''), false);
  assert.equal(constantTimeEquals('abc', 'abcd'), false, 'a prefix must not match');
  assert.equal(constantTimeEquals('abcd', 'abc'), false);
});

test('comparison does not short-circuit on the first differing character', () => {
  // A mismatch at position 0 and at the last position must both compare the full width.
  // Verified structurally rather than by timing, which is unreliable in CI.
  const source = constantTimeEquals.toString();
  assert.doesNotMatch(source, /return\s+false/, 'no early return may exist in the loop');
  assert.match(source, /\|=/, 'differences must be accumulated, not branched on');
});

// ── presentation helpers ────────────────────────────────────────────────────────

test('the PIN is grouped for legibility on screen', () => {
  assert.equal(formatPin('482731'), '482 731');
  assert.equal(formatPin('123'), '123', 'unexpected lengths pass through unchanged');
});
