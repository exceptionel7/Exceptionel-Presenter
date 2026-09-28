/**
 * EXCEPTIONEL PRESENTER — the media service (Phase 5).
 *
 * Joins the file dialog, the import pipeline and the library index, and is the ONLY thing that turns a
 * stored asset into something a renderer may see.
 *
 * WHY THE VIEW MAPPING LIVES HERE AND NOWHERE ELSE. `MediaAsset` carries `absPath` and
 * `thumbnailPath`. If two places built the renderer's payload, one of them would eventually forget to
 * strip them, and a filesystem path — including the operator's own name in `C:\\Users\\...` — would
 * end up in the DOM of a window that also runs third-party JavaScript. One function, used by every
 * channel.
 *
 * WHY IMPORT IS SEQUENTIAL. Twenty files are hashed one after another rather than in parallel. The
 * limiting factor is the disk, so concurrency buys nothing; meanwhile a serial loop keeps peak memory
 * at one chunk buffer and makes progress reporting mean what it says.
 */

import {
  deleteStoredFile,
  ensureMediaRoots,
  prepareImport,
  storeFile,
  type MediaRoots,
} from './media-import.ts';
import { mediaThumbnailUrl, mediaUrl } from '../../shared/domain/media.ts';
import type { MediaAsset } from '../../shared/domain/entities.ts';
import type {
  MediaAssetView,
  MediaImportReport,
  MediaQuery,
  RefusedMedia,
} from '../../shared/ipc-contract.ts';
import type { AppDatabase } from '../db/database.ts';

/**
 * Opens the native file dialog. Injected, so the service is testable without Electron — and so the
 * renderer has no way to supply a path.
 */
export type ChooseMediaFiles = () => Promise<string[]>;

/**
 * Generates a thumbnail, returning its absolute path, or null when it cannot.
 *
 * A seam, not a detail: the real implementation needs Electron's `nativeImage` (and, for video, a
 * decode this process cannot do), so it is supplied from index.ts. A church laptop that fails to
 * decode one file must still finish the import, which is why this returns null instead of throwing.
 */
export type GenerateThumbnail = (
  asset: MediaAsset,
  roots: MediaRoots,
) => Promise<{ path: string; width: number | null; height: number | null } | null>;

export interface MediaService {
  list(query: MediaQuery): MediaAssetView[];
  categories(): string[];
  import(): Promise<MediaImportReport>;
  /** Tombstones the row and removes the file, unless another live row still needs it. */
  remove(id: string): Promise<void>;
  setFavorite(id: string, isFavorite: boolean): void;
  setCategory(id: string, category: string | null): void;
  /**
   * Resolves a request from the `app-media:` protocol to a real file.
   *
   * MAIN ONLY. Returns null for an id with no live row, so a stale URL held by a renderer after a
   * delete produces a clean 404 rather than serving whatever is now at that path.
   */
  resolveFile(assetId: string, want: 'original' | 'thumbnail'): { path: string; mime: string } | null;
}

