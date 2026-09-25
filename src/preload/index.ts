/**
 * EXCEPTIONEL PRESENTER — the preload script (single bundle, role-scoped at runtime).
 *
 * WHY ONE FILE: a sandboxed preload cannot `require()` local files. With three entry points
 * Rollup split their shared code into `chunks/bridge-*.cjs`; each entry became a stub whose
 * `require` of that chunk threw, so `contextBridge` was never reached and
 * `window.exceptionel` was undefined. A single entry has nothing to split.
 *
 * The role arrives from main via `webPreferences.additionalArguments` and is unreachable
 * from page JavaScript. Unknown or missing roles fall back to the most restricted surface.
 *
 * The renderer gets no `require`, no `fs`, no `ipcRenderer` — only the narrow, frozen
 * `window.exceptionel` object built below. See docs/ARCHITECTURE.md §4.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  CONFIDENCE_ALLOWED_CHANNELS,
  CONFIDENCE_ALLOWED_EVENTS,
  IPC_CHANNELS,
  IPC_EVENTS,
  OUTPUT_ALLOWED_CHANNELS,
  OUTPUT_ALLOWED_EVENTS,
  type IpcChannel,
  type IpcEvent,
  type IpcResult,
} from '../shared/ipc-contract.ts';
import { parsePreloadRole, type PreloadRole } from '../shared/preload-role.ts';

const role: PreloadRole = parsePreloadRole(process.argv);

const SURFACES: Record<PreloadRole, { channels: readonly IpcChannel[]; events: readonly IpcEvent[] }> = {
  // The only window trusted with the complete contract.
  operator: { channels: IPC_CHANNELS, events: IPC_EVENTS },
  // The audience screen renders and nothing else. It cannot advance a slide, edit a song or
  // change a setting. Camera streams are opened here with getUserMedia and never cross IPC,
  // which is why no camera channel is needed.
  output: { channels: OUTPUT_ALLOWED_CHANNELS, events: OUTPUT_ALLOWED_EVENTS },
  // Read-only like output, plus service context for next-slide and speaker notes.
  confidence: { channels: CONFIDENCE_ALLOWED_CHANNELS, events: CONFIDENCE_ALLOWED_EVENTS },
};

const surface = SURFACES[role];
const allowedChannels = new Set<string>(surface.channels);
const allowedEvents = new Set<string>(surface.events);

const api = {
  async invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>> {
    if (!allowedChannels.has(channel)) {
      // Refused in the renderer so a forbidden call never reaches main. The main-process
      // dispatcher enforces the same rule independently — two checks, because one bug in
      // either must not be enough to let an audience display mutate the library.
      return {
        ok: false,
        failure: {
          domain: 'internal',
          code: 'ipc/channel-not-exposed',
          message: 'This action is not available in this window.',
          detail: `A "${role}" window may not call "${channel}".`,
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

  on(event: string, listener: (payload: unknown) => void): () => void {
    if (!allowedEvents.has(event)) {
      console.warn(`[bridge] a "${role}" window may not subscribe to "${event}"`);
      return () => undefined;
    }
    // The Electron event object is deliberately not forwarded: it carries `sender`, which
    // would hand the renderer a handle back into the main process.
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.removeListener(event, wrapped);
  },

  role,
  allowedChannels: Object.freeze([...surface.channels]),
  allowedEvents: Object.freeze([...surface.events]),
};

contextBridge.exposeInMainWorld('exceptionel', Object.freeze(api));

// Confirms in the terminal (main forwards renderer console output) that the bridge actually
// installed. Its absence was previously indistinguishable from a UI bug.
console.log(`[preload] exposed window.exceptionel for role "${role}"`);
