/**
 * EXCEPTIONEL PRESENTER — application menu (Section 4).
 *
 * Replaces Electron's default menu, which advertises nothing about this product and
 * includes items (Reload, Toggle Developer Tools) that must not be one keystroke away
 * during a live service.
 *
 * Menu items emit NAMED ACTIONS over `action:invoke` rather than doing work directly, so
 * the menu, keyboard shortcuts and on-screen buttons all travel the same path and stay
 * consistent.
 */

import { Menu, app, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export interface MenuOptions {
  /** Sends a named action to the operator window. */
  dispatch: (action: string) => void;
  isDevelopment: boolean;
  getOperator: () => BrowserWindow | null;
}

export function buildApplicationMenu(options: MenuOptions): Menu {
  const isMac = process.platform === 'darwin';
  const send = (action: string) => () => options.dispatch(action);

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: send('nav.settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push(
    {
      label: '&File',
      submenu: [
        { label: 'New Service', accelerator: 'CmdOrCtrl+N', click: send('service.new') },
        { label: 'Open Service…', accelerator: 'CmdOrCtrl+O', click: send('service.open') },
        { type: 'separator' },
        { label: 'Save Service', accelerator: 'CmdOrCtrl+S', click: send('service.save') },
        { type: 'separator' },
        ...(isMac
          ? ([{ role: 'close' }] as MenuItemConstructorOptions[])
          : ([
              { label: 'Settings', accelerator: 'Ctrl+,', click: send('nav.settings') },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])),
      ],
    },

    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Library', accelerator: 'CmdOrCtrl+F', click: send('search.focus') },
      ],
    },

    {
      label: '&Service',
      submenu: [
        { label: 'Go Live', accelerator: 'CmdOrCtrl+Return', click: send('live.go') },
        { type: 'separator' },
        { label: 'Previous Slide', accelerator: 'Left', click: send('live.previous') },
        { label: 'Next Slide', accelerator: 'Right', click: send('live.next') },
        { type: 'separator' },
        { label: 'Black Audience Screen', accelerator: 'B', click: send('live.black') },
        { label: 'Clear Text', accelerator: 'C', click: send('live.clear') },
        { label: 'Stop Presenting', click: send('live.stop') },
      ],
    },

    {
      label: '&Media',
      submenu: [
        { label: 'Songs', click: send('nav.songs') },
        { label: 'Bible', click: send('nav.bible') },
        { label: 'Media Library', click: send('nav.media') },
        { type: 'separator' },
        { label: 'Cameras', click: send('nav.camera') },
      ],
    },

    {
      label: '&View',
      submenu: [
        { label: 'Dashboard', click: send('nav.dashboard') },
        { label: 'Service', click: send('nav.service') },
        { label: 'Themes', click: send('nav.themes') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Reload and DevTools are development-only. In a packaged build, an accidental
        // Ctrl+R mid-service would tear down the operator interface and the audience output
        // with it.
        ...(options.isDevelopment
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },

    {
      label: '&Outputs',
      submenu: [
        { label: 'Manage Outputs…', click: send('nav.outputs') },
        { type: 'separator' },
        {
          label: 'Toggle Presentation Output',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: send('output.toggle'),
        },
        { label: 'Toggle Confidence Monitor', click: send('output.toggleConfidence') },
      ],
    },

    {
      label: '&Help',
      submenu: [
        { label: 'Keyboard Shortcuts', click: send('nav.help') },
        { type: 'separator' },
        {
          label: 'Open Library Folder',
          click: () => {
            void shell.openPath(app.getPath('userData'));
          },
        },
        {
          label: 'Copy Diagnostics',
          click: send('diagnostics.copy'),
        },
      ],
    },
  );

  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(options: MenuOptions): void {
  Menu.setApplicationMenu(buildApplicationMenu(options));
}
