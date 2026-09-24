/**
 * EXCEPTIONEL PRESENTER — Electron IPC wiring.
 *
 * The thin adapter between Electron's `ipcMain` and the pure `dispatch` function. All the
 * security logic lives in dispatcher.ts, which has no Electron import and is therefore
 * unit-tested; this file only translates between the two worlds.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-contract.ts';
import { dispatch, type HandlerRegistry, type WindowRole } from './dispatcher.ts';
import type { ErrorNotice } from '../../shared/domain/errors.ts';

export interface RegisterIpcOptions {
  handlers: HandlerRegistry;
  /** Resolves which window sent the request, so the dispatcher can authorise by role. */
  roleOf: (event: IpcMainInvokeEvent) => WindowRole | null;
  onFailure?: (notice: ErrorNotice) => void;
}

export function registerIpc(options: RegisterIpcOptions): () => void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      const role = options.roleOf(event);

      if (role === null) {
        // A request from a WebContents we do not recognise as one of our windows. This
        // should be impossible, so it is refused rather than defaulted to 'operator' —
        // guessing the most privileged role would be exactly the wrong failure mode.
        const notice: ErrorNotice = {
          domain: 'internal',
          code: 'ipc/unknown-window',
          message: 'This action is not permitted.',
          detail: `IPC on "${channel}" from an unrecognised window.`,
          remedies: ['This is a bug in Exceptionel Presenter. Please report it.'],
          severity: 'warning',
          retryable: false,
          id: `err_unknown_${Date.now().toString(36)}`,
          occurredAt: new Date().toISOString(),
        };
        options.onFailure?.(notice);
        return { ok: false, failure: notice };
      }

      return dispatch(channel, payload, role, {
        handlers: options.handlers,
        ...(options.onFailure ? { onFailure: options.onFailure } : {}),
      });
    });
  }

  return () => {
    for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
  };
}
