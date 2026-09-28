/**
 * EXCEPTIONEL PRESENTER — the `app-media:` protocol.
 *
 * The Electron pieces (`net.fetch`, the session, `pathToFileURL`) are injected, so the routing, the
 * refusals and the headers are all exercised here. What CANNOT be verified in this sandbox is that
 * Chromium actually plays what this serves — there is no Electron binary (docs/ENVIRONMENT.md). The
 * seeking behaviour in particular needs a real window; see the note on the Range header below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_SCHEME_PRIVILEGES,
  registerMediaProtocol,
  resolveMediaRequest,
  type MediaRequest,
  type ResolveMedia,
} from '../src/main/protocol/media-protocol.ts';
import {
  MEDIA_PROTOCOL,
  mediaThumbnailUrl,
  mediaUrl,
  parseMediaUrl,
} from '../src/shared/domain/media.ts';
import { newId } from '../src/main/db/repositories/support.ts';

// ── URL parsing ─────────────────────────────────────────────────────────────────

test('a media URL round-trips through its parser', () => {
  assert.deepEqual(parseMediaUrl(mediaUrl('media_abc123')), {
    assetId: 'media_abc123',
    want: 'original',
  });
  assert.deepEqual(parseMediaUrl(mediaThumbnailUrl('media_abc123')), {
    assetId: 'media_abc123',
    want: 'thumbnail',
  });
});

test('a query or fragment is ignored, not treated as part of the id', () => {
  // Chromium appends cache-busters and fragments of its own accord.
  assert.deepEqual(parseMediaUrl(`${MEDIA_PROTOCOL}://media_abc?v=2`), {
    assetId: 'media_abc',
    want: 'original',
  });
  assert.deepEqual(parseMediaUrl(`${MEDIA_PROTOCOL}://media_abc/thumbnail#t=1`), {
    assetId: 'media_abc',
    want: 'thumbnail',
  });
  assert.deepEqual(parseMediaUrl(`${MEDIA_PROTOCOL}://media_abc/`), {
    assetId: 'media_abc',
    want: 'original',
  });
});

test('anything that is not a plain asset id is refused outright', () => {
  for (const url of [
    // Traversal, in the forms it actually arrives in.
    `${MEDIA_PROTOCOL}://../../etc/passwd`,
    `${MEDIA_PROTOCOL}://..`,
    `${MEDIA_PROTOCOL}://media_a/../../secret`,
    `${MEDIA_PROTOCOL}://media_a/thumbnail/extra`,
    // A path where an id belongs.
    `${MEDIA_PROTOCOL}://C:/Users/asaim/Documents/secret.txt`,
    `${MEDIA_PROTOCOL}://media_a%2F..%2Fsecret`,
    // NUL, which truncates a path in some system calls.
    `${MEDIA_PROTOCOL}://media_a\0.txt`,
    // The wrong file under a valid id.
    `${MEDIA_PROTOCOL}://media_a/original`,
    `${MEDIA_PROTOCOL}://media_a/thumb`,
    // Empty, and the scheme alone.
    `${MEDIA_PROTOCOL}://`,
    `${MEDIA_PROTOCOL}://media_a//`,
    // A different scheme entirely.
    'file:///etc/passwd',
    'http://example.com/tracker.gif',
    `x${MEDIA_PROTOCOL}://media_a`,
    '',
  ]) {
    assert.equal(parseMediaUrl(url), null, `must refuse: ${JSON.stringify(url)}`);
  }
});

test('an over-long id is refused, matching the IPC id rule', () => {
  assert.equal(parseMediaUrl(`${MEDIA_PROTOCOL}://${'a'.repeat(64)}`)?.assetId, 'a'.repeat(64));
  assert.equal(parseMediaUrl(`${MEDIA_PROTOCOL}://${'a'.repeat(65)}`), null);
});

test('generated media ids are lower case, because a URL host is', () => {
  /*
   * With `standard: true` the scheme is hierarchical, so the id sits in the HOST position — and
   * Chromium canonicalises a host to lower case. An id containing capitals would arrive back
   * lower-cased and never match its row: every background would silently 404. This pins the
   * invariant that makes the host position safe to use.
   */
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = newId('media');
    assert.equal(id, id.toLowerCase(), id);
    assert.match(id, /^[a-z0-9_]+$/);
  }
});

