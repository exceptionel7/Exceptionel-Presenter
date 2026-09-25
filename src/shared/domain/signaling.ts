/**
 * EXCEPTIONEL PRESENTER — WebRTC signaling protocol (Section 10).
 *
 * TRANSPORT CHOICE: HTTPS with Server-Sent Events downstream and POST upstream, rather than
 * WebSockets. Three reasons, in order of weight:
 *
 *  1. No dependency. Node has no WebSocket server, so `ws` would be required. SSE is plain
 *     HTTP and works with the server we already need for the phone page.
 *  2. Signaling volume is tiny — an offer, an answer, and a handful of ICE candidates, all
 *     during setup. Once the peer connection is up, no video touches this channel, so the
 *     latency of the signaling transport is irrelevant to the latency of the picture.
 *  3. It is testable. An SSE stream can be exercised with `fetch`, which is how the server
 *     in this repository is actually verified.
 *
 * Every message crossing this boundary arrives from a phone browser, so all of it is
 * validated. This module is pure so the protocol and its state machine are testable without
 * a network, a browser or a peer connection.
 */

export const SIGNAL_KINDS = ['offer', 'answer', 'ice', 'ready', 'bye', 'state', 'ping'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** SDP payloads are large; this bounds them so a hostile client cannot exhaust memory. */
export const MAX_SDP_LENGTH = 64 * 1024;
export const MAX_CANDIDATE_LENGTH = 1024;

export type SignalMessage =
  /** Desktop → phone. The desktop is the offerer, so it drives the negotiation. */
  | { kind: 'offer'; sdp: string }
  /** Phone → desktop. */
  | { kind: 'answer'; sdp: string }
  /** Either direction. An empty candidate signals end-of-candidates. */
  | { kind: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /** Phone → desktop: camera permission granted, tracks available, ready to negotiate. */
  | { kind: 'ready'; width: number | null; height: number | null; frameRate: number | null; hasAudio: boolean }
  /** Either direction: a clean, intentional shutdown. */
  | { kind: 'bye'; reason: string }
  /** Phone → desktop: local peer state, so the desktop can show an accurate status. */
  | { kind: 'state'; state: PeerState }
  /** Keeps the SSE stream alive through proxies and detects a silently dead phone. */
  | { kind: 'ping'; at: number };

/**
 * Mirrors RTCPeerConnectionState plus a `reconnecting` state of our own.
 *
 * WebRTC reports `disconnected` for a transient interruption and `failed` when ICE has given
 * up. Section 15 needs those distinguished: the first is worth waiting through, the second
 * requires renegotiation.
 */
export const PEER_STATES = [
  'new',
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'failed',
  'closed',
] as const;
export type PeerState = (typeof PEER_STATES)[number];

export const isLivePeerState = (state: PeerState): boolean =>
  state === 'connected' || state === 'reconnecting';

export const isTerminalPeerState = (state: PeerState): boolean =>
  state === 'failed' || state === 'closed';

// ── validation ──────────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * Parses a message from the phone.
 *
 * Deliberately strict: unknown kinds are refused rather than ignored, and SDP is length-capped
 * before anything stores it. A rejected message must never become a thrown exception inside an
 * HTTP handler.
 */
export function parseSignalMessage(input: unknown): ParseResult<SignalMessage> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('expected a JSON object');
  }
  const raw = input as Record<string, unknown>;
  const kind = raw['kind'];
  if (typeof kind !== 'string') return fail('missing "kind"');

  switch (kind) {
    case 'offer':
    case 'answer': {
      const sdp = raw['sdp'];
      if (typeof sdp !== 'string' || sdp.length === 0) return fail(`${kind} requires "sdp"`);
      if (sdp.length > MAX_SDP_LENGTH) return fail(`${kind} sdp exceeds ${MAX_SDP_LENGTH} bytes`);
      // A real SDP always begins with a version line. Cheap sanity check that rejects
      // obviously bogus payloads before they reach a peer connection.
      if (!sdp.startsWith('v=')) return fail(`${kind} sdp is malformed`);
      return { ok: true, value: { kind, sdp } };
    }

    case 'ice': {
      const candidate = raw['candidate'];
      if (typeof candidate !== 'string') return fail('ice requires "candidate"');
      if (candidate.length > MAX_CANDIDATE_LENGTH) return fail('ice candidate too long');

      const sdpMid = raw['sdpMid'];
      const sdpMLineIndex = raw['sdpMLineIndex'];
      return {
        ok: true,
        value: {
          kind: 'ice',
          candidate,
          sdpMid: typeof sdpMid === 'string' ? sdpMid : null,
          sdpMLineIndex: typeof sdpMLineIndex === 'number' && Number.isInteger(sdpMLineIndex) ? sdpMLineIndex : null,
        },
      };
    }

    case 'ready': {
      const dimension = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8192
          ? Math.round(value)
          : null;
      return {
        ok: true,
        value: {
          kind: 'ready',
          width: dimension(raw['width']),
          height: dimension(raw['height']),
          frameRate:
            typeof raw['frameRate'] === 'number' && Number.isFinite(raw['frameRate']) && raw['frameRate'] > 0 && raw['frameRate'] <= 240
              ? Math.round(raw['frameRate'] as number)
              : null,
          hasAudio: raw['hasAudio'] === true,
        },
      };
    }

    case 'bye': {
      const reason = raw['reason'];
      return {
        ok: true,
        value: { kind: 'bye', reason: typeof reason === 'string' ? reason.slice(0, 200) : 'unspecified' },
      };
    }

    case 'state': {
      const state = raw['state'];
      if (typeof state !== 'string' || !(PEER_STATES as readonly string[]).includes(state)) {
        return fail(`state must be one of ${PEER_STATES.join(', ')}`);
      }
      return { ok: true, value: { kind: 'state', state: state as PeerState } };
    }

    case 'ping':
      return { ok: true, value: { kind: 'ping', at: typeof raw['at'] === 'number' ? raw['at'] : Date.now() } };

    default:
      return fail(`unknown message kind "${kind}"`);
  }
}

