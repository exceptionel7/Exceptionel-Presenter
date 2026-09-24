/**
 * EXCEPTIONEL PRESENTER — per-channel request validators.
 *
 * The main process refuses to dispatch any channel that has no entry here. That is a
 * fail-closed design: adding a handler without a validator makes the channel unreachable
 * rather than unguarded, so the insecure path is the one that doesn't work.
 */

import {
  CAMERA_PROVIDERS,
  DISPLAY_ROLES,
  MEDIA_KINDS,
  SLIDE_BREAK_MODES,
  SERVICE_ITEM_KINDS,
  SONG_SECTION_KINDS,
} from '../domain/entities.ts';
import type { IpcChannel } from '../ipc-contract.ts';
import {
  vAccelerator,
  vArray,
  vBoolean,
  vDateOnly,
  vEnum,
  vId,
  vInt,
  vNullable,
  vNumber,
  vObject,
  vOptional,
  vString,
  vTagged,
  vUnknown,
  vVoid,
  type Validator,
} from './validate.ts';

/** Optional nullable text field — the shape most entity columns take. */
const vText = (max: number) => vOptional(vNullable(vString({ max })));

const vJsonRecord = (): Validator<Record<string, unknown>> => ({
  parse(input, path = '') {
    if (input === undefined || input === null) return { ok: true, value: {} };
    if (typeof input !== 'object' || Array.isArray(input))
      return { ok: false, path, message: 'expected a JSON object' };
    // Guard against prototype pollution before this reaches JSON.stringify → SQLite.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      if (Object.prototype.hasOwnProperty.call(input, key))
        return { ok: false, path: `${path}.${key}`, message: 'forbidden key' };
    }
    return { ok: true, value: input as Record<string, unknown> };
  },
});

const vSongSectionDraft = vObject({
  id: vOptional(vId()),
  kind: vEnum(SONG_SECTION_KINDS),
  label: vString({ min: 1, max: 80 }),
  sortOrder: vInt({ min: 0, max: 999 }),
  // Lyrics keep their internal newlines — trim: false, since blank lines are slide breaks.
  lyrics: vString({ max: 20_000, trim: false }),
  slideBreakMode: vEnum(SLIDE_BREAK_MODES),
});

const vSongDraft = vObject({
  id: vOptional(vId()),
  title: vString({ min: 1, max: 300 }),
  artist: vText(200),
  author: vText(200),
  copyright: vText(500),
  ccliNumber: vOptional(vNullable(vString({ max: 32, pattern: /^[0-9]*$/ }))),
  songKey: vText(16),
  notes: vText(5_000),
  category: vText(80),
  isFavorite: vOptional(vBoolean()),
  sections: vArray(vSongSectionDraft, { max: 200 }),
});

const vServiceItemDraft = vObject({
  id: vOptional(vId()),
  kind: vEnum(SERVICE_ITEM_KINDS),
  label: vString({ min: 1, max: 300 }),
  sortOrder: vInt({ min: 0, max: 9_999 }),
  refId: vOptional(vNullable(vId())),
  config: vOptional(vJsonRecord()),
});

const vServiceDraft = vObject({
  id: vOptional(vId()),
  name: vString({ min: 1, max: 200 }),
  serviceDate: vOptional(vNullable(vDateOnly())),
  themeId: vOptional(vNullable(vId())),
  notes: vText(20_000),
  items: vArray(vServiceItemDraft, { max: 1_000 }),
});

/** Live intents: the discriminated union from domain/live-state.ts. */
const vLiveIntent = vTagged('type', {
  goLive: vObject({ type: vEnum(['goLive'] as const), cueId: vId() }),
  next: vObject({ type: vEnum(['next'] as const) }),
  previous: vObject({ type: vEnum(['previous'] as const) }),
  goToIndex: vObject({ type: vEnum(['goToIndex'] as const), index: vInt({ min: 0, max: 100_000 }) }),
  black: vObject({ type: vEnum(['black'] as const) }),
  clear: vObject({ type: vEnum(['clear'] as const) }),
  pause: vObject({ type: vEnum(['pause'] as const) }),
  resume: vObject({ type: vEnum(['resume'] as const) }),
  stop: vObject({ type: vEnum(['stop'] as const) }),
  setTheme: vObject({ type: vEnum(['setTheme'] as const), themeId: vId() }),
});

const vCue = vObject({
  id: vId(),
  kind: vEnum(['lyric', 'scripture', 'slide', 'image', 'video', 'camera', 'announcement'] as const),
  itemId: vId(),
  label: vString({ min: 1, max: 300 }),
  notes: vOptional(vString({ max: 10_000 })),
});

/**
 * Settings values are opaque by design — the key/value store exists so new preferences
 * need no migration. The *shape* is therefore unknown, but size is bounded below to stop
 * a renderer parking megabytes in the settings table.
 */
/**
 * Dotted namespace keys with camelCase segments, matching the keys seeded in
 * migration 0002 (`presentation.aspectRatio`, `autosave.debounceMs`).
 *
 * The first character must be lowercase so a key can never look like a constructor or a
 * class name, and the alphabet excludes `/`, `\`, `.` at the edges and whitespace — so a
 * key can never be mistaken for a path.
 */
const SETTING_KEY_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)*$/;

const vSettingWrite = vObject({
  key: vString({ min: 1, max: 120, pattern: SETTING_KEY_PATTERN }),
  value: vUnknown(),
});

