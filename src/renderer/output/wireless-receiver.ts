/**
 * EXCEPTIONEL PRESENTER — the desktop side of the phone camera connection (Sections 6, 7, 8).
 *
 * Runs in the OUTPUT window, which is the canonical receiver of every phone camera. The desktop
 * is the OFFERER: it creates the offer and the phone answers. That ordering avoids glare (both
 * ends negotiating at once) and puts the window that will drive the projector in control.
 *
 * No iceServers are configured. Both devices are on the same LAN, so host candidates suffice —
 * which is precisely what keeps video off the internet and latency low.
 *
 * This module holds the only reference to the phone's MediaStream. It is never serialised: the
 * operator preview receives it over a loopback RTCPeerConnection instead (see publisher.ts).
 */

import type { SignalMessage } from '@shared/domain/signaling.ts';
import { client } from '@ui/client.ts';

export interface ReceiverEvents {
  /**
   * A remote track OBJECT exists, so the preview can be wired up.
   *
   * Note what this is not: `ontrack` fires the moment the answer is applied, before a single byte
   * of RTP has arrived. A track here is a promise of video, not video.
   */
  onTrack: (sessionId: string, stream: MediaStream) => void;
  /**
   * Frames are genuinely arriving — the receiving track has unmuted.
   *
   * THIS is the honest signal that a camera works, and the only thing allowed to advance the state
   * machine to `connected`. Reporting on `ontrack` instead would let a negotiated-but-silent
   * connection present itself as a working camera, which Section 24 forbids.
   */
  onMedia: (sessionId: string) => void;
  onState: (sessionId: string, state: RTCPeerConnectionState) => void;
  onStats: (sessionId: string, stats: { packetLoss: number; rttMs: number; jitterMs: number; fps?: number }) => void;
  onClosed: (sessionId: string) => void;
}

interface Peer {
  connection: RTCPeerConnection;
  stream: MediaStream | null;
  statsTimer: number | null;
  /** Previous cumulative counters, since WebRTC reports totals rather than rates. */
  previous: { packetsLost: number; packetsReceived: number } | null;
  /**
   * Candidates that arrived before the answer did.
   *
   * `addIceCandidate` rejects while there is no remote description, and the phone starts trickling
   * the instant it applies its own answer — so on a fast LAN a candidate can genuinely overtake the
   * answer through the signalling path. Dropping those was silently discarding the very host
   * candidates the connection depends on.
   */
  pendingCandidates: RTCIceCandidateInit[];
}

export interface WirelessReceiver {
  /** Handles one signalling message from a phone. */
  handle(sessionId: string, message: SignalMessage): Promise<void>;
  streamFor(sessionId: string): MediaStream | null;
  close(sessionId: string): void;
  closeAll(): void;
  sessions(): string[];
}

/**
 * One prefix for every line, because these logs are forwarded to the operator's terminal and are
 * the only window into a handshake that happens on two devices at once.
 */
const log = (sessionId: string, line: string): void => {
  console.log(`[webrtc ${sessionId.slice(0, 8)}] ${line}`);
};

/**
 * Reports which candidate pair ICE actually chose.
 *
 * On a healthy church LAN this should be host → host. Anything else means traffic is taking a
 * longer path than it needs to, and nothing at all means the two devices cannot reach each other
 * directly — the signature of AP client isolation, which no amount of application code can fix.
 */
async function describeSelectedPair(sessionId: string, connection: RTCPeerConnection): Promise<void> {
  const report = await connection.getStats();
  const candidates = new Map<string, Record<string, unknown>>();
  let pair: Record<string, unknown> | null = null;

  report.forEach((entry) => {
    const stat = entry as unknown as Record<string, unknown>;
    const type = stat['type'];
    if (type === 'local-candidate' || type === 'remote-candidate') {
      candidates.set(String(stat['id']), stat);
    }
    if (type === 'candidate-pair' && (stat['selected'] === true || stat['state'] === 'succeeded')) {
      pair = stat;
    }
  });

  if (!pair) {
    log(sessionId, 'no succeeded candidate pair — the devices cannot reach each other directly');
    return;
  }

  const selected = pair as Record<string, unknown>;
  const local = candidates.get(String(selected['localCandidateId']));
  const remote = candidates.get(String(selected['remoteCandidateId']));
  const describe = (candidate: Record<string, unknown> | undefined): string =>
    candidate ? `${String(candidate['candidateType'])} ${String(candidate['address'])}:${String(candidate['port'])}` : '?';

  log(sessionId, `selected pair ${describe(local)} ↔ ${describe(remote)}`);
}

