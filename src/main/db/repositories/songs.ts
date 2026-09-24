/**
 * EXCEPTIONEL PRESENTER — song library (Section 7).
 *
 * Owns the songs_fts search index: a song's searchable text spans two tables (title in
 * `songs`, lyrics aggregated from `song_sections`), so the index is rebuilt inside the
 * same transaction as every write. See migrations/0001-init.ts for why not triggers.
 *
 * Deletes are TOMBSTONES, not row removal (migration 0003). A hard delete plus a prunable
 * change log means a replica that misses the delete resurrects the song on its next pull.
 */

import type {
  Song,
  SongQuery,
  SongSection,
  SongSectionKind,
  SongSummary,
  SlideBreakMode,
} from '../../../shared/domain/entities.ts';
import type { SongDraft } from '../../../shared/ipc-contract.ts';
import type { SqliteDriver } from '../driver.ts';
import type { IdentityRepository } from './identity.ts';
import {
  asBool,
  asInt,
  asText,
  asTextOrNull,
  boolToSql,
  escapeLike,
  ftsQuery,
  newId,
  nowIso,
  pagination,
  recordOp,
} from './support.ts';

export interface SongRepository {
  list(query: SongQuery): SongSummary[];
  get(id: string): Song | null;
  save(draft: SongDraft): Song;
  /** Soft delete. The row stays as a tombstone so the deletion can propagate. */
  delete(id: string): void;
  /** Undoes a soft delete. Free to offer, because the data was never destroyed. */
  restore(id: string): Song | null;
  duplicate(id: string): Song;
  setFavorite(id: string, isFavorite: boolean): void;
  categories(): string[];
  /** Tombstones deleted before `olderThanIso`. Only safe once every replica has pulled. */
  purgeTombstones(olderThanIso: string): number;
  /** Deleted songs, for an "Recently deleted" recovery view. */
  listDeleted(limit?: number): SongSummary[];
}

