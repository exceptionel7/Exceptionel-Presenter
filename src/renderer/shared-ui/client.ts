/**
 * EXCEPTIONEL PRESENTER — typed renderer client over the preload bridge.
 *
 * `window.exceptionel` is intentionally untyped and stringly-keyed (it must survive
 * contextBridge serialisation). This module restores full type safety on top of it, so a
 * component calling `client.invoke('songs:list', {...})` gets the correct response type
 * and a compile error on a misspelled channel.
 */

import type {
  IpcChannel,
  IpcEvent,
  IpcEventMap,
  IpcRequest,
  IpcResponse,
  IpcResult,
} from '@shared/ipc-contract.ts';
import type { ErrorNotice } from '@shared/domain/errors.ts';

interface ExceptionelBridge {
  invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  readonly role: string;
  readonly allowedChannels: readonly string[];
  readonly allowedEvents: readonly string[];
}

declare global {
  interface Window {
    exceptionel?: ExceptionelBridge;
  }
}

/** Thrown when the preload bridge is missing — a packaging bug, not a runtime condition. */
const MISSING_BRIDGE: ErrorNotice = {
  domain: 'internal',
  code: 'bridge/unavailable',
  message: 'Exceptionel Presenter could not reach its application core.',
  detail: 'window.exceptionel is undefined — the preload script did not load.',
  remedies: [
    'Restart the application.',
    'If this persists, reinstall Exceptionel Presenter.',
  ],
  severity: 'fatal',
  retryable: false,
  id: 'err_bridge_missing',
  occurredAt: new Date().toISOString(),
};

export interface Client {
  invoke<C extends IpcChannel>(channel: C, payload?: IpcRequest<C>): Promise<IpcResult<IpcResponse<C>>>;
  /**
   * Like invoke, but returns the data directly and throws on failure. For call sites where
   * an error is genuinely exceptional and an error boundary should catch it.
   */
  expect<C extends IpcChannel>(channel: C, payload?: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventMap[E]) => void): () => void;
  readonly role: string;
  readonly available: boolean;
}

export class IpcFailureError extends Error {
  readonly notice: ErrorNotice;

  constructor(notice: ErrorNotice) {
    super(notice.message);
    this.name = 'IpcFailureError';
    this.notice = notice;
  }
}

export const client: Client = {
  async invoke(channel, payload) {
    const bridge = window.exceptionel;
    if (!bridge) return { ok: false, failure: MISSING_BRIDGE };
    return (await bridge.invoke(channel, payload)) as IpcResult<never>;
  },

  async expect(channel, payload) {
    const result = await this.invoke(channel, payload);
    if (!result.ok) throw new IpcFailureError(result.failure);
    return result.data;
  },

  on(event, listener) {
    const bridge = window.exceptionel;
    if (!bridge) return () => undefined;
    return bridge.on(event, listener as (payload: unknown) => void);
  },

  get role() {
    return window.exceptionel?.role ?? 'unknown';
  },

  get available() {
    return window.exceptionel !== undefined;
  },
};
