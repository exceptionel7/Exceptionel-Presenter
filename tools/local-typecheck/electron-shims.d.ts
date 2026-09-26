/**
 * Ambient Electron declarations for LOCAL VERIFICATION ONLY.
 *
 * WHY THIS EXISTS: the build sandbox cannot run `npm install`, so Electron's own type
 * definitions are unavailable and `src/main/index.ts`, `src/main/windows/*` and
 * `src/preload/index.ts` could not be typechecked at all. They were only parse-checked, which
 * does not perform scope analysis — and that is exactly how a temporal-dead-zone bug
 * (`Cannot access 'wireless' before initialization`) reached a release and stopped the app from
 * booting. TypeScript reports that as TS2448 the moment it can actually see the file.
 *
 * DELIBERATELY OUTSIDE tsconfig.node.json's `include`. On a machine with the real Electron types
 * installed, these declarations would merge with the genuine ones and conflict. They are passed
 * to `tsc` only by the explicit local verification command, never by `npm run typecheck`.
 *
 * Loose on purpose: the goal is scope, arity and obvious-typo checking of OUR code, not a
 * faithful reproduction of Electron's API surface. `npm run typecheck` on a real machine remains
 * the authoritative check.
 */

declare namespace Electron {
  interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }
}

declare module 'electron' {
  export interface WebContents {
    send(channel: string, payload?: unknown): void;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    openDevTools(options?: { mode?: string }): void;
    isDestroyed(): boolean;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void;
    readonly id: number;
  }

  export interface IpcMainInvokeEvent {
    readonly sender: WebContents;
  }

  export class BrowserWindow {
    constructor(options?: Record<string, unknown>);
    static getAllWindows(): BrowserWindow[];
    readonly webContents: WebContents;
    loadURL(url: string): Promise<void>;
    loadFile(path: string): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
    show(): void;
    hide(): void;
    focus(): void;
    close(): void;
    destroy(): void;
    restore(): void;
    isMinimized(): boolean;
    isDestroyed(): boolean;
    setBounds(bounds: Electron.Rectangle): void;
    setFullScreen(flag: boolean): void;
    setAlwaysOnTop(flag: boolean, level?: string): void;
  }

  export const app: {
    isPackaged: boolean;
    getName(): string;
    setName(name: string): void;
    getVersion(): string;
    getPath(name: string): string;
    quit(): void;
    whenReady(): Promise<void>;
    requestSingleInstanceLock(): boolean;
    on(event: string, listener: (...args: any[]) => void): void;
  };

  export const ipcMain: {
    handle(channel: string, handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown): void;
    removeHandler(channel: string): void;
  };

  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, payload?: unknown): Promise<unknown>;
    on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
    removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  };

  export const dialog: {
    showMessageBox(options: Record<string, unknown>): Promise<{ response: number }>;
    showErrorBox(title: string, content: string): void;
  };

  export const shell: {
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<string>;
  };

  export const session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived(
          listener: (
            details: { responseHeaders?: Record<string, string[]> },
            callback: (response: Record<string, unknown>) => void,
          ) => void,
        ): void;
      };
      setPermissionRequestHandler(
        handler: (contents: WebContents, permission: string, callback: (granted: boolean) => void) => void,
      ): void;
      setPermissionCheckHandler(handler: (contents: WebContents | null, permission: string) => boolean): void;
      setDevicePermissionHandler(handler: () => boolean): void;
    };
  };

  export interface MenuItemConstructorOptions {
    label?: string;
    role?: string;
    type?: string;
    accelerator?: string;
    click?: () => void;
    submenu?: MenuItemConstructorOptions[];
  }

  export class Menu {
    static buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
    static setApplicationMenu(menu: Menu | null): void;
  }

  export const screen: {
    getAllDisplays(): Record<string, unknown>[];
    getPrimaryDisplay(): Record<string, unknown>;
    on(event: string, listener: (...args: any[]) => void): void;
  };
}


