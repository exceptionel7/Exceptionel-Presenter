/**
 * EXCEPTIONEL PRESENTER — the media import pipeline (Phase 5).
 *
 * Takes a file the operator chose in a main-process dialog and turns it into something the
 * presentation engine can serve: classified, measured, hashed, and COPIED into the application's own
 * media root.
 *
 * WHY IMPORT COPIES RATHER THAN REFERENCING THE FILE WHERE IT SITS.
 *
 *  1. `security/policy.ts` already states the invariant that every stored `abs_path` must resolve
 *     inside one of the app's own roots. Referencing a file on the Desktop, or on a memory stick,
 *     breaks that invariant, and a renderer would then be handed paths from anywhere on the disk.
 *  2. A volunteer tidying their Downloads folder on Saturday night must not be able to empty a slide
 *     on Sunday morning. Once a background is in a service, the file behind it belongs to the app.
 *
 * WHY THE READS ARE ASYNCHRONOUS, when the rest of the main process is comfortably synchronous.
 *
 * Hashing is a full read of the file, and the ceiling for a video is four gigabytes. `readFileSync`
 * would hold the main process for the whole of that read — and the main process is what dispatches
 * cues to the projector. Audience-screen video would keep playing, because that decode lives in the
 * renderer, but the operator's next slide change would sit in a queue until the read finished. A
 * chunked `open`/`read` loop hands each chunk to libuv's threadpool and lets the event loop keep
 * turning, so an import during a service is merely slow rather than a freeze.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MAX_BYTES,
  classify,
  describeBytes,
  describeMediaKind,
  isWithinSizeLimit,
  storedFilename,
  type MediaKind,
} from '../../shared/domain/media.ts';
import { isPathWithinRoots } from '../security/policy.ts';

/** The directories the application owns. Nothing outside these is ever written or served. */
export interface MediaRoots {
  /** Imported originals. */
  readonly media: string;
  /** Generated thumbnails. Separate root so a stray original can never masquerade as one. */
  readonly thumbnails: string;
}

export const mediaRoots = (userDataDir: string): MediaRoots =>
  Object.freeze({
    media: join(userDataDir, 'media'),
    thumbnails: join(userDataDir, 'thumbnails'),
  });

export async function ensureMediaRoots(roots: MediaRoots): Promise<void> {
  await mkdir(roots.media, { recursive: true });
  await mkdir(roots.thumbnails, { recursive: true });
}

/**
 * One megabyte per read.
 *
 * Large enough that a four-gigabyte video is four thousand reads rather than a million, small enough
 * that the buffer is not a meaningful allocation and each turn of the loop is brief.
 */
export const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * SHA-256 of a file's bytes, read in chunks.
 *
 * The digest is the identity of the content, and it is what makes re-importing the same file a
 * recognised no-op instead of a second copy. The name is not part of it: the same picture saved as
 * `bg.jpg` and `bg (1).jpg` is one asset.
 */
export async function hashFile(
  path: string,
  options: { chunkBytes?: number } = {},
): Promise<string> {
  const chunkBytes = options.chunkBytes ?? HASH_CHUNK_BYTES;
  const handle = await open(path, 'r');

  try {
    const hash = createHash('sha256');
    const buffer = new Uint8Array(chunkBytes);

    for (;;) {
      // `null` position means "continue from where the last read stopped", so this is a plain
      // sequential scan with no offset arithmetic to get wrong.
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      // The final chunk is short. Hashing the whole buffer would fold in stale bytes from the
      // previous read and produce a digest that depends on the chunk size.
      hash.update(bytesRead === chunkBytes ? buffer : buffer.subarray(0, bytesRead));
    }

    return hash.digest('hex');
  } finally {
    // In a `finally` so a read error cannot leak a descriptor. An import that fails must not cost
    // the process a handle, because the next attempt is usually seconds away.
    await handle.close();
  }
}

/** Everything known about a file before anything has been written. */
export interface PreparedImport {
  readonly sourcePath: string;
  /** The operator's own name for it, kept for display and search. */
  readonly filename: string;
  readonly kind: MediaKind;
  readonly mime: string;
  readonly extension: string;
  readonly bytes: number;
  readonly hash: string;
  /** What it will be called inside the media root. */
  readonly storedName: string;
}

export type PrepareOutcome =
  | { ok: true; prepared: PreparedImport }
  | { ok: false; filename: string; reason: string };