export const IPC_VALIDATORS: Readonly<Record<IpcChannel, Validator<unknown>>> = Object.freeze({
  'app:info': vVoid(),
  'app:quit': vVoid(),

  'profile:get': vVoid(),
  'profile:save': vObject({
    name: vString({ min: 1, max: 200 }),
    timezone: vString({ min: 1, max: 64 }),
    logoAssetId: vOptional(vNullable(vId())),
  }),
  'onboarding:complete': vVoid(),

  'settings:getAll': vVoid(),
  'settings:get': vObject({ key: vString({ min: 1, max: 120, pattern: SETTING_KEY_PATTERN }) }),
  'settings:set': vSettingWrite,
  'settings:reset': vObject({ key: vString({ min: 1, max: 120, pattern: SETTING_KEY_PATTERN }) }),

  'shortcuts:list': vVoid(),
  'shortcuts:set': vObject({
    action: vString({ min: 1, max: 80 }),
    accelerator: vAccelerator(),
    enabled: vBoolean(),
  }),
  'shortcuts:resetDefaults': vVoid(),

  'songs:list': vObject({
    search: vOptional(vString({ max: 200 })),
    category: vOptional(vString({ max: 80 })),
    favoritesOnly: vOptional(vBoolean()),
    limit: vOptional(vInt({ min: 1, max: 1_000 })),
    offset: vOptional(vInt({ min: 0, max: 1_000_000 })),
  }),
  'songs:get': vObject({ id: vId() }),
  'songs:save': vSongDraft,
  'songs:delete': vObject({ id: vId() }),
  'songs:duplicate': vObject({ id: vId() }),
  'songs:setFavorite': vObject({ id: vId(), isFavorite: vBoolean() }),

  'services:list': vVoid(),
  'services:get': vObject({ id: vId() }),
  'services:save': vServiceDraft,
  'services:delete': vObject({ id: vId() }),
  'services:reorder': vObject({ serviceId: vId(), itemIds: vArray(vId(), { max: 1_000 }) }),

  'themes:list': vVoid(),
  'themes:save': vObject({
    id: vOptional(vId()),
    name: vString({ min: 1, max: 120 }),
    parentThemeId: vOptional(vNullable(vId())),
    spec: vJsonRecord(),
  }),
  'themes:delete': vObject({ id: vId() }),

  'media:list': vObject({
    kind: vOptional(vEnum(MEDIA_KINDS)),
    search: vOptional(vString({ max: 200 })),
    category: vOptional(vString({ max: 80 })),
    favoritesOnly: vOptional(vBoolean()),
    limit: vOptional(vInt({ min: 1, max: 1_000 })),
    offset: vOptional(vInt({ min: 0, max: 1_000_000 })),
  }),
  // No payload: the renderer cannot name a path to import. Main opens the dialog, so
  // the only importable files are ones a human explicitly chose. See §4.
  'media:import': vVoid(),
  'media:delete': vObject({ id: vId() }),

  'bible:translations': vVoid(),
  'bible:lookup': vObject({
    translationId: vId(),
    reference: vString({ min: 1, max: 200 }),
  }),

  'announcements:list': vVoid(),
  'announcements:save': vObject({
    id: vOptional(vId()),
    title: vString({ min: 1, max: 300 }),
    body: vText(10_000),
    imageAssetId: vOptional(vNullable(vId())),
    videoAssetId: vOptional(vNullable(vId())),
    eventDate: vOptional(vNullable(vDateOnly())),
    eventTime: vOptional(vNullable(vString({ max: 5, pattern: /^\d{2}:\d{2}$/ }))),
  }),
  'announcements:delete': vObject({ id: vId() }),

  'display:list': vVoid(),
  'display:assign': vObject({
    osDisplayId: vString({ min: 1, max: 64 }),
    role: vEnum(DISPLAY_ROLES),
  }),
  'display:status': vVoid(),
  'display:identify': vObject({ osDisplayId: vString({ min: 1, max: 64 }) }),
  'output:open': vObject({ role: vEnum(['presentation', 'confidence'] as const) }),
  'output:close': vObject({ role: vEnum(['presentation', 'confidence'] as const) }),

  'camera:list': vVoid(),
  'camera:profiles': vVoid(),
  'camera:saveProfile': vObject({
    id: vOptional(vId()),
    label: vString({ min: 1, max: 120 }),
    provider: vEnum(CAMERA_PROVIDERS),
    // Browser deviceIds are long base64-ish hashes, so this is not vId().
    deviceId: vString({ min: 1, max: 256 }),
    resolution: vOptional(vString({ max: 24, pattern: /^\d{2,5}x\d{2,5}$/ })),
    framerate: vOptional(vNumber({ min: 1, max: 240 })),
    mirrored: vOptional(vBoolean()),
    config: vOptional(vJsonRecord()),
  }),
  'camera:deleteProfile': vObject({ id: vId() }),

  'live:getState': vVoid(),
  'live:intent': vLiveIntent,
  'live:setCues': vObject({ cues: vArray(vCue, { max: 20_000 }) }),

  'recovery:check': vVoid(),
  'recovery:restore': vObject({ id: vId() }),
  'recovery:discard': vObject({ id: vId() }),
});

/** Fail-closed lookup used by the main-process dispatcher. */
export function validatorFor(channel: string): Validator<unknown> | null {
  return Object.prototype.hasOwnProperty.call(IPC_VALIDATORS, channel)
    ? (IPC_VALIDATORS as Record<string, Validator<unknown>>)[channel]!
    : null;
}
