/**
 * EXCEPTIONEL PRESENTER — window management.
 *
 * Creates and tracks the three window roles (docs/ARCHITECTURE.md §1):
 *
 *   operator   — the production interface
 *   output     — the audience screen: frameless, kiosk, no chrome, ever
 *   confidence — stage monitor for pastors and worship leaders
 *
 * Every window is built from SECURE_WEB_PREFERENCES and gets navigation, permission and
 * CSP guards attached before it loads anything.
 */

import { BrowserWindow, app, shell, session, type WebContents } from 'electron';
import { join } from 'node:path';
import {
  SECURE_WEB_PREFERENCES,
  buildCsp,
  isNavigationAllowed,
  isPermissionGranted,
} from '../security/policy.ts';
import { roleArgument } from '../../shared/preload-role.ts';
import { readConsoleMessage } from './console-message.ts';
import type { WindowRole } from '../ipc/dispatcher.ts';

/** Vite dev server URL, injected by electron-vite. Absent in packaged builds. */
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'] ?? null;

export interface WindowManagerOptions {
  preloadDir: string;
  rendererDir: string;
  /** Called when the operator window is closed, so the app can shut down cleanly. */
  onOperatorClosed?: () => void;
}

export interface WindowManager {
  openOperator(): BrowserWindow;
  getOperator(): BrowserWindow | null;
  /** Opens (or moves) the audience output window onto the given bounds. */
  openOutput(bounds: Electron.Rectangle | null): BrowserWindow;
  closeOutput(): void;
  getOutput(): BrowserWindow | null;
  openConfidence(bounds: Electron.Rectangle | null): BrowserWindow;
  closeConfidence(): void;
  getConfidence(): BrowserWindow | null;
  /**
   * Guarantees the output renderer exists, opening it HIDDEN if necessary.
   *
   * The output window owns the phone's RTCPeerConnection, so it must be running before a phone
   * can connect — but display assignment is Phase 7. A hidden window is a full renderer: it
   * executes WebRTC and receives frames perfectly well, and `backgroundThrottling: false`
   * keeps it from being throttled while unfocused. Phase 7 will position this same window on a
   * projector without changing the media path.
   */
  ensureMediaHost(): BrowserWindow;
  /** Resolves the role of the window a WebContents belongs to, for IPC authorisation. */
  roleOf(contents: WebContents): WindowRole | null;
  /** Sends an event to every window permitted to receive it. */
  broadcast(channel: string, payload: unknown, roles?: readonly WindowRole[]): void;
  sendTo(role: WindowRole, channel: string, payload: unknown): void;
  closeAll(): void;
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
  let operator: BrowserWindow | null = null;
  let output: BrowserWindow | null = null;
  let confidence: BrowserWindow | null = null;

  const roles = new WeakMap<WebContents, WindowRole>();

  installSessionGuards();

  /**
   * One preload bundle for all three roles, built as .cjs.
   *
   * Not three files: a sandboxed preload cannot `require()` local files, and three entry
   * points made Rollup split their shared code into a chunk that each stub then required
   * and failed on. See electron.vite.config.ts.
   */
  const PRELOAD_PATH = join(options.preloadDir, 'index.cjs');

  /**
   * Tells the preload which surface to expose. Set per-window by main and unreachable from
   * page JavaScript; the preload falls back to the most restricted role if it is absent.
   */
  const roleWebPreferences = (role: WindowRole) => ({
    ...SECURE_WEB_PREFERENCES,
    preload: PRELOAD_PATH,
    additionalArguments: [roleArgument(role)],
  });

  const load = (window: BrowserWindow, entry: string): void => {
    if (DEV_SERVER_URL) {
      const url = `${DEV_SERVER_URL}/${entry}/index.html`;
      console.log(`[window:${entry}] loading ${url}`);
      void window.loadURL(url).catch((error: unknown) => {
        console.error(`[window:${entry}] loadURL failed:`, error);
      });
    } else {
      const file = join(options.rendererDir, entry, 'index.html');
      void window.loadFile(file).catch((error: unknown) => {
        console.error(`[window:${entry}] loadFile ${file} failed:`, error);
      });
    }
  };

