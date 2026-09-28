/**
 * The media import pipeline, exercised against a REAL temporary directory.
 *
 * No filesystem mock. The point of this code is that bytes land on disk, in the right place, exactly
 * once, and that a hash computed in chunks matches the hash of the whole file — none of which a stub
 * can tell you anything about. A mock here would test the mock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HASH_CHUNK_BYTES,
  deleteStoredFile,
  ensureMediaRoots,
  hashFile,
  isInsideMediaRoots,
  mediaRoots,
  prepareImport,
  storeFile,
} from '../src/main/services/media-import.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'ep-media-'));

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[index] = (state >>> 16) & 0xff;
  }
  return out;
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

// ── roots ───────────────────────────────────────────────────────────────────────

test('media and thumbnail roots are separate directories under userData', () => {
  const roots = mediaRoots(join('/home/op/.config/exceptionel'));
  assert.notEqual(roots.media, roots.thumbnails);
  // A thumbnail must never be able to occupy the path of an original, or a lookup by stored name
  // could return the wrong file.
  assert.ok(!roots.thumbnails.startsWith(roots.media + '/'));
});

test('ensureMediaRoots creates both, and is safe to call again', async () => {
  const dir = scratch();
  try {
    const roots = mediaRoots(dir);
    await ensureMediaRoots(roots);
    assert.ok(existsSync(roots.media));
    assert.ok(existsSync(roots.thumbnails));
    // Startup calls this every launch; the second call must not throw EEXIST.
    await ensureMediaRoots(roots);
    assert.ok(existsSync(roots.media));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── hashing ─────────────────────────────────────────────────────────────────────

test('a chunked hash equals the hash of the whole file', async () => {
  const dir = scratch();
  try {
    // Deliberately NOT a multiple of the chunk size: the last read is short, which is where a
    // chunked hash goes wrong if the buffer is hashed in full.
    const content = bytes(5000, 7);
    const path = join(dir, 'clip.mp4');
    writeFileSync(path, content);

    assert.equal(await hashFile(path, { chunkBytes: 1024 }), sha256(content));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the digest does not depend on the chunk size', async () => {
  const dir = scratch();
  try {
    const content = bytes(4096, 11);
    const path = join(dir, 'bg.png');
    writeFileSync(path, content);

    const expected = sha256(content);
    // 4096 is an exact multiple of two of these and not of the others, so both the short-final-read
    // and the exact-fit paths are covered.
    for (const chunkBytes of [1, 7, 64, 1024, 4096, 65536]) {
      assert.equal(await hashFile(path, { chunkBytes }), expected, `chunk ${String(chunkBytes)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default chunk size is a sane read size', () => {
  // A one-byte default would make a 4 GB video four billion awaits.
  assert.ok(HASH_CHUNK_BYTES >= 64 * 1024, 'large enough to not thrash');
  assert.ok(HASH_CHUNK_BYTES <= 8 * 1024 * 1024, 'small enough to keep each turn of the loop brief');
});

test('hashing a missing file rejects rather than returning a digest of nothing', async () => {
  const dir = scratch();
  try {
    await assert.rejects(() => hashFile(join(dir, 'absent.jpg')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── prepare ─────────────────────────────────────────────────────────────────────

test('preparing a real image classifies, measures and hashes it', async () => {
  const dir = scratch();
  try {
    const content = bytes(2048, 3);
    const path = join(dir, 'Sunrise Over Water.JPG');
    writeFileSync(path, content);

    const outcome = await prepareImport(path);
    assert.ok(outcome.ok, 'a plain JPEG must be accepted');
    assert.equal(outcome.prepared.kind, 'image');
    assert.equal(outcome.prepared.mime, 'image/jpeg');
    assert.equal(outcome.prepared.bytes, 2048);
    assert.equal(outcome.prepared.hash, sha256(content));
    // The operator's own name is kept for display, with its capitals.
    assert.equal(outcome.prepared.filename, 'Sunrise Over Water.JPG');
    /*
     * The STORED name normalises the extension to lower case. That is not cosmetic: the protocol
     * handler picks a MIME type by extension, and a `.JPG` on disk would miss a lower-cased lookup.
     * Normalising once here means nothing downstream has to remember to fold case.
     */
    assert.equal(
      outcome.prepared.storedName,
      `${sha256(content).slice(0, 12)}_Sunrise Over Water.jpg`,
    );
    assert.equal(outcome.prepared.extension, '.jpg');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused format is rejected by name, and the file is never read', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'testimony.mov');
    writeFileSync(path, bytes(64));

    let hashed = false;
    const outcome = await prepareImport(path, {
      hash: async () => {
        hashed = true;
        return 'deadbeef';
      },
    });

    assert.ok(!outcome.ok);
    assert.match(outcome.reason, /QuickTime/);
    assert.match(outcome.reason, /MP4/, 'a refusal must say what to do about it');
    // Reading a 3 GB .mov only to refuse it would waste minutes of the operator's morning.
    assert.equal(hashed, false, 'an unsupported file must not be read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty file is refused, because there is nothing to present', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'blank.png');
    writeFileSync(path, new Uint8Array(0));

    const outcome = await prepareImport(path);
    assert.ok(!outcome.ok);
    assert.match(outcome.reason, /empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory named like an image is refused, not treated as a file', async () => {
  const dir = scratch();
  try {
    // This is reachable: a macOS bundle or a folder the operator renamed.
    const path = join(dir, 'album.png');
    mkdirSync(path);

    const outcome = await prepareImport(path);
    assert.ok(!outcome.ok);
    assert.match(outcome.reason, /folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file reports why, quoting its name', async () => {
  const dir = scratch();
  try {
    const outcome = await prepareImport(join(dir, 'gone.mp4'));
    assert.ok(!outcome.ok);
    assert.equal(outcome.filename, 'gone.mp4');
    assert.match(outcome.reason, /Could not read gone\.mp4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized file is refused with both its size and the limit, and is never read', async () => {
  const dir = scratch();
  try {
    /*
     * A real file of a real size, made SPARSE with truncate rather than by allocating 65 MB. The
     * check has to hold against what the filesystem reports, so stubbing `stat` would test nothing;
     * but writing 65 MB of zeroes to prove it would make the suite slower for no extra confidence.
     */
    const path = join(dir, 'enormous.png');
    writeFileSync(path, new Uint8Array(0));
    truncateSync(path, 65 * 1024 * 1024);

    let hashed = false;
    const outcome = await prepareImport(path, {
      hash: async () => {
        hashed = true;
        return 'deadbeef';
      },
    });

    assert.ok(!outcome.ok);
    assert.match(outcome.reason, /65\.0 MB/, 'the operator is told how big it is');
    assert.match(outcome.reason, /64\.0 MB/, 'and what the limit is');
    assert.match(outcome.reason, /image/, 'and which limit applies');
    // Reading 65 MB only to refuse it wastes the operator's time for nothing.
    assert.equal(hashed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file just inside the ceiling is accepted', async () => {
  const dir = scratch();
  try {
    // The boundary itself: 64 MB exactly must pass, or the stated limit is a lie.
    const path = join(dir, 'exactly-at-the-limit.png');
    writeFileSync(path, new Uint8Array(0));
    truncateSync(path, 64 * 1024 * 1024);

    const outcome = await prepareImport(path, { hash: async () => 'a'.repeat(64) });
    assert.ok(outcome.ok, '64 MB is within a 64 MB limit');
    assert.equal(outcome.prepared.bytes, 64 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the video ceiling is far larger than the image one, because videos are', async () => {
  const dir = scratch();
  try {
    // 200 MB: refused as an image, fine as a video. Same bytes, different ceiling.
    const asVideo = join(dir, 'sermon-bumper.mp4');
    writeFileSync(asVideo, new Uint8Array(0));
    truncateSync(asVideo, 200 * 1024 * 1024);
    const video = await prepareImport(asVideo, { hash: async () => 'b'.repeat(64) });
    assert.ok(video.ok, 'a 200 MB video is ordinary');

    const asImage = join(dir, 'sermon-bumper.png');
    writeFileSync(asImage, new Uint8Array(0));
    truncateSync(asImage, 200 * 1024 * 1024);
    const image = await prepareImport(asImage, { hash: async () => 'c'.repeat(64) });
    assert.ok(!image.ok, 'a 200 MB still image is a mistake');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── store ───────────────────────────────────────────────────────────────────────

test('storing copies the bytes into the media root, byte for byte', async () => {
  const dir = scratch();
  try {
    const source = join(dir, 'source');
    mkdirSync(source);
    const content = bytes(3333, 19);
    const path = join(source, 'worship-loop.mp4');
    writeFileSync(path, content);

    const roots = mediaRoots(join(dir, 'userData'));
    const prepared = await prepareImport(path);
    assert.ok(prepared.ok);

    const stored = await storeFile(prepared.prepared, roots);

    assert.equal(stored.alreadyPresent, false);
    assert.ok(stored.absPath.startsWith(roots.media), 'must land inside the app root');
    assert.deepEqual(new Uint8Array(readFileSync(stored.absPath)), content);
    // The original is untouched: import is a copy, not a move. A volunteer's video stays where they
    // put it.
    assert.ok(existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same content imported twice is stored once', async () => {
  const dir = scratch();
  try {
    const content = bytes(999, 23);
    // Two different names, same bytes — the memory-stick-twice case.
    const first = join(dir, 'background.jpg');
    const second = join(dir, 'background (1).jpg');
    writeFileSync(first, content);
    writeFileSync(second, content);

    const roots = mediaRoots(join(dir, 'userData'));

    const a = await prepareImport(first);
    const b = await prepareImport(second);
    assert.ok(a.ok);
    assert.ok(b.ok);
    assert.equal(a.prepared.hash, b.prepared.hash, 'identical bytes hash identically');

    const storedA = await storeFile(a.prepared, roots);
    // Re-importing the FIRST file must be recognised, not copied again.
    const again = await storeFile(a.prepared, roots);

    assert.equal(storedA.alreadyPresent, false);
    assert.equal(again.alreadyPresent, true);
    assert.equal(again.absPath, storedA.absPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two different files with the same name do not collide', async () => {
  const dir = scratch();
  try {
    const one = join(dir, 'a');
    const two = join(dir, 'b');
    mkdirSync(one);
    mkdirSync(two);
    // Every church has three files called background.jpg.
    writeFileSync(join(one, 'background.jpg'), bytes(512, 2));
    writeFileSync(join(two, 'background.jpg'), bytes(512, 5));

    const roots = mediaRoots(join(dir, 'userData'));
    const a = await prepareImport(join(one, 'background.jpg'));
    const b = await prepareImport(join(two, 'background.jpg'));
    assert.ok(a.ok);
    assert.ok(b.ok);

    const storedA = await storeFile(a.prepared, roots);
    const storedB = await storeFile(b.prepared, roots);

    assert.notEqual(storedA.absPath, storedB.absPath, 'different content, different file');
    assert.equal(storedB.alreadyPresent, false, 'the second must actually be written');
    assert.deepEqual(new Uint8Array(readFileSync(storedA.absPath)), bytes(512, 2));
    assert.deepEqual(new Uint8Array(readFileSync(storedB.absPath)), bytes(512, 5));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated leftover from an interrupted copy is overwritten, not trusted', async () => {
  const dir = scratch();
  try {
    const content = bytes(4000, 31);
    const path = join(dir, 'clip.webm');
    writeFileSync(path, content);

    const roots = mediaRoots(join(dir, 'userData'));
    const prepared = await prepareImport(path);
    assert.ok(prepared.ok);

    // Simulate the machine being shut down mid-copy: right path, wrong length.
    mkdirSync(roots.media, { recursive: true });
    const target = join(roots.media, prepared.prepared.storedName);
    writeFileSync(target, content.subarray(0, 100));

    const stored = await storeFile(prepared.prepared, roots);

    assert.equal(stored.alreadyPresent, false, 'a short file must not pass as the real thing');
    assert.deepEqual(new Uint8Array(readFileSync(stored.absPath)), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('storing works when the media root does not exist yet', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'first-ever.png');
    writeFileSync(path, bytes(128, 41));

    // First import on a fresh install: nothing has created the root.
    const roots = mediaRoots(join(dir, 'brand-new-userData'));
    assert.ok(!existsSync(roots.media));

    const prepared = await prepareImport(path);
    assert.ok(prepared.ok);
    const stored = await storeFile(prepared.prepared, roots);
    assert.ok(existsSync(stored.absPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── delete ──────────────────────────────────────────────────────────────────────

test('deleting removes the copied file', async () => {
  const dir = scratch();
  try {
    const path = join(dir, 'old.jpg');
    writeFileSync(path, bytes(256, 13));
    const roots = mediaRoots(join(dir, 'userData'));
    const prepared = await prepareImport(path);
    assert.ok(prepared.ok);
    const stored = await storeFile(prepared.prepared, roots);

    assert.equal(await deleteStoredFile(stored.absPath, roots), 'deleted');
    assert.ok(!existsSync(stored.absPath));
    // The source the operator imported from is not ours to delete.
    assert.ok(existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting an already-missing file is not an error', async () => {
  const dir = scratch();
  try {
    const roots = mediaRoots(join(dir, 'userData'));
    await ensureMediaRoots(roots);
    // The row still needs removing, so this must not throw.
    assert.equal(await deleteStoredFile(join(roots.media, 'absent.jpg'), roots), 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting refuses any path outside the media roots, and deletes nothing', async () => {
  const dir = scratch();
  try {
    const roots = mediaRoots(join(dir, 'userData'));
    await ensureMediaRoots(roots);

    // A file that matters, in the position of "somewhere else on the operator's disk".
    const precious = join(dir, 'sermon-notes.txt');
    writeFileSync(precious, 'do not delete me');

    for (const candidate of [
      precious,
      join(roots.media, '..', '..', 'sermon-notes.txt'),
      `${roots.media}-evil/x.jpg`,
      '',
    ]) {
      assert.equal(await deleteStoredFile(candidate, roots), 'refused', candidate);
    }

    assert.ok(existsSync(precious), 'nothing outside the roots may be unlinked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('containment accepts both roots and rejects their siblings', () => {
  const roots = mediaRoots(join('/home/op/.config/exceptionel'));
  assert.equal(isInsideMediaRoots(join(roots.media, 'a.jpg'), roots), true);
  assert.equal(isInsideMediaRoots(join(roots.thumbnails, 'a.png'), roots), true);
  assert.equal(isInsideMediaRoots('/home/op/.config/exceptionel/library.db', roots), false);
  // NUL truncation: the path looks contained but a system call would stop at the NUL.
  assert.equal(isInsideMediaRoots(`${join(roots.media, 'a.jpg')}\0.txt`, roots), false);
});
