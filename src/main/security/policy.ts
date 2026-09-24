/**
 * EXCEPTIONEL PRESENTER — security policy (Section 34).
 *
 * Every BrowserWindow in the app is created from `SECURE_WEB_PREFERENCES`. The values are
 * frozen and exported as one object so a future window cannot be created with a weaker
 * configuration by omission — the insecure choice has to be made deliberately and
 * visibly, rather than by forgetting a flag.
 *
 * The pure predicates here (isNavigationAllowed, isMediaPermission, buildCsp) carry no
 * Electron imports, so they are unit-testable without a running app.
 */

/** Applied to operator, output and confidence windows alike. */
export const SECURE_WEB_PREFERENCES = Object.freeze({
  /** Renderer gets no Node globals. */
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  /** Preload runs in an isolated world; `window` cannot be tampered with from page JS. */
  contextIsolation: true,
  /** Chromium's OS-level sandbox. */
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  /** Blocks <webview>, which would be a second, unguarded rendering surface. */
  webviewTag: false,
  experimentalFeatures: false,
  /** No remote module, no spellcheck network calls. */
  spellcheck: false,
  /** Chromium's background throttling would stall an audience-screen video when the
   *  operator window has focus, so it must stay off for presentation windows. */
  backgroundThrottling: false,
});

/**
 * Origins a window may navigate to.
 *
 * In development this is the Vite dev server; in production only the packaged
 * `file://` bundle. Anything else — a link in a song's notes, an injected iframe, a
 * compromised dependency calling location.assign — is refused.
 */
export function isNavigationAllowed(
  targetUrl: string,
  options: { devServerUrl: string | null; isPackaged: boolean },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false; // unparseable is not navigable
  }

  if (parsed.protocol === 'file:') {
    // Only allowed once packaged; during development everything is served over http.
    return options.isPackaged;
  }

  if (!options.isPackaged && options.devServerUrl) {
    try {
      const dev = new URL(options.devServerUrl);
      return parsed.origin === dev.origin;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Permissions the app will grant to its own windows.
 *
 * `media` is required for Section 9's live cameras. Everything else — geolocation,
 * notifications, MIDI, USB, clipboard reads, opening external handlers — has no place in
 * a presentation app and is denied, so a future dependency cannot quietly request it.
 */
const GRANTED_PERMISSIONS = Object.freeze(['media', 'fullscreen'] as const);

export function isPermissionGranted(permission: string): boolean {
  return (GRANTED_PERMISSIONS as readonly string[]).includes(permission);
}

export const isMediaPermission = (permission: string): boolean => permission === 'media';

export interface CspOptions {
  devServerUrl: string | null;
  isPackaged: boolean;
}

/**
 * Content-Security-Policy header.
 *
 * Notes on the deliberate relaxations:
 *  - `'unsafe-inline'` for style-src: themes generate inline styles for the audience
 *    output (font size, colour, shadow computed per slide). Removing it would require a
 *    nonce on every generated style, which buys little here because theme values come
 *    from our own database rather than from the web.
 *  - `media-src`/`img-src` allow `blob:` and `mediastream:` for camera feeds, and
 *    `app-media:` for the custom protocol that streams local media files (Phase 5) —
 *    that protocol exists precisely so we never have to widen this to `file:`.
 *  - `'unsafe-eval'` is permitted ONLY against the dev server, which Vite needs for HMR.
 *    It is absent from packaged builds.
 */
export function buildCsp(options: CspOptions): string {
  const dev = !options.isPackaged && options.devServerUrl ? options.devServerUrl : null;
  const devWs = dev ? dev.replace(/^http/, 'ws') : null;

  const scriptSrc = ["'self'", dev, dev ? "'unsafe-eval'" : null].filter(Boolean).join(' ');
  const connectSrc = ["'self'", dev, devWs].filter(Boolean).join(' ');

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: app-media:`,
    `media-src 'self' blob: mediastream: app-media:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    // No plugins, no Flash-era embeds.
    `object-src 'none'`,
    // Nothing may frame us, and we frame nothing.
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    // Blocks <base href> hijacking of relative URLs.
    `base-uri 'self'`,
    // No form can post anywhere, since the app has no HTTP backend.
    `form-action 'none'`,
    // Workers must come from our own bundle.
    `worker-src 'self' blob:`,
  ].join('; ');
}

/**
 * Guards a filesystem path supplied by (or derived from) a renderer.
 *
 * Section 34's "safe file handling": a renderer may never name an arbitrary path. Media
 * import is driven by a main-process dialog, and every stored `abs_path` must resolve
 * inside one of the app's own roots. This function is the check that enforces it.
 *
 * `resolve` and `relative` are injected so this stays free of node:path and therefore
 * unit-testable in isolation.
 */
export function isPathWithinRoots(
  candidate: string,
  roots: readonly string[],
  helpers: {
    resolve: (path: string) => string;
    relative: (from: string, to: string) => string;
    isAbsolute: (path: string) => boolean;
    sep: string;
  },
): boolean {
  if (!candidate || candidate.includes('\0')) return false; // NUL truncation attacks

  const resolved = helpers.resolve(candidate);

  return roots.some((root) => {
    const resolvedRoot = helpers.resolve(root);
    if (resolved === resolvedRoot) return true;
    const rel = helpers.relative(resolvedRoot, resolved);
    // A path inside the root never needs to climb out of it, and must not be absolute
    // (which is what `relative` returns when the two are on different Windows drives).
    return rel !== '' && !rel.startsWith(`..${helpers.sep}`) && rel !== '..' && !helpers.isAbsolute(rel);
  });
}
