/**
 * EXCEPTIONEL PRESENTER — the media library (Section 13, Phase 5).
 *
 * The index of what has been imported. The FILES live in the app's own media root and are written by
 * `services/media-import.ts`; this repository owns the rows that describe them, and nothing else in
 * the app reads `media_assets` directly.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG, so they are stated up front.
 *
 * 1. DE-DUPLICATION IS BY CONTENT HASH, AND THE DATABASE ENFORCES IT. `idx_media_hash` is UNIQUE over
 *    live rows only (migration 0003), so `add` cannot create a second row for bytes already in the
 *    library even if two imports race. The partial index deliberately ignores tombstones, because
 *    deleting a background must not permanently prevent re-importing it.
 *
 * 2. DELETE IS A TOMBSTONE, BUT THE FILE IS REAL. The row survives so the deletion can propagate to
 *    other machines; the file on disk has to go, or "delete" would not free any space. That leaves a
 *    hazard: delete a file, re-import the identical file, and the tombstone's `abs_path` now names a
 *    file that belongs to the NEW row. So `delete` reports whether any live row still references the
 *    path, and the caller unlinks only when none does. Getting this wrong deletes media that is still
 *    in Sunday's service.
 */

import type { MediaAsset, MediaKind } from '../../../shared/domain/entities.ts';
import { MEDIA_KINDS } from '../../../shared/domain/entities.ts';
import type { MediaQuery } from '../../../shared/ipc-contract.ts';
import type { SqliteDriver, SqlValue } from '../driver.ts';
import type { IdentityRepository } from './identity.ts';
import {
  asBool,
  asInt,
  asIntOrNull,
  asText,
  asTextOrNull,
  boolToSql,
  escapeLike,
  newId,
  nowIso,
  pagination,
  recordOp,
} from './support.ts';

/** What import knows about a file once it has been stored. */
export interface MediaAssetInput {
  kind: MediaKind;
  filename: string;
  absPath: string;
  mime: string;
  bytes: number;
  hash: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  thumbnailPath?: string | null;
  category?: string | null;
}

export interface AddedMedia {
  asset: MediaAsset;
  /**
   * False when these bytes were already in the library, so nothing new was recorded.
   *
   * The caller reports this to the operator as "already in your library" rather than a silent success,
   * because importing forty files and being told forty were added when eight were duplicates is a
   * lie the operator will only discover later.
   */
  created: boolean;
}

export interface DeletedMedia {
  asset: MediaAsset;
  /**
   * True when a LIVE row still points at the same file, so the caller must NOT unlink it.
   *
   * Happens when an asset was deleted and the identical file re-imported: the tombstone and the new
   * row share a path, because the stored name is derived from the content hash.
   */
  fileStillReferenced: boolean;
}

export interface MediaRepository {
  list(query: MediaQuery): MediaAsset[];
  get(id: string): MediaAsset | null;
  /** Live row for these bytes, if the library already has them. */
  findByHash(hash: string): MediaAsset | null;
  /** Records an import. Returns the existing asset, unchanged, when the hash already exists. */
  add(input: MediaAssetInput): AddedMedia;
  setFavorite(id: string, isFavorite: boolean): void;
  setCategory(id: string, category: string | null): void;
  /** Fills in what only a decoder can know: pixel dimensions, duration, thumbnail. */
  setProbe(
    id: string,
    probe: {
      width?: number | null;
      height?: number | null;
      durationMs?: number | null;
      thumbnailPath?: string | null;
    },
  ): void;
  /** Tombstones the row. Returns what was deleted so the caller can remove the file. */
  delete(id: string): DeletedMedia | null;
  categories(): string[];
  count(): number;
  /** Tombstones deleted before `olderThanIso`. Only safe once every replica has pulled. */
  purgeTombstones(olderThanIso: string): number;
}

const COLUMNS = `id, kind, filename, abs_path, mime, bytes, width, height, duration_ms,
                 thumbnail_path, category, is_favorite, hash, created_at, updated_at`;

