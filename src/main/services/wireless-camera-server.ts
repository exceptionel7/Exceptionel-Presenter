/**
 * EXCEPTIONEL PRESENTER — the Wireless Camera HTTPS + signaling server (Sections 2, 5, 10).
 *
 * Serves the phone camera page and relays WebRTC signaling. Bound to one interface, never
 * exposed beyond the LAN, and it never carries video — only SDP and ICE. The media path is
 * phone → Wi-Fi → desktop, peer to peer.
 *
 * AUTHENTICATION. Two different secrets, deliberately:
 *   - the PAIRING token travels in the QR code and may have been photographed, so it is
 *     single-use and only ever exchanged for the second one;
 *   - the CONNECTION token is issued once over TLS to the phone that proved it knew the PIN,
 *     and is delivered as an HttpOnly cookie so it never appears in a URL, a browser history
 *     entry or a server log.
 *
 * The SSE stream authenticates by cookie because `EventSource` cannot send headers, and
 * EventSource is considerably more reliable on iOS Safari than streaming `fetch`.
 */

import { createServer, type Server } from 'node:https';
import { PHONE_PAGE_HTML, PHONE_PAGE_JS, PHONE_PAGE_CSS } from './phone-page.ts';
import {
  encodeSseFrame,
  parseSignalMessage,
  type PeerState,
  type SignalMessage,
} from '../../shared/domain/signaling.ts';
import { describeClaimFailure, isPlausiblePin, isPlausibleSessionId, isPlausibleToken } from '../../shared/domain/pairing.ts';
import type { PairingRegistry } from './pairing-registry.ts';

const COOKIE_NAME = 'ep_camera';
const MAX_BODY_BYTES = 128 * 1024;

export interface ServerOptions {
  registry: PairingRegistry;
  certificatePem: string;
  privateKeyPem: string;
  /** Specific interface to bind. Never 0.0.0.0 — see Section 2. */
  host: string;
  /** 0 asks the OS for a free port, which is what tests use. */
  port: number;
  /** Called when the phone sends something the desktop must act on. */
  onPhoneMessage?: (sessionId: string, message: SignalMessage) => void;
  onPhoneState?: (sessionId: string, state: PeerState) => void;
  onLog?: (line: string) => void;
}

export interface WirelessCameraServer {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
  /** Queues a message for the phone and flushes it if a stream is attached. */
  sendToPhone(sessionId: string, message: SignalMessage): void;
  readonly address: { host: string; port: number } | null;
}

interface Attached {
  sessionId: string;
  write: (chunk: string) => boolean;
  end: () => void;
}

/**
 * Minimal shapes for Node's request and response.
 *
 * Declared as interfaces with real methods rather than `Record<string, unknown>` on purpose:
 * the loose form forced bracket access, and extracting a method into a variable
 * (`const on = request['on']`) silently drops its `this` binding, so `Readable.on` threw
 * "Cannot read properties of undefined". Typed methods make that mistake impossible.
 */
interface HttpRequest {
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (chunk?: unknown) => void): unknown;
}

interface HttpResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): boolean;
  end(body?: string): unknown;
}

