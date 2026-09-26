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

          // Tell main a REAL track arrived. This is the only path to the `connected` state, so
          // a completed handshake with no media can never look like a working camera.
          void client.invoke('wireless:signal', {
            sessionId,
            message: { kind: 'state', state: 'connected' },
          });
          bump((value) => value + 1);
        },

        onState: (sessionId, state) => {
          void client.invoke('wireless:signal', { sessionId, message: { kind: 'state', state } });
        },

        onStats: (sessionId, stats) => {
          // Reported as a ping carrying measured values; main grades quality with the existing
          // worst-of-three rule rather than trusting anything computed here.
          void client.invoke('wireless:signal', {
            sessionId,
            message: { kind: 'ping', at: Date.now() },
          });
          void client.invoke('media:relay', {
            to: 'operator',
            message: { stats: { sessionId, ...stats } },
          });
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