export function createMediaRepository(
  db: SqliteDriver,
  identity: IdentityRepository,
): MediaRepository {
  const toAsset = (row: Record<string, unknown>): MediaAsset => ({
    id: asText((row['id'] ?? null) as SqlValue),
    kind: toKind((row['kind'] ?? null) as SqlValue),
    filename: asText((row['filename'] ?? null) as SqlValue),
    absPath: asText((row['abs_path'] ?? null) as SqlValue),
    mime: asText((row['mime'] ?? null) as SqlValue),
    bytes: asInt((row['bytes'] ?? null) as SqlValue),
    width: asIntOrNull((row['width'] ?? null) as SqlValue),
    height: asIntOrNull((row['height'] ?? null) as SqlValue),
    durationMs: asIntOrNull((row['duration_ms'] ?? null) as SqlValue),
    thumbnailPath: asTextOrNull((row['thumbnail_path'] ?? null) as SqlValue),
    category: asTextOrNull((row['category'] ?? null) as SqlValue),
    isFavorite: asBool((row['is_favorite'] ?? null) as SqlValue),
    hash: asTextOrNull((row['hash'] ?? null) as SqlValue),
    createdAt: asText((row['created_at'] ?? null) as SqlValue),
    // Rows written before migration 0003 have no updated_at; fall back rather than emit an empty
    // string, which would sort before every real timestamp.
    updatedAt: asTextOrNull((row['updated_at'] ?? null) as SqlValue) ??
      asText((row['created_at'] ?? null) as SqlValue),
  });

  const get = (id: string): MediaAsset | null => {
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM media_assets WHERE id = ? AND deleted_at IS NULL`)
      .get(id);
    return row ? toAsset(row) : null;
  };

  const findByHash = (hash: string): MediaAsset | null => {
    if (hash === '') return null;
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM media_assets WHERE hash = ? AND deleted_at IS NULL`)
      .get(hash);
    return row ? toAsset(row) : null;
  };

  /** Stamps a row as changed. Every mutation goes through this, so none can forget the sync fields. */
  const touch = (id: string, op: 'update', payload?: unknown): void => {
    const stamp = identity.nextStamp();
    db.prepare(
      `UPDATE media_assets SET updated_at = ?, revision = ?, origin_device_id = ?
       WHERE id = ? AND deleted_at IS NULL`,
    ).run(nowIso(), stamp.revision, stamp.originDeviceId, id);
    recordOp(db, 'media_assets', id, op, payload, stamp);
  };

  return {
    get,
    findByHash,

    list(query) {
      const where: string[] = ['deleted_at IS NULL'];
      const params: SqlValue[] = [];

      if (query.kind) {
        where.push('kind = ?');
        params.push(query.kind);
      }

      if (query.category) {
        where.push('category = ?');
        params.push(query.category);
      }

      if (query.favoritesOnly) where.push('is_favorite = 1');

      const search = query.search?.trim() ?? '';
      if (search !== '') {
        /*
         * LIKE on the filename and category, not FTS.
         *
         * Media has no body text to index — the only words are the name the operator gave the file
         * and the folder they filed it under. An FTS table would be a second copy of two short
         * columns, kept in sync for no gain, and it would tokenise "sunrise-01.jpg" in ways that make
         * typing "01" find nothing.
         */
        where.push(`(filename LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')`);
        const like = `%${escapeLike(search)}%`;
        params.push(like, like);
      }

      const page = pagination(query.limit, query.offset);

      return db
        .prepare(
          `SELECT ${COLUMNS} FROM media_assets
           WHERE ${where.join(' AND ')}
           ORDER BY is_favorite DESC, created_at DESC, id
           LIMIT ? OFFSET ?`,
        )
        .all(...params, page.limit, page.offset)
        .map(toAsset);
    },

    add(input) {
      return db.transaction(() => {
        /*
         * Checked inside the transaction, not before it. Two import dialogs cannot be open at once
         * today, but the unique index is the real guarantee and this check has to sit under the same
         * lock as the insert for the two to agree.
         */
        const existing = findByHash(input.hash);
        if (existing) return { asset: existing, created: false };

        const id = newId('media');
        const timestamp = nowIso();
        const stamp = identity.nextStamp();

        db.prepare(
          `INSERT INTO media_assets (id, kind, filename, abs_path, mime, bytes, width, height,
                                     duration_ms, thumbnail_path, category, is_favorite, hash,
                                     created_at, updated_at, revision, origin_device_id, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          id,
          input.kind,
          input.filename,
          input.absPath,
          input.mime,
          input.bytes,
          input.width ?? null,
          input.height ?? null,
          input.durationMs ?? null,
          input.thumbnailPath ?? null,
          input.category ?? null,
          input.hash,
          timestamp,
          timestamp,
          stamp.revision,
          stamp.originDeviceId,
        );

        recordOp(db, 'media_assets', id, 'insert', { kind: input.kind, hash: input.hash }, stamp);

        const saved = get(id);
        if (!saved) throw new Error(`media asset ${id} vanished immediately after insert`);
        return { asset: saved, created: true };
      });
    },

    setFavorite(id, isFavorite) {
      db.transaction(() => {
        db.prepare(`UPDATE media_assets SET is_favorite = ? WHERE id = ? AND deleted_at IS NULL`).run(
          boolToSql(isFavorite),
          id,
        );
        touch(id, 'update', { isFavorite });
      });
    },

    setCategory(id, category) {
      db.transaction(() => {
        // An empty string is stored as NULL: "" and "no category" must not be two different
        // categories in the filter list, which is what a blank entry in the dropdown would be.
        const value = category === null || category.trim() === '' ? null : category.trim();
        db.prepare(`UPDATE media_assets SET category = ? WHERE id = ? AND deleted_at IS NULL`).run(
          value,
          id,
        );
        touch(id, 'update', { category: value });
      });
    },

    setProbe(id, probe) {
      db.transaction(() => {
        /*
         * Built as a partial update: a thumbnail generated later must not wipe dimensions that were
         * read at import, and an image has no duration to set. Passing the whole row would make every
         * caller responsible for re-supplying fields it knows nothing about.
         */
        const sets: string[] = [];
        const params: SqlValue[] = [];

        if (probe.width !== undefined) {
          sets.push('width = ?');
          params.push(probe.width);
        }
        if (probe.height !== undefined) {
          sets.push('height = ?');
          params.push(probe.height);
        }
        if (probe.durationMs !== undefined) {
          sets.push('duration_ms = ?');
          params.push(probe.durationMs);
        }
        if (probe.thumbnailPath !== undefined) {
          sets.push('thumbnail_path = ?');
          params.push(probe.thumbnailPath);
        }

        if (sets.length === 0) return;

        db.prepare(
          `UPDATE media_assets SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
        ).run(...params, id);
        touch(id, 'update', probe);
      });
    },

    delete(id) {
      return db.transaction(() => {
        const existing = get(id);
        if (!existing) return null;

        const stamp = identity.nextStamp();
        const timestamp = nowIso();
        db.prepare(
          `UPDATE media_assets SET deleted_at = ?, updated_at = ?, revision = ?, origin_device_id = ?
           WHERE id = ? AND deleted_at IS NULL`,
        ).run(timestamp, timestamp, stamp.revision, stamp.originDeviceId, id);
        recordOp(db, 'media_assets', id, 'delete', undefined, stamp);

        /*
         * Asked AFTER the tombstone, so this row is no longer counted.
         *
         * The stored filename contains the content hash, so a re-imported identical file occupies the
         * same path as an older tombstone. Unlinking on the strength of the path alone would delete a
         * background that is live in a service.
         */
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n FROM media_assets WHERE abs_path = ? AND deleted_at IS NULL`,
          )
          .get(existing.absPath);

        return { asset: existing, fileStillReferenced: asInt(row?.['n'] ?? null) > 0 };
      });
    },

    categories() {
      return db
        .prepare(
          `SELECT DISTINCT category FROM media_assets
           WHERE category IS NOT NULL AND category <> '' AND deleted_at IS NULL
           ORDER BY category COLLATE NOCASE`,
        )
        .all()
        .map((row) => asText((row['category'] ?? null) as SqlValue));
    },

    count() {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM media_assets WHERE deleted_at IS NULL')
        .get();
      return asInt(row?.['n'] ?? null);
    },

    purgeTombstones(olderThanIso) {
      return db.transaction(() => {
        const doomed = db
          .prepare('SELECT id FROM media_assets WHERE deleted_at IS NOT NULL AND deleted_at < ?')
          .all(olderThanIso)
          .map((row) => asText((row['id'] ?? null) as SqlValue));

        if (doomed.length === 0) return 0;

        db.prepare('DELETE FROM media_assets WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(
          olderThanIso,
        );
        return doomed.length;
      });
    },
  };
}

/**
 * Coerces the stored kind.
 *
 * The column has a CHECK constraint, so an unknown value means the database was edited outside the
 * app. Falling back to `image` shows the operator a broken thumbnail they can delete, which beats
 * throwing and taking the whole media grid down over one bad row.
 */
function toKind(value: SqlValue): MediaKind {
  const text = asText(value);
  return (MEDIA_KINDS as readonly string[]).includes(text) ? (text as MediaKind) : 'image';
}
