/**
 * EXCEPTIONEL PRESENTER — song library (Section 7).
 *
 * Owns the songs_fts search index: a song's searchable text spans two tables (title in
 * `songs`, lyrics aggregated from `song_sections`), so the index is rebuilt inside the
 * same transaction as every write. See the comment in migrations/0001-init.ts for why
 * this is not done with triggers.
 */

import type { Song, SongQuery, SongSection, SongSectionKind, SongSummary, SlideBreakMode } from '../../../shared/domain/entities.ts';
import type { SongDraft } from '../../../shared/ipc-contract.ts';
import type { SqliteDriver } from '../driver.ts';
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
  delete(id: string): void;
  duplicate(id: string): Song;
  setFavorite(id: string, isFavorite: boolean): void;
  categories(): string[];
}

export function createSongRepository(db: SqliteDriver): SongRepository {
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

  const read = (id: string): Song | null => {
    const row = db
      .prepare(
        `SELECT id, title, artist, author, copyright, ccli_number, song_key, notes,
                category, is_favorite, created_at, updated_at
         FROM songs WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    return {
      id: asText(row['id'] ?? null),
      title: asText(row['title'] ?? null),
      artist: asTextOrNull(row['artist'] ?? null),
      author: asTextOrNull(row['author'] ?? null),
      copyright: asTextOrNull(row['copyright'] ?? null),
      ccliNumber: asTextOrNull(row['ccli_number'] ?? null),
      songKey: asTextOrNull(row['song_key'] ?? null),
      notes: asTextOrNull(row['notes'] ?? null),
      category: asTextOrNull(row['category'] ?? null),
      isFavorite: asBool(row['is_favorite'] ?? null),
      createdAt: asText(row['created_at'] ?? null),
      updatedAt: asText(row['updated_at'] ?? null),
      sections: readSections(id),
    };
  };

  /**
   * Rebuilds one song's FTS row. Delete-then-insert rather than UPDATE because FTS5
   * external rows are keyed by rowid, and we address ours by the UNINDEXED song_id.
   * MUST be called inside the write's transaction so data and index commit together.
   */
  const reindex = (songId: string): void => {
    db.prepare('DELETE FROM songs_fts WHERE song_id = ?').run(songId);
    const row = db.prepare('SELECT title FROM songs WHERE id = ?').get(songId);
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

  return {
    list(query) {
      const { limit, offset } = pagination(query.limit, query.offset);
      const search = query.search?.trim() ?? '';

      const where: string[] = [];
      const params: (string | number)[] = [];

      if (search) {
        // Two-pronged search: FTS covers lyrics and tokenised titles, while LIKE catches
        // partial words mid-token ("mak" in "Maker") that FTS prefix matching misses
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
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.is_favorite DESC, s.title COLLATE NOCASE
        LIMIT ? OFFSET ?`;

      return db
        .prepare(sql)
        .all(...params, limit, offset)
        .map((row) => ({
          id: asText(row['id'] ?? null),
          title: asText(row['title'] ?? null),
          artist: asTextOrNull(row['artist'] ?? null),
          songKey: asTextOrNull(row['song_key'] ?? null),
          category: asTextOrNull(row['category'] ?? null),
          isFavorite: asBool(row['is_favorite'] ?? null),
          sectionCount: asInt(row['section_count'] ?? null),
          updatedAt: asText(row['updated_at'] ?? null),
        }));
    },

    get: read,

    save(draft) {
      return db.transaction(() => {
        const timestamp = nowIso();
        const isNew = !draft.id;
        const songId = draft.id ?? newId('song');

        if (isNew) {
          db.prepare(
            `INSERT INTO songs (id, title, artist, author, copyright, ccli_number, song_key,
                                notes, category, is_favorite, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          );
        } else {
          const existing = db.prepare('SELECT 1 AS present FROM songs WHERE id = ?').get(songId);
          if (!existing) throw new Error(`cannot update song ${songId}: it does not exist`);
          db.prepare(
            `UPDATE songs SET title = ?, artist = ?, author = ?, copyright = ?, ccli_number = ?,
                              song_key = ?, notes = ?, category = ?, is_favorite = ?, updated_at = ?
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
            songId,
          );
        }

        // Sections are replaced wholesale. Diffing them would be more code for no gain:
        // the editor always submits the complete, ordered list, and a song has tens of
        // sections at most.
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
            // Trust position in the array over a client-supplied sortOrder, which can
            // arrive with gaps or duplicates after drag-and-drop reordering.
            index,
            section.lyrics,
            section.slideBreakMode,
          );
        });

        reindex(songId);
        recordOp(db, 'songs', songId, isNew ? 'insert' : 'update');

        const saved = read(songId);
        if (!saved) throw new Error(`song ${songId} vanished immediately after write`);
        return saved;
      });
    },

    delete(id) {
      db.transaction(() => {
        const result = db.prepare('DELETE FROM songs WHERE id = ?').run(id);
        if (result.changes === 0) return; // deleting a missing song is not an error
        // song_sections cascade and songs_fts is cleared by trigger; see 0001-init.ts.
        recordOp(db, 'songs', id, 'delete');
      });
    },

    duplicate(id) {
      return db.transaction(() => {
        const source = read(id);
        if (!source) throw new Error(`cannot duplicate song ${id}: it does not exist`);

        const copyId = newId('song');
        const timestamp = nowIso();
        db.prepare(
          `INSERT INTO songs (id, title, artist, author, copyright, ccli_number, song_key,
                              notes, category, is_favorite, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // A copy starts unfavourited: duplicating to experiment shouldn't clutter
          // the operator's favourites list.
          0,
          timestamp,
          timestamp,
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
        recordOp(db, 'songs', copyId, 'insert');

        const saved = read(copyId);
        if (!saved) throw new Error(`duplicated song ${copyId} vanished immediately after write`);
        return saved;
      });
    },

    setFavorite(id, isFavorite) {
      db.transaction(() => {
        db.prepare('UPDATE songs SET is_favorite = ?, updated_at = ? WHERE id = ?').run(
          boolToSql(isFavorite),
          nowIso(),
          id,
        );
        recordOp(db, 'songs', id, 'update', { isFavorite });
      });
    },

    categories() {
      return db
        .prepare(
          `SELECT DISTINCT category FROM songs
           WHERE category IS NOT NULL AND category <> ''
           ORDER BY category COLLATE NOCASE`,
        )
        .all()
        .map((row) => asText(row['category'] ?? null));
    },
  };
}
