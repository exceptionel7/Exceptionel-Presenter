/**
 * EXCEPTIONEL PRESENTER — Electron main process entry point.
 *
 * Responsibilities, in order: enforce a single instance, open and migrate the library,
 * create the operator window, wire IPC, start the autosave heartbeat, and shut down
 * cleanly so nothing is lost.
 *
 * UNVERIFIED IN THE BUILD SANDBOX: this file cannot run where it was written (no Electron
 * binary — see docs/ENVIRONMENT.md). The logic it orchestrates is tested; this wiring
 * needs a local `npm run dev`.
 */

import { app, dialog, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type AppDatabase } from './db/database.ts';
import { MigrationFailure } from './db/migrator.ts';
import { APP_SCHEMA_VERSION } from './db/migrations/index.ts';
import { createWindowManager, type WindowManager } from './windows/window-manager.ts';
import { installApplicationMenu } from './windows/menu.ts';
import { createLiveStateService } from './services/live-state-service.ts';
import { createAutosave } from './services/autosave.ts';
import { createHandlers } from './ipc/handlers.ts';
import { registerIpc } from './ipc/register.ts';
import { BRAND } from '../shared/brand.ts';
import type { AppInfo } from '../shared/ipc-contract.ts';
import type { ErrorNotice } from '../shared/domain/errors.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Runtime {
  db: AppDatabase;
  windows: WindowManager;
  sessionId: string;
  teardownIpc: () => void;
  stopAutosave: () => void;
  flush: () => void;
}

let runtime: Runtime | null = null;

