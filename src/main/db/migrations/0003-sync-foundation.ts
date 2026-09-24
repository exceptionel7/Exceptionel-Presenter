/**
 * EXCEPTIONEL PRESENTER — migration 0003: synchronisation foundation.
 *
 * Adds what an authoritative-library-plus-replicas model needs, BEFORE any real church
 * data exists. Every one of these is cheap now and painful to retrofit:
 *
 *   1. TOMBSTONES (deleted_at). Hard deletes plus a prunable change log mean a replica
 *      that misses the delete RESURRECTS the row on the next pull. Deleted data coming
 *      back is among the worst sync bugs there is.
 *
 *   2. LAMPORT REVISIONS (revision + origin_device_id). Ordering by wall-clock updated_at
 *      assumes clocks are right. Church booth machines are frequently months or years off,
 *      and a wrong clock makes last-write-wins silently discard the NEWER edit. A counter
 *      needs no clock.
 *
 *   3. DEVICE IDENTITY (app_identity). Needed to designate which library is authoritative
 *      and to answer "which machine wrote this?".
 *
 *   4. SETTINGS SCOPE. Settings are mixed: presentation.defaultThemeId belongs to the
 *      library, display.presentationId belongs to this computer. Without a scope, pulling
 *      a service would reassign the booth's projector.
 *
 * Children (song_sections, service_items, playlist_items, presentation_slides) get NO sync
 * columns on purpose: repositories replace them wholesale with their parent, so the parent
 * row's revision already versions them.
 *
 * IMMUTABLE once shipped — see 0001-init.ts.
 */

