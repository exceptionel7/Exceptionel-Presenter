/**
 * EXCEPTIONEL PRESENTER — live pairing sessions and their message queues.
 *
 * Holds sessions IN MEMORY, never in SQLite. A pairing is meaningful only for the lifetime of
 * the process: persisting one would mean a token surviving a restart, which Section 20
 * explicitly forbids ("when the session ends, invalidate the pairing token"). Closing the app
 * must end every camera session, and in-memory storage makes that automatic rather than
 * something cleanup code has to remember.
 */

import { randomUUID } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_PAIRING_POLICY,
  claimSession,
  createPairingSession,
  isExpired,
  markConnected,
  revokeSession,
  type ClaimFailureReason,
  type PairingPolicy,
  type PairingRandom,
  type PairingSession,
} from '../../shared/domain/pairing.ts';
import {
  advanceLifecycle,
  initialLifecycle,
  type PeerLifecycle,
  type PeerState,
  type SignalMessage,
} from '../../shared/domain/signaling.ts';

/** Crypto-grade randomness for real use; tests inject a deterministic source. */
export const cryptoRandom: PairingRandom = { bytes: (count) => new Uint8Array(randomBytes(count)) };

export interface LiveSession {
  pairing: PairingSession;
  /**
   * Bearer token for signaling requests, issued on a successful claim.
   *
   * Deliberately NOT the pairing token: that one is in the QR code and may have been
   * photographed. This one is returned once, over TLS, only to the phone that proved it knew
   * the PIN, and it never appears in a URL that could end up in a log or a history entry.
   */
  connectionToken: string;
  lifecycle: PeerLifecycle;
  /** Human label for the operator list, e.g. "Pastor Phone". */
  label: string;
  /** Messages waiting to be delivered to the phone over SSE. */
  outbound: SignalMessage[];
  /** True while an SSE stream is attached. */
  streaming: boolean;
  lastSeenAt: number;
  /** Negotiated media facts reported by the phone. */
  media: { width: number | null; height: number | null; frameRate: number | null; hasAudio: boolean };
}

export interface RegistryOptions {
  policy?: PairingPolicy;
  random?: PairingRandom;
  now?: () => number;
}

export type ClaimOutcome =
  | { ok: true; session: LiveSession }
  | { ok: false; reason: ClaimFailureReason };

export interface PairingRegistry {
  /** Opens a new pairing and returns it for display as a QR code. */
  create(label: string): LiveSession;
  get(sessionId: string): LiveSession | null;
  list(): LiveSession[];
  /** Validates token + PIN and issues a connection token. */
  claim(input: { sessionId: string; token: string; pin: string; deviceLabel: string }): ClaimOutcome;
  /** Confirms a bearer token belongs to a live, non-expired session. */
  authenticate(sessionId: string, connectionToken: string): LiveSession | null;
  enqueue(sessionId: string, message: SignalMessage): boolean;
  /** Takes and clears everything queued for the phone. */
  drain(sessionId: string): SignalMessage[];
  setStreaming(sessionId: string, streaming: boolean): void;
  recordState(sessionId: string, state: PeerState): LiveSession | null;
  recordMedia(sessionId: string, media: LiveSession['media']): void;
  touch(sessionId: string): void;
  /**
   * Ends a session and invalidates its tokens, keeping the record briefly so a connected phone
   * can still collect its `bye` over the open stream.
   */
  revoke(sessionId: string, reason: string): void;
  /**
   * Ends a session and deletes it immediately, freeing its capacity slot.
   *
   * For operator-initiated cancellation of a pairing that never connected. `revoke` alone leaves
   * the record in place for 30 seconds so a live phone can be told goodbye — which means
   * cancelling four QR codes in a row would exhaust the slots and fail with a confusing
   * "maximum reached" error.
   */
  remove(sessionId: string, reason: string): void;
  /** Drops expired, unclaimed sessions. Returns the ids removed. */
  prune(): string[];
  /** Ends every session — called on app quit (Section 20, and test 12). */
  revokeAll(reason: string): void;
  readonly capacity: number;
}