export function createSongRepository(db: SqliteDriver, identity: IdentityRepository): SongRepository {
  const readSections = (songId: string): SongSection[] =>
    db
      .prepare(
        `SELECT id, song_id, kind, label, sort_order, lyrics, slide_break_mode
         FROM song_sections WHERE song_id = ? ORDER BY sort_order, id`,
      )
      .all(songId)
      .map((row) => ({
        id: asText(row['id'] ?? null),
        songId: asText(row['song_id'] ?? null),
        kind: asText(row['kind'] ?? null) as SongSectionKind,
        label: asText(row['label'] ?? null),
        sortOrder: asInt(row['sort_order'] ?? null),
        lyrics: asText(row['lyrics'] ?? null),
        slideBreakMode: asText(row['slide_break_mode'] ?? null) as SlideBreakMode,
      }));

  const SELECT_SONG = `SELECT id, title, artist, author, copyright, ccli_number, song_key, notes,
                              category, is_favorite, created_at, updated_at
                       FROM songs`;

  const toSong = (row: Record<string, unknown>, id: string): Song => ({
    id,
    title: asText((row['title'] ?? null) as never),
    artist: asTextOrNull((row['artist'] ?? null) as never),
    author: asTextOrNull((row['author'] ?? null) as never),
    copyright: asTextOrNull((row['copyright'] ?? null) as never),
    ccliNumber: asTextOrNull((row['ccli_number'] ?? null) as never),
    songKey: asTextOrNull((row['song_key'] ?? null) as never),
    notes: asTextOrNull((row['notes'] ?? null) as never),
    category: asTextOrNull((row['category'] ?? null) as never),
    isFavorite: asBool((row['is_favorite'] ?? null) as never),
    createdAt: asText((row['created_at'] ?? null) as never),
    updatedAt: asText((row['updated_at'] ?? null) as never),
    sections: readSections(id),
  });

  /** Live songs only. A tombstoned song must be invisible to every normal read. */
  const read = (id: string): Song | null => {
    const row = db.prepare(`${SELECT_SONG} WHERE id = ? AND deleted_at IS NULL`).get(id);
    return row ? toSong(row, id) : null;
  };

  /**
   * Rebuilds one song's FTS row. Delete-then-insert because FTS5 rows are addressed by the
   * UNINDEXED song_id rather than by rowid. MUST run inside the write's transaction so data
   * and index commit together.
   */
  const reindex = (songId: string): void => {
    db.prepare('DELETE FROM songs_fts WHERE song_id = ?').run(songId);

    // Tombstoned songs are deliberately left out of the index, so a deleted song stops
    // appearing in search immediately. The hard-delete trigger in 0001-init covers purges.
    const row = db.prepare('SELECT title FROM songs WHERE id = ? AND deleted_at IS NULL').get(songId);
    if (!row) return;

    const lyrics = db
      .prepare('SELECT lyrics FROM song_sections WHERE song_id = ? ORDER BY sort_order')
      .all(songId)
      .map((section) => asText(section['lyrics'] ?? null))
      .join('\n');

    db.prepare('INSERT INTO songs_fts (song_id, title, lyrics) VALUES (?, ?, ?)').run(
      songId,
      asText(row['title'] ?? null),
      lyrics,
    );
  };

  const toSummary = (row: Record<string, unknown>): SongSummary => ({
    id: asText((row['id'] ?? null) as never),
    title: asText((row['title'] ?? null) as never),
    artist: asTextOrNull((row['artist'] ?? null) as never),
    songKey: asTextOrNull((row['song_key'] ?? null) as never),
    category: asTextOrNull((row['category'] ?? null) as never),
    isFavorite: asBool((row['is_favorite'] ?? null) as never),
    sectionCount: asInt((row['section_count'] ?? null) as never),
    updatedAt: asText((row['updated_at'] ?? null) as never),
  });

  return {
    list(query) {
      const { limit, offset } = pagination(query.limit, query.offset);
      const search = query.search?.trim() ?? '';

      const where: string[] = ['s.deleted_at IS NULL'];
      const params: (string | number)[] = [];

      if (search) {
        // Two-pronged search: FTS covers lyrics and tokenised titles, while LIKE catches
        // partial words mid-token ("aker" in "Maker") that FTS prefix matching misses
        // because it only anchors at token starts.
        const match = ftsQuery(search);
        if (match) {
          where.push(
            `(s.id IN (SELECT song_id FROM songs_fts WHERE songs_fts MATCH ?)
              OR s.title LIKE ? ESCAPE '\\'
              OR IFNULL(s.artist, '') LIKE ? ESCAPE '\\')`,
          );
          const like = `%${escapeLike(search)}%`;
          params.push(match, like, like);
        } else {
          where.push(`s.title LIKE ? ESCAPE '\\'`);
          params.push(`%${escapeLike(search)}%`);
        }
      }

      if (query.category) {
        where.push('s.category = ?');
        params.push(query.category);
      }
      if (query.favoritesOnly) where.push('s.is_favorite = 1');

      const sql = `
        SELECT s.id, s.title, s.artist, s.song_key, s.category, s.is_favorite, s.updated_at,
               (SELECT COUNT(*) FROM song_sections sec WHERE sec.song_id = s.id) AS section_count
        FROM songs s
        WHERE ${where.join(' AND ')}
        ORDER BY s.is_favorite DESC, s.title COLLATE NOCASE
        LIMIT ? OFFSET ?`;

      return db
        .prepare(sql)
        .all(...params, limit, offset)
        .map(toSummary);
    },

    get: read,

    save(draft) {
      return db.transaction(() => {
        const timestamp = nowIso();
        const stamp = identity.nextStamp();
        const isNew = !draft.id;
        const songId = draft.id ?? newId('song');

        if (isNew) {
          db.prepare(
            `INSERT INTO songs (id, title, artist, author, copyright, ccli_number, song_key,
                                notes, category, is_favorite, created_at, updated_at,
                                revision, origin_device_id, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          ).run(
            songId,
            draft.title,
            draft.artist ?? null,
            draft.author ?? null,
            draft.copyright ?? null,
            draft.ccliNumber ?? null,
            draft.songKey ?? null,
            draft.notes ?? null,
            draft.category ?? null,
            boolToSql(draft.isFavorite ?? false),
            timestamp,
            timestamp,
            stamp.revision,
            stamp.originDeviceId,
          );
        } else {
          // A tombstoned song cannot be edited: the operator has to restore it first, so
          // an edit never silently undeletes something another machine deleted.
          const existing = db
            .prepare('SELECT deleted_at FROM songs WHERE id = ?')
            .get(songId);
          if (!existing) throw new Error(`cannot update song ${songId}: it does not exist`);
          if (existing['deleted_at'] !== null) {
            throw new Error(`cannot update song ${songId}: it has been deleted — restore it first`);
          }

          db.prepare(
            `UPDATE songs SET title = ?, artist = ?, author = ?, copyright = ?, ccli_number = ?,
                              song_key = ?, notes = ?, category = ?, is_favorite = ?,
                              updated_at = ?, revision = ?, origin_device_id = ?
             WHERE id = ?`,
          ).run(
            draft.title,
            draft.artist ?? null,
            draft.author ?? null,
            draft.copyright ?? null,
            draft.ccliNumber ?? null,
            draft.songKey ?? null,
            draft.notes ?? null,
            draft.category ?? null,
            boolToSql(draft.isFavorite ?? false),
            timestamp,
            stamp.revision,
            stamp.originDeviceId,
            songId,
          );
        }

        // Sections are replaced wholesale. Diffing them would be more code for no gain: the
        // editor always submits the complete ordered list, and they are versioned by the
        // parent song's revision rather than individually.
        db.prepare('DELETE FROM song_sections WHERE song_id = ?').run(songId);
        const insertSection = db.prepare(
          `INSERT INTO song_sections (id, song_id, kind, label, sort_order, lyrics, slide_break_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        draft.sections.forEach((section, index) => {
          insertSection.run(
            section.id ?? newId('sec'),
            songId,
            section.kind,
            section.label,
            // Array position wins over a client-supplied sortOrder, which arrives with gaps
            // and duplicates after drag-and-drop reordering.
            index,
            section.lyrics,
            section.slideBreakMode,
          );
        });

        reindex(songId);
        recordOp(db, 'songs', songId, isNew ? 'insert' : 'update', undefined, stamp);

        const saved = read(songId);
        if (!saved) throw new Error(`song ${songId} vanished immediately after write`);
        return saved;
      });
    },

    delete(id) {
      db.transaction(() => {
        const stamp = identity.nextStamp();
        const result = db
          .prepare(
            `UPDATE songs SET deleted_at = ?, updated_at = ?, revision = ?, origin_device_id = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(nowIso(), nowIso(), stamp.revision, stamp.originDeviceId, id);

        // Deleting a missing or already-deleted song is not an error — the desired end
        // state already holds, and a pull may legitimately replay a delete.
        if (result.changes === 0) return;

        // Drop it from the search index so it disappears from results at once. The row
        // itself survives as the tombstone.
        db.prepare('DELETE FROM songs_fts WHERE song_id = ?').run(id);
        recordOp(db, 'songs', id, 'delete', undefined, stamp);
      });
    },

    restore(id) {
      return db.transaction(() => {
        const stamp = identity.nextStamp();
        const result = db
          .prepare(
            `UPDATE songs SET deleted_at = NULL, updated_at = ?, revision = ?, origin_device_id = ?
             WHERE id = ? AND deleted_at IS NOT NULL`,
          )
          .run(nowIso(), stamp.revision, stamp.originDeviceId, id);

        if (result.changes === 0) return null;

        reindex(id);
        recordOp(db, 'songs', id, 'update', { restored: true }, stamp);
        return read(id);
      });
    },

    duplicate(id) {
      return db.transaction(() => {
        const source = read(id);
        if (!source) throw new Error(`cannot duplicate song ${id}: it does not exist`);

        const copyId = newId('song');
        const timestamp = nowIso();
        const stamp = identity.nextStamp();

        db.prepare(
          `INSERT INTO songs (id, title, artist, author, copyright, ccli_number, song_key,
                              notes, category, is_favorite, created_at, updated_at,
                              revision, origin_device_id, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          copyId,
          `${source.title} (Copy)`,
          source.artist,
          source.author,
          source.copyright,
          source.ccliNumber,
          source.songKey,
          source.notes,
          source.category,
          // A copy starts unfavourited: duplicating to experiment should not clutter the
          // operator's favourites list.
          0,
          timestamp,
          timestamp,
          stamp.revision,
          stamp.originDeviceId,
        );

        const insertSection = db.prepare(
          `INSERT INTO song_sections (id, song_id, kind, label, sort_order, lyrics, slide_break_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const section of source.sections) {
          insertSection.run(
            newId('sec'),
            copyId,
            section.kind,
            section.label,
            section.sortOrder,
            section.lyrics,
            section.slideBreakMode,
          );
        }

        reindex(copyId);
        recordOp(db, 'songs', copyId, 'insert', undefined, stamp);

        const saved = read(copyId);
        if (!saved) throw new Error(`duplicated song ${copyId} vanished immediately after write`);
        return saved;
      });
    },

    setFavorite(id, isFavorite) {
      db.transaction(() => {
        const stamp = identity.nextStamp();
        db.prepare(
          `UPDATE songs SET is_favorite = ?, updated_at = ?, revision = ?, origin_device_id = ?
           WHERE id = ? AND deleted_at IS NULL`,
        ).run(boolToSql(isFavorite), nowIso(), stamp.revision, stamp.originDeviceId, id);
        recordOp(db, 'songs', id, 'update', { isFavorite }, stamp);
      });
    },

    categories() {
      return db
        .prepare(
          `SELECT DISTINCT category FROM songs
           WHERE category IS NOT NULL AND category <> '' AND deleted_at IS NULL
           ORDER BY category COLLATE NOCASE`,
        )
        .all()
        .map((row) => asText(row['category'] ?? null));
    },

    listDeleted(limit = 50) {
      return db
        .prepare(
          `SELECT s.id, s.title, s.artist, s.song_key, s.category, s.is_favorite, s.updated_at,
                  (SELECT COUNT(*) FROM song_sections sec WHERE sec.song_id = s.id) AS section_count
           FROM songs s
           WHERE s.deleted_at IS NOT NULL
           ORDER BY s.deleted_at DESC
           LIMIT ?`,
        )
        .all(Math.min(Math.max(limit, 1), 500))
        .map(toSummary);
    },

    purgeTombstones(olderThanIso) {
      return db.transaction(() => {
        // Hard DELETE here, which is what the songs_fts_after_song_delete trigger and the
        // song_sections cascade are for. Only safe once every replica has seen the
        // tombstone, otherwise the song comes back on the next pull.
        const result = db
          .prepare('DELETE FROM songs WHERE deleted_at IS NOT NULL AND deleted_at < ?')
          .run(olderThanIso);
        return result.changes;
      });
    },
  };
}
