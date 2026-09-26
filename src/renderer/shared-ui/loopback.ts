/**
 * EXCEPTIONEL PRESENTER — loopback stream forwarding between two renderers.
 *
 * THE PROBLEM: a MediaStream cannot be serialised. It cannot cross Electron IPC and cannot be
 * passed between windows. But the phone's camera arrives in the OUTPUT window, and the operator
 * preview lives in a different renderer entirely.
 *
 * THE SOLUTION: a second, local RTCPeerConnection between the two renderers, signalled through
 * main (which relays SDP and ICE only — never media). One connection from the phone, one local
 * hop to the preview. The alternative would be a second connection from the phone, doubling its
 * upload and battery drain for a picture the audience never sees.
 *
 * The audience path therefore stays the shortest: phone → output window → projector. The
 * operator preview pays the extra hop, which is the right way round.
 */

import { client } from './client.ts';

type RelayMessage =
  | { loopback: 'offer'; sdp: string; id: string }
  | { loopback: 'answer'; sdp: string; id: string }
  | { loopback: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; id: string }
  | { loopback: 'end'; id: string };

const isRelayMessage = (value: unknown): value is RelayMessage =>
  typeof value === 'object' && value !== null && typeof (value as { loopback?: unknown }).loopback === 'string';

// ── publisher: runs in the output window ────────────────────────────────────────

export interface LoopbackPublisher {
  /** Publishes (or re-publishes) a stream under an id the subscriber will use. */
  publish(id: string, stream: MediaStream): void;
  unpublish(id: string): void;
  handleRelay(message: unknown): void;
  closeAll(): void;
}

export function createLoopbackPublisher(): LoopbackPublisher {
  const connections = new Map<string, RTCPeerConnection>();

  const send = (message: RelayMessage): void => {
    void client.invoke('media:relay', { to: 'operator', message });
  };

  const teardown = (id: string): void => {
    const existing = connections.get(id);
    if (!existing) return;
    connections.delete(id);
    existing.close();
  };

  return {
    publish(id, stream) {
      // Republishing replaces the previous connection outright. Reusing it would mean
      // renegotiating mid-stream, and a fresh local connection costs almost nothing.
      teardown(id);

      const connection = new RTCPeerConnection({ iceServers: [] });
      connections.set(id, connection);

      for (const track of stream.getTracks()) connection.addTrack(track, stream);

      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        send({
          loopback: 'ice',
          id,
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      };

      void connection
        .createOffer()
        .then((offer) => connection.setLocalDescription(offer).then(() => offer))
        .then((offer) => send({ loopback: 'offer', id, sdp: offer.sdp ?? '' }));
    },

    unpublish(id) {
      teardown(id);
      send({ loopback: 'end', id });
    },

    handleRelay(message) {
      if (!isRelayMessage(message)) return;
      const connection = connections.get(message.id);
      if (!connection) return;

      if (message.loopback === 'answer') {
        void connection.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        return;
      }
      if (message.loopback === 'ice' && message.candidate) {
        void connection
          .addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex,
          })
          .catch(() => undefined);
      }
    },

    closeAll() {
      for (const id of [...connections.keys()]) teardown(id);
    },
  };
}

// ── subscriber: runs in the operator window ─────────────────────────────────────

export interface LoopbackSubscriber {
  handleRelay(message: unknown): void;
  streamFor(id: string): MediaStream | null;
  onStream(listener: (id: string, stream: MediaStream | null) => void): () => void;
  closeAll(): void;
}

export function createLoopbackSubscriber(): LoopbackSubscriber {
  const connections = new Map<string, RTCPeerConnection>();
  const streams = new Map<string, MediaStream>();
  const listeners = new Set<(id: string, stream: MediaStream | null) => void>();

  const send = (message: RelayMessage): void => {
    void client.invoke('media:relay', { to: 'output', message });
  };

  const notify = (id: string, stream: MediaStream | null): void => {
    for (const listener of [...listeners]) listener(id, stream);
  };

  const teardown = (id: string): void => {
    connections.get(id)?.close();
    connections.delete(id);
    streams.delete(id);
    notify(id, null);
  };

  return {
    streamFor: (id) => streams.get(id) ?? null,

    onStream(listener) {
      listeners.add(listener);
      // Replay what already exists, so a component mounting after the stream arrived still
      // shows a picture instead of waiting for the next change.
      for (const [id, stream] of streams) listener(id, stream);
      return () => listeners.delete(listener);
    },

    handleRelay(message) {
      if (!isRelayMessage(message)) return;

      if (message.loopback === 'end') {
        teardown(message.id);
        return;
      }

      if (message.loopback === 'offer') {
        // A new offer for an existing id means the output window republished; discard the old
        // connection rather than trying to renegotiate it.
        connections.get(message.id)?.close();

        const connection = new RTCPeerConnection({ iceServers: [] });
        connections.set(message.id, connection);

        connection.onicecandidate = (event) => {
          if (!event.candidate) return;
          send({
            loopback: 'ice',
            id: message.id,
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          });
        };

        connection.ontrack = (event) => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          streams.set(message.id, stream);
          notify(message.id, stream);
        };

        void connection
          .setRemoteDescription({ type: 'offer', sdp: message.sdp })
          .then(() => connection.createAnswer())
          .then((answer) => connection.setLocalDescription(answer).then(() => answer))
          .then((answer) => send({ loopback: 'answer', id: message.id, sdp: answer.sdp ?? '' }));
        return;
      }

      if (message.loopback === 'ice' && message.candidate) {
        void connections
          .get(message.id)
          ?.addIceCandidate({
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex,
          })
          .catch(() => undefined);
      }
    },

    closeAll() {
      for (const id of [...connections.keys()]) teardown(id);
      listeners.clear();
    },
  };
}