// ── scheme registration ─────────────────────────────────────────────────────────

test('the scheme is privileged in the ways media playback needs, and no further', () => {
  const { scheme, privileges } = MEDIA_SCHEME_PRIVILEGES;
  assert.equal(scheme, 'app-media');
  // Without `stream`, a <video> cannot play progressively or seek at all.
  assert.equal(privileges.stream, true);
  // Without `secure`, the page treats it as mixed content and blocks it — a blank background with
  // only a console warning to show for it.
  assert.equal(privileges.secure, true);
  assert.equal(privileges.standard, true);
  /*
   * NOT bypassing CSP. The policy in security/policy.ts already names app-media: in img-src and
   * media-src, so bypassing buys nothing and would exempt this scheme from every future tightening.
   */
  assert.equal(privileges.bypassCSP, false);
});

test('the scheme name matches the one the CSP allows', async () => {
  const { buildCsp } = await import('../src/main/security/policy.ts');
  const csp = buildCsp({ devServerUrl: null, isPackaged: true });
  // If these ever disagree, every background disappears and the only clue is a console message.
  assert.ok(csp.includes(`img-src 'self' data: blob: ${MEDIA_PROTOCOL}:`));
  assert.ok(csp.includes(`${MEDIA_PROTOCOL}:`));
});

// ── resolution ──────────────────────────────────────────────────────────────────

const library: ResolveMedia = (assetId, want) => {
  if (assetId !== 'media_known') return null;
  return want === 'thumbnail'
    ? { path: '/userData/thumbnails/media_known.png', mime: 'image/png' }
    : { path: '/userData/media/abc123_loop.mp4', mime: 'video/mp4' };
};

test('a known id resolves to the file the library recorded', () => {
  assert.deepEqual(resolveMediaRequest(mediaUrl('media_known'), library), {
    ok: true,
    path: '/userData/media/abc123_loop.mp4',
    mime: 'video/mp4',
  });
  assert.deepEqual(resolveMediaRequest(mediaThumbnailUrl('media_known'), library), {
    ok: true,
    path: '/userData/thumbnails/media_known.png',
    mime: 'image/png',
  });
});

test('a malformed URL is 400 and an unknown asset is 404, kept distinct', () => {
  const malformed = resolveMediaRequest(`${MEDIA_PROTOCOL}://../../etc/passwd`, library);
  assert.ok(!malformed.ok);
  // 400 means the caller is wrong; 404 means the caller is stale. While debugging a blank projector
  // those are completely different problems.
  assert.equal(malformed.status, 400);

  const unknown = resolveMediaRequest(mediaUrl('media_deleted'), library);
  assert.ok(!unknown.ok);
  assert.equal(unknown.status, 404);
});

// ── the handler ─────────────────────────────────────────────────────────────────

interface Fake {
  respond: (url: string, headers?: Record<string, string>) => Promise<Response>;
  fetched: { url: string; range: string | null }[];
  logs: string[];
}

function fakeHost(options: { resolve?: ResolveMedia; fail?: boolean } = {}): Fake {
  const fetched: { url: string; range: string | null }[] = [];
  const logs: string[] = [];
  let handler: ((request: MediaRequest) => Promise<Response> | Response) | null = null;

  registerMediaProtocol({
    protocol: {
      handle: (_scheme, fn) => {
        handler = fn;
      },
    },
    resolve: options.resolve ?? library,
    fetchFile: (url, init) => {
      fetched.push({ url, range: init?.headers?.['range'] ?? null });
      if (options.fail) return Promise.reject(new Error('ENOENT: no such file'));
      // Stands in for net.fetch: a 200 with a body and a guessed content type.
      return Promise.resolve(
        new Response('BYTES', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-length': '5' },
        }),
      );
    },
    toFileUrl: (path) => `file://${path}`,
    onLog: (line) => logs.push(line),
  });

  assert.ok(handler, 'registration must install a handler');
  const installed = handler as (request: MediaRequest) => Promise<Response> | Response;

  return {
    respond: async (url, headers) =>
      installed({
        url,
        headers: { get: (name) => headers?.[name.toLowerCase()] ?? null },
      }),
    fetched,
    logs,
  };
}

