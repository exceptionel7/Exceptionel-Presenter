/**
 * EXCEPTIONEL PRESENTER — theme resolution and slide text fitting (Sections 16, 21).
 *
 * ZERO dependencies, so main, the operator renderer, the audience output and the confidence
 * monitor all share ONE definition of what a theme means.
 *
 * That sharing is the point. Before this file existed, `BASE_THEME_SPEC` and `mergeSpec` lived in
 * `main/db/repositories/themes.ts` and were COPIED into `Themes.tsx` as `FALLBACK`/`mergePreview`,
 * because a renderer cannot import from main. Two definitions of "what a theme defaults to" is a
 * guarantee that the operator's preview and the audience screen will eventually disagree — and the
 * operator would have no way to know which one was lying.
 */

import type { Theme, ThemeSpec } from './entities.ts';

/**
 * The fallback every theme resolves against, so the presentation renderer always receives a
 * complete spec and never has to guard a missing field mid-service.
 */
export const BASE_THEME_SPEC: ThemeSpec = Object.freeze({
  background: { kind: 'solid', value: '#000000' },
  text: {
    fontFamily: 'Inter',
    fontSize: 72,
    fontWeight: 600,
    color: '#FFFFFF',
    align: 'center',
    lineHeight: 1.3,
    letterSpacing: 0,
    shadow: { enabled: true, color: 'rgba(0,0,0,0.7)', blur: 24, offsetY: 4 },
    outline: { enabled: false, color: '#000000', width: 0 },
    // On by default: overflowing text is never the right answer, and a theme that wants fixed
    // type can turn it off deliberately.
    autoFit: { enabled: true, minScale: 0.45 },
  },
  padding: { top: 0.1, right: 0.08, bottom: 0.1, left: 0.08 },
  textBox: { enabled: false, color: '#000000', opacity: 0, cornerRadius: 0 },
  transition: { kind: 'fade', durationMs: 250 },
}) as ThemeSpec;

/** The normalised design canvas every theme's geometry is expressed against (§5). */
export const DESIGN_CANVAS = Object.freeze({ width: 1920, height: 1080 });

/**
 * The application's fallback theme id, matching the row seeded by migration 0002.
 *
 * Declared here, once, because it was previously written out as a literal in three places — and one
 * of them, `createInitialLiveState`, had it as `'modern-worship'` without the `theme-` prefix. That
 * id matches no row in the database, so any code path taking that default resolved to no theme at
 * all. Production happened to avoid it by reading the setting explicitly, which is precisely what
 * makes this kind of mistake survive: it is only wrong on the path nobody exercises.
 */
export const DEFAULT_THEME_ID = 'theme-modern-worship';

/**
 * Field-level merge, one level into each group.
 *
 * Themes override individual properties (say, just `text.color`) without having to restate the
 * whole group — a blind spread would wipe the sibling fields, so a theme that set only
 * `text.color` would silently lose the base font, size, weight and shadow.
 */
export function mergeSpec(base: ThemeSpec, override: Partial<ThemeSpec>): ThemeSpec {
  return {
    background: { ...base.background, ...(override.background ?? {}) },
    text: {
      ...base.text,
      ...(override.text ?? {}),
      shadow: { ...base.text.shadow, ...(override.text?.shadow ?? {}) },
      outline: { ...base.text.outline, ...(override.text?.outline ?? {}) },
      autoFit: { ...base.text.autoFit, ...(override.text?.autoFit ?? {}) },
    },
    padding: { ...base.padding, ...(override.padding ?? {}) },
    textBox: { ...base.textBox, ...(override.textBox ?? {}) },
    transition: { ...base.transition, ...(override.transition ?? {}) },
  };
}

/**
 * Flattens a theme and its ancestors into one complete spec, working from a list of themes.
 *
 * Takes a list rather than a lookup callback so a renderer that already holds the result of
 * `themes:list` can resolve without a further IPC round trip per slide change. The main process
 * repository delegates here, which is what keeps the two paths identical.
 *
 * Returns null for an unknown id — the caller must decide, since rendering with a silent default
 * would hide a broken service.
 */
export function resolveThemeSpec(themes: readonly Theme[], id: string): ThemeSpec | null {
  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  const chain: Theme[] = [];
  const seen = new Set<string>();

  let cursor = byId.get(id);
  if (!cursor) return null;

  while (cursor) {
    // Defensive: the repository rejects cycles on save, but a hand-edited database must degrade
    // rather than hang the process that is driving a live service.
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentThemeId ? byId.get(cursor.parentThemeId) : undefined;
  }

  // Applied from the most distant ancestor down to the requested theme, so nearer wins.
  return chain.reverse().reduce<ThemeSpec>((spec, theme) => mergeSpec(spec, theme.spec), BASE_THEME_SPEC);
}

/** Resolves, falling back to the base spec so a live service can never be left with nothing. */
export const resolveThemeSpecOrBase = (themes: readonly Theme[], id: string | null): ThemeSpec =>
  (id === null ? null : resolveThemeSpec(themes, id)) ?? BASE_THEME_SPEC;

// ── fitting text to the canvas ───────────────────────────────────────────────────

