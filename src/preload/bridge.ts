/**
 * EXCEPTIONEL PRESENTER — shared contextBridge plumbing.
 *
 * Builds a narrow API object from an explicit channel allow-list. The renderer receives
 * exactly the functions its role is permitted to call and nothing more: no ipcRenderer, no
 * require, no Node globals (Section 34).
 *
 * The allow-list is enforced here AND independently in the main-process dispatcher. Two
 * checks rather than one, because a single bug in either should not be enough to let an
 * audience display mutate the library.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel, IpcEvent, IpcResult } from '../shared/ipc-contract.ts';

export interface ExposedApi {
  invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  readonly role: string;
  readonly allowedChannels: readonly string[];
  readonly allowedEvents: readonly string[];
}

export function exposeApi(options: {
  role: string;
  channels: readonly IpcChannel[] | 'all';
  events: readonly IpcEvent[];
  allChannels: readonly IpcChannel[];
}): void {
  const channels: readonly string[] = options.channels === 'all' ? options.allChannels : options.channels;
  const channelSet = new Set(channels);
  const eventSet = new Set<string>(options.events);

  const api: ExposedApi = {
    async invoke(channel, payload) {
      if (!channelSet.has(channel)) {
        // Refused in the renderer, so a forbidden call never even reaches main. Returning
        // the standard failure shape means callers need no special case for it.
        return {
          ok: false,
          failure: {
            domain: 'internal',
            code: 'ipc/channel-not-exposed',
            message: 'This action is not available in this window.',
            detail: `A "${options.role}" window may not call "${channel}".`,
            remedies: ['This is a bug in Exceptionel Presenter. Please report it.'],
            severity: 'warning',
            retryable: false,
            id: `err_bridge_${Date.now().toString(36)}`,
            occurredAt: new Date().toISOString(),
          },
        };
      }
      return (await ipcRenderer.invoke(channel, payload)) as IpcResult<unknown>;
    },

    on(event, listener) {
      if (!eventSet.has(event)) {
        console.warn(`[bridge] "${options.role}" window may not subscribe to "${event}"`);
        return () => undefined;
      }
      // The Electron event object is deliberately not forwarded: it carries `sender`,
      // which would hand the renderer a handle back into the main process.
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
      ipcRenderer.on(event, wrapped);
      return () => ipcRenderer.removeListener(event, wrapped);
    },

    role: options.role,
    allowedChannels: Object.freeze([...channels]),
    allowedEvents: Object.freeze([...options.events]),
  };

  contextBridge.exposeInMainWorld('exceptionel', Object.freeze(api));
}
