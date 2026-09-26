/**
 * EXCEPTIONEL PRESENTER — the AUDIENCE OUTPUT renderer (Sections 5, 6, 21).
 *
 * This window shows only the presentation. No menus, no buttons, no cursor, no operator
 * previews — ever. It is a pure render target driven entirely by `live:state` broadcasts
 * from the main process, and its preload surface cannot mutate anything.
 *
 * The layer stack (docs/ARCHITECTURE.md §5) is what makes Camera + Lyrics and
 * Camera + Scripture fall out of one mechanism rather than three special cases:
 *
 *   z4  FOREGROUND  logo / watermark
 *   z3  TEXT        lyrics | scripture | announcement
 *   z2  MEDIA       image | video | animated background
 *   z1  CAMERA      live local MediaStream
 *   z0  BASE        solid colour | gradient
 */

import { useEffect, useState, type ReactNode } from 'react';
import { resolveAudienceVisibility, type Cue, type LiveState } from '@shared/domain/live-state.ts';
import { client } from '@ui/client.ts';
import { useIpcEvent } from '@ui/hooks.ts';

/** The design canvas every theme's geometry is expressed against. */
const CANVAS = { width: 1920, height: 1080 } as const;

export function OutputApp(): JSX.Element {
  const [live, setLive] = useState<LiveState | null>(null);
  const [cues, setCues] = useState<readonly Cue[]>([]);

  useIpcEvent('live:state', setLive);
  useIpcEvent('live:cues', ({ cues: next }) => setCues(next));

  /*
   * This window owns every phone camera connection and republishes each stream to the operator
   * preview over a loopback peer connection. It is mounted here rather than in the operator
   * window because a MediaStream cannot cross a process boundary, so whichever renderer will
   * eventually drive the projector has to be the one that receives the phone.
   */
  const wireless = useWirelessCameraHost();

  // Pull once on mount: this window may open mid-service, and must render the correct
  // slide immediately rather than staying black until the next operator action.
  useEffect(() => {
    void client.invoke('live:getState').then((result) => {
      if (result.ok) setLive(result.data);
    });
  }, []);

  // Until state arrives, black is the only safe thing to show.
  if (!live) return <div className="fixed inset-0 bg-black" />;

  const visibility = resolveAudienceVisibility(live);
  const cue = live.cueIndex >= 0 ? (cues[live.cueIndex] ?? null) : null;

  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      {/*
        The canvas is letterboxed into the real display and scaled, so slide geometry
        authored at 1920x1080 lands identically on a 720p projector and a 4K wall.
      */}
      <Stage>
        {/* z0 BASE */}
        {visibility.showBase && <div className="absolute inset-0 bg-[#050B14]" />}

        {/*
          z1 CAMERA — the phone's real stream.
          Muted so the desktop never echoes phone audio into the room; the church PA handles
          sound. Kept mounted but hidden when not visible, so a black-out does not tear down the
          peer connection and force a re-buffer on restore.
        */}
        {wireless.liveStream && (
          <video
            key={wireless.liveSessionId ?? 'camera'}
            ref={wireless.attachVideo}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
            style={{ visibility: visibility.showCamera ? 'visible' : 'hidden' }}
          />
        )}

        {/* z2 MEDIA — NOT IMPLEMENTED until Phase 5. */}

        {/* z3 TEXT */}
        {visibility.showText && cue !== null && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
              paddingTop: CANVAS.height * 0.1,
              paddingBottom: CANVAS.height * 0.1,
              paddingLeft: CANVAS.width * 0.08,
              paddingRight: CANVAS.width * 0.08,
            }}
          >
            <p
              className="text-center text-white"
              style={{
                fontSize: 84,
                fontWeight: 600,
                lineHeight: 1.22,
                textShadow: '0 4px 28px rgba(0,0,0,0.75)',
                margin: 0,
              }}
            >
              {cue.label}
            </p>
          </div>
        )}

        {/* z4 FOREGROUND — reserved for an operator-placed logo. */}
      </Stage>

      {/*
        Opaque black covers every layer for a black-out. Rendered as an overlay rather than
        by unmounting the slide, so background video and camera keep running underneath and
        resume instantly on restore instead of re-buffering.
      */}
      {visibility.opaqueBlack && <div className="absolute inset-0 bg-black" />}
    </div>
  );
}

/**
 * Scales the fixed 1920x1080 design canvas to fit the window while preserving aspect
 * ratio, centring the result. Using a transform rather than percentage layout means one
 * slide definition renders pixel-proportionally on any output resolution.
 */
function Stage({ children }: { children: ReactNode }): JSX.Element {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const measure = (): void => {
      setScale(Math.min(window.innerWidth / CANVAS.width, window.innerHeight / CANVAS.height));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <div className="absolute inset-0 grid place-items-center">
      <div
        style={{
          width: CANVAS.width,
          height: CANVAS.height,
          transform: `scale(${scale})`,
          transformOrigin: 'center',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
