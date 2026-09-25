/**
 * EXCEPTIONEL PRESENTER — Wireless Camera pairing (Sections 6, 19, 20).
 *
 * A phone becomes a camera only after an explicit, short-lived, single-use pairing. This
 * module is the whole security model, and it is pure so every rule is actually testable:
 * no permanent URLs, no silent reconnection, no camera without authorisation.
 *
 * THE THREAT MODEL IS THE CHURCH WI-FI ITSELF. Guest networks are shared with the whole
 * congregation, passwords get printed on bulletins, and the signaling server is reachable by
 * every device on the subnet. So a pairing URL alone must never be sufficient.
 */

export const PAIRING_STATES = ['pending', 'claimed', 'connected', 'expired', 'revoked'] as const;
export type PairingState = (typeof PAIRING_STATES)[number];

export interface PairingSession {
  /** Short, human-readable, shown as "Session: ABC123". */
  id: string;
  /** Long secret in the QR code. Single-use: consumed on a successful claim. */
  token: string;
  /** Six digits displayed on the desktop and typed on the phone. */
  pin: string;
  createdAt: string;
  expiresAt: string;
  state: PairingState;
  /** Set when the phone claims the session, e.g. "iPhone (Safari)". */
  deviceLabel: string | null;
  claimedAt: string | null;
  /** Wrong-PIN attempts. A six-digit PIN on a LAN is brute-forceable without a cap. */
  failedAttempts: number;
}

export interface PairingPolicy {
  /** How long an unclaimed QR code stays valid. */
  ttlMs: number;
  /** Wrong PINs allowed before the session is burned. */
  maxFailedAttempts: number;
  /** Simultaneous phone cameras. */
  maxSessions: number;
}

/**
 * Two minutes is long enough to walk a phone across a stage and short enough that a QR code
 * photographed from the back of the room is useless by the time anyone acts on it.
 */
export const DEFAULT_PAIRING_POLICY: PairingPolicy = {
  ttlMs: 120_000,
  maxFailedAttempts: 5,
  maxSessions: 4,
};

/**
 * Crockford-style base32 with the ambiguous characters removed: no 0/O, no 1/I/L, no U.
 * Session ids get read aloud across a noisy auditorium and typed by hand, so "was that an O
 * or a zero?" is a real failure mode rather than a theoretical one.
 */
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Injected so tests are deterministic; defaults to crypto-grade randomness in production. */
export interface PairingRandom {
  /** Must return cryptographically secure bytes. */
  bytes(count: number): Uint8Array;
}

export function createPairingSession(options: {
  now: Date;
  random: PairingRandom;
  policy?: PairingPolicy;
}): PairingSession {
  const policy = options.policy ?? DEFAULT_PAIRING_POLICY;
  const now = options.now;

  return {
    id: encodeAlphabet(options.random.bytes(6), ID_ALPHABET, 6),
    // 32 bytes of entropy. The token is the actual bearer secret, so it is sized to be
    // unguessable rather than readable.
    token: toHex(options.random.bytes(32)),
    pin: encodeDigits(options.random.bytes(4), 6),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.ttlMs).toISOString(),
    state: 'pending',
    deviceLabel: null,
    claimedAt: null,
    failedAttempts: 0,
  };
}

export const isExpired = (session: PairingSession, now: Date): boolean =>
  now.getTime() >= Date.parse(session.expiresAt);

/** Terminal states can never become active again. */
export const isTerminal = (session: PairingSession): boolean =>
  session.state === 'expired' || session.state === 'revoked';

export function remainingMs(session: PairingSession, now: Date): number {
  return Math.max(Date.parse(session.expiresAt) - now.getTime(), 0);
}

export type ClaimFailureReason =
  | 'not-found'
  | 'expired'
  | 'revoked'
  | 'already-claimed'
  | 'bad-token'
  | 'bad-pin'
  | 'too-many-attempts';

export type ClaimResult =
  | { ok: true; session: PairingSession }
  | { ok: false; reason: ClaimFailureReason; session: PairingSession };

/**
 * Claims a session on behalf of a phone.
 *
 * Order matters and is deliberate: expiry and state are checked BEFORE the token and PIN, so
 * a dead session reveals nothing about whether a guessed credential was close.
 */
