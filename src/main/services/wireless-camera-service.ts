/**
 * EXCEPTIONEL PRESENTER — the Wireless Camera service.
 *
 * Owns everything the feature needs in the main process: the certificate, the LAN address, the
 * HTTPS signalling server, the pairing registry, and one state machine per phone. It exposes a
 * single `WirelessStatus` snapshot for the UI and emits it whenever anything changes.
 *
 * It holds NO media. Video lives in the output renderer, which owns the RTCPeerConnection; main
 * only relays SDP and ICE. See docs/ARCHITECTURE.md §7.
 */

import { createCertificateStore, certificatePaths, type CertificateMaterial } from './certificate.ts';
import { allLanAddresses, diagnoseNetwork, type ReadInterfaces } from './network.ts';
import { createPairingRegistry, type PairingRegistry } from './pairing-registry.ts';
import { createWirelessCameraServer, type WirelessCameraServer } from './wireless-camera-server.ts';
import { buildPairingUrl } from '../../shared/domain/pairing.ts';
import {
  classifyConnectionQuality,
  type ConnectionQuality,
} from '../../shared/domain/camera.ts';
import {
  eventForPeerState,
  metricsAreStale,
  transition,
  type WirelessEvent,
  type WirelessState,
} from '../../shared/domain/wireless-camera-state.ts';
import type { PeerState, SignalMessage } from '../../shared/domain/signaling.ts';
import type { PairingTicket, WirelessPhone, WirelessStatus } from '../../shared/ipc-contract.ts';

/** Fixed default port. A stable port means a previously-trusted certificate keeps working. */
export const DEFAULT_WIRELESS_PORT = 8443;

export interface WirelessCameraServiceOptions {
  userDataDir: string;
  port?: number;
  readInterfaces?: ReadInterfaces;
  /**
   * Overrides which interface the socket binds, without changing the address advertised in the
   * QR code.
   *
   * Exists because interface auto-detection can pick wrong on an unusual setup — a machine with
   * several subnets, or a VPN that outranks nothing else. One of the failure remedies already
   * tells the operator they can choose a different address, so this is the mechanism behind
   * that promise. Also lets tests bind loopback while still asserting the QR advertises a
   * routable LAN address.
   */
  bindAddress?: string;
  /** Emits a fresh snapshot whenever anything changes. */
  onStatus: (status: WirelessStatus) => void;
  /** Delivers a phone message to the window that owns the peer connection. */
  onSignalToDesktop: (sessionId: string, message: SignalMessage) => void;
  /** Called when a phone appears or vanishes, so camera sources can be rebuilt. */
  onPhonesChanged?: (phones: WirelessPhone[]) => void;
  onLog?: (line: string) => void;
}

export interface WirelessCameraService {
  start(): Promise<WirelessStatus>;
  stop(): Promise<WirelessStatus>;
  status(): WirelessStatus;
  createSession(label: string): PairingTicket;
  cancelSession(sessionId: string): WirelessStatus;
  disconnect(sessionId: string): WirelessStatus;
  /** Queues a desktop → phone message (an offer, or an ICE candidate). */
  sendToPhone(sessionId: string, message: SignalMessage): void;
  /** Called by the output window once a remote track actually arrives. */
  markTrackReceived(sessionId: string): WirelessStatus;
  /**
   * Records a pairing attempt. The HTTPS server calls this for every claim; it is exposed so the
   * same seam can be exercised directly.
   */
  notifyClaim(sessionId: string, accepted: boolean): void;
  /**
   * Reports the DESKTOP peer's connection state, as observed by the output window.
   *
   * Distinct from the phone's own reports, which arrive over HTTP: either side can notice a drop
   * first, and the desktop usually notices faster because it stops receiving packets while the
   * phone is still trying to send them.
   */
  notifyDesktopPeerState(sessionId: string, state: PeerState): void;
  /** Reported periodically by the output window from getStats(). */
  reportStats(sessionId: string, stats: { packetLoss: number; rttMs: number; jitterMs: number; fps?: number }): void;
  /** Applies a live/standby assignment coming from the camera source layer. */
  setLive(sessionId: string, live: boolean): WirelessStatus;
  readonly registry: PairingRegistry;
}

interface PhoneRecord {
  sessionId: string;
  label: string;
  state: WirelessState;
  quality: ConnectionQuality | null;
  latencyMs: number | null;
  fps: number | null;
}

