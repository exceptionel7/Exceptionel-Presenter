import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BYTES,
  MEDIA_KINDS,
  REFUSED_FORMATS,
  SUPPORTED_FORMATS,
  acceptedExtensions,
  canBeBackground,
  classify,
  describeBytes,
  describeMediaKind,
  dialogExtensions,
  extensionOf,
  isWithinSizeLimit,
  safeFilename,
  storedFilename,
} from '../src/shared/domain/media.ts';

/**
 * EXCEPTIONEL PRESENTER — media classification and naming.
 *
 * Two things are being defended here. First, that a file which imports is a file that PLAYS — accepting
 * something that then fails silently mid-service is worse than refusing it on Thursday. Second, that a
 * filename arriving from a filesystem cannot escape the directory the application writes into, because
 * import copies files rather than referencing them where they sit.
 */

// ── classification ──────────────────────────────────────────────────────────────

test('EVERY ACCEPTED FORMAT IS ONE CHROMIUM DECODES WITHOUT A PLATFORM CODEC', () => {
  /*
   * The rule behind the list. A format needing a system codec imports happily on the laptop a service
   * was prepared on and then fails on the booth machine, which is the worst possible place to find out.
   */
  const accepted = acceptedExtensions();
  assert.ok(accepted.length > 0);

  for (const extension of accepted) {
    const format = SUPPORTED_FORMATS[extension];
    assert.ok(format, extension);
    assert.match(extension, /^\.[a-z0-9]+$/, 'extensions are lower-case and dotted');
    assert.match(format.mime, /^(image|video|audio)\//, `${extension} must carry a real MIME type`);
    assert.ok((MEDIA_KINDS as readonly string[]).includes(format.kind), `${extension} kind`);
  }

  // The formats that actually matter for worship media.
  for (const extension of ['.jpg', '.png', '.webp', '.mp4', '.webm', '.mp3']) {
    assert.ok(accepted.includes(extension), `${extension} must be accepted`);
  }
});

test('SVG IS REFUSED, BECAUSE IT IS A DOCUMENT THAT CAN CARRY SCRIPT', () => {
  /*
   * It would be rendered inside a window that has access to our preload bridge. Not a risk worth taking
   * for a background image, and the refusal says so rather than calling it "unsupported".
   */
  assert.equal(acceptedExtensions().includes('.svg'), false);
  const result = classify('slide.svg');
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.reason, /scripts/i);
});

test('A REFUSAL SAYS WHAT TO DO ABOUT IT', () => {
  // "Unsupported file" tells an operator nothing they can act on at eight on a Sunday morning.
  for (const [extension, reason] of Object.entries(REFUSED_FORMATS)) {
    const result = classify(`file${extension}`);
    assert.equal(result.ok, false, extension);
    assert.ok(!result.ok);
    assert.equal(result.reason, reason);
    // Every refusal either names a remedy or explains a security decision.
    assert.ok(
      /Convert it to|scripts|not displayable|Export/i.test(reason),
      `${extension}: "${reason}" gives the operator nothing to do`,
    );
  }

  // The formats a church is most likely to try.
  for (const extension of ['.wmv', '.avi', '.mov', '.mkv', '.heic']) {
    assert.ok(REFUSED_FORMATS[extension], `${extension} should be explained by name`);
  }
});

test('an unknown extension lists what IS accepted', () => {
  const result = classify('archive.gz');
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.reason, /\.gz files are not supported/);
  assert.match(result.reason, /\.mp4/, 'and shows the accepted list');
});

test('classification is case-insensitive, as filesystems are not', () => {
  for (const name of ['PHOTO.JPG', 'photo.Jpg', 'photo.jpg']) {
    const result = classify(name);
    assert.ok(result.ok, name);
    assert.equal(result.kind, 'image');
    assert.equal(result.mime, 'image/jpeg');
    assert.equal(result.extension, '.jpg', 'normalised to lower case');
  }
});

test('a file with no usable extension is refused rather than guessed at', () => {
  for (const name of ['noextension', '.hidden', 'trailingdot.', '']) {
    const result = classify(name);
    assert.equal(result.ok, false, JSON.stringify(name));
  }
  assert.equal(extensionOf('a.tar.gz'), '.gz', 'the last extension is the one that decides');
  assert.equal(extensionOf('noextension'), '');
  assert.equal(extensionOf('.hidden'), '', 'a leading dot is not an extension');
  assert.equal(extensionOf('trailingdot.'), '');
});

test('dialog extensions are bare, as a file dialog expects', () => {
  const bare = dialogExtensions();
  assert.ok(bare.includes('mp4'));
  assert.equal(bare.some((entry) => entry.startsWith('.')), false);
  assert.equal(bare.length, acceptedExtensions().length);
});

// ── size ceilings ───────────────────────────────────────────────────────────────

test('SIZE CEILINGS EXIST BECAUSE IMPORT READS THE FILE IN THE MAIN PROCESS', () => {
  /*
   * Hashing happens in the process driving the projector. A ceiling is what stops someone accidentally
   * selecting a 40 GB video export and stalling the application at the moment they can least afford it.
   */
  for (const kind of MEDIA_KINDS) {
    assert.ok(MAX_BYTES[kind] > 0, kind);
    assert.equal(isWithinSizeLimit(kind, MAX_BYTES[kind]), true, `${kind} at the limit`);
    assert.equal(isWithinSizeLimit(kind, MAX_BYTES[kind] + 1), false, `${kind} over the limit`);
    assert.equal(isWithinSizeLimit(kind, 0), false, 'an empty file is not media');
    assert.equal(isWithinSizeLimit(kind, -1), false);
  }

  // Video is allowed to be far larger than an image; a logo far smaller.
  assert.ok(MAX_BYTES.video > MAX_BYTES.image);
  assert.ok(MAX_BYTES.logo < MAX_BYTES.image);
});