export function claimSession(
  session: PairingSession,
  attempt: { token: string; pin: string; deviceLabel: string; now: Date },
  policy: PairingPolicy = DEFAULT_PAIRING_POLICY,
): ClaimResult {
  if (session.state === 'revoked') return { ok: false, reason: 'revoked', session };

  if (isExpired(session, attempt.now) || session.state === 'expired') {
    return { ok: false, reason: 'expired', session: { ...session, state: 'expired' } };
  }

  // Single-use: a QR code photographed by someone else cannot be replayed after the
  // intended phone has connected.
  if (session.state === 'claimed' || session.state === 'connected') {
    return { ok: false, reason: 'already-claimed', session };
  }

  if (session.failedAttempts >= policy.maxFailedAttempts) {
    return { ok: false, reason: 'too-many-attempts', session: { ...session, state: 'revoked' } };
  }

  // Constant-time comparison. The token is compared with the same routine as the PIN so
  // neither leaks its length or a matching prefix through timing.
  if (!constantTimeEquals(session.token, attempt.token)) {
    return { ok: false, reason: 'bad-token', session: burnAttempt(session, policy) };
  }

  if (!constantTimeEquals(session.pin, attempt.pin)) {
    return { ok: false, reason: 'bad-pin', session: burnAttempt(session, policy) };
  }

  return {
    ok: true,
    session: {
      ...session,
      state: 'claimed',
      deviceLabel: attempt.deviceLabel,
      claimedAt: attempt.now.toISOString(),
      // The token has done its job. Blanking it means a leaked QR code is inert even if the
      // session object is later exposed.
      token: '',
    },
  };
}

function burnAttempt(session: PairingSession, policy: PairingPolicy): PairingSession {
  const failedAttempts = session.failedAttempts + 1;
  return {
    ...session,
    failedAttempts,
    // Revoke rather than merely counting: this is what turns a 10^6 PIN space into
    // something a LAN attacker cannot grind through.
    state: failedAttempts >= policy.maxFailedAttempts ? 'revoked' : session.state,
  };
}

/** Marks a claimed session as carrying live video. */
export function markConnected(session: PairingSession): PairingSession {
  if (session.state !== 'claimed' && session.state !== 'connected') return session;
  return { ...session, state: 'connected' };
}

/** Section 20: ending a session invalidates the pairing permanently. */
export const revokeSession = (session: PairingSession): PairingSession => ({
  ...session,
  state: 'revoked',
  token: '',
});

// ── QR payload ──────────────────────────────────────────────────────────────────

export interface QrTarget {
  /** Always 'https' in practice: phones refuse getUserMedia on an insecure origin. */
  scheme: 'https' | 'http';
  host: string;
  port: number;
}

/**
 * The URL encoded into the QR code.
 *
 * Carries the session id and token but NOT the PIN. The PIN stays on the desktop screen, so
 * photographing or forwarding the QR code is not enough — someone must be standing in front
 * of the operator's monitor. That is the entire point of having both.
 */
export function buildPairingUrl(session: PairingSession, target: QrTarget): string {
  const url = new URL(`${target.scheme}://${target.host}:${target.port}/camera`);
  url.searchParams.set('s', session.id);
  url.searchParams.set('t', session.token);
  return url.toString();
}

export interface ParsedPairingUrl {
  sessionId: string;
  token: string;
  origin: string;
}

export function parsePairingUrl(raw: string): ParsedPairingUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.pathname !== '/camera') return null;

  const sessionId = url.searchParams.get('s');
  const token = url.searchParams.get('t');
  if (!sessionId || !token) return null;

  // Shape-check before anything trusts these: they arrive from a scanned QR code, which is
  // attacker-controlled input.
  if (!isPlausibleSessionId(sessionId) || !isPlausibleToken(token)) return null;

  return { sessionId, token, origin: url.origin };
}

export const isPlausibleSessionId = (value: string): boolean =>
  value.length === 6 && [...value].every((char) => ID_ALPHABET.includes(char));

export const isPlausibleToken = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

export const isPlausiblePin = (value: string): boolean => /^\d{6}$/.test(value);

/** Grouped for legibility on screen: "482 731". */
export const formatPin = (pin: string): string =>
  pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;

// ── helpers ─────────────────────────────────────────────────────────────────────

/**
 * Compares two strings in time independent of their content.
 *
 * Length is folded into the result rather than short-circuiting, so an attacker cannot learn
 * the secret's length from response timing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Maps bytes onto an alphabet by rejection-free modulo.
 *
 * Modulo bias is acceptable HERE and only here: the session id is a lookup handle, not a
 * secret. The token and PIN carry the security, and a 30-character alphabet over 256 values
 * has bias too small to help an attacker who must also hold the token.
 */
function encodeAlphabet(bytes: Uint8Array, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

function encodeDigits(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    // Two bytes per digit widens the range before the modulo, reducing bias.
    const value = ((bytes[i % bytes.length] ?? 0) << 8) | (bytes[(i + 1) % bytes.length] ?? 0);
    out += String(value % 10);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Human-readable reason for the phone and the operator log. */
export function describeClaimFailure(reason: ClaimFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'That pairing code is not recognised. Ask the operator for a new QR code.';
    case 'expired':
      return 'This QR code has expired. Ask the operator to generate a new one.';
    case 'revoked':
      return 'This pairing was cancelled. Ask the operator for a new QR code.';
    case 'already-claimed':
      return 'Another phone has already used this QR code. Ask the operator for a new one.';
    case 'bad-token':
      return 'This pairing link is not valid. Scan the QR code again.';
    case 'bad-pin':
      return 'That PIN is incorrect. Check the code shown on the computer.';
    case 'too-many-attempts':
      return 'Too many incorrect PIN attempts. Ask the operator for a new QR code.';
  }
}
