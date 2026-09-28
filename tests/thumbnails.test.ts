/**
 * EXCEPTIONEL PRESENTER — thumbnail generation.
 *
 * The decoder is injected, because the real one is Electron's `nativeImage` and there is no Electron
 * binary here (docs/ENVIRONMENT.md). What is tested is the decisions: which kinds get a thumbnail,
 * which dimensions are recorded, and what happens when a file will not decode.
 *
 * NOT VERIFIED HERE: that `nativeImage` actually decodes a given JPEG, or that the PNG it produces
 * looks right. That needs a real window.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THUMBNAIL_WIDTH, createThumbnailGenerator, type DecodeImage } from '../src/main/services/thumbnails.ts';
import { mediaRoots } from '../src/main/services/media-import.ts';
import type { MediaAsset, MediaKind } from '../src/shared/domain/entities.ts';

const roots = mediaRoots('/userData');

const asset = (kind: MediaKind, filename = 'thing.jpg'): MediaAsset => ({
  id: 'media_abc',
  kind,
  filename,
  absPath: `/userData/media/aaa_${filename}`,
  mime: 'image/jpeg',
  bytes: 1024,
  width: null,
  height: null,
  durationMs: null,
  thumbnailPath: null,
  category: null,
  isFavorite: false,
  hash: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

interface Harness {
  generate: ReturnType<typeof createThumbnailGenerator>;
  written: { path: string; bytes: number }[];
  decoded: string[];
  requestedWidths: number[];
  logs: string[];
}

function harness(options: { decode?: DecodeImage } = {}): Harness {
  const written: { path: string; bytes: number }[] = [];
  const decoded: string[] = [];
  const requestedWidths: number[] = [];
  const logs: string[] = [];

  const decodeImage: DecodeImage =
    options.decode ??
    ((path) => {
      decoded.push(path);
      return {
        width: 3840,
        height: 2160,
        toThumbnailPng: (maxWidth) => {
          requestedWidths.push(maxWidth);
          return Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
        },
      };
    });

  return {
    generate: createThumbnailGenerator({
      decodeImage: (path) => {
        if (options.decode) decoded.push(path);
        return decodeImage(path);
      },
      write: (path, bytes) => {
        written.push({ path, bytes: bytes.length });
        return Promise.resolve();
      },
      join: (...parts) => parts.join('/'),
      onLog: (line) => logs.push(line),
    }),
    written,
    decoded,
    requestedWidths,
    logs,
  };
}

test('an image gets a thumbnail in the thumbnail root, named by asset id', async () => {
  const h = harness();
  const result = await h.generate(asset('image'), roots);

  assert.ok(result);
  assert.equal(result.path, `${roots.thumbnails}/media_abc.png`);
  assert.equal(h.written.length, 1);
  assert.ok((h.written[0]?.bytes ?? 0) > 0, 'a thumbnail with no bytes is not a thumbnail');
  assert.deepEqual(h.requestedWidths, [THUMBNAIL_WIDTH]);
});

test('the dimensions recorded are the ORIGINAL file’s, not the thumbnail’s', async () => {
  const h = harness();
  const result = await h.generate(asset('image'), roots);

  /*
   * The presentation engine needs to know whether a background can fill a 16:9 projector without
   * being stretched, and whether it will survive being scaled up. Recording 480 × 270 for every image
   * would make that judgement impossible.
   */
  assert.equal(result?.width, 3840);
  assert.equal(result?.height, 2160);
});

test('a thumbnail is never upscaled past the original width', async () => {
  const asked: number[] = [];
  const h = harness({
    decode: () => ({
      width: 120,
      height: 90,
      toThumbnailPng: (maxWidth) => {
        asked.push(maxWidth);
        return Uint8Array.of(1, 2, 3);
      },
    }),
  });
  const result = await h.generate(asset('logo', 'logo.png'), roots);

  assert.ok(result, 'a small image still gets a thumbnail');
  assert.equal(result.width, 120, 'and its real dimensions are recorded');
  // A 120px logo blown up to 480px is blurrier than the same logo at its own size, and costs sixteen
  // times the bytes to be worse.
  assert.deepEqual(asked, [120]);
});

test('a video gets NO thumbnail, and this is deliberate', async () => {
  const h = harness();
  const result = await h.generate(asset('video', 'loop.mp4'), roots);

  /*
   * NOT IMPLEMENTED, on purpose: a poster frame needs a video decoder, which nativeImage does not
   * have. The media grid must therefore show a labelled video placeholder — never a blank tile, which
   * an operator reads as a failed import, and never a made-up image.
   */
  assert.equal(result, null);
  assert.equal(h.written.length, 0);
  assert.equal(h.decoded.length, 0, 'a video must not even be handed to the image decoder');
});

test('audio gets no thumbnail, because there is nothing to look at', async () => {
  const h = harness();
  assert.equal(await h.generate(asset('audio', 'organ.mp3'), roots), null);
  assert.equal(h.written.length, 0);
});

test('backgrounds and logos are treated as images', async () => {
  for (const kind of ['background', 'logo'] as const) {
    const h = harness();
    const result = await h.generate(asset(kind), roots);
    assert.ok(result, `${kind} should get a thumbnail`);
  }
});

test('a file that will not decode reports no thumbnail, and says so in the log', async () => {
  const h = harness({ decode: () => null });
  const result = await h.generate(asset('image', 'renamed-document.jpg'), roots);

  // A renamed document, or a truncated download. The import still succeeds; only the preview is
  // missing, and the log explains why the tile is a placeholder.
  assert.equal(result, null);
  assert.equal(h.written.length, 0);
  assert.match(h.logs.join('\n'), /could not be decoded/);
  assert.match(h.logs.join('\n'), /renamed-document\.jpg/);
});

test('an image that decodes to zero pixels is rejected rather than written', async () => {
  const h = harness({
    decode: () => ({
      width: 0,
      height: 0,
      toThumbnailPng: () => Uint8Array.of(),
    }),
  });
  // Writing a zero-byte PNG would give the grid a tile that fails to load, which looks like a
  // different bug entirely.
  assert.equal(await h.generate(asset('image'), roots), null);
  assert.equal(h.written.length, 0);
  assert.match(h.logs.join('\n'), /decoded to nothing/);
});

test('the thumbnail width is a sensible grid size', () => {
  assert.ok(THUMBNAIL_WIDTH >= 240, 'sharp enough on a high-density display');
  assert.ok(THUMBNAIL_WIDTH <= 800, 'small enough that 300 backgrounds are megabytes, not hundreds');
});