test('a known asset is served with OUR content type, not the guessed one', async () => {
  const host = fakeHost();
  const response = await host.respond(mediaUrl('media_known'));

  assert.equal(response.status, 200);
  /*
   * The stored MIME came from the extension, via the same table that decided the file was
   * presentable. Letting a sniffed `application/octet-stream` win would reintroduce the exact
   * inconsistency that classifying by extension exists to avoid — Chromium would refuse to decode it.
   */
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), 'BYTES');
  assert.equal(host.fetched[0]?.url, 'file:///userData/media/abc123_loop.mp4');
});

test('the Range header is forwarded, or video cannot be sought', async () => {
  const host = fakeHost();
  await host.respond(mediaUrl('media_known'), { range: 'bytes=1024-2047' });

  /*
   * A <video> element asks for byte ranges, including one purely to discover the duration. Dropping
   * the header returns the whole file with status 200 every time and Chromium concludes the stream is
   * not seekable: `seekable` reports 0-0 and setting currentTime snaps back to zero.
   */
  assert.equal(host.fetched[0]?.range, 'bytes=1024-2047');
});

test('a request with no Range is not given an empty one', async () => {
  const host = fakeHost();
  await host.respond(mediaUrl('media_known'));
  // Sending `range: ""` would be a malformed request rather than an absent one.
  assert.equal(host.fetched[0]?.range, null);
});

test('imported media is cached hard, because its URL changes when its bytes do', async () => {
  const host = fakeHost();
  const response = await host.respond(mediaUrl('media_known'));
  // The stored filename contains the content hash, so a file at a given id never changes underneath
  // us. Re-reading a 200 MB video every time a slide returns to it would stutter for nothing.
  assert.match(response.headers.get('cache-control') ?? '', /immutable/);
});

test('a malformed URL never reaches the filesystem', async () => {
  const host = fakeHost();
  const response = await host.respond(`${MEDIA_PROTOCOL}://../../etc/passwd`);

  assert.equal(response.status, 400);
  assert.equal(host.fetched.length, 0, 'nothing may be read for a URL we do not understand');
  assert.match(host.logs.join('\n'), /400/);
});

test('an unknown or deleted asset is a clean 404', async () => {
  const host = fakeHost();
  const response = await host.respond(mediaUrl('media_gone'));

  assert.equal(response.status, 404);
  assert.equal(host.fetched.length, 0);
  // Logged, because a background that does not appear is otherwise completely silent.
  assert.match(host.logs.join('\n'), /404/);
});

test('a thumbnail that was never generated is 404, not the full-size file', async () => {
  const host = fakeHost({
    resolve: (assetId, want) =>
      want === 'thumbnail' ? null : { path: '/userData/media/x.jpg', mime: 'image/jpeg' },
  });
  const response = await host.respond(mediaThumbnailUrl('media_known'));

  // Serving the original instead would make a grid of forty backgrounds decode forty full images.
  assert.equal(response.status, 404);
  assert.equal(host.fetched.length, 0);
});

test('a row whose file has vanished becomes a 404 with an explanation', async () => {
  const host = fakeHost({ fail: true });
  const response = await host.respond(mediaUrl('media_known'));

  assert.equal(response.status, 404);
  // The operator can act on this: it names the library folder as the thing to look at.
  assert.match(await response.text(), /missing from your library folder/);
  assert.match(host.logs.join('\n'), /ENOENT/);
});