export function createWirelessCameraService(
  options: WirelessCameraServiceOptions,
): WirelessCameraService {
  const log = options.onLog ?? (() => undefined);
  const port = options.port ?? DEFAULT_WIRELESS_PORT;
  const certificates = createCertificateStore(certificatePaths(options.userDataDir));
  const registry = createPairingRegistry();

  const phones = new Map<string, PhoneRecord>();
  let server: WirelessCameraServer | null = null;
  let material: CertificateMaterial | null = null;
  let bound: { host: string; port: number } | null = null;
  let problem: string | null = null;
  let remedies: string[] = [];

  /** Applies an event to one phone's machine and emits a snapshot if anything moved. */
  const apply = (sessionId: string, event: WirelessEvent): void => {
    const phone = phones.get(sessionId);
    if (!phone) return;

    const result = transition(phone.state, event);
    if (result.rejected) {
      // Refused transitions are logged, never surfaced: they are a programming signal, not
      // something an operator can act on.
      log(`[wireless-camera] ${sessionId}: ${result.rejected}`);
      return;
    }
    if (!result.changed) return;

    phone.state = result.state;

    // Section 16 and 18: never report yesterday's numbers. Clearing here rather than in the UI
    // means every consumer of the snapshot sees the same truth.
    if (metricsAreStale(phone.state)) {
      phone.quality = null;
      phone.latencyMs = null;
      phone.fps = null;
    }

    log(`[wireless-camera] ${sessionId} → ${phone.state}`);
    emit();
  };

  const emit = (): void => {
    const status = buildStatus();
    options.onStatus(status);
    options.onPhonesChanged?.(status.phones);
  };

  const buildStatus = (): WirelessStatus => {
    const diagnosis = diagnoseNetwork(options.readInterfaces);
    const origin = bound && diagnosis.best ? `https://${diagnosis.best.address}:${bound.port}` : null;

    return {
      running: server !== null && bound !== null,
      origin,
      lanAddress: diagnosis.best?.address ?? null,
      interfaceName: diagnosis.best?.interfaceName ?? null,
      certificateFingerprint: material?.fingerprint ?? null,
      maxPhones: registry.capacity,
      problem: problem ?? diagnosis.problem,
      remedies: problem ? remedies : diagnosis.remedies,
      phones: [...phones.values()].map((phone) => {
        const session = registry.get(phone.sessionId);
        const media = session?.media;
        return {
          sessionId: phone.sessionId,
          label: phone.label,
          state: phone.state,
          deviceLabel: session?.pairing.deviceLabel ?? null,
          resolution:
            media?.width && media.height ? { width: media.width, height: media.height } : null,
          fps: phone.fps ?? media?.frameRate ?? null,
          latencyMs: phone.latencyMs,
          quality: phone.quality,
          audioEnabled: media?.hasAudio ?? false,
          // Only meaningful while a QR code is still on screen.
          expiresAt: phone.state === 'pairing' ? session?.pairing.expiresAt ?? null : null,
          pin: phone.state === 'pairing' || phone.state === 'authenticating' ? session?.pairing.pin ?? null : null,
        };
      }),
    };
  };

  const handlePhoneState = (sessionId: string, peerState: PeerState): void => {
    const event = eventForPeerState(peerState);
    if (event) apply(sessionId, event);
  };

  /**
   * Advances the machine through authentication.
   *
   * Pairing happens over HTTP rather than as a signalling message, so without this the machine
   * would never leave `pairing` and no phone could ever reach `connected`. A rejected claim
   * returns to `pairing`, keeping the QR code usable so a mistyped PIN costs nothing.
   */
  const notifyClaim = (sessionId: string, accepted: boolean): void => {
    apply(sessionId, 'phoneClaiming');
    apply(sessionId, accepted ? 'claimAccepted' : 'claimRejected');
  };

  return {
    registry,

    status: buildStatus,

    async start() {
      if (server) return buildStatus();

      problem = null;
      remedies = [];

      const diagnosis = diagnoseNetwork(options.readInterfaces);
      if (!diagnosis.ok || !diagnosis.best) {
        problem = diagnosis.problem;
        remedies = diagnosis.remedies;
        return buildStatus();
      }

      try {
        // The certificate covers every interface, not just the chosen one, so switching from
        // Ethernet to Wi-Fi mid-setup does not invalidate it.
        material = certificates.ensure({ ipAddresses: allLanAddresses(options.readInterfaces) });
      } catch (error) {
        problem = 'A local certificate could not be created.';
        remedies = [
          'Wireless Camera needs a certificate so your phone can use its camera securely.',
          error instanceof Error ? error.message : String(error),
        ];
        return buildStatus();
      }

      const instance = createWirelessCameraServer({
        registry,
        certificatePem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
        // Bound to one specific interface, never 0.0.0.0 (Section 2).
        host: options.bindAddress ?? diagnosis.best.address,
        port,
        onPhoneMessage: (sessionId, message) => {
          // 'ready' means the phone HAS a camera track, not that we have received one. The
          // machine deliberately stays in `connecting` until a real remote track arrives.
          options.onSignalToDesktop(sessionId, message);
        },
        onClaimAttempt: notifyClaim,
        onPhoneState: handlePhoneState,
        onLog: log,
      });

      try {
        bound = await instance.start();
        server = instance;
        log(`[wireless-camera] ready at https://${bound.host}:${bound.port}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problem = /EADDRINUSE/.test(message)
          ? `Port ${port} is already in use by another program.`
          : 'The Wireless Camera service could not start.';
        remedies = /EADDRINUSE/.test(message)
          ? ['Close the other program using this port, or change the port in Settings.', message]
          : ['Check that your firewall allows Exceptionel Presenter.', message];
        server = null;
        bound = null;
      }

      const status = buildStatus();
      options.onStatus(status);
      return status;
    },

    async stop() {
      if (server) await server.stop();
      server = null;
      bound = null;
      phones.clear();
      const status = buildStatus();
      options.onStatus(status);
      return status;
    },

    createSession(label) {
      if (!server || !bound) throw new Error('Wireless Camera is not running.');
      if (!material) throw new Error('No local certificate is available.');

      const session = registry.create(label);
      phones.set(session.pairing.id, {
        sessionId: session.pairing.id,
        label,
        state: 'disconnected',
        quality: null,
        latencyMs: null,
        fps: null,
      });
      apply(session.pairing.id, 'beginPairing');

      const diagnosis = diagnoseNetwork(options.readInterfaces);
      const host = diagnosis.best?.address ?? bound.host;

      return {
        sessionId: session.pairing.id,
        // Only this string goes into the QR image. It carries the session id and pairing
        // token — never the PIN.
        pairingUrl: buildPairingUrl(session.pairing, { scheme: 'https', host, port: bound.port }),
        // The PIN travels to the OPERATOR'S SCREEN by a separate path. That separation is the
        // whole two-factor model.
        pin: session.pairing.pin,
        expiresAt: session.pairing.expiresAt,
        label,
        displayUrl: `https://${host}:${bound.port}`,
      };
    },

    cancelSession(sessionId) {
      registry.revoke(sessionId, 'Cancelled by the operator');
      apply(sessionId, 'stop');
      phones.delete(sessionId);
      const status = buildStatus();
      options.onStatus(status);
      return status;
    },

    disconnect(sessionId) {
      // Section 18: the connection must actually terminate and credentials must be invalidated.
      if (server) server.sendToPhone(sessionId, { kind: 'bye', reason: 'Disconnected by the operator' });
      registry.revoke(sessionId, 'Disconnected by the operator');
      apply(sessionId, 'stop');
      const status = buildStatus();
      options.onStatus(status);
      return status;
    },

    sendToPhone(sessionId, message) {
      server?.sendToPhone(sessionId, message);
    },

    notifyClaim,

    notifyDesktopPeerState: handlePhoneState,

    markTrackReceived(sessionId) {
      apply(sessionId, 'trackReceived');
      return buildStatus();
    },

    reportStats(sessionId, stats) {
      const phone = phones.get(sessionId);
      if (!phone) return;
      // Stats arriving while reconnecting describe a connection that is already gone.
      if (metricsAreStale(phone.state)) return;

      phone.quality = classifyConnectionQuality({
        packetLoss: stats.packetLoss,
        rttMs: stats.rttMs,
        jitterMs: stats.jitterMs,
      });
      // Section 20: report measured latency only. Half the round trip is the one-way estimate.
      phone.latencyMs = Number.isFinite(stats.rttMs) && stats.rttMs > 0 ? Math.round(stats.rttMs / 2) : null;
      phone.fps = stats.fps !== undefined && Number.isFinite(stats.fps) ? Math.round(stats.fps) : phone.fps;
      emit();
    },

    setLive(sessionId, live) {
      apply(sessionId, live ? 'goLive' : 'leaveLive');
      return buildStatus();
    },
  };
}
