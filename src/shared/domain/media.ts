/**
 * EXCEPTIONEL PRESENTER — media classification and naming (Phase 5).
 *
 * ZERO dependencies and pure, so every rule here is testable without a filesystem, a dialog or an
 * image decoder.
 *
 * CLASSIFIED BY EXTENSION, NOT BY A REPORTED MIME TYPE. An operating system's idea of a file's type
 * comes from its own registry, which on Windows is routinely wrong or absent for media a church has
 * been handed on a memory stick. The extension is what the person who made the file chose, it is what
 * Chromium will actually use to pick a decoder, and it is the same on every machine. Where the two
 * disagree, the extension is the one that predicts whether playback works.
 */

import { MEDIA_KINDS, type MediaKind } from './entities.ts';

export { MEDIA_KINDS };
export type { MediaKind };

/**
 * What the presentation engine can actually display, mapped to the MIME type to serve it with.
 *
 * Deliberately conservative. Every format here is one Chromium decodes without a platform codec, so a
 * file that imports is a file that plays — on the booth machine as well as the laptop it was prepared
 * on. Formats that depend on a system codec (`.wmv`, `.avi`, `.mov` with certain encodings) are refused
 * at import with an explanation, rather than accepted and then failing silently mid-service.
 */
export const SUPPORTED_FORMATS: Readonly<Record<string, { mime: string; kind: MediaKind }>> =
  Object.freeze({
    // ── images ────────────────────────────────────────────────────────────────────
    '.jpg': { mime: 'image/jpeg', kind: 'image' },
    '.jpeg': { mime: 'image/jpeg', kind: 'image' },
    '.png': { mime: 'image/png', kind: 'image' },
    '.webp': { mime: 'image/webp', kind: 'image' },
    '.gif': { mime: 'image/gif', kind: 'image' },
    '.avif': { mime: 'image/avif', kind: 'image' },
    // SVG is deliberately absent: it is a document that can carry script, and it would be rendered
    // inside a window that has access to our preload bridge. Not worth the risk for a background.

    // ── video ─────────────────────────────────────────────────────────────────────
    '.mp4': { mime: 'video/mp4', kind: 'video' },
    '.m4v': { mime: 'video/mp4', kind: 'video' },
    '.webm': { mime: 'video/webm', kind: 'video' },

    // ── audio ─────────────────────────────────────────────────────────────────────
    '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
    '.m4a': { mime: 'audio/mp4', kind: 'audio' },
    '.wav': { mime: 'audio/wav', kind: 'audio' },
    '.ogg': { mime: 'audio/ogg', kind: 'audio' },
  });

/**
 * Formats a church is likely to try, with the reason they are refused.
 *
 * Named individually so the operator gets "Windows Media Video needs a system codec" rather than a
 * generic refusal — the difference between knowing to convert the file and assuming the application is
 * broken.
 */
export const REFUSED_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  '.svg': 'SVG files can contain scripts, so they are not accepted as media.',
  '.wmv': 'Windows Media Video needs a system codec that is not always present. Convert it to MP4.',
  '.avi': 'AVI needs a system codec that is not always present. Convert it to MP4.',
  '.mov': 'QuickTime files often use codecs that will not play on every machine. Convert it to MP4.',
  '.mkv': 'Matroska is a container Chromium does not reliably play. Convert it to MP4 or WebM.',
  '.flv': 'Flash Video is obsolete. Convert it to MP4.',
  '.wma': 'Windows Media Audio needs a system codec. Convert it to MP3.',
  '.aiff': 'AIFF is not reliably supported. Convert it to WAV or MP3.',
  '.tif': 'TIFF is not displayable in a browser engine. Convert it to PNG or JPEG.',
  '.tiff': 'TIFF is not displayable in a browser engine. Convert it to PNG or JPEG.',
  '.psd': 'Photoshop documents are not displayable. Export a PNG or JPEG.',
  '.heic': 'HEIC needs a system codec that Windows often lacks. Convert it to JPEG.',
});