/**
 * Average glyph advance as a fraction of font size, for the humanist sans-serif faces this
 * application ships with at display weights.
 *
 * An ESTIMATE, and the only estimate in this file. It exists to predict WRAPPING, which is what
 * makes vertical overflow unpredictable. Real per-glyph measurement needs a DOM and a loaded font;
 * that belongs in the renderer and cannot be unit-tested here, so the arithmetic that decides
 * whether a slide fits is deliberately kept pure and slightly conservative instead.
 *
 * Consequence to be honest about: a slide of unusually wide text (all capitals, or a font much
 * wider than Inter) may still wrap one line more than predicted. The CSS in SlideCanvas therefore
 * also allows the text block to shrink visually, so the worst case is slightly smaller type rather
 * than text running off the screen.
 */
export const AVERAGE_GLYPH_WIDTH_RATIO = 0.52;

/** Scale is reduced in fixed steps, so the result is deterministic and testable. */
const FIT_STEP = 0.02;

/*
 * THE GEOMETRY THE RENDERER ACTUALLY DRAWS, in canvas units.
 *
 * Shared with SlideCanvas rather than duplicated there, because the fitter has to model what will be
 * painted or it is not fitting anything. The first version measured ONLY the text lines while the
 * renderer went on to add scrim padding and a caption beneath them — around 110 canvas pixels the
 * arithmetic knew nothing about. In the Live Worship theme, whose safe area is a 400-pixel lower third,
 * that was enough to push the last line and the whole reference past the edge, where `overflow: hidden`
 * silently clipped them. A verse cut off mid-sentence on the audience screen, with nothing to indicate
 * it had happened.
 */
export const SCRIM_PADDING_Y = 24;
export const SCRIM_PADDING_X = 40;
/** A caption is a little over half the body size: clearly secondary, still readable from the back. */
export const CAPTION_SCALE = 0.55;
/** Gap above the caption, as a fraction of the body font size. */
export const CAPTION_GAP = 0.45;
export const CAPTION_LINE_HEIGHT = 1.2;

/**
 * A little height held back to absorb the difference between predicted and real font metrics.
 *
 * Two per cent of the safe area. Slightly smaller type is invisible; a clipped final line is not.
 */
export const FIT_SAFETY = 0.02;

export interface SlideFit {
  /** The font size to render at, in canvas points. */
  fontSize: number;
  /** `fontSize` as a fraction of the theme's declared size. 1 means untouched. */
  scale: number;
  /** Lines after predicted wrapping. Equals `lines.length` when nothing wraps. */
  estimatedLineCount: number;
  /**
   * Why the size ended up where it did.
   *
   * `minimum` is the honest admission: even at the smallest permitted size the slide is predicted
   * to overflow. The operator can act on that — split the slide, or shorten the line.
   */
  limitedBy: 'none' | 'fit' | 'minimum' | 'disabled';
}

/**
 * Chooses a font size at which a slide is predicted to fit inside the theme's safe area.
 *
 * The VERTICAL arithmetic is exact: available height, line count, line height and font size are all
 * known quantities. Only the wrapped line count is predicted.
 */
export function fitSlideText(
  lines: readonly string[],
  spec: ThemeSpec,
  canvas: { width: number; height: number } = DESIGN_CANVAS,
  options: {
    /**
     * Whether a caption will be drawn beneath the text.
     *
     * Must be passed when one will be, or the fit is computed for a block smaller than the one that gets
     * painted — which is exactly how a scripture reference and the last line of a verse ended up clipped
     * off the bottom of the screen.
     */
    hasCaption?: boolean;
  } = {},
): SlideFit {
  const declared = spec.text.fontSize;

  const availableWidth = canvas.width * (1 - spec.padding.left - spec.padding.right);
  /*
   * The safe area, less what the renderer adds around the text and a small safety margin.
   *
   * The scrim's padding is fixed; the caption scales with the body, so it is folded into `heightAt`
   * below rather than subtracted once here.
   */
  const scrimPadding = spec.textBox.enabled ? SCRIM_PADDING_Y * 2 : 0;
  const availableHeight =
    canvas.height * (1 - spec.padding.top - spec.padding.bottom) * (1 - FIT_SAFETY) - scrimPadding;

  const countWrapped = (fontSize: number): number => {
    // Advance per character including tracking, since letter spacing genuinely changes wrapping.
    const perCharacter = fontSize * (AVERAGE_GLYPH_WIDTH_RATIO + spec.text.letterSpacing);
    if (perCharacter <= 0 || availableWidth <= 0) return lines.length;

    let total = 0;
    for (const line of lines) {
      const width = line.length * perCharacter;
      // An empty line still occupies one line box — that is how a lyric slide spaces a stanza.
      total += Math.max(1, Math.ceil(width / availableWidth));
    }
    return total;
  };

  /** Everything inside the scrim: the wrapped lines, and the caption if one will be drawn. */
  const heightAt = (fontSize: number): number => {
    const body = countWrapped(fontSize) * fontSize * spec.text.lineHeight;
    const caption =
      options.hasCaption === true ? fontSize * (CAPTION_SCALE * CAPTION_LINE_HEIGHT + CAPTION_GAP) : 0;
    return body + caption;
  };

  if (lines.length === 0) {
    return { fontSize: declared, scale: 1, estimatedLineCount: 0, limitedBy: 'none' };
  }

  if (!spec.text.autoFit.enabled) {
    // Reported honestly rather than silently: the theme asked for a fixed size, so overflow is a
    // deliberate choice by whoever authored it.
    return {
      fontSize: declared,
      scale: 1,
      estimatedLineCount: countWrapped(declared),
      limitedBy: 'disabled',
    };
  }

  if (heightAt(declared) <= availableHeight) {
    return { fontSize: declared, scale: 1, estimatedLineCount: countWrapped(declared), limitedBy: 'none' };
  }

  const minScale = Math.min(Math.max(spec.text.autoFit.minScale, 0.05), 1);

  for (let scale = 1 - FIT_STEP; scale >= minScale - 1e-9; scale -= FIT_STEP) {
    const fontSize = declared * scale;
    if (heightAt(fontSize) <= availableHeight) {
      return {
        fontSize,
        scale,
        estimatedLineCount: countWrapped(fontSize),
        limitedBy: 'fit',
      };
    }
  }

  const fontSize = declared * minScale;
  return {
    fontSize,
    scale: minScale,
    estimatedLineCount: countWrapped(fontSize),
    limitedBy: 'minimum',
  };
}

