/**
 * EXCEPTIONEL PRESENTER — turning a service into the cue list the live engine steps through.
 *
 * ZERO dependencies, so the whole expansion is unit-testable without a database, Electron or a
 * display. This is the heart of Phase 3: it is what makes "open the service and press Next" mean
 * something.
 *
 * THE RULE THIS FILE ENFORCES. An item whose feature has not been built produces NO CUE, and says
 * why. It is never silently dropped, and it never produces a slide reading "not implemented" — the
 * audience must not be shown the state of our backlog. The operator sees the explanation; the
 * congregation sees nothing.
 */

import type { Service, ServiceItem, ServiceItemKind, Song } from './entities.ts';
import type { Cue } from './live-state.ts';
import { songToSlides } from './song.ts';

/**
 * Which theme each kind of cue renders with.
 *
 * Separate ids rather than one theme with per-kind variants, because that is how the seeded
 * settings already model it: `presentation.lyricsThemeId`, `presentation.scriptureThemeId`,
 * `presentation.cameraThemeId` and `presentation.defaultThemeId`. Lyrics over a camera feed and
 * scripture on a dark gradient are genuinely different designs, not variations of one.
 */
export interface CueThemes {
  default: string | null;
  lyrics: string | null;
  scripture: string | null;
  camera: string | null;
}

export const NO_THEMES: CueThemes = Object.freeze({
  default: null,
  lyrics: null,
  scripture: null,
  camera: null,
});

/** Why an item in the running order produced nothing to present. */
export type SkipReason =
  | { code: 'not-implemented'; phase: string; detail: string }
  | { code: 'missing-song'; phase: null; detail: string }
  | { code: 'empty-song'; phase: null; detail: string };

export interface SkippedItem {
  itemId: string;
  label: string;
  kind: ServiceItemKind;
  reason: SkipReason;
}

export interface BuiltCues {
  cues: Cue[];
  /**
   * Items that will present nothing, with a reason for each.
   *
   * Returned alongside the cues rather than logged, so the operator interface can show it. An
   * operator who builds a service on Thursday must find out then that its scripture readings cannot
   * be presented yet — not by pressing Next on Sunday and watching nothing happen.
   *
   * Headers are absent by design: they are dividers in the running order and were never meant to
   * reach a screen, so reporting them as a problem would be noise.
   */
  skipped: SkippedItem[];
}

/** Bound on generated cue ids, matching the `vId()` validator the IPC layer applies. */
const MAX_ID_LENGTH = 64;

/**
 * Expands a service's items into cues.
 *
 * Song sections are presented in their stored order. Per-service arrangements — the classic
 * V1 / C / V2 / C / Bridge / C — are a Phase 8 service-builder concern: they need a UI to author
 * them and a defined shape in `service_items.config`, and inventing that contract here would
 * pre-empt a decision that belongs with the builder.
 */
export function buildCues(input: {
  service: Pick<Service, 'themeId' | 'items'>;
  songs: readonly Song[];
  themes?: CueThemes;
}): BuiltCues {
  const themes = input.themes ?? NO_THEMES;
  const songsById = new Map(input.songs.map((song) => [song.id, song]));

  // A theme set on the service overrides the application default, but never a kind-specific
  // choice: someone who has picked a scripture theme means it for every service.
  const fallbackTheme = input.service.themeId ?? themes.default;

  const cues: Cue[] = [];
  const skipped: SkippedItem[] = [];

  const skip = (item: ServiceItem, reason: SkipReason): void => {
    skipped.push({ itemId: item.id, label: item.label, kind: item.kind, reason });
  };

  for (const item of input.service.items) {
    switch (item.kind) {
      case 'header':
        // A divider in the operator's running order. Deliberately produces nothing.
        continue;

      case 'song': {
        if (item.refId === null) {
          skip(item, {
            code: 'missing-song',
            phase: null,
            detail: 'This item is not linked to a song in the library.',
          });
          continue;
        }

        const song = songsById.get(item.refId);
        if (!song) {
          // The song was deleted after the service was built. Reported, not guessed at.
          skip(item, {
            code: 'missing-song',
            phase: null,
            detail: 'The song this item points to is no longer in the library.',
          });
          continue;
        }

        const slides = songToSlides(song.sections);
        if (slides.length === 0) {
          skip(item, {
            code: 'empty-song',
            phase: null,
            detail: `"${song.title}" has no lyrics yet, so there is nothing to present.`,
          });
          continue;
        }

        slides.forEach((slide, index) => {
          cues.push({
            id: cueId(item.id, index),
            kind: 'lyric',
            itemId: item.id,
            // The song title travels with every slide so the operator can always see which song
            // they are in, however deep the running order is scrolled.
            label: `${song.title} — ${slide.sectionLabel}`,
            lines: slide.lines,
            themeId: themes.lyrics ?? fallbackTheme,
            ...notesOf(item),
          });
        });
        continue;
      }

      case 'camera_scene':
        /*
         * Presentable now: the wireless camera layer is real and tested on hardware. No text, so
         * `lines` is empty — the audience sees the camera, and the theme decides whether anything
         * is drawn over it.
         */
        cues.push({
          id: cueId(item.id, 0),
          kind: 'camera',
          itemId: item.id,
          label: item.label,
          lines: [],
          themeId: themes.camera ?? fallbackTheme,
          ...notesOf(item),
        });
        continue;

      case 'scripture':
        skip(item, {
          code: 'not-implemented',
          phase: 'Phase 4',
          detail:
            'Scripture needs the Bible module: reference parsing and an installed translation. No scripture text is bundled.',
        });
        continue;

      case 'image':
      case 'video':
        skip(item, {
          code: 'not-implemented',
          phase: 'Phase 5',
          detail: 'Images and video need the media library, which handles import and streaming playback.',
        });
        continue;

      case 'announcement':
        skip(item, {
          code: 'not-implemented',
          phase: 'Phase 9',
          detail: 'Announcements are stored but have no editor or renderer yet.',
        });
        continue;

      case 'slide':
        skip(item, {
          code: 'not-implemented',
          phase: 'Phase 9',
          detail: 'Custom slides need the presentation designer.',
        });
        continue;
    }
  }

  return { cues, skipped };
}

/**
 * A cue id derived from its item and position, so it is stable across reopening the same service.
 *
 * Stability matters: `LiveStateService.setCues` re-points the live cue by id, so an operator who
 * edits the running order mid-service keeps their place instead of being thrown back to black.
 *
 * Truncated from the FRONT of the item id when it would exceed the validator's limit, because the
 * distinguishing part of a generated id is its tail.
 */
function cueId(itemId: string, index: number): string {
  const suffix = `_${index}`;
  const room = MAX_ID_LENGTH - 'cue_'.length - suffix.length;
  const trimmed = itemId.length > room ? itemId.slice(itemId.length - room) : itemId;
  return `cue_${trimmed}${suffix}`;
}

/** Notes live on the item and are copied to every cue it produces, for the confidence monitor. */
function notesOf(item: ServiceItem): { notes?: string } {
  const notes = item.config['notes'];
  return typeof notes === 'string' && notes.trim() !== '' ? { notes } : {};
}

/**
 * How many cues an item will contribute, without building them.
 *
 * Used by the operator's running order to show "12 slides" beside a song. Deliberately derived from
 * `buildCues` rather than reimplemented, because two counting rules would eventually disagree and
 * the operator would be told a song has more slides than Next will actually step through.
 */
export function countItemCues(
  item: ServiceItem,
  songs: readonly Song[],
): number {
  return buildCues({ service: { themeId: null, items: [item] }, songs }).cues.length;
}
