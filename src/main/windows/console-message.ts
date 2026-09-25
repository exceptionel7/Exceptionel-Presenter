/**
 * EXCEPTIONEL PRESENTER — normalises Electron's `console-message` event.
 *
 * Electron changed this event's signature. It used to be
 * `(event, level: number, message, line, sourceId)` with a Chromium level enum, and is now
 * `(details)` carrying a string `level`. Passing the old form logs a deprecation warning and
 * the arguments will be removed entirely.
 *
 * Both shapes are handled rather than committing to one. This is the code that makes renderer
 * failures visible in the terminal; if it breaks silently after an Electron upgrade, every
 * future renderer bug becomes invisible again — which is exactly the failure mode it exists
 * to prevent.
 *
 * Pure and dependency-free so both shapes can actually be tested.
 */

export type ConsoleSeverity = 'debug' | 'info' | 'warning' | 'error';

export interface NormalisedConsoleMessage {
  severity: ConsoleSeverity;
  text: string;
  line: number;
  sourceId: string;
}

/** Chromium's historic numeric levels. */
const NUMERIC_SEVERITY: Record<number, ConsoleSeverity> = {
  0: 'info', // verbose/log
  1: 'info',
  2: 'warning',
  3: 'error',
};

const STRING_SEVERITY: Record<string, ConsoleSeverity> = {
  debug: 'debug',
  verbose: 'debug',
  log: 'info',
  info: 'info',
  warning: 'warning',
  warn: 'warning',
  error: 'error',
};

/**
 * Reads whichever shape Electron used. Returns null when the arguments cannot be interpreted,
 * so an unexpected future signature degrades to silence rather than throwing inside an event
 * handler in the main process.
 */
export function readConsoleMessage(args: readonly unknown[]): NormalisedConsoleMessage | null {
  // NEW SHAPE: a single object carrying level and message.
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const candidate = arg as Record<string, unknown>;
    if (typeof candidate['message'] !== 'string') continue;

    const severity = toSeverity(candidate['level']);
    if (!severity) continue;

    return {
      severity,
      text: candidate['message'],
      line: typeof candidate['lineNumber'] === 'number' ? candidate['lineNumber'] : 0,
      sourceId: typeof candidate['sourceId'] === 'string' ? candidate['sourceId'] : '',
    };
  }

  // OLD SHAPE: (event, level, message, line, sourceId). The event object is skipped, so the
  // first primitive level and the following string are located positionally.
  for (let i = 0; i < args.length - 1; i++) {
    const severity = toSeverity(args[i]);
    const text = args[i + 1];
    if (severity && typeof text === 'string') {
      return {
        severity,
        text,
        line: typeof args[i + 2] === 'number' ? (args[i + 2] as number) : 0,
        sourceId: typeof args[i + 3] === 'string' ? (args[i + 3] as string) : '',
      };
    }
  }

  return null;
}

function toSeverity(value: unknown): ConsoleSeverity | null {
  if (typeof value === 'number') return NUMERIC_SEVERITY[value] ?? null;
  if (typeof value === 'string') return STRING_SEVERITY[value.toLowerCase()] ?? null;
  return null;
}
