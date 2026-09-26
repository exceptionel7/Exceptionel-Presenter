/**
 * EXCEPTIONEL PRESENTER — opening a service for presentation (Phase 3).
 *
 * ONE path from "a service in the database" to "a cue list the operator can step through", used by
 * both the `services:open` channel and crash recovery. Two paths would drift, and the day they
 * drifted would be the day a recovered service behaved differently from a freshly opened one —
 * during the service, which is the only time recovery is ever used.
 *
 * Cue construction lives in the MAIN process, not the operator renderer, for two reasons:
 *   - the audience output is forbidden from reading the library, so cues must arrive already
 *     carrying their own text (see the note on `Cue.lines`);
 *   - main owns live state, so a renderer cannot hand it a cue list that disagrees with the
 *     database.
 */

import { buildCues, type CueThemes, type SkippedItem } from '../../shared/domain/cues.ts';
import type { Service, Song } from '../../shared/domain/entities.ts';
import type { Cue } from '../../shared/domain/live-state.ts';
import { DEFAULT_THEME_ID } from '../../shared/domain/theme.ts';
import type { AppDatabase } from '../db/database.ts';
import type { LiveStateService } from './live-state-service.ts';

export interface OpenedService {
  service: Service;
  cues: Cue[];
  skipped: SkippedItem[];
}

/**
 * Reads the per-kind theme choices.
 *
 * Falls back to the seeded default rather than null, because a cue with no theme would leave the
 * output renderer deciding for itself — and a projector guessing is how a service ends up in the
 * wrong colours with nobody able to explain why.
 */
export function readCueThemes(db: AppDatabase): CueThemes {
  const setting = (key: string, fallback: string | null): string | null => {
    const value = db.settings.get<unknown>(key, fallback);
    return typeof value === 'string' && value !== '' ? value : fallback;
  };

  const fallback = setting('presentation.defaultThemeId', DEFAULT_THEME_ID);
  return {
    default: fallback,
    lyrics: setting('presentation.lyricsThemeId', fallback),
    scripture: setting('presentation.scriptureThemeId', fallback),
    camera: setting('presentation.cameraThemeId', fallback),
  };
}

/**
 * Loads a service, expands it into cues, and installs them as the live cue list.
 *
 * Returns null for an unknown or deleted service rather than throwing: "that service is gone" is an
 * answer the operator interface can render, whereas an exception becomes a red failure banner that
 * says less.
 */
export function openService(
  db: AppDatabase,
  live: LiveStateService,
  serviceId: string,
): OpenedService | null {
  const service = db.services.get(serviceId);
  if (!service) return null;

  /*
   * Only the songs this service actually references are loaded.
   *
   * `songs.get` is a per-song read including its sections, so a service of twelve items costs
   * twelve reads — not the whole library, which on a church with two thousand songs would be the
   * difference between opening instantly and visibly stalling.
   */
  const songIds = new Set<string>();
  for (const item of service.items) {
    if (item.kind === 'song' && item.refId !== null) songIds.add(item.refId);
  }

  const songs: Song[] = [];
  for (const id of songIds) {
    const song = db.songs.get(id);
    // A missing song is not an error here. `buildCues` reports it as a skipped item, which is how
    // the operator finds out that a song was deleted after the service was built.
    if (song) songs.push(song);
  }

  const themes = readCueThemes(db);
  const built = buildCues({ service, songs, themes });

  live.setCues(built.cues);

  /*
   * The live state's own theme is the last-resort fallback for a cue that names none. Set from the
   * service if it has one, otherwise the application default.
   */
  const themeId = service.themeId ?? themes.default ?? DEFAULT_THEME_ID;
  live.apply({ type: 'setTheme', themeId });

  return { service, cues: built.cues, skipped: built.skipped };
}
