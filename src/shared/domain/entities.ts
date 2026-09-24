/**
 * EXCEPTIONEL PRESENTER — core entity types.
 *
 * Mirrors the SQLite schema in src/main/db/migrations/0001_init.sql. Dependency-free so
 * both the main process and the renderer can speak the same language about data.
 *
 * Convention: `id` values are opaque strings (see vId). Timestamps are ISO-8601 UTC
 * strings — stored as TEXT because SQLite has no date type and ISO TEXT sorts correctly.
 */

// ── church profile & settings ───────────────────────────────────────────────────

export interface ChurchProfile {
  id: string;
  name: string;
  timezone: string;
  logoAssetId: string | null;
  onboardingCompleted: boolean;
}

/** Settings are a typed key/value store — new preferences need no migration. */
export interface SettingEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

// ── songs (Section 7) ───────────────────────────────────────────────────────────

export const SONG_SECTION_KINDS = [
  'intro',
  'verse',
  'pre-chorus',
  'chorus',
  'bridge',
  'tag',
  'ending',
  'instrumental',
  'vamp',
] as const;
export type SongSectionKind = (typeof SONG_SECTION_KINDS)[number];

/** How a section's lyrics become slides. Operators differ on this, so it's per-section. */
export const SLIDE_BREAK_MODES = [
  'blank-line',
  'every-2-lines',
  'every-4-lines',
  'whole-section',
] as const;
export type SlideBreakMode = (typeof SLIDE_BREAK_MODES)[number];

export interface SongSection {
  id: string;
  songId: string;
  kind: SongSectionKind;
  /** Operator-facing label, e.g. "Verse 1". Distinct from `kind` so numbering works. */
  label: string;
  sortOrder: number;
  lyrics: string;
  slideBreakMode: SlideBreakMode;
}

export interface Song {
  id: string;
  title: string;
  artist: string | null;
  author: string | null;
  copyright: string | null;
  ccliNumber: string | null;
  songKey: string | null;
  notes: string | null;
  category: string | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  sections: SongSection[];
}

/** List-view projection — avoids loading every lyric to render a library table. */
export interface SongSummary {
  id: string;
  title: string;
  artist: string | null;
  songKey: string | null;
  category: string | null;
  isFavorite: boolean;
  sectionCount: number;
  updatedAt: string;
}

export interface SongQuery {
  search?: string;
  category?: string;
  favoritesOnly?: boolean;
  limit?: number;
  offset?: number;
}

// ── services (Section 17) ───────────────────────────────────────────────────────

export const SERVICE_ITEM_KINDS = [
  'song',
  'scripture',
  'slide',
  'image',
  'video',
  'camera_scene',
  'announcement',
  'header',
] as const;
export type ServiceItemKind = (typeof SERVICE_ITEM_KINDS)[number];

export interface ServiceItem {
  id: string;
  serviceId: string;
  sortOrder: number;
  kind: ServiceItemKind;
  label: string;
  /** Points at the underlying song/media/announcement row, when the kind has one. */
  refId: string | null;
  /** Kind-specific configuration: verse range, camera profile, theme override… */
  config: Record<string, unknown>;
}

export interface Service {
  id: string;
  name: string;
  serviceDate: string | null;
  themeId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items: ServiceItem[];
}

export interface ServiceSummary {
  id: string;
  name: string;
  serviceDate: string | null;
  itemCount: number;
  updatedAt: string;
}

// ── themes (Section 16) ─────────────────────────────────────────────────────────

export interface ThemeSpec {
  background: { kind: 'solid' | 'gradient' | 'image' | 'video' | 'camera'; value: string };
  text: {
    fontFamily: string;
    /** Points against the normalised 1920×1080 design canvas (see §5). */
    fontSize: number;
    fontWeight: number;
    color: string;
    align: 'left' | 'center' | 'right';
    lineHeight: number;
    letterSpacing: number;
    shadow: { enabled: boolean; color: string; blur: number; offsetY: number };
    outline: { enabled: boolean; color: string; width: number };
  };
  /** Safe-area insets as a fraction of the canvas — keeps text off projector edges. */
  padding: { top: number; right: number; bottom: number; left: number };
  textBox: { enabled: boolean; color: string; opacity: number; cornerRadius: number };
  transition: { kind: 'none' | 'fade' | 'crossfade' | 'slide'; durationMs: number };
}