// ── CSS helpers shared by every surface that paints a slide ──────────────────────

/** Applies an opacity to a hex colour, for the scrim behind text over a camera or image. */
export function withOpacity(hex: string, opacity: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return hex;
  const value = Number.parseInt(match[1] ?? '0', 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

/**
 * The CSS background for a spec, i.e. what the BASE layer (z0) paints.
 *
 * `camera`, `image` and `video` all return null, and for the same reason in every case: each is
 * painted by a layer of its own above the base, and a colour underneath would only be something for
 * them to fail to cover. It is not a stand-in for an unimplemented feature — SlideCanvas paints all
 * three for real.
 */
export function backgroundCss(spec: ThemeSpec): string | null {
  switch (spec.background.kind) {
    case 'solid':
    case 'gradient':
      return spec.background.value;
    case 'camera':
    case 'image':
    case 'video':
      return null;
  }
}

/**
 * What the z2 MEDIA layer should show, or null when it should show nothing.
 *
 * Pure, and shared by every surface that paints a slide, so the operator's preview and the audience
 * screen can never disagree about which background is on.
 *
 * Returns null when the kind is `image` or `video` but no asset has been chosen. That is a real state
 * — a theme someone started configuring and left — and it must be distinguishable from "no media
 * background", because an operator surface has to say "no image chosen" rather than show black and
 * let them wonder.
 */
export function backgroundMedia(spec: ThemeSpec): SlideMedia | null {
  const { kind, mediaAssetId, fit } = spec.background;
  if (kind !== 'image' && kind !== 'video') return null;
  if (mediaAssetId === null || mediaAssetId === undefined || mediaAssetId === '') return null;
  return { assetId: mediaAssetId, kind, fit: fit ?? 'cover' };
}

/** What the media layer paints. Identical whether it came from a theme or from a cue. */
export interface SlideMedia {
  assetId: string;
  kind: 'image' | 'video';
  fit: 'cover' | 'contain';
}

/**
 * Decides what the media layer shows, given a theme and whatever the CUE asked for.
 *
 * The precedence, in one place: a cue that IS a piece of media overrides the theme's background; a cue
 * that explicitly wants nothing there (`null`) gets nothing; a cue with no opinion (`undefined`) gets
 * the theme's background. Pure, so the operator's preview and the audience screen resolve it
 * identically — this rule living in a component would be a rule only a browser could check.
 */
export function resolveSlideMedia(
  spec: ThemeSpec,
  cueMedia?: SlideMedia | null,
): SlideMedia | null {
  return cueMedia === undefined ? backgroundMedia(spec) : cueMedia;
}

/**
 * True when the theme asks for a media background but names no asset.
 *
 * Exists so operator surfaces can annotate honestly. `backgroundMedia` returning null is ambiguous on
 * its own: it means both "this theme has no media background" and "this theme's media background is
 * unfinished", and only the second is worth telling someone about.
 */
export const isMediaBackgroundUnset = (spec: ThemeSpec): boolean =>
  (spec.background.kind === 'image' || spec.background.kind === 'video') &&
  backgroundMedia(spec) === null;

export function describeBackground(spec: ThemeSpec): string {
  switch (spec.background.kind) {
    case 'solid':
      return spec.background.value;
    case 'gradient':
      return 'gradient';
    case 'camera':
      return 'live camera';
    case 'image':
      return isMediaBackgroundUnset(spec) ? 'image — none chosen' : 'image';
    case 'video':
      // Stated, because it is a real limitation rather than an oversight: a background plays silently
      // and on a loop. Audio playback is a separate feature and is NOT IMPLEMENTED.
      return isMediaBackgroundUnset(spec) ? 'video — none chosen' : 'video (silent, looping)';
  }
}