export function createWirelessReceiver(events: ReceiverEvents): WirelessReceiver {
  const peers = new Map<string, Peer>();

  const send = (sessionId: string, message: SignalMessage): void => {
    void client.invoke('wireless:signal', { sessionId, message });
  };

  const create = (sessionId: string): Peer => {
    const existing = peers.get(sessionId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({ iceServers: [] });
    const peer: Peer = {
      connection,
      stream: null,
      statsTimer: null,
      previous: null,
      pendingCandidates: [],
    };
    peers.set(sessionId, peer);

    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      // The candidate TYPE is the single most useful diagnostic on a LAN: with no STUN or TURN
      // configured every candidate should be `host`, and a connection that never pairs two host
      // candidates is almost always client isolation on the access point rather than a bug here.
      log(sessionId, `local candidate ${event.candidate.type ?? '?'} ${event.candidate.address ?? ''}`);
      send(sessionId, {
        kind: 'ice',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    };

    connection.onicegatheringstatechange = () => {
      log(sessionId, `ice gathering ${connection.iceGatheringState}`);
    };

    connection.oniceconnectionstatechange = () => {
      log(sessionId, `ice connection ${connection.iceConnectionState}`);
    };

    connection.onsignalingstatechange = () => {
      log(sessionId, `signalling ${connection.signalingState}`);
    };

    connection.ontrack = (event) => {
      /*
       * A receiver now exists — but `ontrack` fires when the ANSWER is applied, not when media
       * arrives, and the track starts muted. So the stream is wired to the preview here (so it is
       * ready to paint the first frame) while `connected` waits for the unmute below.
       */
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      peer.stream = stream;
      log(sessionId, `track ${event.track.kind} received (muted=${String(event.track.muted)})`);

      // A phone switching camera replaces the track on the same connection, so this can fire
      // again for an existing session. Re-reporting is correct and keeps the preview in step.
      events.onTrack(sessionId, stream);

      const announceMedia = (): void => {
        log(sessionId, `media flowing on ${event.track.kind}`);
        events.onMedia(sessionId);
      };

      if (event.track.muted) {
        // `unmute` fires on the first RTP packet. That is the earliest moment at which claiming a
        // working camera is true rather than hopeful.
        event.track.addEventListener('unmute', announceMedia, { once: true });
        event.track.addEventListener('mute', () => log(sessionId, 'media stopped (track muted)'));
      } else {
        announceMedia();
      }
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      log(sessionId, `peer ${state}`);
      events.onState(sessionId, state);

      if (state === 'connected') {
        void describeSelectedPair(sessionId, connection);
        startStats(sessionId, peer);
      }
      if (state === 'failed' || state === 'closed') {
        stopStats(peer);
        events.onClosed(sessionId);
      }
    };

    return peer;
  };

  /**
   * Samples getStats() for the quality grade.
   *
   * WebRTC reports CUMULATIVE totals, so packet loss has to be derived from the delta between
   * samples. Using the raw totals would show a service-long average that never recovers after an
   * early glitch, making a healthy connection look permanently poor.
   */
  const startStats = (sessionId: string, peer: Peer): void => {
    stopStats(peer);
    peer.statsTimer = window.setInterval(() => {
      void peer.connection.getStats().then((report) => {
        let packetsLost = 0;
        let packetsReceived = 0;
        let jitterMs = 0;
        let rttMs = 0;
        let fps: number | undefined;

        report.forEach((entry) => {
          const stat = entry as Record<string, unknown>;
          if (stat['type'] === 'inbound-rtp' && stat['kind'] === 'video') {
            packetsLost = Number(stat['packetsLost'] ?? 0);
            packetsReceived = Number(stat['packetsReceived'] ?? 0);
            jitterMs = Number(stat['jitter'] ?? 0) * 1000;
            if (typeof stat['framesPerSecond'] === 'number') fps = stat['framesPerSecond'];
          }
          if (stat['type'] === 'candidate-pair' && stat['state'] === 'succeeded') {
            const rtt = Number(stat['currentRoundTripTime'] ?? 0);
            if (rtt > 0) rttMs = rtt * 1000;
          }
        });

        const previous = peer.previous;
        peer.previous = { packetsLost, packetsReceived };

        // The first sample has no baseline, so no loss figure can be honestly derived from it.
        if (!previous) return;

        const lostDelta = Math.max(packetsLost - previous.packetsLost, 0);
        const receivedDelta = Math.max(packetsReceived - previous.packetsReceived, 0);
        const total = lostDelta + receivedDelta;

        events.onStats(sessionId, {
          packetLoss: total > 0 ? lostDelta / total : 0,
          rttMs,
          jitterMs,
          ...(fps === undefined ? {} : { fps }),
        });
      });
    }, 2000);
  };

  const stopStats = (peer: Peer): void => {
    if (peer.statsTimer !== null) {
      window.clearInterval(peer.statsTimer);
      peer.statsTimer = null;
    }
  };

  return {
    sessions: () => [...peers.keys()],

    streamFor: (sessionId) => peers.get(sessionId)?.stream ?? null,

    async handle(sessionId, message) {
      if (message.kind === 'ready') {
        /*
         * The phone has a camera track and is waiting to be offered to. Creating the offer here
         * — after the phone is ready — means the offer already reflects a real media session
         * rather than negotiating an empty one and renegotiating later.
         */
        const peer = create(sessionId);

        /*
         * Transceivers are added once per connection.
         *
         * A phone can send `ready` more than once — it re-posts after its EventSource reconnects —
         * and adding a second recvonly video transceiver each time would grow the offer with dead
         * m-lines and force a renegotiation the phone is not expecting.
         */
        if (peer.connection.getTransceivers().length === 0) {
          // recvonly: the desktop receives the phone's camera and sends nothing back.
          peer.connection.addTransceiver('video', { direction: 'recvonly' });
          if (message.hasAudio) peer.connection.addTransceiver('audio', { direction: 'recvonly' });
        }

        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        log(sessionId, `offer sent (${(offer.sdp ?? '').length} bytes)`);
        send(sessionId, { kind: 'offer', sdp: offer.sdp ?? '' });
        return;
      }

      const peer = peers.get(sessionId);
      if (!peer) return;

      if (message.kind === 'answer') {
        await peer.connection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        log(sessionId, `answer applied (${message.sdp.length} bytes)`);

        // Now that a remote description exists, everything that arrived early can be applied.
        const queued = peer.pendingCandidates;
        peer.pendingCandidates = [];
        if (queued.length > 0) log(sessionId, `applying ${queued.length} queued candidate(s)`);
        for (const candidate of queued) {
          await peer.connection.addIceCandidate(candidate).catch(() => undefined);
        }
        return;
      }

      if (message.kind === 'ice' && message.candidate) {
        const candidate: RTCIceCandidateInit = {
          candidate: message.candidate,
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex,
        };

        if (!peer.connection.remoteDescription) {
          peer.pendingCandidates.push(candidate);
          log(sessionId, 'candidate queued until the answer arrives');
          return;
        }

        try {
          await peer.connection.addIceCandidate(candidate);
        } catch {
          // A single rejected candidate is survivable; ICE tries the others.
        }
        return;
      }

      if (message.kind === 'bye') {
        this.close(sessionId);
      }
    },

    close(sessionId) {
      const peer = peers.get(sessionId);
      if (!peer) return;
      peers.delete(sessionId);
      stopStats(peer);

      // Stop the received tracks so nothing keeps decoding after a disconnect.
      peer.stream?.getTracks().forEach((track) => track.stop());
      peer.connection.close();
      events.onClosed(sessionId);
    },

    closeAll() {
      for (const sessionId of [...peers.keys()]) this.close(sessionId);
    },
  };
}