test('sizes are described in units an operator reads', () => {
  assert.equal(describeBytes(512), '512 B');
  assert.equal(describeBytes(2048), '2 KB');
  assert.equal(describeBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(describeBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
});

// ── filename safety ─────────────────────────────────────────────────────────────

test('A FILENAME CANNOT ESCAPE THE MEDIA DIRECTORY', () => {
  /*
   * Import COPIES files into the application's own media root, so this name is used to create a real
   * file. A name that could climb out of that directory would be an arbitrary-write primitive.
   */
  for (const [input, expected] of [
    ['../../../etc/passwd.png', 'passwd.png'],
    ['..\\..\\Windows\\System32\\evil.png', 'evil.png'],
    ['C:\\Windows\\evil.png', 'evil.png'],
    ['/etc/shadow.png', 'shadow.png'],
    ['..', 'media'],
    ['.', 'media'],
    ['', 'media'],
  ] as const) {
    const result = safeFilename(input);
    assert.equal(result, expected, input);
    assert.equal(result.includes('/'), false);
    assert.equal(result.includes('\\'), false);
    assert.equal(result.startsWith('..'), false);
  }
});

test('NUL AND CONTROL CHARACTERS ARE STRIPPED', () => {
  // NUL truncates a path in some system calls, so "photo\0.png.exe" can become "photo".
  assert.equal(safeFilename('photo\u0000.png'), 'photo.png');
  assert.equal(safeFilename('a\u0001b\u001fc.png'), 'abc.png');
  assert.equal(safeFilename('tab\there.png'), 'tabhere.png');
});

test('WINDOWS TRAPS ARE HANDLED: TRAILING DOTS AND RESERVED DEVICE NAMES', () => {
  /*
   * Windows silently strips trailing dots and spaces, so "evil.txt." is created as "evil.txt" — a name
   * that passed a check the real file then fails. And CON, NUL, COM1 and friends are unusable as
   * filenames even with an extension.
   */
  assert.equal(safeFilename('evil.txt.'), 'evil.txt');
  assert.equal(safeFilename('trailing   .png'), 'trailing.png');

  for (const reserved of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
    assert.equal(safeFilename(`${reserved}.jpg`), `${reserved}_file.jpg`, reserved);
    assert.equal(safeFilename(`${reserved.toLowerCase()}.jpg`), `${reserved.toLowerCase()}_file.jpg`);
  }
});

test('characters Windows reserves are removed', () => {
  assert.equal(safeFilename('a<>:"|?*b.png'), 'ab.png');
});

test('names are bounded so the stored path stays inside the filesystem limit', () => {
  const long = `${'x'.repeat(300)}.png`;
  const result = safeFilename(long);
  assert.ok(result.length <= 84, `got ${String(result.length)} characters`);
  assert.ok(result.endsWith('.png'), 'and the extension survives, since it decides the MIME type');
});

test('NON-ASCII NAMES ARE PRESERVED, NOT MANGLED', () => {
  // A church that names its files in Haitian Creole or French must not find them renamed to rubbish.
  assert.equal(safeFilename('Chanson Mèsi.jpg'), 'Chanson Mèsi.jpg');
  assert.equal(safeFilename('Noël 2026.png'), 'Noël 2026.png');
  assert.equal(safeFilename('背景.png'), '背景.png');
});

// ── stored names ────────────────────────────────────────────────────────────────

test('THE STORED NAME IS UNIQUE BY CONTENT, SO TWO FILES CANNOT COLLIDE', () => {
  /*
   * A hash prefix rather than a counter: two different files both called `background.jpg` get different
   * stored names without the import needing to read the directory, and re-importing one is recognised
   * immediately.
   */
  const first = storedFilename('aaaaaaaaaaaaaaaaaaaa', 'background.jpg');
  const second = storedFilename('bbbbbbbbbbbbbbbbbbbb', 'background.jpg');

  assert.notEqual(first, second);
  assert.equal(first, 'aaaaaaaaaaaa_background.jpg');
  assert.ok(first.endsWith('.jpg'), 'the extension is preserved');

  // The same content produces the same name, which is what makes de-duplication possible.
  assert.equal(storedFilename('aaaaaaaaaaaaaaaaaaaa', 'background.jpg'), first);
});

test('a stored name is safe even when the original was not', () => {
  const result = storedFilename('deadbeefdeadbeefdead', '../../escape.png');
  assert.equal(result, 'deadbeefdead_escape.png');
  assert.equal(result.includes('/'), false);
  assert.equal(result.includes('..'), false);
});

// ── kinds ───────────────────────────────────────────────────────────────────────

test('every media kind has an operator-facing label', () => {
  for (const kind of MEDIA_KINDS) {
    const label = describeMediaKind(kind);
    assert.ok(label.length > 0, kind);
    assert.match(label, /^[A-Z]/, 'labels are shown in the interface, so they are capitalised');
  }
});

test('only visual kinds can sit behind text', () => {
  // Audio has nothing to show, so offering it as a background would be a control that does nothing.
  assert.equal(canBeBackground('image'), true);
  assert.equal(canBeBackground('video'), true);
  assert.equal(canBeBackground('background'), true);
  assert.equal(canBeBackground('audio'), false);
  assert.equal(canBeBackground('logo'), false);
});
