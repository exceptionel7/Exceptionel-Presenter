/**
 * EXCEPTIONEL PRESENTER — autosave and crash-recovery heartbeat (Sections 32, 33).
 *
 * Two jobs:
 *   1. Debounce writes per aggregate, so typing in a lyric editor does not hit SQLite on
 *      every keystroke, while still committing quickly enough that a crash costs at most
 *      one debounce window.
 *   2. Keep a session snapshot fresh, so a crash can be detected and offered for recovery.
 *
 * Timers are injected so this is testable without waiting in real time.
 */

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface AutosaveOptions {
  debounceMs?: number;
  heartbeatMs?: number;
  clock?: Clock;
  /** Persists one aggregate. Throwing is reported, not swallowed. */
  commit: (key: string, payload: unknown) => void;
  /** Writes the recovery snapshot. */
  heartbeat: () => void;
  onCommitted?: (key: string, at: string) => void;
  onError?: (key: string, error: unknown) => void;
}

export interface Autosave {
  /** Queues a write. Later calls for the same key replace earlier pending payloads. */
  queue(key: string, payload: unknown): void;
  /** Commits everything pending immediately — used on quit and on explicit Save. */
  flush(): void;
  pendingKeys(): string[];
  start(): void;
  stop(): void;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const {
    debounceMs = 400,
    heartbeatMs = 5_000,
    clock = systemClock,
    commit,
    heartbeat,
    onCommitted,
    onError,
  } = options;

  const pending = new Map<string, unknown>();
  const timers = new Map<string, unknown>();
  let heartbeatHandle: unknown = null;

  const commitKey = (key: string): void => {
    if (!pending.has(key)) return;
    const payload = pending.get(key);

    // Clear before committing. If the commit throws, the payload is already out of the
    // queue, so a persistently failing write cannot wedge every later autosave behind it.
    pending.delete(key);
    const timer = timers.get(key);
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      timers.delete(key);
    }

    try {
      commit(key, payload);
      onCommitted?.(key, new Date().toISOString());
    } catch (error) {
      // Never silently fail (Section 39). The operator sees a notice and can hit Save.
      onError?.(key, error);
    }
  };

  return {
    queue(key, payload) {
      pending.set(key, payload);
      const existing = timers.get(key);
      if (existing !== undefined) clock.clearTimeout(existing);
      timers.set(
        key,
        clock.setTimeout(() => commitKey(key), debounceMs),
      );
    },

    flush() {
      // Snapshot the keys: commitKey mutates the map as it goes.
      for (const key of [...pending.keys()]) commitKey(key);
    },

    pendingKeys: () => [...pending.keys()],

    start() {
      if (heartbeatHandle !== null) return;
      heartbeatHandle = clock.setInterval(() => {
        try {
          heartbeat();
        } catch (error) {
          onError?.('session', error);
        }
      }, heartbeatMs);
    },

    stop() {
      if (heartbeatHandle !== null) {
        clock.clearInterval(heartbeatHandle);
        heartbeatHandle = null;
      }
      for (const timer of timers.values()) clock.clearTimeout(timer);
      timers.clear();
    },
  };
}