/**
 * A second instance would open the same SQLite file twice and, worse, fight over the
 * projector. The first instance is focused instead.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const operator = runtime?.windows.getOperator();
    if (operator) {
      if (operator.isMinimized()) operator.restore();
      operator.focus();
    }
  });

  app.whenReady().then(bootstrap).catch(reportFatal);
}

async function bootstrap(): Promise<void> {
  app.setName(BRAND.name);

  const libraryPath = join(app.getPath('userData'), 'library.db');

  let db: AppDatabase;
  try {
    db = openDatabase({ path: libraryPath });
  } catch (error) {
    // A migration problem is the one startup failure that must never be papered over: it
    // is the difference between "update the app" and "your library is gone".
    const failure = error instanceof MigrationFailure ? error.failure : null;
    await dialog.showMessageBox({
      type: 'error',
      title: failure ? failure.message : 'Exceptionel Presenter could not open your library',
      message: failure ? failure.message : String(error),
      detail: [
        ...(failure?.remedies ?? ['Restart the application. If the problem persists, restore a backup.']),
        '',
        `Library: ${libraryPath}`,
        ...(failure?.detail ? ['', failure.detail] : []),
      ].join('\n'),
      buttons: ['Quit'],
    });
    app.quit();
    return;
  }

  if (db.integrityProblems.length > 0) {
    // Reported, not fatal: an orphaned row should not stop a church running Sunday's
    // service, but it must be visible rather than silently tolerated.
    console.warn('[database] integrity warnings:', db.integrityProblems.join('; '));
  }

  const live = createLiveStateService({
    initialThemeId: db.settings.get<string>('presentation.defaultThemeId', 'theme-modern-worship'),
  });

  const windows = createWindowManager({
    preloadDir: join(here, '../preload'),
    rendererDir: join(here, '../renderer'),
    onOperatorClosed: () => {
      // Closing the operator window ends the service: the audience screen must not be
      // left running with nothing driving it.
      windows.closeOutput();
      windows.closeConfidence();
    },
  });

  // Recovery bookkeeping starts before any window opens, so even a crash during startup
  // leaves a detectable trace.
  db.recovery.prune(20);
  const sessionId = db.recovery.beginSession(null, null);

  const pushFailure = (notice: ErrorNotice): void => {
    console.error(`[${notice.domain}] ${notice.code}: ${notice.message}`, notice.detail ?? '');
    windows.sendTo('operator', 'error:notice', notice);
  };

  const autosave = createAutosave({
    debounceMs: db.settings.get<number>('autosave.debounceMs', 400),
    commit: (key, payload) => {
      // Phase 2 autosaves settings. Phase 8 routes service and song edits through here.
      if (key.startsWith('setting:')) {
        db.settings.set(key.slice('setting:'.length), payload);
      }
    },
    heartbeat: () => {
      const state = live.getState();
      const cues = live.getCues();
      db.recovery.heartbeat(
        sessionId,
        {
          liveState: state,
          cueCount: cues.length,
          activeCueLabel: cues[state.cueIndex]?.label ?? null,
        },
        null,
        null,
      );
    },
    onCommitted: (key, at) => windows.sendTo('operator', 'autosave:committed', { entity: key, at }),
    onError: (key, error) =>
      pushFailure({
        domain: 'database',
        code: 'autosave/failed',
        message: 'A change could not be saved automatically.',
        detail: `${key}: ${error instanceof Error ? error.message : String(error)}`,
        remedies: ['Use File → Save to retry.', 'Check that the disk is not full or read-only.'],
        severity: 'error',
        retryable: true,
        id: `err_autosave_${Date.now().toString(36)}`,
        occurredAt: new Date().toISOString(),
      }),
  });

  const appInfo = (): AppInfo => ({
    name: BRAND.name,
    version: app.getVersion(),
    electronVersion: process.versions['electron'] ?? 'unknown',
    chromeVersion: process.versions['chrome'] ?? 'unknown',
    nodeVersion: process.versions['node'] ?? 'unknown',
    platform: process.platform as AppInfo['platform'],
    schemaVersion: APP_SCHEMA_VERSION,
    sqliteEngine: db.driver.engine,
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
  });

  const teardownIpc = registerIpc({
    handlers: createHandlers({
      db,
      live,
      appInfo,
      quit: () => app.quit(),
    }),
    roleOf: (event) => windows.roleOf(event.sender),
    onFailure: pushFailure,
  });

  // Rebroadcast authoritative live state to every window that is allowed to see it.
  // Output and confidence windows are pure render targets; this is how they learn.
  live.subscribe((state) => windows.broadcast('live:state', state));
  live.subscribeCues((cues) => windows.broadcast('live:cues', { cues }));

  // Menu items emit named actions rather than acting directly, so the menu, keyboard
  // shortcuts and on-screen buttons all follow one code path.
  installApplicationMenu({
    dispatch: (action) => windows.sendTo('operator', 'action:invoke', { action }),
    isDevelopment: !app.isPackaged,
    getOperator: () => windows.getOperator(),
  });

  autosave.start();

  runtime = {
    db,
    windows,
    sessionId,
    teardownIpc,
    stopAutosave: autosave.stop,
    flush: autosave.flush,
  };

  windows.openOperator();

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows open should reopen the operator.
    if (BrowserWindow.getAllWindows().length === 0) windows.openOperator();
  });
}

/**
 * Clean shutdown. `before-quit` rather than `window-all-closed` because the latter does
 * not fire on an OS-initiated logout, which is exactly when losing a service would hurt.
 */
app.on('before-quit', () => {
  if (!runtime) return;
  const { db, sessionId, teardownIpc, stopAutosave, flush, windows } = runtime;
  runtime = null;

  try {
    // Order matters: stop new work, commit what is pending, mark the session clean, then
    // close the database so WAL is checkpointed into the main file.
    stopAutosave();
    flush();
    teardownIpc();
    db.recovery.markCleanShutdown(sessionId);
    windows.closeAll();
    db.close();
  } catch (error) {
    console.error('[shutdown] failed to close cleanly:', error);
  }
});

app.on('window-all-closed', () => {
  // macOS convention keeps the app running with no windows; every other platform quits.
  if (process.platform !== 'darwin') app.quit();
});

// A renderer must never be able to talk to a remote host (Section 34).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function reportFatal(error: unknown): void {
  console.error('[fatal] startup failed:', error);
  dialog.showErrorBox(
    'Exceptionel Presenter could not start',
    [
      error instanceof Error ? error.message : String(error),
      '',
      'Please report this, including the text above.',
    ].join('\n'),
  );
  app.quit();
}

process.on('uncaughtException', (error) => {
  // Log and keep running where possible: crashing the main process mid-service would
  // black out the audience screen. A genuinely unrecoverable state still reaches
  // render-process-gone or the dialog above.
  console.error('[uncaught]', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason);
});
