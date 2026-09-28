/**
 * EXCEPTIONEL PRESENTER — the `app-media:` protocol (Phase 5).
 *
 * Serves imported media to renderers BY ID. A window asks for `app-media://media_abc…`; main looks
 * that id up in the library and streams the file it names. The renderer never learns, and never
 * supplies, a filesystem path.
 *
 * WHY NOT JUST ALLOW `file:`
 *
 *  - It would widen `img-src`/`media-src` to the whole disk. Any markup that ends up in the app —
 *    a song's notes, a malformed import — could then read files the operator can read.
 *  - Real paths in the DOM contain the operator's account name (`C:\\Users\\…`), which then appears
 *    in screenshots, bug reports and the DevTools network panel.
 *  - An id is checked against a row. A path can only be checked against a guess.
 *
 * A STALE URL MUST NOT SERVE THE WRONG FILE. Stored filenames contain the content hash, so deleting
 * an asset and importing the same bytes again reuses the path. Resolution therefore goes id → row →
 * path, every time. A window still holding a deleted asset's URL gets 404, not its replacement.
 *
 * THE ELECTRON WIRING IS INJECTED. `net.fetch`, the session and `Response` all arrive as arguments,
 * so the routing, the refusals and the headers are all testable without an Electron binary — which
 * this project cannot run where it is built (docs/ENVIRONMENT.md).
 */

import { MEDIA_PROTOCOL, parseMediaUrl } from '../../shared/domain/media.ts';

/**
 * Scheme privileges. MUST be registered before the app is ready, or Chromium will already have
 * decided what `app-media:` means.
 *
 *  - `standard` — makes it a normal hierarchical scheme, so `app-media://<id>/thumbnail` parses with
 *    a host and a path instead of being treated as an opaque blob.
 *  - `secure` — otherwise the window (loaded over http in dev, file in production) treats it as
 *    mixed content and blocks it, which presents as a silently blank background.
 *  - `stream` — REQUIRED for <video> and <audio>. Without it a media element gets the whole file as
 *    one buffer and cannot play progressively or seek at all.
 *  - `bypassCSP: false` — deliberately NOT bypassing. `security/policy.ts` names `app-media:` in
 *    img-src and media-src, so the policy already permits exactly this and nothing more. A scheme
 *    that bypasses CSP would also be exempt from every future tightening of it.
 */
export const MEDIA_SCHEME_PRIVILEGES = Object.freeze({
  scheme: MEDIA_PROTOCOL,
  privileges: Object.freeze({
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true,
    bypassCSP: false,
  }),
});

/** What the library can tell us about an id. Supplied by the media service. */
export type ResolveMedia = (
  assetId: string,
  want: 'original' | 'thumbnail',
) => { path: string; mime: string } | null;

export type MediaResolution =
  | { ok: true; path: string; mime: string }
  | { ok: false; status: 400 | 404; reason: string };

/**
 * Turns a request URL into a file to serve, or a refusal.
 *
 * Two distinct failures, kept distinct: a malformed URL is 400 (the caller is wrong), a well-formed
 * URL for something that no longer exists is 404 (the caller is stale). Collapsing them would make a
 * traversal attempt indistinguishable from a deleted background while debugging.
 */
export function resolveMediaRequest(url: string, resolve: ResolveMedia): MediaResolution {
  const target = parseMediaUrl(url);
  if (!target) return { ok: false, status: 400, reason: `Malformed media URL: ${url}` };

  const found = resolve(target.assetId, target.want);
  if (!found) {
    return {
      ok: false,
      status: 404,
      reason: `No ${target.want} for asset ${target.assetId}`,
    };
  }

  return { ok: true, path: found.path, mime: found.mime };
}

/** Just enough of an incoming request to route it. */
export interface MediaRequest {
  url: string;
  headers?: { get(name: string): string | null };
}

/** The subset of Electron's session.protocol this needs. */
export interface ProtocolHost {
  handle(scheme: string, handler: (request: MediaRequest) => Promise<Response> | Response): void;
}

export interface MediaProtocolOptions {
  protocol: ProtocolHost;
  resolve: ResolveMedia;
  /** `net.fetch`. Given a `file://` URL, returns a streaming response. */
  fetchFile: (fileUrl: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  /** `pathToFileURL(path).toString()`, injected to keep node:url out of the tested path. */
  toFileUrl: (path: string) => string;
  onLog?: (line: string) => void;
}

export function registerMediaProtocol(options: MediaProtocolOptions): void {
  const log = options.onLog ?? (() => undefined);

  options.protocol.handle(MEDIA_PROTOCOL, async (request) => {
    const resolution = resolveMediaRequest(request.url, options.resolve);

    if (!resolution.ok) {
      // Logged, because a background that does not appear is otherwise completely silent: the
      // renderer sees a failed image load and nothing says why.
      log(`[media] ${String(resolution.status)} ${resolution.reason}`);
      return new Response(resolution.reason, {
        status: resolution.status,
        headers: { 'content-type': 'text/plain' },
      });
    }

    /*
     * THE RANGE HEADER IS FORWARDED, and this is not optional.
     *
     * A <video> element does not read a file from start to finish; it asks for byte ranges, and it
     * asks for a range in order to discover how long the media is. Dropping the header returns the
     * whole file with status 200 for every request, and Chromium concludes the stream is not
     * seekable — `seekable` reports 0-0 and setting `currentTime` snaps back to zero. For a worship
     * video that means it can only ever be played from the beginning.
     *
     * Electron had its own regression here between 37.0.0 and the fix in electron/electron#47703
     * (backported to 37-x-y on 2025-08-06, so first present in 37.2.6), which is why package.json
     * pins a floor above it rather than merely `^37.0.0`.
     */
    const range = request.headers?.get('range') ?? null;
    const init = range === null ? undefined : { headers: { range } };

    let response: Response;
    try {
      response = await options.fetchFile(options.toFileUrl(resolution.path), init);
    } catch (error) {
      // The row exists but the file does not — a failed backup restore, or a deleted app folder.
      log(
        `[media] 404 could not read the file for ${request.url}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return new Response('That media file is missing from your library folder.', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }

    /*
     * The Content-Type comes from OUR record of the file, not from whatever the file fetch guessed.
     *
     * The stored MIME was chosen from the extension at import, by the same table that decided the
     * file was presentable at all. Letting the guess win would reintroduce exactly the inconsistency
     * that classifying by extension exists to avoid.
     */
    const headers = new Headers(response.headers);
    headers.set('content-type', resolution.mime);
    // Local files are immutable once imported: the stored name contains their content hash, so a
    // changed file is a different URL. Caching them costs nothing and saves re-reading a 200 MB
    // video every time a slide returns to it.
    headers.set('cache-control', 'public, max-age=31536000, immutable');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}
