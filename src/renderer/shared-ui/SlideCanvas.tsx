/**
 * EXCEPTIONEL PRESENTER — the ONE renderer for everything that paints a slide.
 *
 * Used by the audience output, the operator's preview pane, the operator's live pane, the confidence
 * monitor and the theme gallery. Not five implementations that look similar — literally this
 * component, five times.
 *
 * WHY THAT MATTERS MORE THAN ANY OTHER DECISION IN PHASE 3. A preview exists so the operator can
 * trust it. A second implementation of "how a theme renders" would eventually disagree with the
 * first, and the operator would discover the disagreement on the projector, in front of the
 * congregation, with no way to tell which one had been lying. The audience screen and the preview
 * are therefore the same code with different props.
 *
 * GEOMETRY. The design canvas is a fixed 1920×1080 (docs/ARCHITECTURE.md §5), letterboxed into
 * whatever box it is given and sized in container-query units. `1cqh` is 1% of the canvas height, so
 * a theme's 84pt type is `(84/1080)*100 cqh` and lands proportionally identically in a 240px-wide
 * preview thumbnail and on a 4K wall. No resize listeners, no measurement, no scale transforms.
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { ThemeSpec } from '@shared/domain/entities.ts';
import {
  DESIGN_CANVAS,
  backgroundCss,
  fitSlideText,
  withOpacity,
} from '@shared/domain/theme.ts';

/** Which layers of the stack are permitted to paint. Mirrors `resolveAudienceVisibility`. */
export interface SlideVisibility {
  showBase: boolean;
  showCamera: boolean;
  showMedia: boolean;
  showText: boolean;
  opaqueBlack: boolean;
}

export const ALL_VISIBLE: SlideVisibility = Object.freeze({
  showBase: true,
  showCamera: true,
  showMedia: true,
  showText: true,
  opaqueBlack: false,
});

export interface SlideCanvasProps {
  spec: ThemeSpec;
  /** The audience text, one entry per authored line. Empty renders no text layer. */
  lines: readonly string[];
  visibility?: SlideVisibility;
  /**
   * The live camera feed, when the theme's background is a camera.
   *
   * A `MediaStream` rather than an id, because a stream cannot cross a process boundary and the
   * renderer holding it is the only one that can paint it.
   */
  cameraStream?: MediaStream | null;
  /**
   * Changing this restarts the text transition. Pass the cue id.
   *
   * Only the text layer animates, so advancing a lyric does not restart a background video or make
   * a camera feed flicker.
   */
  transitionKey?: string;
  /**
   * Draws honest operator-only annotations: "no camera signal", "image backgrounds arrive in
   * Phase 5", "this slide does not fit".
   *
   * OFF by default, and never enabled on the audience output. The congregation must not be shown
   * the state of our backlog, and a diagnostic caption on a projector is worse than none.
   */
  annotate?: boolean;
  className?: string;
}

