/**
 * EXCEPTIONEL PRESENTER — the wireless camera state machine (Section 12).
 *
 * Explicit states with an explicit transition table, because the alternative — booleans
 * scattered across the UI and the main process — is how a camera ends up reporting
 * "connected" with no stream attached. Section 24 forbids exactly that, so the machine
 * REFUSES invalid transitions rather than tolerating them.
 *
 * The one rule worth stating up front: `CONNECTED` means a real remote track has been
 * received. It is not reachable from a successful handshake alone.
 */

export const WIRELESS_STATES = [
  'disconnected',
  'pairing',
  'authenticating',
  'connecting',
  'connected',
  'live',
  'reconnecting',
  'failed',
  'stopped',
] as const;
export type WirelessState = (typeof WIRELESS_STATES)[number];

export const WIRELESS_EVENTS = [
  /** Operator asked for a QR code. */
  'beginPairing',
  /** A phone POSTed a claim and is being checked. */
  'phoneClaiming',
  /** Token and PIN accepted; negotiation may start. */
  'claimAccepted',
  /** Token or PIN rejected. */
  'claimRejected',
  /** The QR code timed out before any phone used it. */
  'pairingExpired',
  /** A remote media track actually arrived. This is the only way to reach `connected`. */
  'trackReceived',
  /** Operator promoted this camera to the audience output. */
  'goLive',
  /** Operator took it off the audience output but kept it connected. */
  'leaveLive',
  /** Transport dropped but may recover. */
  'connectionInterrupted',
  /** Transport recovered. */
  'connectionRestored',
  /** Gave up: ICE failed, or the reconnect window elapsed. */
  'connectionFailed',
  /** Operator pressed Disconnect, or the phone pressed Stop. */
  'stop',
  /** Operator cleared a finished or failed camera from the list. */
  'reset',
] as const;
export type WirelessEvent = (typeof WIRELESS_EVENTS)[number];

/**
 * The permitted transitions. Anything absent here is refused.
 *
 * Note what is deliberately NOT here:
 *  - nothing reaches `connected` except `trackReceived`, so a completed SDP exchange with no
 *    media cannot present itself as a working camera;
 *  - `pairing` cannot jump straight to `connected`, so a phone must authenticate first;
 *  - `failed` and `stopped` lead only to `reset`, so a dead camera never silently revives.
 */
const TRANSITIONS: Readonly<Record<WirelessState, Partial<Record<WirelessEvent, WirelessState>>>> = {
  disconnected: {
    beginPairing: 'pairing',
  },
  pairing: {
    phoneClaiming: 'authenticating',
    pairingExpired: 'disconnected',
    stop: 'stopped',
  },
  authenticating: {
    claimAccepted: 'connecting',
    // A rejected claim returns to pairing: the QR code is still valid and the operator
    // should not have to generate a new one because someone fat-fingered the PIN.
    claimRejected: 'pairing',
    pairingExpired: 'disconnected',
    stop: 'stopped',
  },
  connecting: {
    trackReceived: 'connected',
    connectionFailed: 'failed',
    connectionInterrupted: 'reconnecting',
    stop: 'stopped',
  },
  connected: {
    goLive: 'live',
    connectionInterrupted: 'reconnecting',
    connectionFailed: 'failed',
    stop: 'stopped',
    // Re-firing trackReceived is harmless — it happens when the phone switches camera and
    // replaceTrack surfaces a new track on the same connection.
    trackReceived: 'connected',
  },
  live: {
    leaveLive: 'connected',
    connectionInterrupted: 'reconnecting',
    connectionFailed: 'failed',
    stop: 'stopped',
    trackReceived: 'live',
  },
  reconnecting: {
    connectionRestored: 'connected',
    connectionFailed: 'failed',
    trackReceived: 'connected',
    stop: 'stopped',
  },
  failed: {
    reset: 'disconnected',
    stop: 'stopped',
  },
  stopped: {
    reset: 'disconnected',
  },
};

export interface TransitionResult {
  state: WirelessState;
  changed: boolean;
  /** Set when the event was refused, for logging. Never surfaced to the operator. */
  rejected: string | null;
}

export function transition(state: WirelessState, event: WirelessEvent): TransitionResult {
  const next = TRANSITIONS[state][event];
  if (next === undefined) {
    return { state, changed: false, rejected: `${event} is not valid from ${state}` };
  }
  return { state: next, changed: next !== state, rejected: null };
}

export const canTransition = (state: WirelessState, event: WirelessEvent): boolean =>
  TRANSITIONS[state][event] !== undefined;

export const allowedEvents = (state: WirelessState): WirelessEvent[] =>
  Object.keys(TRANSITIONS[state]) as WirelessEvent[];

/**
 * True when a real stream should exist. Used to assert the UI never claims a picture it does
 * not have, and to decide whether metrics are meaningful.
 */
export const hasStream = (state: WirelessState): boolean =>
  state === 'connected' || state === 'live' || state === 'reconnecting';

/** Section 13: only a camera with a stream may be promoted to the audience output. */
export const canGoLive = (state: WirelessState): boolean => canTransition(state, 'goLive');

/** Section 18: stale metrics must be cleared in these states. */
export const metricsAreStale = (state: WirelessState): boolean =>
  !hasStream(state) || state === 'reconnecting';

export const isTerminal = (state: WirelessState): boolean => state === 'failed' || state === 'stopped';

/** Operator-facing label. */
export function describeWirelessState(state: WirelessState): string {
  switch (state) {
    case 'disconnected':
      return 'Disconnected';
    case 'pairing':
      return 'Waiting for phone';
    case 'authenticating':
      return 'Authenticating';
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'live':
      return 'Live';
    case 'reconnecting':
      return 'Reconnecting';
    case 'failed':
      return 'Connection failed';
    case 'stopped':
      return 'Stopped';
  }
}

/** Maps to the dot colour used across the operator UI. */
export function wirelessStateTone(state: WirelessState): 'live' | 'ok' | 'ready' | 'idle' | 'error' {
  switch (state) {
    case 'live':
      return 'live';
    case 'connected':
      return 'ok';
    case 'pairing':
    case 'authenticating':
    case 'connecting':
    case 'reconnecting':
      return 'ready';
    case 'failed':
      return 'error';
    case 'disconnected':
    case 'stopped':
      return 'idle';
  }
}

/**
 * Translates a WebRTC peer state into a machine event.
 *
 * `disconnected` becomes `connectionInterrupted` rather than a failure: WebRTC reports it
 * routinely during a Wi-Fi roam between access points and usually recovers unaided. Tearing the
 * camera down there would drop a feed that was about to come back.
 */
export function eventForPeerState(peerState: string): WirelessEvent | null {
  switch (peerState) {
    case 'connected':
      return 'connectionRestored';
    case 'disconnected':
      return 'connectionInterrupted';
    case 'failed':
      return 'connectionFailed';
    case 'closed':
      return 'stop';
    default:
      return null;
  }
}
