/**
 * EXCEPTIONEL PRESENTER — hosts every phone camera connection in the output window.
 *
 * Wires three things together:
 *   1. phone signalling relayed from main → the desktop RTCPeerConnection
 *   2. the received MediaStream → republished to the operator preview over loopback
 *   3. peer state and getStats() → back to main, so the state machine and the quality grade
 *      reflect what is actually happening on the wire
 *
 * The stream object never leaves this renderer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CameraSource } from '@shared/domain/camera.ts';
import type { SignalMessage } from '@shared/domain/signaling.ts';
import { client } from '@ui/client.ts';
import { useIpcEvent } from '@ui/hooks.ts';
import { createLoopbackPublisher } from '@ui/loopback.ts';
import { createWirelessReceiver } from './wireless-receiver.ts';
import { sourceIdForSession } from './source-id.ts';

export interface WirelessCameraHost {
  /** The stream currently assigned to the audience output, if any. */
  liveStream: MediaStream | null;
  liveSessionId: string | null;
  /** Ref callback that attaches the live stream to a video element. */
  attachVideo: (element: HTMLVideoElement | null) => void;
}

export function useWirelessCameraHost(): WirelessCameraHost {
  const publisher = useMemo(() => createLoopbackPublisher(), []);
  const streams = useRef(new Map<string, MediaStream>());
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [, bump] = useState(0);

  const receiver = useMemo(
    () =>
      createWirelessReceiver({
        onTrack: (sessionId, stream) => {
          streams.current.set(sessionId, stream);

          // Republish to the operator preview. Re-firing on a camera switch is expected and
          // simply replaces the previous loopback connection.
          publisher.publish(sourceIdForSession(sessionId), stream);
          bump((value) => value + 1);
        },

        onMedia: (sessionId) => {
          // A dedicated channel, not a peer-state report: this is the only route to `connected`,
          // so it must not be confusable with anything else. It fires when RTP actually arrives,
          // which is why `connected` in the operator UI means a picture and not a handshake.
          void client.invoke('wireless:track', { sessionId });
        },

        onState: (sessionId, state) => {
          void client.invoke('wireless:signal', { sessionId, message: { kind: 'state', state } });
        },

        onStats: (sessionId, stats) => {
          /*
           * Straight to main, which grades them.
           *
           * This previously sent a `ping` to the phone (which ignores it) and relayed the numbers to
           * the OPERATOR window as a `media:relay` — where the loopback subscriber discarded them,
           * because they are not loopback signalling. So `reportStats` was never called by anything
           * and the operator's Latency and Connection readings could never show a value.
           *
           * Main is the right destination regardless: it owns the state machine that decides whether
           * the numbers are stale, and every window reads them from the same snapshot.
           */
          void client.invoke('wireless:stats', { sessionId, ...stats });
        },

        onClosed: (sessionId) => {
          streams.current.delete(sessionId);
          publisher.unpublish(sourceIdForSession(sessionId));
          bump((value) => value + 1);
        },
      }),
    [publisher],
  );

  useIpcEvent('wireless:signal', ({ sessionId, message }) => {
    const kind = (message as { kind?: string } | null)?.kind ?? 'unknown';
    // Forwarded to the terminal by the main process, so the whole handshake is traceable.
    console.log(`[output] handling ${kind} for ${sessionId}`);
    void receiver.handle(sessionId, message as SignalMessage).catch((error: unknown) => {
      // A rejected promise here would otherwise be invisible and the handshake would just stall.
      console.error(`[output] failed to handle ${kind}:`, error);
    });
  });

  useIpcEvent('media:relay', ({ message }) => publisher.handleRelay(message));

  // Whichever source the operator put live decides what this window renders.
  useIpcEvent('camera:sources', (sources: CameraSource[]) => {
    const live = sources.find((source) => source.assignment === 'live' && source.isWireless);
    setLiveSessionId(live ? live.id.replace(/^phone:/, '') : null);
  });

  useEffect(
    () => () => {
      receiver.closeAll();
      publisher.closeAll();
    },
    [receiver, publisher],
  );

  const liveStream = liveSessionId ? (streams.current.get(liveSessionId) ?? null) : null;

  const attachVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      if (!element) return;
      if (element.srcObject !== liveStream) element.srcObject = liveStream;
    },
    [liveStream],
  );

  return { liveStream, liveSessionId, attachVideo };
}