/**
 * Size ceilings, per kind.
 *
 * Import reads a file to hash it, in the main process — the one driving the projector. A ceiling is what
 * stops someone accidentally selecting a 40 GB video export and stalling the application at the moment
 * they can least afford it.
 */
export const MAX_BYTES: Readonly<Record<MediaKind, number>> = Object.freeze({
  image: 64 * 1024 * 1024,
  background: 64 * 1024 * 1024,
  logo: 16 * 1024 * 1024,
  video: 4 * 1024 * 1024 * 1024,
  audio: 512 * 1024 * 1024,
});

export const acceptedExtensions = (): string[] => Object.keys(SUPPORTED_FORMATS).sort();

/** Extensions for a file dialog filter, without the leading dot. */
export const dialogExtensions = (): string[] =>
  acceptedExtensions().map((extension) => extension.slice(1));

/** The extension, lower-cased and including the dot. Empty when there is none. */
export function extensionOf(filename: string): string {
  // `lastIndexOf` rather than a split, so "a.tar.gz" and "My Photo.JPG" both behave.
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot).toLowerCase();
}

export type Classification =
  | { ok: true; kind: MediaKind; mime: string; extension: string }
  | { ok: false; reason: string };

/**
 * Decides what a file is, and whether it can be presented.
 *
 * A refusal always says WHY and, where possible, what to do about it. "Unsupported file" tells an
 * operator nothing they can act on at eight o'clock on a Sunday morning.
 */
export function classify(filename: string): Classification {
  const extension = extensionOf(filename);

  if (extension === '') {
    return { ok: false, reason: 'That file has no extension, so its type cannot be determined.' };
  }

  const supported = SUPPORTED_FORMATS[extension];
  if (supported) {
    return { ok: true, kind: supported.kind, mime: supported.mime, extension };
  }

  const refused = REFUSED_FORMATS[extension];
  if (refused) return { ok: false, reason: refused };

  return {
    ok: false,
    reason: `${extension} files are not supported. Accepted formats: ${acceptedExtensions().join(', ')}.`,
  };
}

/** True when the file is within the ceiling for its kind. */
export function isWithinSizeLimit(kind: MediaKind, bytes: number): boolean {
  return bytes > 0 && bytes <= MAX_BYTES[kind];
}

export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * A filename safe to write inside the app's own media directory.
 *
 * Import COPIES files in rather than referencing them where they sit, so this name is used to create a
 * real file. Everything that could escape the directory or confuse a filesystem is removed:
 *
 *  - path separators and `..`, so a crafted name cannot climb out of the media root;
 *  - NUL, which truncates a path in some system calls;
 *  - control characters and the characters Windows reserves;
 *  - trailing dots and spaces, which Windows silently strips — turning "evil.txt." into "evil.txt";
 *  - reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), which are unusable on Windows even
 *    with an extension.
 *
 * The extension is preserved separately by the caller, because it decides the MIME type.
 */
export function safeFilename(filename: string, fallback = 'media'): string {
  // Take the basename first: a name arriving with separators is already suspect.
  const base = filename.split(/[\\/]/).pop() ?? '';

  const extension = extensionOf(base);
  const stem = extension === '' ? base : base.slice(0, base.length - extension.length);

  let cleaned = stem
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*\\/]/g, '')
    .replace(/\.+/g, '.')
    .trim()
    // Windows strips trailing dots and spaces, so a name ending in one is not the name it appears to be.
    .replace(/[. ]+$/, '');

  if (RESERVED_NAMES.has(cleaned.toUpperCase())) cleaned = `${cleaned}_file`;
  if (cleaned === '' || cleaned === '.' || cleaned === '..') cleaned = fallback;

  // Long enough for any real title, short enough to stay inside path limits once a hash is prepended.
  return `${cleaned.slice(0, 80)}${extension}`;
}

