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
  | { loopback: 'end'; id: string }
  /**
   * Subscriber → publisher: "send me what you already have."
   *
   * THE FIX FOR A CAMERA THAT SHOWED IN ONE SECTION BUT NOT ANOTHER. A loopback offer used to be sent
   * exactly once, at the moment the phone's track arrived. So whichever operator section happened to be
   * mounted then got the picture, and any section opened afterwards got nothing — pair the camera on the
   * Camera screen, walk over to Service, and the live pane read "NO CAMERA SIGNAL" while the audience
   * output was showing the feed perfectly well.
   *
   * Carries no id: a subscriber that has just mounted does not know what exists yet.
   */
  | { loopback: 'request' };

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
  /*
   * Every stream currently published, retained so a subscriber that mounts later can be served.
   *
   * The connection alone is not enough: republishing needs the original MediaStream to build a fresh
   * offer from, and a closed RTCPeerConnection cannot give its tracks back.
   */
  const published = new Map<string, MediaStream>();

  const send = (message: RelayMessage): void => {
    void client.invoke('media:relay', { to: 'operator', message });
  };

  const teardown = (id: string): void => {
    const existing = connections.get(id);
    if (!existing) return;
    connections.delete(id);
    existing.close();
  };

  /** Builds and sends one offer. Shared by `publish` and a subscriber's `request`. */
  const offer = (id: string, stream: MediaStream): void => {
    // Republishing replaces the previous connection outright. Reusing it would mean renegotiating
    // mid-stream, and a fresh local connection costs almost nothing.
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
      .then((created) => connection.setLocalDescription(created).then(() => created))
      .then((created) => send({ loopback: 'offer', id, sdp: created.sdp ?? '' }));
  };

  return {
    publish(id, stream) {
      published.set(id, stream);
      offer(id, stream);
    },

    unpublish(id) {
      published.delete(id);
      teardown(id);
      send({ loopback: 'end', id });
    },

    handleRelay(message) {
      if (!isRelayMessage(message)) return;

      /*
       * Handled BEFORE the id lookup, because a request carries none — and because this is the whole
       * point of it: an operator section that has just mounted gets everything currently published,
       * rather than waiting for a track that arrived minutes ago to arrive again.
       */
      if (message.loopback === 'request') {
        for (const [id, stream] of published) offer(id, stream);
        return;
      }

      const connection = connections.get(message.id);
      if (!connection) return;

      if (message.loopback === 'answer') {
        void connection
          .setRemoteDescription({ type: 'answer', sdp: message.sdp })
          // A second answer for one offer lands here — two operator sections mounted at once would do
          // it. Swallowed rather than left as an unhandled rejection, since the first answer already
          // established the connection.
          .catch(() => undefined);
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
      published.clear();
    },
  };
}

// ── subscriber: runs in the operator window ─────────────────────────────────────

export interface LoopbackSubscriber {
  /**
   * Asks the publisher for everything it currently holds.
   *
   * MUST be called on mount. The publisher offers a stream when the phone's track arrives, which may
   * have been minutes ago and in a different operator section — without this, a section opened later
   * shows "no camera signal" while the audience output is displaying the feed perfectly well.
   */
  requestStreams(): void;
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
    requestStreams: () => send({ loopback: 'request' }),

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