export function SlideCanvas({
  spec,
  lines,
  visibility = ALL_VISIBLE,
  cameraStream = null,
  transitionKey,
  annotate = false,
  className,
}: SlideCanvasProps): JSX.Element {
  // Deterministic and pure, so the preview and the audience screen compute the same size from the
  // same cue. Memoised on identity rather than for correctness.
  const fit = useMemo(() => fitSlideText(lines, spec), [lines, spec]);

  const background = backgroundCss(spec);
  const hasText = visibility.showText && lines.length > 0;

  return (
    <div className={`relative grid place-items-center overflow-hidden bg-black ${className ?? ''}`}>
      {/*
        The letterbox. `aspect-ratio` with both maxima means the canvas fits a container of any
        shape — 16:9, 4:3, 21:9 — by shrinking on whichever axis binds, exactly as it will on an
        unknown projector. 16:9 is fixed here; honouring `presentation.aspectRatio` is Phase 7,
        alongside real display management.
      */}
      <div
        className="relative w-full"
        style={{
          aspectRatio: `${String(DESIGN_CANVAS.width)} / ${String(DESIGN_CANVAS.height)}`,
          maxWidth: '100%',
          maxHeight: '100%',
          // Establishes the container for every cqh unit below.
          containerType: 'size',
        }}
      >
        {/* ── z0 BASE ─────────────────────────────────────────────────────────── */}
        {visibility.showBase && background !== null && (
          <div className="absolute inset-0" style={{ background }} />
        )}

        {/*
          ── z1 CAMERA ─────────────────────────────────────────────────────────
          Mounted whenever a stream exists and HIDDEN rather than unmounted when the layer is not
          visible. Unmounting would destroy the video element, so a black-out would cost a visible
          re-buffer on restore — and a black-out is precisely the moment an operator needs the
          picture to come straight back.
        */}
        {cameraStream !== null && (
          <video
            className="absolute inset-0 w-full h-full object-cover"
            style={{ visibility: visibility.showCamera ? 'visible' : 'hidden' }}
            // Muted always: the church PA carries the sound, and echoing phone audio into the room
            // through the desktop is never wanted.
            autoPlay
            playsInline
            muted
            ref={(element) => {
              if (element && element.srcObject !== cameraStream) element.srcObject = cameraStream;
            }}
          />
        )}

        {/*
          An honest note when a camera theme has no feed. Operator surfaces only — the audience gets
          black, which is the correct thing to show when there is no picture.
        */}
        {annotate && spec.background.kind === 'camera' && cameraStream === null && (
          <Annotation>No camera signal</Annotation>
        )}

        {/* ── z2 MEDIA — NOT IMPLEMENTED until Phase 5 ────────────────────────── */}
        {annotate && (spec.background.kind === 'image' || spec.background.kind === 'video') && (
          <Annotation>
            {spec.background.kind === 'image' ? 'Image' : 'Video'} backgrounds arrive in Phase 5
          </Annotation>
        )}

        {/* ── z3 TEXT ─────────────────────────────────────────────────────────── */}
        {hasText && (
          <div
            className="absolute inset-0 flex flex-col"
            style={{
              // Safe-area insets as fractions of the canvas, keeping text off projector edges.
              paddingTop: `${String(spec.padding.top * 100)}%`,
              paddingBottom: `${String(spec.padding.bottom * 100)}%`,
              paddingLeft: `${String(spec.padding.left * 100)}%`,
              paddingRight: `${String(spec.padding.right * 100)}%`,
              justifyContent: 'center',
              alignItems: alignItemsFor(spec.text.align),
            }}
          >
            <div
              // Keyed on the cue so React remounts it and the animation replays.
              key={transitionKey}
              className={spec.transition.kind === 'none' ? undefined : 'ep-slide-animate'}
              style={{
                ...scrimStyle(spec),
                ...transitionStyle(spec),
                // Never wider than the safe area, so the scrim hugs the text.
                maxWidth: '100%',
              }}
            >
              {lines.map((line, index) => (
                <div
                  // Lyrics legitimately repeat a line within one slide, so the index is part of the
                  // identity. Using the text alone would make React reuse the wrong node.
                  key={`${String(index)}:${line}`}
                  style={lineStyle(spec, fit.fontSize)}
                >
                  {/* A blank line must still occupy a line box — that is how a stanza is spaced. */}
                  {line === '' ? '\u00A0' : line}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── z4 FOREGROUND — reserved for an operator-placed logo (Phase 9) ──── */}

        {/*
          A slide that cannot fit even at the smallest permitted size. Flagged to the operator so
          they can split it; the audience simply sees the smallest readable type.
        */}
        {annotate && hasText && fit.limitedBy === 'minimum' && (
          <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-status-live/85 text-white text-[10px] font-bold uppercase tracking-widest text-center">
            Too much text to fit — split this slide
          </div>
        )}

        {/*
          Opaque black covers every layer. Rendered as an overlay rather than by unmounting the
          slide, so a background video or camera keeps running underneath and resumes instantly
          instead of re-buffering.
        */}
        {visibility.opaqueBlack && <div className="absolute inset-0 bg-black" />}
      </div>
    </div>
  );
}

function Annotation({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,#0d1a28_0px,#0d1a28_8px,#0a1421_8px,#0a1421_16px)]">
      <span className="px-2 text-center text-[9px] uppercase tracking-[0.2em] text-silver-700">
        {children}
      </span>
    </div>
  );
}

const alignItemsFor = (align: ThemeSpec['text']['align']): string =>
  align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';

/** Canvas points to container-query height units, the conversion this whole file rests on. */
const cqh = (canvasValue: number): string => `${String((canvasValue / DESIGN_CANVAS.height) * 100)}cqh`;

function lineStyle(spec: ThemeSpec, fontSize: number): CSSProperties {
  const { text } = spec;
  return {
    fontFamily: text.fontFamily,
    fontSize: cqh(fontSize),
    fontWeight: text.fontWeight,
    color: text.color,
    textAlign: text.align,
    lineHeight: text.lineHeight,
    letterSpacing: `${String(text.letterSpacing)}em`,
    // Long lines wrap inside the safe area rather than running off the screen.
    overflowWrap: 'break-word',
    whiteSpace: 'pre-wrap',
    ...(text.shadow.enabled
      ? { textShadow: `0 ${cqh(text.shadow.offsetY)} ${cqh(text.shadow.blur)} ${text.shadow.color}` }
      : {}),
    ...(text.outline.enabled
      ? {
          // Paints the stroke behind the glyph rather than over it, so an outline does not eat into
          // the letterforms and make text harder to read from the back of the room.
          WebkitTextStroke: `${cqh(text.outline.width)} ${text.outline.color}`,
          paintOrder: 'stroke fill',
        }
      : {}),
  } as CSSProperties;
}

/** The scrim behind text, which is what makes lyrics legible over a camera feed. */
function scrimStyle(spec: ThemeSpec): CSSProperties {
  if (!spec.textBox.enabled) return {};
  return {
    backgroundColor: withOpacity(spec.textBox.color, spec.textBox.opacity),
    borderRadius: cqh(spec.textBox.cornerRadius),
    padding: `${cqh(24)} ${cqh(40)}`,
  };
}

function transitionStyle(spec: ThemeSpec): CSSProperties {
  if (spec.transition.kind === 'none') return {};
  const name = spec.transition.kind === 'slide' ? 'ep-slide-in' : 'ep-slide-fade';
  return {
    animationName: name,
    animationDuration: `${String(spec.transition.durationMs)}ms`,
    animationTimingFunction: 'ease-out',
    animationFillMode: 'both',
  };
}
