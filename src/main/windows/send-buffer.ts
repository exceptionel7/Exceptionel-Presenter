/**
 * EXCEPTIONEL PRESENTER — buffers messages for renderers that are not listening yet.
 *
 * `webContents.send` to a window whose page has not finished loading is DROPPED SILENTLY. There is
 * no error, no return value and no queue.
 *
 * That cost a working feature. Opening the hidden media host and immediately forwarding a phone's
 * one-shot `ready` message meant the message vanished: no WebRTC offer was ever created, and the
 * phone sat at "CAMERA READY" with Connection "—" indefinitely. Nothing in any log indicated a
 * message had been discarded.
 *
 * Extracted from WindowManager so the buffering rules are testable without Electron.
 */

export interface BufferedMessage {
  channel: string;
  payload: unknown;
}

export interface SendBuffer<Role extends string> {
  /** True once that role's renderer has reported it is loaded. */
  isReady(role: Role): boolean;
  markReady(role: Role): BufferedMessage[];
  /** Queues a message. Returns true when it was buffered rather than ready to send now. */
  enqueue(role: Role, message: BufferedMessage): boolean;
  /** Forgets a role entirely, for a window that has closed. */
  forget(role: Role): void;
  pendingCount(role: Role): number;
}

export interface SendBufferOptions {
  /** Bounded so a renderer that never loads cannot grow the queue without limit. */
  maxPending?: number;
  onDrop?: (role: string, message: BufferedMessage) => void;
}

export function createSendBuffer<Role extends string>(
  options: SendBufferOptions = {},
): SendBuffer<Role> {
  const maxPending = options.maxPending ?? 64;
  const ready = new Set<Role>();
  const pending = new Map<Role, BufferedMessage[]>();

  return {
    isReady: (role) => ready.has(role),

    markReady(role) {
      ready.add(role);
      const queued = pending.get(role) ?? [];
      pending.delete(role);
      return queued;
    },

    enqueue(role, message) {
      if (ready.has(role)) return false;

      const queued = pending.get(role) ?? [];
      if (queued.length >= maxPending) {
        // Oldest first: the newest signalling messages are the ones still worth delivering.
        const dropped = queued.shift();
        if (dropped) options.onDrop?.(role, dropped);
      }
      queued.push(message);
      pending.set(role, queued);
      return true;
    },

    forget(role) {
      // A closed window must not stay marked ready, or the next window opened under the same role
      // would have its first messages sent before it is listening — the original bug, recurring.
      ready.delete(role);
      pending.delete(role);
    },

    pendingCount: (role) => pending.get(role)?.length ?? 0,
  };
}
