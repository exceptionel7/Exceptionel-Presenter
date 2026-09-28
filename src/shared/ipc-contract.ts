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
  MediaKind,
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
import type { SkippedItem } from './domain/cues.ts';
import type { ScripturePassage } from './domain/scripture.ts';
import type { ErrorNotice } from './domain/errors.ts';
import type { CameraSource } from './domain/camera.ts';

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
  /**
   * The library, as the renderer is allowed to see it.
   *
   * `MediaAssetView`, NOT `MediaAsset`: the entity carries `absPath`, and a filesystem path must
   * never cross the bridge. The view replaces it with an `app-media://` URL addressed by id.
   */
  'media:list': { req: MediaQuery; res: MediaAssetView[] };
  /**
   * Imports whatever the operator picks in a main-process dialog.
   *
   * Takes NO payload, deliberately. A renderer cannot name a path to import, so the only importable
   * files are ones a human explicitly chose in a native dialog. Same rule as `bible:import`.
   *
   * Reports per-file outcomes rather than a bare list, because a folder of media routinely contains
   * something that cannot be presented, and "37 of 40 added" is the honest answer.
   */
  'media:import': { req: void; res: MediaImportReport };
  'media:delete': { req: { id: string }; res: void };
  'media:setFavorite': { req: { id: string; isFavorite: boolean }; res: void };
  /** Null clears the category. */
  'media:setCategory': { req: { id: string; category: string | null }; res: void };
  /** The categories actually in use, for the filter bar. */
  'media:categories': { req: void; res: string[] };

  // bible (Section 8) — Phase 4
  'bible:translations': { req: void; res: BibleTranslation[] };
  /**
   * Resolves a typed reference against an installed translation.
   *
   * Returns a discriminated result rather than throwing, because "that translation does not include
   * Romans" is an ANSWER, not an exception. Failures here are expected, actionable, and each has its
   * own remedy — collapsing them into a red error banner would throw that information away.
   */
  'bible:lookup': { req: { translationId: string; reference: string }; res: ScriptureLookup };
  /** Books present in a translation, with real chapter counts. */
  'bible:books': { req: { translationId: string }; res: BibleBookSummary[] };
  /**
   * Verses per chapter, read from the installed text.
   *
   * So the operator's chapter and verse pickers offer only what exists. A hard-coded versification
   * table would eventually disagree with some translation and offer a verse that comes back empty.
   */
  'bible:chapters': { req: { translationId: string; bookNumber: number }; res: number[] };
  'bible:search': { req: { translationId: string; query: string; limit?: number }; res: BibleSearchHit[] };
  /**
   * Installs a translation package chosen through a main-process file dialog.
   *
   * No payload: the renderer never sees or supplies a filesystem path. Main opens the dialog, reads the
   * file, validates it and installs it, which keeps path handling on the trusted side of the boundary.
   */
  'bible:import': { req: void; res: TranslationImportReport };
  'bible:removeTranslation': { req: { id: string }; res: void };

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
  /**
   * Opens a service for presentation: main loads it, expands it into cues and installs them.
   *
   * Returns null when the service is missing or deleted. `skipped` names every item that will
   * present nothing and why — the operator must learn that on Thursday, not by pressing Next on
   * Sunday and watching the screen stay black.
   */
  'services:open': { req: { serviceId: string }; res: OpenedService | null };

  // crash recovery (Section 33)
  'recovery:check': { req: void; res: RecoverySnapshot | null };
  'recovery:restore': { req: { id: string }; res: Service | null };
  'recovery:discard': { req: { id: string }; res: void };

  // wireless camera (phone over Wi-Fi)
  'wireless:status': { req: void; res: WirelessStatus };
  'wireless:start': { req: void; res: WirelessStatus };
  'wireless:stop': { req: void; res: WirelessStatus };
  'wireless:createSession': { req: { label: string }; res: PairingTicket };
  'wireless:cancelSession': { req: { sessionId: string }; res: WirelessStatus };
  'wireless:disconnect': { req: { sessionId: string }; res: WirelessStatus };
  /** Desktop → phone signalling, sent from the window that owns the peer connection. */
  'wireless:signal': { req: { sessionId: string; message: unknown }; res: void };
  /**
   * Reports that a REAL remote media track has arrived in the output window.
   *
   * A dedicated channel rather than a signalling message, because this is the only route to the
   * `connected` state and it must not be confusable with a peer-state report. A completed
   * handshake is not a picture.
   */
  'wireless:track': { req: { sessionId: string }; res: void };
  /**
   * Measured transport statistics, sampled from `getStats()` in the window that owns the peer
   * connection.
   *
   * Raw measurements only — packet loss, round trip, jitter. Main grades them with the worst-of-three
   * rule and halves the RTT for the one-way latency estimate, so the renderer cannot invent a
   * flattering number and there is exactly one place where quality is decided.
   */
  'wireless:stats': {
    req: { sessionId: string; packetLoss: number; rttMs: number; jitterMs: number; fps?: number };
    res: void;
  };

  // camera sources shared across local and wireless providers
  'camera:sources': { req: void; res: CameraSource[] };
  'camera:assign': { req: { id: string; assignment: string }; res: CameraSource[] };

  /**
   * Renderer-to-renderer signalling relay.
   *
   * A MediaStream cannot cross a process boundary, so the operator preview receives the phone's
   * video over a loopback RTCPeerConnection from the output window. Main relays the SDP and ICE
   * between the two renderers; no media passes through it.
   */
  'media:relay': { req: { to: 'operator' | 'output'; message: unknown }; res: void };
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
  /** Pairing progress and connected phones. */
  'wireless:status': WirelessStatus;
  /** Phone → desktop signalling, delivered to whichever window owns the peer. */
  'wireless:signal': { sessionId: string; message: unknown };
  /** The unified source list, after any change from any provider. */
  'camera:sources': CameraSource[];
  /** Relayed loopback signalling between the output and operator renderers. */
  'media:relay': { from: 'operator' | 'output'; message: unknown };
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
  'media:setFavorite',
  'media:setCategory',
  'media:categories',
  'bible:translations',
  'bible:lookup',
  'bible:books',
  'bible:chapters',
  'bible:search',
  'bible:import',
  'bible:removeTranslation',
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
  'services:open',
  'recovery:check',
  'recovery:restore',
  'recovery:discard',
  'wireless:status',
  'wireless:start',
  'wireless:stop',
  'wireless:createSession',
  'wireless:cancelSession',
  'wireless:disconnect',
  'wireless:signal',
  'wireless:track',
  'wireless:stats',
  'camera:sources',
  'camera:assign',
  'media:relay',
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
  'wireless:status',
  'wireless:signal',
  'camera:sources',
  'media:relay',
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
  /*
   * The output window owns the phone's RTCPeerConnection, so it must be able to answer the
   * phone and relay to the operator preview. Both are SIGNALLING ONLY — they carry SDP and ICE,
   * never library data, and neither can alter a song, service or setting. The audience screen
   * remains unable to mutate anything.
   */
  'wireless:signal',
  'wireless:track',
  'wireless:stats',
  'media:relay',
] as const satisfies readonly IpcChannel[]);

