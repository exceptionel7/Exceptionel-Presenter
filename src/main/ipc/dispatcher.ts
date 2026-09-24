/**
 * EXCEPTIONEL PRESENTER — the IPC dispatcher.
 *
 * Every renderer → main call funnels through `dispatch`, which:
 *   1. refuses channels with no registered handler,
 *   2. refuses channels with no validator (fail-closed — see ipc-validators.ts),
 *   3. refuses channels not permitted for the calling window's ROLE,
 *   4. validates the payload before any handler touches SQLite or the filesystem,
 *   5. converts thrown errors into `IpcResult` values rather than letting an Electron
 *      IPC exception cross the bridge as a mangled string with a main-process stack in it.
 *
 * This file has no Electron import, so the whole security boundary is unit-testable.
 * The Electron wiring that calls it lives in register.ts.
 */

import {
  CONFIDENCE_ALLOWED_CHANNELS,
  OUTPUT_ALLOWED_CHANNELS,
  type IpcChannel,
  type IpcResult,
} from '../../shared/ipc-contract.ts';
import { failure, type AppFailure, type ErrorNotice } from '../../shared/domain/errors.ts';
import { validatorFor } from '../../shared/validation/ipc-validators.ts';

export type WindowRole = 'operator' | 'output' | 'confidence';

/** A handler receives an already-validated payload. */
export type IpcHandler = (payload: unknown) => unknown | Promise<unknown>;

export type HandlerRegistry = Partial<Record<IpcChannel, IpcHandler>>;

/**
 * Which channels each window role may call. The operator window is trusted with the full
 * contract; output and confidence windows get explicit read-only allow-lists.
 *
 * This is defence in depth: the output preload already exposes only a narrow surface, but
 * a bug there must not translate into the audience screen being able to delete a song.
 */
export function allowedChannelsFor(role: WindowRole): readonly IpcChannel[] | 'all' {
  switch (role) {
    case 'operator':
      return 'all';
    case 'output':
      return OUTPUT_ALLOWED_CHANNELS;
    case 'confidence':
      return CONFIDENCE_ALLOWED_CHANNELS;
  }
}

export function isChannelAllowedForRole(channel: string, role: WindowRole): boolean {
  const allowed = allowedChannelsFor(role);
  if (allowed === 'all') return true;
  return (allowed as readonly string[]).includes(channel);
}

let noticeCounter = 0;

export function toNotice(appFailure: AppFailure): ErrorNotice {
  noticeCounter += 1;
  return {
    ...appFailure,
    id: `err_${Date.now().toString(36)}_${noticeCounter.toString(36)}`,
    occurredAt: new Date().toISOString(),
  };
}

export interface DispatchOptions {
  handlers: HandlerRegistry;
  /** Called for every failure, so main can log it and push `error:notice` to the UI. */
  onFailure?: (notice: ErrorNotice) => void;
}

export async function dispatch(
  channel: string,
  payload: unknown,
  role: WindowRole,
  options: DispatchOptions,
): Promise<IpcResult<unknown>> {
  const reject = (appFailure: AppFailure): IpcResult<unknown> => {
    const notice = toNotice(appFailure);
    options.onFailure?.(notice);
    return { ok: false, failure: notice };
  };

  // 1. Unknown channel. Checked before the role test so a typo reports as unknown rather
  //    than as a permission problem, which would send a developer down the wrong path.
  const handler = Object.prototype.hasOwnProperty.call(options.handlers, channel)
    ? (options.handlers as Record<string, IpcHandler | undefined>)[channel]
    : undefined;

  if (!handler) {
    return reject(
      failure({
        domain: 'internal',
        code: 'ipc/unknown-channel',
        message: 'This action is not available.',
        detail: `No handler registered for IPC channel "${channel}".`,
        remedies: ['This is a bug in Exceptionel Presenter. Please report it.'],
      }),
    );
  }

  // 2. Fail-closed validation lookup.
  const validator = validatorFor(channel);
  if (!validator) {
    return reject(
      failure({
        domain: 'internal',
        code: 'ipc/no-validator',
        message: 'This action is not available.',
        detail:
          `IPC channel "${channel}" has a handler but no validator, so it is refused. ` +
          `Add an entry to IPC_VALIDATORS.`,
        remedies: ['This is a bug in Exceptionel Presenter. Please report it.'],
        severity: 'fatal',
      }),
    );
  }

  // 3. Role restriction.
  if (!isChannelAllowedForRole(channel, role)) {
    return reject(
      failure({
        domain: 'internal',
        code: 'ipc/forbidden-for-role',
        message: 'This action is not permitted from this window.',
        detail: `A "${role}" window attempted to call "${channel}".`,
        remedies: ['This is a bug in Exceptionel Presenter. Please report it.'],
        severity: 'warning',
      }),
    );
  }

  // 4. Payload validation.
  const parsed = validator.parse(payload);
  if (!parsed.ok) {
    return reject(
      failure({
        domain: 'validation',
        code: 'ipc/invalid-payload',
        message: 'That request could not be completed because some details were invalid.',
        detail: `${channel}: ${parsed.path ? `${parsed.path} — ` : ''}${parsed.message}`,
        remedies: parsed.path
          ? [`Check the "${parsed.path}" field and try again.`]
          : ['Check the values you entered and try again.'],
        severity: 'warning',
      }),
    );
  }

  // 5. Execute, converting any throw into a value.
  try {
    const data = await handler(parsed.value);
    return { ok: true, data };
  } catch (error) {
    // A handler may throw a pre-built AppFailure (e.g. MigrationFailure) to control the
    // message the operator sees; otherwise fall back to a generic report that still keeps
    // the technical detail for logs.
    const carried = extractAppFailure(error);
    if (carried) return reject(carried);

    return reject(
      failure({
        domain: 'internal',
        code: 'ipc/handler-failed',
        message: 'Something went wrong completing that action.',
        detail: `${channel}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        remedies: [
          'Try again.',
          'If it keeps happening, restart Exceptionel Presenter and report the technical detail.',
        ],
        retryable: true,
      }),
    );
  }
}

/** Recognises errors that carry a structured AppFailure (MigrationFailure and friends). */
function extractAppFailure(error: unknown): AppFailure | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = (error as { failure?: unknown }).failure;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const maybe = candidate as Partial<AppFailure>;
  if (typeof maybe.code === 'string' && typeof maybe.message === 'string' && typeof maybe.domain === 'string') {
    return {
      domain: maybe.domain,
      code: maybe.code,
      message: maybe.message,
      remedies: maybe.remedies ?? [],
      severity: maybe.severity ?? 'error',
      retryable: maybe.retryable ?? false,
      ...(maybe.detail === undefined ? {} : { detail: maybe.detail }),
    };
  }
  return null;
}
