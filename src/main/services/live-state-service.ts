/**
 * EXCEPTIONEL PRESENTER — authoritative live state, owned by the main process.
 *
 * Wraps the pure reducer from shared/domain/live-state.ts with subscription and cue
 * management. Operator windows send intents; this broadcasts the resulting state to every
 * output and confidence window (docs/ARCHITECTURE.md §1).
 *
 * No Electron import: the window plumbing subscribes from outside, which keeps this
 * unit-testable.
 */

import {
  createInitialLiveState,
  reduceLive,
  type Cue,
  type LiveIntent,
  type LiveState,
} from '../../shared/domain/live-state.ts';

export type LiveStateListener = (state: LiveState) => void;
export type CueListener = (cues: readonly Cue[]) => void;

export interface LiveStateService {
  getState(): LiveState;
  getCues(): readonly Cue[];
  /** Applies an intent. Returns the resulting state, broadcasting only if it changed. */
  apply(intent: LiveIntent): LiveState;
  /**
   * Replaces the cue list when the operator opens or edits a service.
   * If the live cue survives the change, its position is retained so the audience screen
   * does not jump; if it disappears, output is blacked rather than left showing a slide
   * that no longer exists.
   */
  setCues(cues: readonly Cue[]): LiveState;
  subscribe(listener: LiveStateListener): () => void;
  subscribeCues(listener: CueListener): () => void;
}

export function createLiveStateService(options: { initialThemeId?: string } = {}): LiveStateService {
  let state: LiveState = createInitialLiveState(options.initialThemeId);
  let cues: readonly Cue[] = [];

  const stateListeners = new Set<LiveStateListener>();
  const cueListeners = new Set<CueListener>();

  const broadcast = (): void => {
    // Iterate a copy: a listener that unsubscribes during notification (a window closing
    // mid-broadcast) would otherwise mutate the set we are walking.
    for (const listener of [...stateListeners]) listener(state);
  };

  const commit = (next: LiveState): LiveState => {
    if (next === state) return state; // reducer returns the same object for no-ops
    state = next;
    broadcast();
    return state;
  };

  return {
    getState: () => state,
    getCues: () => cues,

    apply(intent) {
      return commit(reduceLive(state, intent, cues));
    },

    setCues(next) {
      const previous = state.activeCueId;
      cues = [...next];
      for (const listener of [...cueListeners]) listener(cues);

      if (previous === null) return state;

      const index = cues.findIndex((cue) => cue.id === previous);
      if (index === -1) {
        // The live cue was deleted. Stopping is the safe outcome: continuing to render a
        // slide that no longer exists, or silently jumping to a neighbour, would both
        // surprise the audience.
        return commit(reduceLive(state, { type: 'stop' }, cues));
      }

      if (index !== state.cueIndex) {
        // The cue still exists but moved (an item was reordered above it). Re-point the
        // index without changing what is on screen.
        state = { ...state, cueIndex: index, revision: state.revision + 1 };
        broadcast();
      }
      return state;
    },

    subscribe(listener) {
      stateListeners.add(listener);
      // Push current state immediately: a window that opens mid-service must not wait for
      // the next operator action before it knows what to render.
      listener(state);
      return () => stateListeners.delete(listener);
    },

    subscribeCues(listener) {
      cueListeners.add(listener);
      listener(cues);
      return () => cueListeners.delete(listener);
    },
  };
}

/*
 * `cuesFromServiceItems` lived here through Phase 2 and produced one cue per service item.
 *
 * Phase 3 replaced it with `buildCues` in shared/domain/cues.ts, which expands a song into one cue
 * per lyric slide and reports the items it cannot present. It moved to `shared` because it is pure
 * and because the operator interface needs the same `skipped` list the engine derives — and it grew
 * a `songs` parameter, which this module has no business fetching.
 *
 * See src/main/services/service-opener.ts for the single path from a stored service to a cue list.
 */