export const OUTPUT_ALLOWED_EVENTS = Object.freeze([
  'live:state',
  'live:cues',
  'settings:changed',
  'wireless:signal',
  'media:relay',
  'camera:sources',
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

/**
 * The result of opening a service for presentation.
 *
 * `cues` is returned as well as broadcast on `live:cues` so the operator can render the running
 * order from the same expansion the engine will step through — not a second one of its own.
 */
export interface OpenedService {
  service: Service;
  cues: Cue[];
  /** Items that will present nothing, each with a reason the operator can act on. */
  skipped: SkippedItem[];
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

/**
 * An asset as a renderer sees it.
 *
 * Derived from `MediaAsset` by REMOVING `absPath` and `thumbnailPath` and adding URLs in their place.
 * Written out in full rather than as an `Omit<>`, so that adding a path-shaped field to the entity
 * later cannot quietly leak it across the bridge — a new field has to be added here deliberately.
 *
 * `hash` is also absent: the renderer has no use for it, and it is the one field that would let a
 * compromised renderer recognise files it was never shown.
 */
export interface MediaAssetView {
  id: string;
  kind: MediaKind;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  category: string | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  /** `app-media://<id>` — the original file, served by main after validating the id. */
  url: string;
  /** `app-media://<id>/thumbnail`, or null when none has been generated. */
  thumbnailUrl: string | null;
}

/** One file that could not be imported, and why. */
export interface RefusedMedia {
  filename: string;
  reason: string;
}

export type MediaImportReport =
  | {
      outcome: 'completed';
      added: MediaAssetView[];
      /**
       * Files already in the library, by content.
       *
       * Reported rather than counted as added: telling an operator forty files were imported when
       * eight were duplicates is a lie they discover later, in the media grid, while looking for
       * something else.
       */
      duplicates: MediaAssetView[];
      refused: RefusedMedia[];
    }
  /** The operator closed the dialog. Not an error, and must not produce a banner. */
  | { outcome: 'cancelled' };

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

/*
 * Re-exported from shared/domain/scripture.ts rather than declared here.
 *
 * The repository, the cue builder, every renderer and this contract all describe the same passage. A
 * second declaration is a guarantee that the two eventually disagree — which is exactly what happened
 * with the theme spec before it was consolidated.
 */
export type {
  ScriptureCitation,
  ScripturePassage,
  ScriptureVerse,
} from './domain/scripture.ts';

export type ScriptureLookup =
  | { found: true; passage: ScripturePassage }
  | {
      found: false;
      /** Each cause has a different remedy, so each keeps its own code. */
      code: 'bad-reference' | 'no-translation' | 'book-missing' | 'chapter-missing' | 'verses-missing';
      message: string;
      /** Candidate book names, when the reference was ambiguous rather than wrong. */
      candidates?: string[];
    };

export interface BibleBookSummary {
  bookNumber: number;
  name: string;
  abbreviation: string;
  chapterCount: number;
}

export interface BibleSearchHit {
  translationId: string;
  bookNumber: number;
  bookName: string;
  chapter: number;
  verse: number;
  text: string;
  /** A normalised reference, so a hit can be acted on without a second lookup. */
  reference: string;
}

/** The outcome of an import attempt, detailed enough to fix a bad package. */
export type TranslationImportReport =
  | { outcome: 'installed'; translation: BibleTranslation; warnings: { path: string; message: string }[] }
  /** The operator closed the file dialog. Not an error. */
  | { outcome: 'cancelled' }
  | { outcome: 'rejected'; problems: { path: string; message: string }[] };

// ── wireless camera ─────────────────────────────────────────────────────────────

/**
 * What the operator needs to display a QR code.
 *
 * The PIN is carried here for the OPERATOR'S SCREEN only; `pairingUrl` — the thing encoded into
 * the QR image — deliberately does not contain it. That separation is the two-factor model:
 * photographing the QR code is not enough, because the PIN exists only on the monitor.
 */
export interface PairingTicket {
  sessionId: string;
  /** Encode exactly this into the QR code. Contains the session id and pairing token. */
  pairingUrl: string;
  pin: string;
  expiresAt: string;
  label: string;
  /** Shown beneath the code so the operator can read it out if scanning fails. */
  displayUrl: string;
}

export interface WirelessPhone {
  sessionId: string;
  label: string;
  /** A WirelessState value. */
  state: string;
  deviceLabel: string | null;
  resolution: { width: number; height: number } | null;
  fps: number | null;
  latencyMs: number | null;
  /** A ConnectionQuality value, or null when not measurable yet. */
  quality: string | null;
  audioEnabled: boolean;
  expiresAt: string | null;
  pin: string | null;
}

export interface WirelessStatus {
  /** True once the HTTPS signalling server is listening. */
  running: boolean;
  /** Where a phone should connect, e.g. "https://192.168.1.100:8443". */
  origin: string | null;
  lanAddress: string | null;
  interfaceName: string | null;
  /** SHA-256 of the local certificate, so the operator can match what the phone shows. */
  certificateFingerprint: string | null;
  phones: WirelessPhone[];
  /** Set when the server could not start, or there is no usable network. */
  problem: string | null;
  remedies: string[];
  maxPhones: number;
}