/**
 * Inspects a file and decides whether it can be imported — WITHOUT writing anything.
 *
 * Separate from `storeFile` so a refusal costs nothing and leaves nothing behind. A batch import can
 * therefore report "three added, one refused because QuickTime needs a codec" with no half-written
 * files to clean up.
 */
export async function prepareImport(
  sourcePath: string,
  options: { hash?: (path: string) => Promise<string> } = {},
): Promise<PrepareOutcome> {
  const filename = basename(sourcePath);

  // Type first: it is the cheapest check and the most common refusal.
  const classified = classify(filename);
  if (!classified.ok) return { ok: false, filename, reason: classified.reason };

  let size: number;
  try {
    const stats = await stat(sourcePath);
    if (!stats.isFile()) {
      return { ok: false, filename, reason: `${filename} is a folder, not a media file.` };
    }
    size = stats.size;
  } catch (error) {
    return { ok: false, filename, reason: `Could not read ${filename}: ${describeError(error)}` };
  }

  if (size === 0) {
    return { ok: false, filename, reason: `${filename} is empty — there is nothing to import.` };
  }

  if (!isWithinSizeLimit(classified.kind, size)) {
    const limit = describeBytes(MAX_BYTES[classified.kind]);
    return {
      ok: false,
      filename,
      reason:
        `${filename} is ${describeBytes(size)}. The limit for ` +
        `${describeMediaKind(classified.kind).toLowerCase()} files is ${limit}.`,
    };
  }

  // Only now is the file worth reading in full. Injected so callers can supply a cheaper digest in
  // tests; production always uses the chunked read above.
  const hash = await (options.hash ?? hashFile)(sourcePath);

  return {
    ok: true,
    prepared: {
      sourcePath,
      filename,
      kind: classified.kind,
      mime: classified.mime,
      extension: classified.extension,
      bytes: size,
      hash,
      storedName: storedFilename(hash, filename),
    },
  };
}

export interface StoredFile {
  readonly absPath: string;
  readonly storedName: string;
  /**
   * True when the bytes were already in the media root, so nothing was copied.
   *
   * The name carries the content hash, so an identical file always lands on the same path. That makes
   * this check a genuine de-duplication rather than an optimisation: a church that imports the same
   * background twice from two memory sticks stores it once.
   */
  readonly alreadyPresent: boolean;
}

/** Copies a prepared file into the media root. Idempotent for identical content. */
export async function storeFile(prepared: PreparedImport, roots: MediaRoots): Promise<StoredFile> {
  await mkdir(roots.media, { recursive: true });

  const absPath = join(roots.media, prepared.storedName);

  try {
    const existing = await stat(absPath);
    /*
     * Same path AND same length. The path alone already implies the same content, since it contains
     * the hash; the length is a cheap guard against a previous import that was interrupted part-way
     * through the copy and left a truncated file behind. Such a file is overwritten rather than
     * trusted.
     */
    if (existing.isFile() && existing.size === prepared.bytes) {
      return { absPath, storedName: prepared.storedName, alreadyPresent: true };
    }
  } catch {
    // Not there. That is the normal path for a new import, not an error worth reporting.
  }

  await copyFile(prepared.sourcePath, absPath);

  return { absPath, storedName: prepared.storedName, alreadyPresent: false };
}

const PATH_HELPERS = Object.freeze({
  resolve: (path: string) => resolve(path),
  relative,
  isAbsolute,
  sep,
});

/** True when a path lies inside one of the app's own media directories. */
export const isInsideMediaRoots = (candidate: string, roots: MediaRoots): boolean =>
  isPathWithinRoots(candidate, [roots.media, roots.thumbnails], PATH_HELPERS);

export type DeleteOutcome = 'deleted' | 'missing' | 'refused';

/**
 * Deletes a file the app imported.
 *
 * Refuses anything outside the media roots, and says so rather than failing silently. This function
 * is the only route from a database row to `unlink`, so the containment check has to live here: a
 * corrupted or tampered `abs_path` must not be able to turn "remove this background" into deleting
 * something in the operator's Documents folder.
 */
export async function deleteStoredFile(absPath: string, roots: MediaRoots): Promise<DeleteOutcome> {
  if (!isInsideMediaRoots(absPath, roots)) return 'refused';

  try {
    await unlink(absPath);
    return 'deleted';
  } catch {
    // Already gone. The caller still wants the database row removed, so this is not a failure.
    return 'missing';
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
