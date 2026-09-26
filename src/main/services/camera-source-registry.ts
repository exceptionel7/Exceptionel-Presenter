/**
 * EXCEPTIONEL PRESENTER — the unified camera source list (Sections 10, 13).
 *
 * Projects wireless phones (and, from Phase 6, local USB cameras) into the single
 * `CameraSource` shape the presentation engine consumes. Assignment goes through the
 * already-tested `assignCamera` rules — one live camera, demotion to preview rather than
 * standby, standby cameras never stopped — so those rules have exactly one implementation.
 *
 * Holds no MediaStream. The stream lives in the renderer that opened it.
 */

import {
  assignCamera,
  createSource,
  handleDisconnect,
  liveCamera,
  type CameraAssignment,
  type CameraSource,
  type CameraStatus,
  type ConnectionQuality,
} from '../../shared/domain/camera.ts';
import type { WirelessPhone } from '../../shared/ipc-contract.ts';

export interface CameraSourceRegistry {
  list(): CameraSource[];
  /** Rebuilds the wireless entries from the service's snapshot. */
  syncWireless(phones: readonly WirelessPhone[]): CameraSource[];
  assign(id: string, assignment: string): CameraSource[];
  /** Marks a source as dropped; reports whether the LIVE camera was the one lost. */
  disconnect(id: string, reason: string): { sources: CameraSource[]; lostLive: boolean };
  live(): CameraSource | null;
  /** Maps a source id back to the phone session it came from, if any. */
  sessionIdFor(sourceId: string): string | null;
}

const WIRELESS_PREFIX = 'phone:';

export const sourceIdForSession = (sessionId: string): string => `${WIRELESS_PREFIX}${sessionId}`;

export function createCameraSourceRegistry(options: {
  onChanged: (sources: CameraSource[]) => void;
  /** Told when the live camera is lost, so the output can be blacked rather than frozen. */
  onLiveLost?: (source: CameraSource) => void;
} = { onChanged: () => undefined }): CameraSourceRegistry {
  let sources: CameraSource[] = [];

  const publish = (next: CameraSource[]): CameraSource[] => {
    sources = next;
    options.onChanged(sources);
    return sources;
  };

  return {
    list: () => [...sources],

    live: () => liveCamera(sources),

    sessionIdFor: (sourceId) =>
      sourceId.startsWith(WIRELESS_PREFIX) ? sourceId.slice(WIRELESS_PREFIX.length) : null,

    syncWireless(phones) {
      const keep = sources.filter((source) => source.kind !== 'wireless');

      const wireless = phones.map<CameraSource>((phone) => {
        const id = sourceIdForSession(phone.sessionId);
        const existing = sources.find((source) => source.id === id);

        return {
          ...createSource({ id, name: phone.label, kind: 'wireless' }),
          // A phone's camera status is derived from its state machine, so the two can never
          // disagree about whether a picture exists.
          status: statusFromWirelessState(phone.state, phone.quality),
          // Assignment is the operator's decision and survives a metrics refresh. Without this
          // every stats report would silently knock the live camera back to standby.
          assignment: existing?.assignment ?? 'standby',
          resolution: phone.resolution,
          fps: phone.fps,
          latencyMs: phone.latencyMs,
          quality: (phone.quality as ConnectionQuality | null) ?? null,
          audioEnabled: phone.audioEnabled,
          unavailableReason: null,
          isWireless: true,
        };
      });

      return publish([...keep, ...wireless]);
    },

    assign(id, assignment) {
      return publish(assignCamera(sources, id, assignment as CameraAssignment));
    },

    disconnect(id, reason) {
      const result = handleDisconnect(sources, id, reason);
      const lost = result.lostLive ? sources.find((source) => source.id === id) : undefined;
      publish(result.sources);
      if (lost) options.onLiveLost?.(lost);
      return { sources: [...result.sources], lostLive: result.lostLive };
    },
  };
}

/**
 * Translates a wireless state into a camera status.
 *
 * `poor` quality reports `weak` rather than `connected`, which keeps the camera usable (Section
 * 19 forbids auto-disconnecting) while making the degradation visible before it drops.
 */
function statusFromWirelessState(state: string, quality: string | null): CameraStatus {
  switch (state) {
    case 'connected':
    case 'live':
      return quality === 'poor' ? 'weak' : 'connected';
    case 'reconnecting':
      // Still holds a track, but its numbers are meaningless, so it is not offered as healthy.
      return 'weak';
    case 'pairing':
      return 'pairing';
    case 'authenticating':
    case 'connecting':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'stopped':
    case 'disconnected':
    default:
      return 'disconnected';
  }
}
