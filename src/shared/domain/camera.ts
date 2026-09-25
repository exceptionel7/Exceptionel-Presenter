/**
 * EXCEPTIONEL PRESENTER — the unified camera source model (Section 25).
 *
 * One abstraction for every camera, whatever it physically is: a USB webcam, a phone over
 * Wi-Fi, a capture card, NDI or RTSP. The presentation engine consumes `CameraSource` and
 * never learns which kind it is holding, so adding a provider later changes nothing
 * downstream.
 *
 * A NOTE ON WHERE STREAMS LIVE: this model carries no MediaStream. A MediaStream cannot be
 * serialised across IPC or between windows, so the object is held only by the renderer that
 * opened it, and main tracks the metadata. See docs/ARCHITECTURE.md §7.
 *
 * Dependency-free and unit-tested.
 */

export const CAMERA_SOURCE_KINDS = ['usb', 'capture-card', 'wireless', 'ndi', 'rtsp'] as const;
export type CameraSourceKind = (typeof CAMERA_SOURCE_KINDS)[number];

/**
 * `weak` is deliberately distinct from `connected`: Section 15 requires the operator to see
 * a degrading wireless camera BEFORE it drops, while it is still usable.
 */
export const CAMERA_STATUSES = [
  'available',
  'pairing',
  'connecting',
  'connected',
  'weak',
  'disconnected',
  'error',
  'unavailable',
] as const;
export type CameraStatus = (typeof CAMERA_STATUSES)[number];

/** Section 9: exactly one camera is LIVE; others sit in preview or standby. */
export const CAMERA_ASSIGNMENTS = ['live', 'preview', 'standby'] as const;
export type CameraAssignment = (typeof CAMERA_ASSIGNMENTS)[number];

export const CONNECTION_QUALITIES = ['excellent', 'good', 'fair', 'poor'] as const;
export type ConnectionQuality = (typeof CONNECTION_QUALITIES)[number];

export interface Resolution {
  width: number;
  height: number;
}

export interface CameraSource {
  id: string;
  /** Operator-facing name, e.g. "Pastor Camera". */
  name: string;
  kind: CameraSourceKind;
  status: CameraStatus;
  assignment: CameraAssignment;
  /** Negotiated resolution once running, null before. */
  resolution: Resolution | null;
  fps: number | null;
  audioEnabled: boolean;
  /** Round-trip estimate. Only wireless sources can measure this; null elsewhere. */
  latencyMs: number | null;
  quality: ConnectionQuality | null;
  /** Populated whenever status is `unavailable` or `error`. Never a bare message. */
  unavailableReason: string | null;
  /** True when this source is a phone, so the UI can show the wireless affordances. */
  isWireless: boolean;
}

/**
 * What a provider can actually do. Reported rather than assumed, so the UI greys out
 * controls a given source genuinely does not support instead of offering dead buttons.
 */
export interface CameraCapabilities {
  canSwitchFacing: boolean;
  canSetResolution: boolean;
  canSetFrameRate: boolean;
  canCaptureAudio: boolean;
  canMeasureLatency: boolean;
  /** Resolutions the DEVICE reported. Never a hardcoded list (Section 7). */
  supportedResolutions: readonly Resolution[];
  supportedFrameRates: readonly number[];
}

export const NO_CAPABILITIES: CameraCapabilities = {
  canSwitchFacing: false,
  canSetResolution: false,
  canSetFrameRate: false,
  canCaptureAudio: false,
  canMeasureLatency: false,
  supportedResolutions: [],
  supportedFrameRates: [],
};

/** A source is usable as a presentation input only in these states. */
export const isUsable = (source: CameraSource): boolean =>
  source.status === 'connected' || source.status === 'weak';

export const isConnected = isUsable;

/**
 * Applies an assignment across the source list.
 *
 * Two rules, both from Section 14:
 *  - Only ONE source may be `live`. Promoting a camera demotes the previous one to
 *    `preview`, not `standby`, so the operator can cut straight back to it.
 *  - Other cameras are NOT stopped. Their status is untouched; only assignment changes, so
 *    switching back is instant rather than a reconnect.
 */
export function assignCamera(
  sources: readonly CameraSource[],
  id: string,
  assignment: CameraAssignment,
): CameraSource[] {
  const target = sources.find((source) => source.id === id);

  // Refuse to put an unusable camera on the projector. Going live with a disconnected
  // source would black the audience screen mid-service.
  if (!target || (assignment === 'live' && !isUsable(target))) return [...sources];

  return sources.map((source) => {
    if (source.id === id) return { ...source, assignment };
    if (assignment === 'live' && source.assignment === 'live') {
      return { ...source, assignment: 'preview' };
    }
    return source;
  });
}