export function createMediaService(options: {
  db: AppDatabase;
  roots: MediaRoots;
  chooseFiles: ChooseMediaFiles;
  generateThumbnail?: GenerateThumbnail;
  onLog?: (line: string) => void;
}): MediaService {
  const { db, roots } = options;
  const log = options.onLog ?? (() => undefined);

  return {
    list: (query) => db.media.list(query).map(toView),

    categories: () => db.media.categories(),

    async import() {
      const paths = await options.chooseFiles();
      // Closing the dialog is not an error and must not produce a failure banner.
      if (paths.length === 0) return { outcome: 'cancelled' };

      await ensureMediaRoots(roots);

      const added: MediaAssetView[] = [];
      const duplicates: MediaAssetView[] = [];
      const refused: RefusedMedia[] = [];

      for (const path of paths) {
        const prepared = await prepareImport(path);
        if (!prepared.ok) {
          refused.push({ filename: prepared.filename, reason: prepared.reason });
          log(`[media] refused ${prepared.filename}: ${prepared.reason}`);
          continue;
        }

        /*
         * STORE BEFORE RECORDING, always — even when the hash is already known.
         *
         * `storeFile` is a no-op when the file is already there, and a repair when it is not. Doing it
         * unconditionally means a library whose media directory was partly lost (a failed backup
         * restore, a volunteer "cleaning up") heals itself on the next import of the same file, rather
         * than de-duplicating against a row whose file no longer exists and leaving a blank slide.
         */
        let stored;
        try {
          stored = await storeFile(prepared.prepared, roots);
        } catch (error) {
          const reason = `Could not copy the file into your library: ${describeError(error)}`;
          refused.push({ filename: prepared.prepared.filename, reason });
          log(`[media] copy failed for ${prepared.prepared.filename}: ${describeError(error)}`);
          continue;
        }

        const result = db.media.add({
          kind: prepared.prepared.kind,
          filename: prepared.prepared.filename,
          absPath: stored.absPath,
          mime: prepared.prepared.mime,
          bytes: prepared.prepared.bytes,
          hash: prepared.prepared.hash,
        });

        if (!result.created) {
          duplicates.push(toView(result.asset));
          log(`[media] already in the library: ${prepared.prepared.filename}`);
          continue;
        }

        // Thumbnails are generated after the row exists, so a decode failure leaves an imported
        // asset with no preview rather than no asset.
        const probed = await probe(result.asset);
        added.push(toView(probed));
        log(
          `[media] imported ${probed.filename} (${probed.kind}, ${String(probed.bytes)} bytes)` +
            `${stored.alreadyPresent ? ' — file was already on disk' : ''}`,
        );
      }

      return { outcome: 'completed', added, duplicates, refused };
    },

    async remove(id) {
      const deleted = db.media.delete(id);
      if (!deleted) return; // already gone; nothing to undo

      /*
       * The row is tombstoned FIRST, and the file removed second.
       *
       * If the unlink fails — a file locked by another process, which Windows does readily — the asset
       * is still gone from the library, which is what the operator asked for. The reverse order would
       * risk a row pointing at a file that had already been deleted.
       */
      if (deleted.fileStillReferenced) {
        log(`[media] kept the file for ${deleted.asset.filename}: another asset still uses it`);
        return;
      }

      const outcome = await deleteStoredFile(deleted.asset.absPath, roots);
      if (outcome === 'refused') {
        // Only reachable if abs_path was written by something other than this app.
        log(`[media] REFUSED to delete ${deleted.asset.absPath}: outside the media roots`);
      }

      if (deleted.asset.thumbnailPath) {
        await deleteStoredFile(deleted.asset.thumbnailPath, roots);
      }
    },

    setFavorite: (id, isFavorite) => {
      db.media.setFavorite(id, isFavorite);
    },

    setCategory: (id, category) => {
      db.media.setCategory(id, category);
    },

    resolveFile(assetId, want) {
      const asset = db.media.get(assetId);
      if (!asset) return null;

      if (want === 'thumbnail') {
        return asset.thumbnailPath === null
          ? null
          : { path: asset.thumbnailPath, mime: 'image/png' };
      }

      return { path: asset.absPath, mime: asset.mime };
    },
  };

  /** Fills in dimensions and a thumbnail where the host can produce them. */
  async function probe(asset: MediaAsset): Promise<MediaAsset> {
    if (!options.generateThumbnail) return asset;

    let result: Awaited<ReturnType<GenerateThumbnail>> = null;
    try {
      result = await options.generateThumbnail(asset, roots);
    } catch (error) {
      // An undecodable file is a bad file, not a failed import.
      log(`[media] no thumbnail for ${asset.filename}: ${describeError(error)}`);
      return asset;
    }

    if (!result) return asset;

    db.media.setProbe(asset.id, {
      thumbnailPath: result.path,
      width: result.width,
      height: result.height,
    });
    return db.media.get(asset.id) ?? asset;
  }
}

/**
 * The renderer-facing shape.
 *
 * Constructed field by field rather than by spreading the asset and deleting paths. A spread would
 * mean that any field added to `MediaAsset` in future is published to renderers by default; this way
 * the default is to withhold it.
 */
export function toView(asset: MediaAsset): MediaAssetView {
  return {
    id: asset.id,
    kind: asset.kind,
    filename: asset.filename,
    mime: asset.mime,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    category: asset.category,
    isFavorite: asset.isFavorite,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    url: mediaUrl(asset.id),
    thumbnailUrl: asset.thumbnailPath === null ? null : mediaThumbnailUrl(asset.id),
  };
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