export interface Theme {
  id: string;
  name: string;
  /** Themes inherit: a child overrides only the fields it sets. */
  parentThemeId: string | null;
  isBuiltin: boolean;
  spec: Partial<ThemeSpec>;
}

// ── displays & outputs (Sections 5, 22) ─────────────────────────────────────────

export const DISPLAY_ROLES = [
  'operator',
  'presentation',
  'preview',
  'confidence',
  'unused',
] as const;
export type DisplayRole = (typeof DISPLAY_ROLES)[number];

export interface DisplayInfo {
  /** Electron's Display.id, as a string. */
  osDisplayId: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  rotation: number;
  colorDepth: number;
  isPrimary: boolean;
  isInternal: boolean;
  /** Derived, e.g. "16:9". Computed from bounds, not reported by the OS. */
  aspectRatio: string;
  /**
   * NOT AVAILABLE from Electron's screen API — always null.
   * Section 22 asks for refresh rate; showing null is honest, inventing 60 is not.
   * Requires a native helper module — Phase 7 item.
   */
  refreshRateHz: number | null;
  role: DisplayRole;
  connected: boolean;
}

export interface OutputAssignment {
  osDisplayId: string;
  role: DisplayRole;
}

export interface OutputStatus {
  assignments: OutputAssignment[];
  presentationWindowOpen: boolean;
  confidenceWindowOpen: boolean;
  /** Set when output is parked because its display vanished mid-service. */
  parkedReason: string | null;
}

// ── cameras (Sections 9, 12) ────────────────────────────────────────────────────

export const CAMERA_PROVIDERS = ['usb', 'capture-card', 'ndi', 'rtsp'] as const;
export type CameraProviderId = (typeof CAMERA_PROVIDERS)[number];

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
  provider: CameraProviderId;
  /** False for registered-but-unimplemented providers; UI greys these with a reason. */
  available: boolean;
  unavailableReason: string | null;
}

export interface CameraProfile {
  id: string;
  label: string;
  provider: CameraProviderId;
  deviceId: string;
  resolution: string;
  framerate: number;
  mirrored: boolean;
  config: Record<string, unknown>;
}

// ── media (Section 13) ──────────────────────────────────────────────────────────

export const MEDIA_KINDS = ['image', 'video', 'audio', 'background', 'logo'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  filename: string;
  /** Absolute path. Main process only — never trusted when arriving from a renderer. */
  absPath: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbnailPath: string | null;
  category: string | null;
  isFavorite: boolean;
  createdAt: string;
}

// ── bible (Section 8) ───────────────────────────────────────────────────────────

export const TRANSLATION_INSTALL_STATES = [
  'available',
  'installing',
  'installed',
  'failed',
] as const;
export type TranslationInstallState = (typeof TRANSLATION_INSTALL_STATES)[number];

export interface BibleTranslation {
  id: string;
  abbreviation: string;
  name: string;
  language: string;
  /** Licence string. Required — we do not install text without knowing its terms. */
  license: string;
  sourceUrl: string | null;
  installState: TranslationInstallState;
  verseCount: number;
  installedAt: string | null;
}

// ── announcements (Section 25) ──────────────────────────────────────────────────

export interface Announcement {
  id: string;
  title: string;
  body: string | null;
  imageAssetId: string | null;
  videoAssetId: string | null;
  eventDate: string | null;
  eventTime: string | null;
}

// ── shortcuts (Section 20) ──────────────────────────────────────────────────────

export interface ShortcutBinding {
  action: string;
  accelerator: string;
  enabled: boolean;
}

// ── crash recovery (Section 33) ─────────────────────────────────────────────────

export interface RecoverySnapshot {
  id: string;
  serviceId: string | null;
  serviceName: string | null;
  snapshot: Record<string, unknown>;
  heartbeatAt: string;
  cleanShutdown: boolean;
}