export const liveCamera = (sources: readonly CameraSource[]): CameraSource | null =>
  sources.find((source) => source.assignment === 'live') ?? null;

/**
 * Demotes a source that has dropped, and reports whether the LIVE camera was lost so the
 * caller can black the output rather than leave a frozen frame on the projector.
 */
export function handleDisconnect(
  sources: readonly CameraSource[],
  id: string,
  reason: string,
): { sources: CameraSource[]; lostLive: boolean } {
  const target = sources.find((source) => source.id === id);
  if (!target) return { sources: [...sources], lostLive: false };

  return {
    lostLive: target.assignment === 'live',
    sources: sources.map((source) =>
      source.id === id
        ? {
            ...source,
            status: 'disconnected',
            assignment: 'standby',
            resolution: null,
            fps: null,
            latencyMs: null,
            quality: null,
            unavailableReason: reason,
          }
        : source,
    ),
  };
}

/** WebRTC stats relevant to how a wireless camera is actually performing. */
export interface ConnectionStats {
  /** Fraction lost, 0–1. */
  packetLoss: number;
  /** Round-trip time in milliseconds. */
  rttMs: number;
  /** Jitter in milliseconds. */
  jitterMs: number;
  /** Frames per second actually arriving, if known. */
  framesPerSecond?: number;
}

/**
 * Classifies connection quality (Section 18).
 *
 * Thresholds are tuned for LIVE VIDEO on a church Wi-Fi network, which is a harsher
 * environment than a typical office: congested 2.4 GHz, a congregation of phones, and
 * often a single access point. The worst of the three metrics decides the grade, because a
 * connection with perfect RTT and 8% packet loss looks fine by average and looks terrible
 * on the projector.
 */
export function classifyConnectionQuality(stats: ConnectionStats): ConnectionQuality {
  const grade = (value: number, thresholds: readonly [number, number, number]): number => {
    if (value <= thresholds[0]) return 0; // excellent
    if (value <= thresholds[1]) return 1; // good
    if (value <= thresholds[2]) return 2; // fair
    return 3; // poor
  };

  const worst = Math.max(
    grade(Math.max(stats.packetLoss, 0), [0.005, 0.02, 0.05]),
    grade(Math.max(stats.rttMs, 0), [50, 120, 250]),
    grade(Math.max(stats.jitterMs, 0), [10, 30, 60]),
  );

  return CONNECTION_QUALITIES[worst] ?? 'poor';
}

/**
 * Whether the operator should be warned. Section 18 is explicit that a poor connection must
 * NOT auto-disconnect — a degraded picture is better than no picture mid-service.
 */
export const shouldWarnOperator = (quality: ConnectionQuality): boolean =>
  quality === 'fair' || quality === 'poor';

/** Maps quality onto the status a usable-but-struggling source should report. */
export const statusForQuality = (quality: ConnectionQuality): CameraStatus =>
  quality === 'poor' ? 'weak' : 'connected';

export const describeQuality = (quality: ConnectionQuality): string => {
  switch (quality) {
    case 'excellent':
      return 'Excellent';
    case 'good':
      return 'Good';
    case 'fair':
      return 'Fair';
    case 'poor':
      return 'Poor';
  }
};

/** Formats a source for the operator list: "1920×1080 · 30 fps · 24 ms". */
export function describeSource(source: CameraSource): string {
  const parts: string[] = [];
  if (source.resolution) parts.push(`${source.resolution.width}×${source.resolution.height}`);
  if (source.fps !== null) parts.push(`${Math.round(source.fps)} fps`);
  if (source.latencyMs !== null) parts.push(`${Math.round(source.latencyMs)} ms`);
  return parts.length > 0 ? parts.join(' · ') : 'No signal';
}

export function createSource(init: {
  id: string;
  name: string;
  kind: CameraSourceKind;
  status?: CameraStatus;
  unavailableReason?: string | null;
}): CameraSource {
  return {
    id: init.id,
    name: init.name,
    kind: init.kind,
    status: init.status ?? 'available',
    assignment: 'standby',
    resolution: null,
    fps: null,
    audioEnabled: false,
    latencyMs: null,
    quality: null,
    unavailableReason: init.unavailableReason ?? null,
    isWireless: init.kind === 'wireless',
  };
}
