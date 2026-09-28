/**
 * EXCEPTIONEL PRESENTER — thumbnail generation (Phase 5).
 *
 * Produces the small preview the media grid shows, and records the real pixel dimensions while the
 * decoder has the file open anyway.
 *
 * WHAT THIS DOES NOT DO: VIDEO POSTER FRAMES — NOT IMPLEMENTED.
 *
 * Extracting a frame needs a video decoder. Electron's `nativeImage` has none, so the only ways to get
 * one are to bundle ffmpeg (a large native dependency, per-platform, for a thumbnail) or to load the
 * file into a hidden renderer, seek it, and paint it to a canvas. The second is feasible and is where
 * this should go, but it means a window whose only job is decoding, competing with the projector for
 * GPU time — not something to add during a phase that has to stay safe for a Sunday.
 *
 * So a video gets NO thumbnail, and `thumbnailUrl` is null. The media grid must show a labelled video
 * placeholder, NOT a made-up image and not a silent grey square. An operator who sees a blank tile
 * where they expect a frame will assume the import failed and import it again.
 *
 * The decoder is injected, because `nativeImage` needs Electron and this project's tests cannot run
 * Electron (docs/ENVIRONMENT.md).
 */

import { isStillImage } from '../../shared/domain/media.ts';
import type { MediaAsset } from '../../shared/domain/entities.ts';
import type { GenerateThumbnail } from './media-service.ts';
import type { MediaRoots } from './media-import.ts';

/**
 * Wide enough to look sharp in a grid tile on a high-density display, small enough that a library of
 * three hundred backgrounds is a few megabytes rather than a few hundred.
 */
export const THUMBNAIL_WIDTH = 480;

export interface DecodedImage {
  /** The ORIGINAL dimensions, not the thumbnail's. */
  width: number;
  height: number;
  /** PNG bytes, scaled so the width is at most `maxWidth`. */
  toThumbnailPng(maxWidth: number): Uint8Array;
}

/** Returns null when the file cannot be decoded at all. */
export type DecodeImage = (path: string) => DecodedImage | null;

export function createThumbnailGenerator(options: {
  decodeImage: DecodeImage;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  join: (...parts: string[]) => string;
  onLog?: (line: string) => void;
}): GenerateThumbnail {
  const log = options.onLog ?? (() => undefined);

  return async (asset: MediaAsset, roots: MediaRoots) => {
    /*
     * Only still images. Audio has nothing to look at, and video needs a decoder this process does not
     * have. Both are reported as "no thumbnail" rather than as a failure, because neither is a broken
     * file — and a LOGO is very much an image, which is what makes `canBeBackground` the wrong test
     * here.
     */
    if (!isStillImage(asset.kind)) return null;

    const decoded = options.decodeImage(asset.absPath);
    if (decoded === null) {
      // A file with an image extension that is not an image: a renamed document, or a truncated
      // download. Worth logging, because the grid tile will be a placeholder and the operator will
      // wonder why.
      log(`[media] ${asset.filename} could not be decoded as an image`);
      return null;
    }

    if (decoded.width <= 0 || decoded.height <= 0) {
      log(`[media] ${asset.filename} decoded to nothing`);
      return null;
    }

    const path = options.join(roots.thumbnails, `${asset.id}.png`);
    /*
     * Never wider than the original.
     *
     * A 120 px logo stretched to 480 px is blurrier than the same logo shown at its own size, and it
     * costs sixteen times the bytes to be worse. The clamp lives here rather than in the decoder so it
     * is part of the tested decision rather than of the Electron wiring.
     */
    await options.write(path, decoded.toThumbnailPng(Math.min(THUMBNAIL_WIDTH, decoded.width)));

    /*
     * The dimensions returned are the ORIGINAL file's, not the thumbnail's.
     *
     * They are what the presentation engine needs: whether a background is landscape enough to fill a
     * 16:9 projector without being stretched, and whether it is high enough resolution to survive
     * being scaled up. Recording 480 × 270 for every image would make that judgement impossible.
     */
    return { path, width: decoded.width, height: decoded.height };
  };
}
