/**
 * EXCEPTIONEL PRESENTER — migration 0001: initial schema (Section 28).
 *
 * SQL lives in a TypeScript module rather than a .sql file so the identical text loads in
 * all three runtimes with no loader configuration: `node --test`, `electron-vite dev`, and
 * a packaged asar archive (where runtime file reads need unpacking and path juggling).
 *
 * IMMUTABLE. Once applied, this text is checksummed into schema_migrations; editing it
 * makes every existing library refuse to open. Add a new migration instead.
 *
 * Conventions:
 *   - ids are TEXT, generated in app code — stable across cloud sync, unlike
 *     autoincrement integers which would collide between two church computers.
 *   - timestamps are TEXT ISO-8601 UTC; SQLite has no date type and ISO text sorts right.
 *   - booleans are INTEGER 0/1 with CHECK constraints.
 *   - enum-ish columns carry CHECK constraints mirroring the const arrays in
 *     src/shared/domain/entities.ts, so a bad write fails at the database, not silently.
 */

export const SQL = String.raw`
-- ── church profile & preferences ────────────────────────────────────────────────

CREATE TABLE church_profile (
  -- Single-row table. The CHECK pins the id so a second profile cannot be inserted.
  id                   TEXT PRIMARY KEY CHECK (id = 'default'),
  name                 TEXT NOT NULL,
  timezone             TEXT NOT NULL DEFAULT 'UTC',
  logo_asset_id        TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  onboarding_completed INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_completed IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE shortcuts (
  action      TEXT PRIMARY KEY,
  accelerator TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

-- Two enabled actions must never share a binding, or a keypress mid-service becomes
-- nondeterministic.
CREATE UNIQUE INDEX idx_shortcuts_accelerator
  ON shortcuts(accelerator) WHERE enabled = 1;

-- ── media (Section 13) ──────────────────────────────────────────────────────────

CREATE TABLE media_assets (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'background', 'logo')),
  filename       TEXT NOT NULL,
  abs_path       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0,
  width          INTEGER,
  height         INTEGER,
  duration_ms    INTEGER,
  thumbnail_path TEXT,
  category       TEXT,
  is_favorite    INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  -- Content hash: lets import recognise a file already in the library instead of
  -- silently duplicating it every time someone re-imports a backgrounds folder.
  hash           TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_media_kind ON media_assets(kind, created_at DESC);
CREATE INDEX idx_media_favorite ON media_assets(is_favorite) WHERE is_favorite = 1;
CREATE UNIQUE INDEX idx_media_hash ON media_assets(hash) WHERE hash IS NOT NULL;

-- ── themes (Section 16) ─────────────────────────────────────────────────────────

CREATE TABLE themes (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- Self-reference for inheritance: a child overrides only the fields it sets.
  -- RESTRICT, not CASCADE: deleting a parent must not silently destroy its children.
  parent_theme_id TEXT REFERENCES themes(id) ON DELETE RESTRICT,
  is_builtin      INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  spec_json       TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_themes_name ON themes(name);

-- ── songs (Section 7) ───────────────────────────────────────────────────────────

CREATE TABLE songs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT,
  author      TEXT,
  copyright   TEXT,
  ccli_number TEXT,
  song_key    TEXT,
  notes       TEXT,
  category    TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_songs_title ON songs(title COLLATE NOCASE);
CREATE INDEX idx_songs_category ON songs(category) WHERE category IS NOT NULL;
CREATE INDEX idx_songs_favorite ON songs(is_favorite) WHERE is_favorite = 1;

CREATE TABLE song_sections (
  id               TEXT PRIMARY KEY,
  song_id          TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'intro', 'verse', 'pre-chorus', 'chorus', 'bridge',
                     'tag', 'ending', 'instrumental', 'vamp')),
  label            TEXT NOT NULL,
  sort_order       INTEGER NOT NULL,
  lyrics           TEXT NOT NULL DEFAULT '',
  slide_break_mode TEXT NOT NULL DEFAULT 'blank-line' CHECK (slide_break_mode IN (
                     'blank-line', 'every-2-lines', 'every-4-lines', 'whole-section'))
);

CREATE INDEX idx_song_sections_song ON song_sections(song_id, sort_order);

-- Full-text search over title AND lyrics, so "way maker" finds the song and
-- "light in the darkness" finds the chorus.
--
-- This is a regular (content-owning) FTS5 table, NOT content=''. Contentless FTS5 cannot
-- be deleted from without replaying the exact original column values, which is impossible
-- here: the indexed lyrics are an aggregate of song_sections rows, so by the time a title
-- changes the old aggregate is gone. Getting that wrong corrupts the index silently --
-- the worst kind of bug in a search feature. The duplicated text costs a few hundred KB.
--
-- song_id UNINDEXED lets us rebuild or delete one song's row by id without depending on
-- rowid stability.
CREATE VIRTUAL TABLE songs_fts USING fts5(
  song_id UNINDEXED,
  title,
  lyrics,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ── bible (Section 8) ───────────────────────────────────────────────────────────
-- No copyrighted text is bundled. Translations install from properly licensed or
-- public-domain packages; license is NOT NULL so text cannot arrive without terms.

CREATE TABLE bible_translations (
  id            TEXT PRIMARY KEY,
  abbreviation  TEXT NOT NULL,
  name          TEXT NOT NULL,
  language      TEXT NOT NULL DEFAULT 'en',
  license       TEXT NOT NULL,
  source_url    TEXT,
  install_state TEXT NOT NULL DEFAULT 'available' CHECK (install_state IN (
                  'available', 'installing', 'installed', 'failed')),
  verse_count   INTEGER NOT NULL DEFAULT 0,
  installed_at  TEXT
);

CREATE UNIQUE INDEX idx_translations_abbrev ON bible_translations(abbreviation);

CREATE TABLE bible_books (
  id             TEXT PRIMARY KEY,
  translation_id TEXT NOT NULL REFERENCES bible_translations(id) ON DELETE CASCADE,
  book_number    INTEGER NOT NULL,
  name           TEXT NOT NULL,
  abbreviation   TEXT NOT NULL,
  chapter_count  INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_books_translation_number
  ON bible_books(translation_id, book_number);

CREATE TABLE bible_verses (
  translation_id TEXT NOT NULL REFERENCES bible_translations(id) ON DELETE CASCADE,
  book_number    INTEGER NOT NULL,
  chapter        INTEGER NOT NULL,
  verse          INTEGER NOT NULL,
  text           TEXT NOT NULL,
  PRIMARY KEY (translation_id, book_number, chapter, verse)
-- WITHOUT ROWID: the composite PK is the access path for every lookup ("John 3:16"), so
-- a separate rowid would only cost space and an indirection across ~31,000 rows each.
) WITHOUT ROWID;

-- Keyword search across verses. Coordinates ride along as UNINDEXED columns so a hit
-- resolves straight to a reference -- bible_verses is WITHOUT ROWID and has no rowid to
-- map against.
CREATE VIRTUAL TABLE bible_verses_fts USING fts5(
  translation_id UNINDEXED,
  book_number UNINDEXED,
  chapter UNINDEXED,
  verse UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ── presentations & slides (Section 15) ─────────────────────────────────────────

CREATE TABLE presentations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  theme_id   TEXT REFERENCES themes(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN (
               'custom', 'song', 'scripture', 'announcement', 'sermon')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE presentation_slides (
  id                  TEXT PRIMARY KEY,
  presentation_id     TEXT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  sort_order          INTEGER NOT NULL,
  -- Slide elements (text/image/shape) as JSON. Geometry is normalised to the 1920x1080
  -- design canvas so one slide renders correctly on 720p and 4K alike.
  elements_json       TEXT NOT NULL DEFAULT '[]',
  notes               TEXT,
  theme_override_json TEXT
);

CREATE INDEX idx_slides_presentation ON presentation_slides(presentation_id, sort_order);

-- ── announcements (Section 25) ──────────────────────────────────────────────────

CREATE TABLE announcements (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  body           TEXT,
  image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  video_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  event_date     TEXT,
  event_time     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- ── services (Section 17) ───────────────────────────────────────────────────────

CREATE TABLE services (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  service_date TEXT,
  theme_id     TEXT REFERENCES themes(id) ON DELETE SET NULL,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_services_date ON services(service_date DESC);

CREATE TABLE service_items (
  id          TEXT PRIMARY KEY,
  service_id  TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN (
                'song', 'scripture', 'slide', 'image', 'video',
                'camera_scene', 'announcement', 'header')),
  label       TEXT NOT NULL,
  -- Deliberately NOT a foreign key: ref_id points into songs, media_assets,
  -- announcements or presentations depending on kind. SQLite cannot express a
  -- polymorphic reference, so the repository layer enforces it.
  ref_id      TEXT,
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_service_items_service ON service_items(service_id, sort_order);

-- ── playlists (Section 18) ──────────────────────────────────────────────────────

CREATE TABLE playlists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('custom', 'template', 'recurring')),
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE playlist_items (
  id          TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL,
  service_id  TEXT REFERENCES services(id) ON DELETE CASCADE,
  item_json   TEXT,
  -- An entry is either a saved service or an inline item, never both and never neither.
  CHECK ((service_id IS NOT NULL AND item_json IS NULL)
      OR (service_id IS NULL AND item_json IS NOT NULL))
);

CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id, sort_order);

-- ── hardware profiles (Sections 9, 22) ──────────────────────────────────────────

CREATE TABLE camera_profiles (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  provider    TEXT NOT NULL CHECK (provider IN ('usb', 'capture-card', 'ndi', 'rtsp')),
  device_id   TEXT NOT NULL,
  resolution  TEXT NOT NULL DEFAULT '1920x1080',
  framerate   REAL NOT NULL DEFAULT 30,
  mirrored    INTEGER NOT NULL DEFAULT 0 CHECK (mirrored IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE display_profiles (
  id            TEXT PRIMARY KEY,
  os_display_id TEXT NOT NULL,
  label         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'unused' CHECK (role IN (
                  'operator', 'presentation', 'preview', 'confidence', 'unused')),
  bounds_json   TEXT NOT NULL DEFAULT '{}',
  scale_factor  REAL NOT NULL DEFAULT 1,
  aspect_ratio  TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  last_seen_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_display_profiles_os_id ON display_profiles(os_display_id);

-- Only one display may hold each singular output role. Two 'presentation' displays would
-- make "which screen is the audience seeing?" unanswerable.
CREATE UNIQUE INDEX idx_display_role_unique
  ON display_profiles(role) WHERE role IN ('presentation', 'confidence', 'preview');

-- ── crash recovery (Section 33) ─────────────────────────────────────────────────

CREATE TABLE session_recovery (
  id             TEXT PRIMARY KEY,
  service_id     TEXT REFERENCES services(id) ON DELETE SET NULL,
  service_name   TEXT,
  snapshot_json  TEXT NOT NULL DEFAULT '{}',
  heartbeat_at   TEXT NOT NULL,
  clean_shutdown INTEGER NOT NULL DEFAULT 0 CHECK (clean_shutdown IN (0, 1))
);

CREATE INDEX idx_session_recovery_heartbeat ON session_recovery(heartbeat_at DESC);

-- ── cloud sync change log (Section 29) ──────────────────────────────────────────
-- Present from day one although sync ships in Phase 9: retrofitting a change log onto a
-- live database means reconstructing history that was never recorded. An unused table
-- costs nothing.

CREATE TABLE sync_oplog (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity       TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  payload_json TEXT,
  local_ts     TEXT NOT NULL,
  synced_at    TEXT
);

CREATE INDEX idx_sync_oplog_pending ON sync_oplog(id) WHERE synced_at IS NULL;

-- ── FTS synchronisation ─────────────────────────────────────────────────────────
--
-- A song's searchable text spans two tables (title in songs, lyrics in song_sections),
-- so maintaining the index from triggers would need an aggregating trigger on both --
-- fragile, and it would fire once per section on every save. Instead SongRepository
-- rebuilds a song's FTS row inside the same transaction as the write.
--
-- Deletion is the one case a trigger handles cleanly, needing no aggregate:
CREATE TRIGGER songs_fts_after_song_delete AFTER DELETE ON songs BEGIN
  DELETE FROM songs_fts WHERE song_id = old.id;
END;

-- Removing a translation must not leave its verses in the search index.
CREATE TRIGGER bible_fts_after_translation_delete
AFTER DELETE ON bible_translations BEGIN
  DELETE FROM bible_verses_fts WHERE translation_id = old.id;
END;
`;