export function createWirelessCameraServer(options: ServerOptions): WirelessCameraServer {
  const log = options.onLog ?? (() => undefined);
  const streams = new Map<string, Attached>();
  let server: Server | null = null;
  let address: { host: string; port: number } | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const flush = (sessionId: string): void => {
    const attached = streams.get(sessionId);
    if (!attached) return;
    for (const message of options.registry.drain(sessionId)) {
      try {
        attached.write(encodeSseFrame(message));
      } catch {
        // A broken pipe means the phone went away; the disconnect path handles it.
        detach(sessionId);
        return;
      }
    }
  };

  const detach = (sessionId: string): void => {
    const attached = streams.get(sessionId);
    if (!attached) return;
    streams.delete(sessionId);
    options.registry.setStreaming(sessionId, false);
    try {
      attached.end();
    } catch {
      // already closed
    }
    // Section 16: losing the page is a disconnect, and it must be reported rather than
    // leaving the operator looking at stale metrics.
    options.registry.recordState(sessionId, 'disconnected');
    options.onPhoneState?.(sessionId, 'disconnected');
    log(`[wireless-camera] stream detached for ${sessionId}`);
  };

  const handler = (request: HttpRequest, response: HttpResponse): void => {
    const send = (status: number, headers: Record<string, string>, body?: string): void => {
      response.writeHead(status, {
        // No CORS headers at all: only our own page should ever call this.
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        ...headers,
      });
      response.end(body);
    };

    const url = parseUrl(request.url ?? '/');
    const method = (request.method ?? 'GET').toUpperCase();
    const headerValue = (name: string): string => {
      const value = request.headers[name];
      return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
    };

    // ── phone page and assets ──────────────────────────────────────────────────
    if (method === 'GET' && url.pathname === '/camera') {
      send(
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          // The phone page loads only its own two assets and talks only to this origin.
          'content-security-policy':
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
            "media-src 'self' blob: mediastream:; connect-src 'self'; base-uri 'none'; form-action 'none'",
        },
        PHONE_PAGE_HTML,
      );
      return;
    }
    if (method === 'GET' && url.pathname === '/camera.js') {
      send(200, { 'content-type': 'text/javascript; charset=utf-8' }, PHONE_PAGE_JS);
      return;
    }
    if (method === 'GET' && url.pathname === '/camera.css') {
      send(200, { 'content-type': 'text/css; charset=utf-8' }, PHONE_PAGE_CSS);
      return;
    }

    // ── health, for the desktop's own check ────────────────────────────────────
    if (method === 'GET' && url.pathname === '/health') {
      send(200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, service: 'wireless-camera' }));
      return;
    }

    // ── claim a pairing ───────────────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/pair/claim') {
      readBody(request, (error, body) => {
        if (error) return send(413, { 'content-type': 'application/json' }, JSON.stringify({ error: 'payload too large' }));

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          return send(400, { 'content-type': 'application/json' }, JSON.stringify({ error: 'invalid JSON' }));
        }

        const sessionId = String(parsed['sessionId'] ?? '');
        const token = String(parsed['token'] ?? '');
        const pin = String(parsed['pin'] ?? '');
        const deviceLabel = String(parsed['deviceLabel'] ?? 'Phone').slice(0, 60);

        // Shape-check before touching the registry, so malformed probes never reach it.
        if (!isPlausibleSessionId(sessionId) || !isPlausibleToken(token) || !isPlausiblePin(pin)) {
          return send(400, { 'content-type': 'application/json' }, JSON.stringify({ error: 'Invalid pairing details.' }));
        }

        const outcome = options.registry.claim({ sessionId, token, pin, deviceLabel });
        if (!outcome.ok) {
          log(`[wireless-camera] claim refused for ${sessionId}: ${outcome.reason}`);
          // 401 for every failure, with copy that never distinguishes "no such session" from
          // "wrong PIN" — otherwise the response enumerates valid session ids.
          return send(
            401,
            { 'content-type': 'application/json' },
            JSON.stringify({ error: describeClaimFailure(outcome.reason), reason: outcome.reason }),
          );
        }

        log(`[wireless-camera] ${deviceLabel} claimed session ${sessionId}`);
        return send(
          200,
          {
            'content-type': 'application/json',
            // HttpOnly so page script cannot read it; Secure because we are HTTPS-only;
            // SameSite=Strict because nothing should ever cross-navigate into this.
            'set-cookie': `${COOKIE_NAME}=${outcome.session.connectionToken}; HttpOnly; Secure; SameSite=Strict; Path=/`,
          },
          JSON.stringify({ ok: true, sessionId, label: outcome.session.label }),
        );
      });
      return;
    }

    // ── signaling stream (SSE, cookie-authenticated) ───────────────────────────
    if (method === 'GET' && url.pathname === '/signal/stream') {
      const sessionId = url.query['s'] ?? '';
      const cookieToken = readCookie(headerValue('cookie'), COOKIE_NAME);
      const session = options.registry.authenticate(sessionId, cookieToken);
      if (!session) return send(401, { 'content-type': 'text/plain' }, 'unauthorised');

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Defensive: stops any intermediary from buffering the stream into uselessness.
        'x-accel-buffering': 'no',
      });

      // Bound closures, not extracted methods — see the note on HttpResponse.
      const write = (chunk: string): boolean => response.write(chunk);
      const end = (): void => void response.end();

      // Replace any previous stream for this session: a phone that reloads the page opens a
      // second one, and leaving the first attached would split messages between them.
      const previous = streams.get(sessionId);
      if (previous) {
        streams.delete(sessionId);
        try {
          previous.end();
        } catch {
          /* already gone */
        }
      }

      streams.set(sessionId, { sessionId, write, end });
      options.registry.setStreaming(sessionId, true);
      write(': connected\n\n');
      flush(sessionId);
      log(`[wireless-camera] stream attached for ${sessionId}`);

      request.on('close', () => detach(sessionId));
      return;
    }

    // ── phone → desktop signaling ─────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/signal/send') {
      const bearer = /^Bearer (.+)$/.exec(headerValue('authorization'))?.[1] ?? '';
      const cookieToken = readCookie(headerValue('cookie'), COOKIE_NAME);
      const sessionId = url.query['s'] ?? '';
      const session = options.registry.authenticate(sessionId, bearer || cookieToken);
      if (!session) return send(401, { 'content-type': 'application/json' }, JSON.stringify({ error: 'unauthorised' }));

      readBody(request, (error, body) => {
        if (error) return send(413, { 'content-type': 'application/json' }, JSON.stringify({ error: 'payload too large' }));

        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          return send(400, { 'content-type': 'application/json' }, JSON.stringify({ error: 'invalid JSON' }));
        }

        const message = parseSignalMessage(json);
        if (!message.ok) {
          log(`[wireless-camera] rejected message from ${sessionId}: ${message.error}`);
          return send(400, { 'content-type': 'application/json' }, JSON.stringify({ error: message.error }));
        }

        options.registry.touch(sessionId);

        if (message.value.kind === 'state') {
          options.registry.recordState(sessionId, message.value.state);
          options.onPhoneState?.(sessionId, message.value.state);
        }
        if (message.value.kind === 'ready') {
          const { width, height, frameRate, hasAudio } = message.value;
          options.registry.recordMedia(sessionId, { width, height, frameRate, hasAudio });
        }
        if (message.value.kind === 'bye') {
          options.registry.revoke(sessionId, message.value.reason);
          options.onPhoneState?.(sessionId, 'closed');
        }

        options.onPhoneMessage?.(sessionId, message.value);
        return send(200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
      });
      return;
    }

    send(404, { 'content-type': 'text/plain' }, 'not found');
  };

  return {
    get address() {
      return address;
    },

    start() {
      return new Promise((resolve, reject) => {
        const instance = createServer(
          { cert: options.certificatePem, key: options.privateKeyPem },
          handler as never,
        );

        instance.on('error', reject as never);
        instance.listen(options.port, options.host);
        instance.on('listening', () => {
          const resolved = instance.address();
          const port = typeof resolved === 'object' && resolved !== null ? resolved.port : options.port;
          server = instance;
          address = { host: options.host, port };

          // SSE keep-alive. Also detects a phone that vanished without closing the socket,
          // which is the normal outcome of walking out of Wi-Fi range.
          heartbeat = setInterval(() => {
            for (const sessionId of [...streams.keys()]) {
              try {
                streams.get(sessionId)?.write(': ping\n\n');
              } catch {
                detach(sessionId);
              }
            }
            options.registry.prune();
          }, 15_000);
          // Never let the heartbeat hold the process open.
          heartbeat.unref?.();

          log(`[wireless-camera] listening on https://${options.host}:${port}`);
          resolve({ host: options.host, port });
        });
      });
    },

    stop() {
      return new Promise((resolve) => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        // Section 20 and test 12: closing the app terminates every camera session.
        for (const sessionId of [...streams.keys()]) {
          options.registry.enqueue(sessionId, { kind: 'bye', reason: 'Exceptionel Presenter closed' });
          flush(sessionId);
          detach(sessionId);
        }
        options.registry.revokeAll('Exceptionel Presenter closed');

        const instance = server;
        if (!instance) {
          address = null;
          return resolve();
        }

        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          server = null;
          address = null;
          resolve();
        };

        instance.close(finish);

        /*
         * CRITICAL: server.close() only waits for existing connections to end, and an SSE
         * stream is a long-lived keep-alive connection that never goes idle on its own. Without
         * forcing them shut, quitting Exceptionel Presenter with a phone connected would hang
         * the application indefinitely on shutdown.
         */
        const forceClose = (instance as unknown as { closeAllConnections?: () => void }).closeAllConnections;
        if (typeof forceClose === 'function') forceClose.call(instance);

        // Last resort, in case a socket still refuses to close: shutdown must never be the
        // thing that prevents the app from exiting.
        const guard = setTimeout(finish, 2_000);
        guard.unref?.();
      });
    },

    sendToPhone(sessionId, message) {
      options.registry.enqueue(sessionId, message);
      flush(sessionId);
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────────

function parseUrl(raw: string): { pathname: string; query: Record<string, string> } {
  const [pathPart = '/', queryPart = ''] = raw.split('?');
  const query: Record<string, string> = {};
  for (const pair of queryPart.split('&')) {
    if (!pair) continue;
    const [key = '', value = ''] = pair.split('=');
    query[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  // Normalise so '/camera/' and '/camera' match, and strip any traversal attempt.
  const pathname = pathPart.replace(/\/+$/, '') || '/';
  return { pathname: pathname.includes('..') ? '/invalid' : pathname, query };
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(';')) {
    const [key = '', ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

/**
 * Collects a request body with a hard size cap.
 *
 * Listeners are registered with `request.on(...)` directly. Extracting the method into a
 * variable first drops its `this` binding and Node throws from inside `Readable.on`.
 */
function readBody(request: HttpRequest, done: (error: Error | null, body: string) => void): void {
  let body = '';
  let finished = false;

  request.on('data', (chunk) => {
    if (finished) return;
    body += String(chunk);
    if (body.length > MAX_BODY_BYTES) {
      finished = true;
      done(new Error('payload too large'), '');
    }
  });

  request.on('end', () => {
    if (finished) return;
    finished = true;
    done(null, body);
  });

  request.on('error', () => {
    if (finished) return;
    finished = true;
    done(new Error('read failed'), '');
  });
}