export const SQL = String.raw`
-- ── device identity ─────────────────────────────────────────────────────────────
-- Single row, id pinned by CHECK. lamport_counter is this installation's logical
-- clock: every local write takes max(counter, anything observed) + 1.

CREATE TABLE app_identity (
  id              TEXT PRIMARY KEY CHECK (id = 'local'),
  device_id       TEXT NOT NULL,
  device_label    TEXT,
  lamport_counter INTEGER NOT NULL DEFAULT 0 CHECK (lamport_counter >= 0),
  -- Which library this machine pulls from. NULL means this machine IS authoritative.
  upstream_uri    TEXT,
  created_at      TEXT NOT NULL
);

-- ── sync columns on library entities ────────────────────────────────────────────
-- SQLite ADD COLUMN cannot use a non-constant default, so updated_at arrives nullable
-- and is backfilled below; every write from here on sets it explicitly.

ALTER TABLE songs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE songs ADD COLUMN origin_device_id TEXT;
ALTER TABLE songs ADD COLUMN deleted_at TEXT;

ALTER TABLE services ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE services ADD COLUMN origin_device_id TEXT;
ALTER TABLE services ADD COLUMN deleted_at TEXT;

ALTER TABLE themes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE themes ADD COLUMN origin_device_id TEXT;
ALTER TABLE themes ADD COLUMN deleted_at TEXT;

ALTER TABLE playlists ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE playlists ADD COLUMN origin_device_id TEXT;
ALTER TABLE playlists ADD COLUMN deleted_at TEXT;

ALTER TABLE presentations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE presentations ADD COLUMN origin_device_id TEXT;
ALTER TABLE presentations ADD COLUMN deleted_at TEXT;

ALTER TABLE announcements ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE announcements ADD COLUMN origin_device_id TEXT;
ALTER TABLE announcements ADD COLUMN deleted_at TEXT;

ALTER TABLE media_assets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media_assets ADD COLUMN origin_device_id TEXT;
ALTER TABLE media_assets ADD COLUMN deleted_at TEXT;
-- media_assets had no updated_at, so it could not take part in ordering at all.
ALTER TABLE media_assets ADD COLUMN updated_at TEXT;
UPDATE media_assets SET updated_at = created_at WHERE updated_at IS NULL;

-- The church profile is library-level and versioned, but has no tombstone: a church
-- cannot delete its own identity, only rename it.
ALTER TABLE church_profile ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE church_profile ADD COLUMN origin_device_id TEXT;

-- camera_profiles is DEVICE-LOCAL and never syncs -- it holds OS-assigned device ids that
-- mean nothing on another computer. It gets updated_at for ordinary bookkeeping only.
ALTER TABLE camera_profiles ADD COLUMN updated_at TEXT;
UPDATE camera_profiles SET updated_at = created_at WHERE updated_at IS NULL;

-- ── settings scope ──────────────────────────────────────────────────────────────

ALTER TABLE settings ADD COLUMN scope TEXT NOT NULL DEFAULT 'library'
  CHECK (scope IN ('library', 'device'));

-- Reclassify the keys seeded in 0002 that describe THIS COMPUTER rather than the library.
-- Mirrors DEVICE_SCOPED_SETTING_PREFIXES in src/shared/domain/sync.ts.
UPDATE settings SET scope = 'device'
WHERE key LIKE 'app.%'
   OR key LIKE 'display.%'
   OR key LIKE 'camera.%'
   OR key LIKE 'confidence.%'
   OR key LIKE 'autosave.%'
   OR key LIKE 'cloud.%'
   OR key = 'presentation.aspectRatio';

-- ── change log gains ordering ───────────────────────────────────────────────────

ALTER TABLE sync_oplog ADD COLUMN revision INTEGER;
ALTER TABLE sync_oplog ADD COLUMN origin_device_id TEXT;

-- ── indexes rebuilt to exclude tombstones ───────────────────────────────────────
--
-- CRITICAL: these UNIQUE indexes must ignore deleted rows. Otherwise deleting a theme
-- called "Christmas" would permanently block ever creating another one with that name,
-- and deleting a media file would block re-importing the identical file.

DROP INDEX idx_themes_name;
CREATE UNIQUE INDEX idx_themes_name ON themes(name) WHERE deleted_at IS NULL;

DROP INDEX idx_media_hash;
CREATE UNIQUE INDEX idx_media_hash ON media_assets(hash)
  WHERE hash IS NOT NULL AND deleted_at IS NULL;

-- Ordinary lookup indexes narrowed to live rows: every list query filters tombstones, so
-- indexing deleted rows only makes the index bigger and the scan slower.

DROP INDEX idx_songs_title;
CREATE INDEX idx_songs_title ON songs(title COLLATE NOCASE) WHERE deleted_at IS NULL;

DROP INDEX idx_songs_category;
CREATE INDEX idx_songs_category ON songs(category)
  WHERE category IS NOT NULL AND deleted_at IS NULL;

DROP INDEX idx_songs_favorite;
CREATE INDEX idx_songs_favorite ON songs(is_favorite)
  WHERE is_favorite = 1 AND deleted_at IS NULL;

DROP INDEX idx_services_date;
CREATE INDEX idx_services_date ON services(service_date DESC) WHERE deleted_at IS NULL;

DROP INDEX idx_media_kind;
CREATE INDEX idx_media_kind ON media_assets(kind, created_at DESC) WHERE deleted_at IS NULL;

DROP INDEX idx_media_favorite;
CREATE INDEX idx_media_favorite ON media_assets(is_favorite)
  WHERE is_favorite = 1 AND deleted_at IS NULL;

-- Tombstone sweeps ("what changed since revision N?") are the hot path for a pull, so
-- they get their own indexes.
CREATE INDEX idx_songs_revision ON songs(revision);
CREATE INDEX idx_services_revision ON services(revision);
CREATE INDEX idx_themes_revision ON themes(revision);
CREATE INDEX idx_playlists_revision ON playlists(revision);
CREATE INDEX idx_presentations_revision ON presentations(revision);
CREATE INDEX idx_announcements_revision ON announcements(revision);
CREATE INDEX idx_media_revision ON media_assets(revision);

-- Compaction ("purge tombstones older than X") needs to find them cheaply.
CREATE INDEX idx_songs_tombstones ON songs(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_services_tombstones ON services(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_media_tombstones ON media_assets(deleted_at) WHERE deleted_at IS NOT NULL;
`;