  const harden = (window: BrowserWindow, role: WindowRole): void => {
    roles.set(window.webContents, role);

    /*
     * DIAGNOSTICS FIRST.
     *
     * A renderer that fails to boot shows an empty window whose background matches the UI
     * background, so it is indistinguishable from a working-but-empty app — and nothing
     * appears in the terminal the operator is watching. That cost real debugging time once
     * already (a CSP rule silently blocked React Refresh). Renderer failures must be loud.
     */
    /*
     * Electron changed this event's shape: it used to pass (event, level, message, line,
     * sourceId) and now passes a single details object, with `level` as a string rather than
     * a Chromium enum. The old form logs a deprecation warning and will be removed.
     *
     * Both shapes are read rather than committing to one, because this is diagnostics code —
     * if it throws or silently stops working after an Electron upgrade, we lose the very
     * thing that makes renderer failures visible.
     */
    window.webContents.on('console-message', (...args: unknown[]) => {
      const message = readConsoleMessage(args);
      if (!message) return;

      // In development everything is forwarded, including the preload's own confirmation
      // line — a noisy terminal is a fair price for being able to see what happened. A
      // packaged build forwards only warnings and errors.
      if (!DEV_SERVER_URL && message.severity === 'info') return;

      const location = message.sourceId ? ` (${message.sourceId}:${message.line})` : '';
      const write = message.severity === 'error' ? console.error : message.severity === 'warning' ? console.warn : console.log;
      write(`[renderer:${role}] ${message.text}${location}`);
    });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      // -3 is ERR_ABORTED, which fires on ordinary navigation cancellation.
      if (errorCode === -3) return;
      console.error(
        `[renderer:${role}] failed to load ${validatedURL}: ${errorDescription} (${errorCode})`,
      );
    });

    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      // Without this, a broken preload leaves window.exceptionel undefined and the UI can
      // only report "could not reach its application core" without saying why.
      console.error(`[preload:${role}] ${preloadPath} threw: ${error.message}`);
    });

    window.webContents.on('unresponsive', () => {
      console.error(`[renderer:${role}] became unresponsive`);
    });

    // Refuse navigation away from our own origin. A link in a song's notes, an injected
    // iframe, or a compromised dependency calling location.assign all land here.
    window.webContents.on('will-navigate', (event, url) => {
      if (!isNavigationAllowed(url, { devServerUrl: DEV_SERVER_URL, isPackaged: app.isPackaged })) {
        event.preventDefault();
        console.warn(`[security] blocked navigation to ${url} from ${role} window`);
      }
    });

    // Never open a new Electron window. External links go to the OS browser instead, so
    // an untrusted page can never run inside the app.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    window.webContents.on('will-attach-webview', (event) => {
      // webviewTag is already false; this is belt and braces.
      event.preventDefault();
    });

    // A renderer crash must not leave a blank audience screen with no explanation.
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[crash] ${role} renderer gone: ${details.reason} (exit ${details.exitCode})`);
    });
  };

  const openOperator = (): BrowserWindow => {
    if (operator && !operator.isDestroyed()) {
      operator.show();
      operator.focus();
      return operator;
    }

    operator = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 1180,
      minHeight: 720,
      show: false,
      backgroundColor: '#0A1421', // the logo navy, so startup never flashes white
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: roleWebPreferences('operator'),
    });

    harden(operator, 'operator');

    // Show only once painted: a visible-but-empty frame looks like a hang.
    operator.once('ready-to-show', () => {
      operator?.show();
      // DevTools open automatically in development so a renderer error is visible
      // immediately rather than hiding behind a blank window.
      if (DEV_SERVER_URL) operator?.webContents.openDevTools({ mode: 'detach' });
    });

    operator.on('closed', () => {
      operator = null;
      options.onOperatorClosed?.();
    });

    load(operator, 'operator');
    return operator;
  };

  const openOutput = (bounds: Electron.Rectangle | null): BrowserWindow => {
    if (output && !output.isDestroyed()) {
      if (bounds) {
        output.setBounds(bounds);
        output.setFullScreen(true);
      }
      output.show();
      return output;
    }

    output = new BrowserWindow({
      ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : { width: 1280, height: 720 }),
      show: false,
      // The audience must never see application furniture (Section 5).
      frame: false,
      titleBarStyle: 'hidden',
      autoHideMenuBar: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      // True black, not a near-black: anything else is visible as a grey glow in a dark
      // auditorium, and reveals the screen edges during a black-out.
      backgroundColor: '#000000',
      webPreferences: roleWebPreferences('output'),
    });

    harden(output, 'output');

    output.once('ready-to-show', () => {
      if (!output || output.isDestroyed()) return;
      // With no bounds this is a hidden media host (see ensureMediaHost): it must NOT appear on
      // screen, or an operator would see a stray black window during a service.
      if (!bounds) return;
      output.show();
      output.setFullScreen(true);
    });

    // Keep the audience screen above other windows, but not above system dialogs.
    output.setAlwaysOnTop(true, 'normal');

    // Escape must not let the audience screen out of fullscreen — exiting is an operator
    // decision, routed through the live controls.
    output.on('leave-full-screen', () => {
      if (output && !output.isDestroyed() && bounds) output.setFullScreen(true);
    });

    output.on('closed', () => {
      output = null;
    });

    load(output, 'output');
    return output;
  };

  const openConfidence = (bounds: Electron.Rectangle | null): BrowserWindow => {
    if (confidence && !confidence.isDestroyed()) {
      if (bounds) confidence.setBounds(bounds);
      confidence.show();
      return confidence;
    }

    confidence = new BrowserWindow({
      ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : { width: 1280, height: 720 }),
      show: false,
      frame: false,
      autoHideMenuBar: true,
      skipTaskbar: true,
      backgroundColor: '#060D16',
      webPreferences: roleWebPreferences('confidence'),
    });

    harden(confidence, 'confidence');
    confidence.once('ready-to-show', () => {
      if (!confidence || confidence.isDestroyed()) return;
      confidence.show();
      if (bounds) confidence.setFullScreen(true);
    });
    confidence.on('closed', () => {
      confidence = null;
    });

    load(confidence, 'confidence');
    return confidence;
  };

  const windowFor = (role: WindowRole): BrowserWindow | null => {
    switch (role) {
      case 'operator':
        return operator;
      case 'output':
        return output;
      case 'confidence':
        return confidence;
    }
  };

  return {
    openOperator,
    getOperator: () => (operator && !operator.isDestroyed() ? operator : null),

    openOutput,
    closeOutput() {
      if (output && !output.isDestroyed()) output.close();
      output = null;
    },
    getOutput: () => (output && !output.isDestroyed() ? output : null),

    ensureMediaHost() {
      if (output && !output.isDestroyed()) return output;

      // Created with no bounds, so openOutput leaves it hidden and windowed rather than
      // fullscreen on a display. It exists purely to host the peer connection until Phase 7
      // assigns it to a projector.
      const created = openOutput(null);
      console.log('[window:output] opened as a hidden media host for Wireless Camera');
      return created;
    },

    openConfidence,
    closeConfidence() {
      if (confidence && !confidence.isDestroyed()) confidence.close();
      confidence = null;
    },
    getConfidence: () => (confidence && !confidence.isDestroyed() ? confidence : null),

    roleOf: (contents) => roles.get(contents) ?? null,

    broadcast(channel, payload, targetRoles = ['operator', 'output', 'confidence']) {
      for (const role of targetRoles) {
        this.sendTo(role, channel, payload);
      }
    },

    sendTo(role, channel, payload) {
      const window = windowFor(role);
      // The isDestroyed guard is essential, not defensive noise: LiveStateService
      // broadcasts over a copy of its listener set, so a window closing mid-broadcast
      // can still be handed one final event after it unsubscribed. Sending to destroyed
      // webContents throws.
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(channel, payload);
    },

    closeAll() {
      for (const window of [output, confidence, operator]) {
        if (window && !window.isDestroyed()) window.destroy();
      }
      operator = null;
      output = null;
      confidence = null;
    },
  };
}

/**
 * Session-wide guards, applied once. These cover every window including any future one,
 * so a new window cannot be created without them.
 */
function installSessionGuards(): void {
  const defaultSession = session.defaultSession;

  // CSP is injected here rather than in a <meta> tag so it cannot be stripped by anything
  // that manipulates the document.
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          buildCsp({ devServerUrl: DEV_SERVER_URL, isPackaged: app.isPackaged }),
        ],
      },
    });
  });

  // Cameras need 'media'. Everything else a presentation app has no business requesting
  // is denied, so a future dependency cannot quietly ask for geolocation or USB.
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = isPermissionGranted(permission);
    if (!granted) console.warn(`[security] denied permission request: ${permission}`);
    callback(granted);
  });

  defaultSession.setPermissionCheckHandler((_contents, permission) => isPermissionGranted(permission));

  // No device may be chosen without an explicit user action through our own UI.
  defaultSession.setDevicePermissionHandler(() => false);
}
