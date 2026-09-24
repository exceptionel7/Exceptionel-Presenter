/**
 * EXCEPTIONEL PRESENTER — the IPC contract.
 *
 * Imported by main, preload AND renderer. A channel's name, request type and response
 * type are declared exactly once, so the two sides of the bridge cannot drift apart:
 * rename a channel and every call site fails to compile.
 *
 * See docs/ARCHITECTURE.md §4.
 */

import type {
  Announcement,
  BibleTranslation,
  CameraDeviceInfo,
  CameraProfile,
  ChurchProfile,
  DisplayInfo,
  MediaAsset,
  OutputAssignment,
  OutputStatus,
  RecoverySnapshot,
  Service,
  ServiceSummary,
  ShortcutBinding,
  Song,
  SongQuery,
  SongSummary,
  Theme,
} from './domain/entities.ts';
import type { Cue, LiveIntent, LiveState } from './domain/live-state.ts';
import type { ErrorNotice } from './domain/errors.ts';

/**
 * Renderer → main, request/response (`ipcRenderer.invoke`).
 *
 * Handlers return `IpcResult<T>` rather than throwing across the bridge: an Electron IPC
 * exception arrives in the renderer as a mangled string with the main-process stack
 * embedded, which is both useless to the operator and a mild information leak.
 */
export interface IpcRequestMap {
  // app / lifecycle
  'app:info': { req: void; res: AppInfo };
  'app:quit': { req: void; res: void };

  // church profile & onboarding (Section 36)
  'profile:get': { req: void; res: ChurchProfile | null };
  'profile:save': { req: ChurchProfileDraft; res: ChurchProfile };
  'onboarding:complete': { req: void; res: ChurchProfile };

  // settings (Section 37)
  'settings:getAll': { req: void; res: Record<string, unknown> };
  'settings:get': { req: { key: string }; res: unknown };
  'settings:set': { req: { key: string; value: unknown }; res: void };
  'settings:reset': { req: { key: string }; res: void };

  // shortcuts (Section 20)
  'shortcuts:list': { req: void; res: ShortcutBinding[] };
  'shortcuts:set': { req: ShortcutBinding; res: ShortcutBinding[] };
  'shortcuts:resetDefaults': { req: void; res: ShortcutBinding[] };

  // songs (Section 7) — Phase 4
  'songs:list': { req: SongQuery; res: SongSummary[] };
  'songs:get': { req: { id: string }; res: Song | null };
  'songs:save': { req: SongDraft; res: Song };
  'songs:delete': { req: { id: string }; res: void };
  'songs:duplicate': { req: { id: string }; res: Song };
  'songs:setFavorite': { req: { id: string; isFavorite: boolean }; res: void };

  // services (Section 17) — Phase 8
  'services:list': { req: void; res: ServiceSummary[] };
  'services:get': { req: { id: string }; res: Service | null };
  'services:save': { req: ServiceDraft; res: Service };
  'services:delete': { req: { id: string }; res: void };
  'services:reorder': { req: { serviceId: string; itemIds: string[] }; res: Service };

  // themes (Section 16) — Phase 9
  'themes:list': { req: void; res: Theme[] };
  'themes:save': { req: ThemeDraft; res: Theme };
  'themes:delete': { req: { id: string }; res: void };

  // media (Section 13) — Phase 5
  'media:list': { req: MediaQuery; res: MediaAsset[] };
  'media:import': { req: void; res: MediaAsset[] }; // opens a main-process dialog
  'media:delete': { req: { id: string }; res: void };

  // bible (Section 8) — Phase 4
  'bible:translations': { req: void; res: BibleTranslation[] };
  'bible:lookup': { req: { translationId: string; reference: string }; res: ScriptureResult };

  // announcements (Section 25)
  'announcements:list': { req: void; res: Announcement[] };
  'announcements:save': { req: AnnouncementDraft; res: Announcement };
  'announcements:delete': { req: { id: string }; res: void };

  // displays & outputs (Sections 5, 22) — Phase 7
  'display:list': { req: void; res: DisplayInfo[] };
  'display:assign': { req: OutputAssignment; res: OutputStatus };
  'display:status': { req: void; res: OutputStatus };
  'display:identify': { req: { osDisplayId: string }; res: void };
  'output:open': { req: { role: 'presentation' | 'confidence' }; res: OutputStatus };
  'output:close': { req: { role: 'presentation' | 'confidence' }; res: OutputStatus };

  // cameras (Sections 9-12) — Phase 6
  'camera:list': { req: void; res: CameraDeviceInfo[] };
  'camera:profiles': { req: void; res: CameraProfile[] };
  'camera:saveProfile': { req: CameraProfileDraft; res: CameraProfile };
  'camera:deleteProfile': { req: { id: string }; res: void };

  // live control (Sections 19-21) — Phase 3
  'live:getState': { req: void; res: LiveState };
  'live:intent': { req: LiveIntent; res: LiveState };
  'live:setCues': { req: { cues: Cue[] }; res: LiveState };

  // crash recovery (Section 33)
  'recovery:check': { req: void; res: RecoverySnapshot | null };
  'recovery:restore': { req: { id: string }; res: Service | null };
  'recovery:discard': { req: { id: string }; res: void };
}

/**
 * Main → renderer, push events. Allow-listed: a renderer may only subscribe to names
 * present here, so main cannot be coaxed into emitting on an arbitrary channel.
 */
export interface IpcEventMap {
  'live:state': LiveState;
  'live:cues': { cues: Cue[] };
  'display:changed': DisplayInfo[];
  'output:status': OutputStatus;
  'camera:changed': CameraDeviceInfo[];
  'error:notice': ErrorNotice;
  'settings:changed': { key: string; value: unknown };
  /** Emitted after a debounced autosave commits, so the UI can show "Saved 14:32". */
  'autosave:committed': { entity: string; at: string };
  /** Menu accelerators and global shortcuts arrive as named actions, not raw keys. */
  'action:invoke': { action: string };
}