export function createPairingRegistry(options: RegistryOptions = {}): PairingRegistry {
  const policy = options.policy ?? DEFAULT_PAIRING_POLICY;
  const random = options.random ?? cryptoRandom;
  const now = options.now ?? (() => Date.now());

  const sessions = new Map<string, LiveSession>();

  const registry: PairingRegistry = {
    capacity: policy.maxSessions,

    create(label) {
      // Make room by discarding dead sessions before refusing on capacity, so a series of
      // abandoned QR codes cannot permanently block a legitimate pairing.
      registry.prune();

      if (sessions.size >= policy.maxSessions) {
        throw new Error(
          `Maximum of ${policy.maxSessions} phone cameras reached. Disconnect one before adding another.`,
        );
      }

      const pairing = createPairingSession({ now: new Date(now()), random, policy });
      const session: LiveSession = {
        pairing,
        connectionToken: '',
        lifecycle: initialLifecycle(now()),
        label,
        outbound: [],
        streaming: false,
        lastSeenAt: now(),
        media: { width: null, height: null, frameRate: null, hasAudio: false },
      };
      sessions.set(pairing.id, session);
      return session;
    },

    get: (sessionId) => sessions.get(sessionId) ?? null,

    list: () => [...sessions.values()],

    claim(input) {
      const session = sessions.get(input.sessionId);
      // An unknown id is reported as not-found, and deliberately takes the same path as a bad
      // credential from the caller's perspective — the HTTP layer returns one generic message
      // so probing cannot enumerate valid session ids.
      if (!session) return { ok: false, reason: 'not-found' };

      const result = claimSession(
        session.pairing,
        { token: input.token, pin: input.pin, deviceLabel: input.deviceLabel, now: new Date(now()) },
        policy,
      );

      // The pairing record is updated either way: a failed attempt must persist its
      // failedAttempts count, or the lockout would never trigger.
      session.pairing = result.session;

      if (!result.ok) return { ok: false, reason: result.reason };

      session.connectionToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      session.label = session.label || input.deviceLabel;
      session.lastSeenAt = now();
      return { ok: true, session };
    },

    authenticate(sessionId, connectionToken) {
      const session = sessions.get(sessionId);
      if (!session || session.connectionToken === '') return null;
      if (session.pairing.state === 'revoked') return null;
      // Expiry applies to the PAIRING window only. Once claimed and connected, a session is
      // not torn down mid-service just because two minutes elapsed — that window exists to
      // limit how long an unused QR code is valid, not to cap a sermon.
      if (session.pairing.state === 'pending' && isExpired(session.pairing, new Date(now()))) return null;
      if (!constantTimeEquals(session.connectionToken, connectionToken)) return null;
      return session;
    },

    enqueue(sessionId, message) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      // Bound the queue so a phone that stops reading cannot grow it without limit.
      if (session.outbound.length >= 256) session.outbound.shift();
      session.outbound.push(message);
      return true;
    },

    drain(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return [];
      const messages = session.outbound;
      session.outbound = [];
      return messages;
    },

    setStreaming(sessionId, streaming) {
      const session = sessions.get(sessionId);
      if (session) {
        session.streaming = streaming;
        session.lastSeenAt = now();
      }
    },

    recordState(sessionId, state) {
      const session = sessions.get(sessionId);
      if (!session) return null;
      session.lifecycle = advanceLifecycle(session.lifecycle, state, now());
      session.lastSeenAt = now();
      if (state === 'connected') session.pairing = markConnected(session.pairing);
      return session;
    },

    recordMedia(sessionId, media) {
      const session = sessions.get(sessionId);
      if (session) session.media = media;
    },

    touch(sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.lastSeenAt = now();
    },

    revoke(sessionId, reason) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.pairing = revokeSession(session.pairing);
      // Blank the bearer token so any in-flight request with it is rejected immediately.
      session.connectionToken = '';
      session.outbound = [{ kind: 'bye', reason }];
      session.lifecycle = { ...session.lifecycle, state: 'closed', lastChangeAt: now() };
    },

    remove(sessionId, reason) {
      // Revoke first so any in-flight request carrying the old token is rejected, then delete.
      registry.revoke(sessionId, reason);
      sessions.delete(sessionId);
    },

    prune() {
      const removed: string[] = [];
      for (const [id, session] of sessions) {
        const { state } = session.pairing;
        const unclaimedAndExpired = state === 'pending' && isExpired(session.pairing, new Date(now()));
        // A revoked session lingers briefly so the phone can still collect its 'bye', then goes.
        const revokedAndSettled = state === 'revoked' && now() - session.lastSeenAt > 30_000;
        if (unclaimedAndExpired || revokedAndSettled) {
          sessions.delete(id);
          removed.push(id);
        }
      }
      return removed;
    },

    revokeAll(reason) {
      for (const id of [...sessions.keys()]) registry.revoke(id, reason);
      sessions.clear();
    },
  };

  return registry;
}

/** Local copy so this module does not import from the renderer-facing pairing helpers. */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
