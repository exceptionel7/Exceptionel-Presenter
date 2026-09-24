import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECURE_WEB_PREFERENCES,
  buildCsp,
  isMediaPermission,
  isNavigationAllowed,
  isPathWithinRoots,
  isPermissionGranted,
} from '../src/main/security/policy.ts';

// POSIX-style helpers, sufficient to exercise the traversal logic.
const posix = {
  resolve: (p: string): string => {
    const isAbs = p.startsWith('/');
    const parts: string[] = [];
    for (const segment of p.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return (isAbs ? '/' : '') + parts.join('/');
  },
  relative: (from: string, to: string): string => {
    const f = posix.resolve(from).split('/').filter(Boolean);
    const t = posix.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
  },
  isAbsolute: (p: string): boolean => p.startsWith('/'),
  sep: '/',
};

test('Section 34 — the secure defaults are actually secure', () => {
  assert.equal(SECURE_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(SECURE_WEB_PREFERENCES.nodeIntegrationInWorker, false);
  assert.equal(SECURE_WEB_PREFERENCES.nodeIntegrationInSubFrames, false);
  assert.equal(SECURE_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(SECURE_WEB_PREFERENCES.sandbox, true);
  assert.equal(SECURE_WEB_PREFERENCES.webSecurity, true);
  assert.equal(SECURE_WEB_PREFERENCES.allowRunningInsecureContent, false);
  assert.equal(SECURE_WEB_PREFERENCES.webviewTag, false);
});

test('the secure defaults are frozen, so a window cannot mutate them on the way in', () => {
  assert.equal(Object.isFrozen(SECURE_WEB_PREFERENCES), true);
});

test('background throttling stays off — a throttled audience video would stutter', () => {
  assert.equal(SECURE_WEB_PREFERENCES.backgroundThrottling, false);
});

// ── navigation ──────────────────────────────────────────────────────────────────

test('development windows may only reach the Vite dev server', () => {
  const opts = { devServerUrl: 'http://localhost:5173', isPackaged: false };
  assert.equal(isNavigationAllowed('http://localhost:5173/operator/index.html', opts), true);
  assert.equal(isNavigationAllowed('http://localhost:5173/output/', opts), true);
  assert.equal(isNavigationAllowed('http://localhost:9999/', opts), false, 'different port');
  assert.equal(isNavigationAllowed('http://evil.example.com/', opts), false);
  assert.equal(isNavigationAllowed('https://localhost:5173/', opts), false, 'different scheme is a different origin');
});

test('packaged windows may only load the local bundle', () => {
  const opts = { devServerUrl: null, isPackaged: true };
  assert.equal(isNavigationAllowed('file:///Applications/Exceptionel.app/out/operator.html', opts), true);
  assert.equal(isNavigationAllowed('http://localhost:5173/', opts), false);
  assert.equal(isNavigationAllowed('https://exceptionel.com/', opts), false);
});

test('file:// is refused in development, where everything legitimate is served over http', () => {
  assert.equal(
    isNavigationAllowed('file:///etc/passwd', { devServerUrl: 'http://localhost:5173', isPackaged: false }),
    false,
  );
});

test('dangerous and malformed URLs are refused outright', () => {
  for (const isPackaged of [true, false]) {
    const opts = { devServerUrl: 'http://localhost:5173', isPackaged };
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'about:blank',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'not a url',
      '',
      '//evil.example.com',
    ]) {
      assert.equal(isNavigationAllowed(url, opts), false, `${url} must be refused (packaged=${isPackaged})`);
    }
  }
});

// ── permissions ─────────────────────────────────────────────────────────────────

test('only media and fullscreen are granted — cameras need media, nothing else does', () => {
  assert.equal(isPermissionGranted('media'), true);
  assert.equal(isPermissionGranted('fullscreen'), true);
  assert.equal(isMediaPermission('media'), true);
  assert.equal(isMediaPermission('geolocation'), false);
});

test('everything a presentation app has no business requesting is denied', () => {
  for (const permission of [
    'geolocation',
    'notifications',
    'midi',
    'midiSysex',
    'pointerLock',
    'openExternal',
    'usb',
    'serial',
    'hid',
    'bluetooth',
    'clipboard-read',
    'idle-detection',
    'window-management',
    'unknown-future-permission',
  ]) {
    assert.equal(isPermissionGranted(permission), false, `${permission} must be denied`);
  }
});

// ── CSP ─────────────────────────────────────────────────────────────────────────

test('packaged CSP has no unsafe-eval and no dev server', () => {
  const csp = buildCsp({ devServerUrl: 'http://localhost:5173', isPackaged: true });
  assert.doesNotMatch(csp, /unsafe-eval/, 'production must never allow eval');
  assert.doesNotMatch(csp, /localhost/, 'production must not trust a dev server');
  assert.match(csp, /script-src 'self'/);
});

test('development CSP permits the dev server and its HMR websocket', () => {
  const csp = buildCsp({ devServerUrl: 'http://localhost:5173', isPackaged: false });
  assert.match(csp, /script-src [^;]*http:\/\/localhost:5173/);
  assert.match(csp, /connect-src [^;]*ws:\/\/localhost:5173/, 'Vite HMR needs the websocket');
  assert.match(csp, /unsafe-eval/, 'Vite dev requires eval');
});

test('CSP locks down the directives that matter', () => {
  for (const isPackaged of [true, false]) {
    const csp = buildCsp({ devServerUrl: 'http://localhost:5173', isPackaged });
    assert.match(csp, /object-src 'none'/, 'no plugins');
    assert.match(csp, /frame-src 'none'/, 'we embed nothing');
    assert.match(csp, /frame-ancestors 'none'/, 'nothing may embed us');
    assert.match(csp, /form-action 'none'/, 'there is no backend to post to');
    assert.match(csp, /base-uri 'self'/, 'no <base> hijacking');
    assert.match(csp, /default-src 'self'/);
  }
});

test('CSP allows camera streams and the app-media protocol, but never file:', () => {
  const csp = buildCsp({ devServerUrl: null, isPackaged: true });
  assert.match(csp, /media-src [^;]*mediastream:/, 'live camera feeds');
  assert.match(csp, /media-src [^;]*blob:/);
  assert.match(csp, /media-src [^;]*app-media:/, 'local media streams through a custom protocol');
  assert.doesNotMatch(csp, /file:/, 'the app-media protocol exists so file: is never needed');
});

// ── path containment ────────────────────────────────────────────────────────────

const roots = ['/home/op/.config/exceptionel/media', '/home/op/.config/exceptionel/thumbs'];

test('paths inside an allowed root are accepted', () => {
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/media/bg.jpg', roots, posix), true);
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/media/sub/dir/clip.mp4', roots, posix), true);
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/thumbs/a.png', roots, posix), true);
});

test('the root itself is accepted', () => {
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/media', roots, posix), true);
});

test('traversal out of the root is refused, however it is spelled', () => {
  for (const path of [
    '/home/op/.config/exceptionel/media/../../../../etc/passwd',
    '/home/op/.config/exceptionel/media/../secrets.txt',
    '/etc/passwd',
    '/home/op/.ssh/id_rsa',
    '../../../etc/shadow',
    '/home/op/.config/exceptionel/media/./../../elsewhere',
  ]) {
    assert.equal(isPathWithinRoots(path, roots, posix), false, `${path} must be refused`);
  }
});

test('a sibling directory sharing a name prefix is NOT inside the root', () => {
  // '/...../media-evil' starts with '/...../media' as a string but is a different
  // directory. A naive startsWith check would wrongly allow it.
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/media-evil/x.jpg', roots, posix), false);
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/mediaX', roots, posix), false);
});

test('NUL bytes and empty paths are refused', () => {
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/media/ok.jpg\0.txt', roots, posix), false);
  assert.equal(isPathWithinRoots('', roots, posix), false);
});

test('no roots means nothing is allowed', () => {
  assert.equal(isPathWithinRoots('/home/op/.config/exceptionel/media/bg.jpg', [], posix), false);
});