// ── SSE framing ─────────────────────────────────────────────────────────────────

/**
 * Encodes one message as an SSE frame.
 *
 * JSON is emitted on a single line because a literal newline inside an SSE `data:` field
 * would be parsed as a field break, truncating the message. SDP is full of newlines, so this
 * is the difference between a working handshake and a silently corrupted one.
 */
export function encodeSseFrame(message: SignalMessage, id?: number): string {
  const json = JSON.stringify(message);
  if (json.includes('\n')) throw new Error('SSE payload must not contain a raw newline');
  return `${id === undefined ? '' : `id: ${id}\n`}data: ${json}\n\n`;
}

/** Parses frames out of an SSE byte stream, returning whole messages and the leftover tail. */
export function decodeSseFrames(buffer: string): { messages: SignalMessage[]; rest: string } {
  const messages: SignalMessage[] = [];
  const parts = buffer.split('\n\n');
  // The final element is either an incomplete frame or an empty string; keep it buffered.
  const rest = parts.pop() ?? '';

  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const parsed = parseSignalMessage(JSON.parse(line.slice(6)));
        if (parsed.ok) messages.push(parsed.value);
      } catch {
        // A malformed frame is skipped rather than aborting the stream: losing one ICE
        // candidate is survivable, losing the connection is not.
      }
    }
  }

  return { messages, rest };
}

// ── peer lifecycle (Sections 15, 16) ────────────────────────────────────────────

export interface PeerLifecycle {
  state: PeerState;
  /** Consecutive transient drops. Used to stop retrying forever. */
  reconnectAttempts: number;
  lastChangeAt: number;
}

export const initialLifecycle = (now = Date.now()): PeerLifecycle => ({
  state: 'new',
  reconnectAttempts: 0,
  lastChangeAt: now,
});

export interface LifecycleOptions {
  /** Transient drops tolerated before the connection is declared failed. */
  maxReconnectAttempts: number;
  /** How long a `disconnected` state may persist before it counts as failed. */
  reconnectWindowMs: number;
}

export const DEFAULT_LIFECYCLE_OPTIONS: LifecycleOptions = {
  maxReconnectAttempts: 5,
  // Wi-Fi roaming between access points in a large building can take several seconds; giving
  // up sooner would drop a camera that was about to recover.
  reconnectWindowMs: 20_000,
};

/**
 * Advances the lifecycle in response to a reported peer state.
 *
 * A transient `disconnected` becomes `reconnecting` rather than a failure, because WebRTC
 * routinely reports it during a Wi-Fi roam and recovers unaided. Section 15 requires exactly
 * that distinction, and Section 14 forbids tearing a camera down unnecessarily.
 */
export function advanceLifecycle(
  current: PeerLifecycle,
  reported: PeerState,
  now: number,
  options: LifecycleOptions = DEFAULT_LIFECYCLE_OPTIONS,
): PeerLifecycle {
  if (isTerminalPeerState(current.state)) return current; // closed and failed are final

  if (reported === 'disconnected') {
    const attempts = current.reconnectAttempts + 1;
    if (attempts > options.maxReconnectAttempts) {
      return { state: 'failed', reconnectAttempts: attempts, lastChangeAt: now };
    }
    return { state: 'reconnecting', reconnectAttempts: attempts, lastChangeAt: now };
  }

  if (reported === 'connected') {
    // A successful reconnection resets the budget, so an hour-long service with occasional
    // Wi-Fi hiccups does not slowly exhaust it.
    return { state: 'connected', reconnectAttempts: 0, lastChangeAt: now };
  }

  return { state: reported, reconnectAttempts: current.reconnectAttempts, lastChangeAt: now };
}

/** True when a reconnection has been pending longer than the allowed window. */
export function hasReconnectTimedOut(
  lifecycle: PeerLifecycle,
  now: number,
  options: LifecycleOptions = DEFAULT_LIFECYCLE_OPTIONS,
): boolean {
  return lifecycle.state === 'reconnecting' && now - lifecycle.lastChangeAt > options.reconnectWindowMs;
}

/** Operator-facing status text. */
export function describePeerState(state: PeerState): string {
  switch (state) {
    case 'new':
      return 'Waiting for phone';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'disconnected':
      return 'Disconnected';
    case 'failed':
      return 'Connection failed';
    case 'closed':
      return 'Disconnected';
  }
}
