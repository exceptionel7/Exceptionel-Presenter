/**
 * EXCEPTIONEL PRESENTER — renderer hooks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcChannel, IpcEvent, IpcEventMap, IpcRequest, IpcResponse } from '@shared/ipc-contract.ts';
import type { ErrorNotice } from '@shared/domain/errors.ts';
import { client } from './client.ts';

export interface QueryState<T> {
  data: T | null;
  failure: ErrorNotice | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Reads from main, tracking loading and failure state.
 *
 * `payload` is serialised into the dependency list rather than used directly: an object
 * literal passed inline would be a new reference every render and re-fetch forever.
 */
export function useQuery<C extends IpcChannel>(
  channel: C,
  payload?: IpcRequest<C>,
): QueryState<IpcResponse<C>> {
  const [data, setData] = useState<IpcResponse<C> | null>(null);
  const [failure, setFailure] = useState<ErrorNotice | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const payloadKey = JSON.stringify(payload ?? null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      const result = await client.invoke(channel, JSON.parse(payloadKey) as IpcRequest<C>);
      // Guard against a resolved request from a previous render overwriting newer data.
      if (cancelled) return;
      if (result.ok) {
        setData(result.data);
        setFailure(null);
      } else {
        setFailure(result.failure);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [channel, payloadKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, failure, loading, reload };
}

/** Subscribes to a main-process event for the lifetime of the component. */
export function useIpcEvent<E extends IpcEvent>(event: E, listener: (payload: IpcEventMap[E]) => void): void {
  // Held in a ref so a caller passing an inline arrow does not resubscribe every render.
  const ref = useRef(listener);
  ref.current = listener;

  useEffect(() => client.on(event, (payload) => ref.current(payload)), [event]);
}

/** Mutations: tracks in-flight state and surfaces failures without throwing. */
export function useMutation<C extends IpcChannel>(
  channel: C,
): {
  run: (payload?: IpcRequest<C>) => Promise<IpcResponse<C> | null>;
  pending: boolean;
  failure: ErrorNotice | null;
  clearFailure: () => void;
} {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ErrorNotice | null>(null);

  const run = useCallback(
    async (payload?: IpcRequest<C>) => {
      setPending(true);
      setFailure(null);
      const result = await client.invoke(channel, payload);
      setPending(false);
      if (result.ok) return result.data;
      setFailure(result.failure);
      return null;
    },
    [channel],
  );

  return { run, pending, failure, clearFailure: useCallback(() => setFailure(null), []) };
}

/**
 * Global keyboard shortcuts (Section 20).
 *
 * Deliberately ignores keystrokes while focus is in a text field — pressing "B" to type a
 * lyric must not black out the audience screen.
 */
export function useShortcuts(bindings: Record<string, () => void>, enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }

      const key = normaliseKey(event);
      const handler = ref.current[key];
      if (handler) {
        event.preventDefault();
        handler();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/** Converts a KeyboardEvent to the accelerator spelling stored in the shortcuts table. */
export function normaliseKey(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');

  const key =
    event.key === ' '
      ? 'Space'
      : event.key === '.'
        ? 'Period'
        : event.key.length === 1
          ? event.key.toUpperCase()
          : event.key;

  parts.push(key);
  return parts.join('+');
}