export type IpcChannel = keyof IpcRequestMap;
export type IpcEvent = keyof IpcEventMap;
export type IpcRequest<C extends IpcChannel> = IpcRequestMap[C]['req'];
export type IpcResponse<C extends IpcChannel> = IpcRequestMap[C]['res'];

/** Every channel resolves to this. Failures are values, not thrown exceptions. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; failure: ErrorNotice };

export const IPC_CHANNELS = Object.freeze([
  'app:info',
  'app:quit',
  'profile:get',
  'profile:save',
  'onboarding:complete',
  'settings:getAll',
  'settings:get',
  'settings:set',
  'settings:reset',
  'shortcuts:list',
  'shortcuts:set',
  'shortcuts:resetDefaults',
  'songs:list',
  'songs:get',
  'songs:save',
  'songs:delete',
  'songs:duplicate',
  'songs:setFavorite',
  'services:list',
  'services:get',
  'services:save',
  'services:delete',
  'services:reorder',
  'themes:list',
  'themes:save',
  'themes:delete',
  'media:list',
  'media:import',
  'media:delete',
  'bible:translations',
  'bible:lookup',
  'announcements:list',
  'announcements:save',
  'announcements:delete',
  'display:list',
  'display:assign',
  'display:status',
  'display:identify',
  'output:open',
  'output:close',
  'camera:list',
  'camera:profiles',
  'camera:saveProfile',
  'camera:deleteProfile',
  'live:getState',
  'live:intent',
  'live:setCues',
  'recovery:check',
  'recovery:restore',
  'recovery:discard',
] as const satisfies readonly IpcChannel[]);

export const IPC_EVENTS = Object.freeze([
  'live:state',
  'live:cues',
  'display:changed',
  'output:status',
  'camera:changed',
  'error:notice',
  'settings:changed',
  'autosave:committed',
  'action:invoke',
] as const satisfies readonly IpcEvent[]);

/**
 * Channels the AUDIENCE OUTPUT window is permitted to use.
 *
 * Deliberately tiny. The output window renders and nothing else — it physically cannot
 * mutate the service, delete a song, or advance a slide. An audience display should
 * never be one bug away from editing the library.
 */
export const OUTPUT_ALLOWED_CHANNELS = Object.freeze([
  'live:getState',
  'themes:list',
  'camera:profiles',
] as const satisfies readonly IpcChannel[]);

export const OUTPUT_ALLOWED_EVENTS = Object.freeze([
  'live:state',
  'live:cues',
  'settings:changed',
] as const satisfies readonly IpcEvent[]);

/** The confidence monitor additionally needs cue context and timers, still read-only. */
export const CONFIDENCE_ALLOWED_CHANNELS = Object.freeze([
  'live:getState',
  'themes:list',
  'services:get',
  'settings:getAll',
] as const satisfies readonly IpcChannel[]);

export const CONFIDENCE_ALLOWED_EVENTS = Object.freeze([
  'live:state',
  'live:cues',
  'settings:changed',
  'autosave:committed',
] as const satisfies readonly IpcEvent[]);

// ── payload shapes referenced above ─────────────────────────────────────────────

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: 'win32' | 'darwin' | 'linux';
  schemaVersion: number;
  /** Which SQLite implementation actually loaded. Surfaced in Settings → Advanced. */
  sqliteEngine: string;
  userDataPath: string;
  isPackaged: boolean;
}

export interface ChurchProfileDraft {
  name: string;
  timezone: string;
  logoAssetId?: string | null;
}

export interface SongSectionDraft {
  id?: string;
  kind: string;
  label: string;
  sortOrder: number;
  lyrics: string;
  slideBreakMode: string;
}

export interface SongDraft {
  id?: string;
  title: string;
  artist?: string | null;
  author?: string | null;
  copyright?: string | null;
  ccliNumber?: string | null;
  songKey?: string | null;
  notes?: string | null;
  category?: string | null;
  isFavorite?: boolean;
  sections: SongSectionDraft[];
}

export interface ServiceItemDraft {
  id?: string;
  kind: string;
  label: string;
  sortOrder: number;
  refId?: string | null;
  config?: Record<string, unknown>;
}

export interface ServiceDraft {
  id?: string;
  name: string;
  serviceDate?: string | null;
  themeId?: string | null;
  notes?: string | null;
  items: ServiceItemDraft[];
}

export interface ThemeDraft {
  id?: string;
  name: string;
  parentThemeId?: string | null;
  spec: Record<string, unknown>;
}

export interface MediaQuery {
  kind?: string;
  search?: string;
  category?: string;
  favoritesOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface AnnouncementDraft {
  id?: string;
  title: string;
  body?: string | null;
  imageAssetId?: string | null;
  videoAssetId?: string | null;
  eventDate?: string | null;
  eventTime?: string | null;
}

export interface CameraProfileDraft {
  id?: string;
  label: string;
  provider: string;
  deviceId: string;
  resolution?: string;
  framerate?: number;
  mirrored?: boolean;
  config?: Record<string, unknown>;
}

export interface ScriptureVerse {
  book: string;
  bookNumber: number;
  chapter: number;
  verse: number;
  text: string;
}

export interface ScriptureResult {
  /** Canonical display form, e.g. "John 3:16-18". */
  reference: string;
  translationAbbreviation: string;
  verses: ScriptureVerse[];
  /** Attribution/licence line the theme may be required to display. */
  copyrightNotice: string | null;
}