const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${String(index + 1)}`),
]);

/**
 * The name a file is stored under: the first twelve characters of its hash, then a safe name.
 *
 * The hash prefix guarantees uniqueness without a counter, so two different files called
 * `background.jpg` cannot collide, and re-importing one recognises it immediately. Twelve hex
 * characters is 48 bits — far beyond collision range for a church's media library, and short enough to
 * keep the path well inside Windows' limit.
 */
export const storedFilename = (hash: string, filename: string): string =>
  `${hash.slice(0, 12)}_${safeFilename(filename)}`;

/** Operator-facing label for a kind. */
export function describeMediaKind(kind: MediaKind): string {
  switch (kind) {
    case 'image':
      return 'Image';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'background':
      return 'Background';
    case 'logo':
      return 'Logo';
  }
}

/** True for kinds the presentation engine can put behind text. */
export const canBeBackground = (kind: MediaKind): boolean =>
  kind === 'image' || kind === 'video' || kind === 'background';

/**
 * True for kinds that are a single still frame an image decoder can open.
 *
 * Deliberately NOT the same set as `canBeBackground`, which includes video (playable behind text, but
 * not decodable by an image decoder) and excludes logos (not a background, but very much an image).
 * The two were conflated once and logos silently lost their thumbnails for it.
 */
export const isStillImage = (kind: MediaKind): boolean =>
  kind === 'image' || kind === 'background' || kind === 'logo';


// ── addressing media from a renderer ────────────────────────────────────────────

/**
 * The custom scheme renderers use to fetch media.
 *
 * A renderer NEVER receives a filesystem path. It addresses an asset by its id, and main resolves
 * that id against the database to find the file. Two reasons this is worth a custom protocol rather
 * than just allowing `file:`:
 *
 *  - `file:` in `img-src`/`media-src` would let any markup in the app read any file the user can,
 *    and would put real paths — including the operator's name, in `C:\Users\...` — into the DOM.
 *  - An id is validated against a row. A path is validated against a guess.
 *
 * The name matches what `security/policy.ts` already allows in the Content-Security-Policy; changing
 * it here without changing that would produce silently blank backgrounds with only a console warning.
 */
export const MEDIA_PROTOCOL = 'app-media';

/** Path segment appended for the generated thumbnail rather than the original. */
export const THUMBNAIL_SEGMENT = 'thumbnail';

export const mediaUrl = (assetId: string): string => `${MEDIA_PROTOCOL}://${assetId}`;

export const mediaThumbnailUrl = (assetId: string): string =>
  `${MEDIA_PROTOCOL}://${assetId}/${THUMBNAIL_SEGMENT}`;

export type MediaTarget = { assetId: string; want: 'original' | 'thumbnail' };

/**
 * Parses a request URL back into an asset id and which file was asked for.
 *
 * Returns null for anything it does not recognise, INCLUDING an id that is not a plain identifier.
 * This is the point where a hostile or malformed URL stops, so it rejects rather than sanitises:
 * there is no useful interpretation of `app-media://../../etc/passwd`, and attempting to clean one up
 * is how traversal bugs are written.
 */
export function parseMediaUrl(url: string): MediaTarget | null {
  const prefix = `${MEDIA_PROTOCOL}://`;
  if (!url.startsWith(prefix)) return null;

  // Query and fragment are meaningless here; Chromium may append a cache-buster.
  const withoutSuffix = url.slice(prefix.length).split(/[?#]/)[0] ?? '';

  const segments = withoutSuffix.split('/');
  /*
   * ONE trailing slash is dropped, and only one.
   *
   * A `standard` scheme is canonicalised by Chromium, which turns `app-media://media_a` into
   * `app-media://media_a/` — so refusing a trailing slash would refuse the app's own URLs. Empty
   * segments are not filtered out wholesale, though: that would also quietly accept `media_a//` and
   * `media_a//thumbnail`, and an addressing scheme with several spellings per file is one where a
   * later containment check can be fooled by picking the wrong spelling.
   */
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();

  if (segments.length === 0 || segments.length > 2) return null;
  if (segments.some((segment) => segment === '')) return null;

  const assetId = segments[0] ?? '';
  // The same alphabet the IPC validators use for an id. `.` is absent, so `..` cannot appear.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) return null;

  if (segments.length === 1) return { assetId, want: 'original' };
  return segments[1] === THUMBNAIL_SEGMENT ? { assetId, want: 'thumbnail' } : null;
}
