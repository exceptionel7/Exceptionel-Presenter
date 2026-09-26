/**
 * EXCEPTIONEL PRESENTER — authoritative live presentation state.
 *
 * Owned by the Electron MAIN process. Operator windows send intents; this pure reducer
 * produces the next state; main broadcasts it to every output / confidence window.
 *
 * ZERO dependencies by design (no electron, no react, no npm) so it is unit-testable
 * and shell-independent. See docs/ARCHITECTURE.md §1.
 */

import { DEFAULT_THEME_ID } from './theme.ts';

export type LiveStatus = 'idle' | 'live' | 'black' | 'clear' | 'paused';

/** A cue is any presentable unit in the service: a lyric slide, a verse, an image... */
export interface Cue {
  id: string;
  kind: 'lyric' | 'scripture' | 'slide' | 'image' | 'video' | 'camera' | 'announcement';
  /** Service item this cue belongs to, so we can report service progress. */
  itemId: string;
  /**
   * Operator-facing label: "Way Maker — Chorus". Shown in the running order and the confidence
   * monitor. NOT what the audience reads.
   */
  label: string;
  /**
   * The text the AUDIENCE reads, one entry per line as authored.
   *
   * Carried in the cue rather than looked up by the window that renders it, because the audience
   * output is deliberately forbidden from reading the library — `OUTPUT_ALLOWED_CHANNELS` grants it
   * no access to songs or services, and that restriction is worth more than the bytes saved. One
   * broadcast therefore carries one complete truth, and the output can never be asked to paint a
   * slide whose words it does not have.
   *
   * Empty for cues with nothing to read, such as a camera scene. Empty is honest; absent would
   * leave every consumer guessing.
   */
  lines: readonly string[];
  /**
   * Theme this cue renders with, resolved when the service was opened.
   *
   * Per-cue rather than per-service: lyrics, scripture and camera scenes are themed differently in
   * every church that has thought about it, and the seeded settings already name three separate
   * theme ids for exactly that reason. Null means "use the service or application default".
   */
  themeId: string | null;
  /** Speaker notes — confidence monitor only, never the audience screen. */
  notes?: string;
}

export interface LiveState {
  status: LiveStatus;
  /** Cue the audience should be seeing. Null when nothing is live. */
  activeCueId: string | null;
  /** Cue to return to when leaving black/clear. Section 21. */
  restoreCueId: string | null;
  /** Index into the flattened cue list, or -1. */
  cueIndex: number;
  themeId: string;
  /** Monotonic. Outputs discard stale broadcasts and can request full resync. */
  revision: number;
}

export type LiveIntent =
  | { type: 'goLive'; cueId: string }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'goToIndex'; index: number }
  | { type: 'black' }
  | { type: 'clear' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'setTheme'; themeId: string };

export function createInitialLiveState(themeId: string = DEFAULT_THEME_ID): LiveState {
  return {
    status: 'idle',
    activeCueId: null,
    restoreCueId: null,
    cueIndex: -1,
    themeId,
    revision: 0,
  };
}

/** Returned unchanged (same object) when an intent is a no-op, so main can skip broadcast. */
export function reduceLive(state: LiveState, intent: LiveIntent, cues: readonly Cue[]): LiveState {
  const next = (patch: Partial<LiveState>): LiveState => ({
    ...state,
    ...patch,
    revision: state.revision + 1,
  });

  const at = (index: number): LiveState => {
    if (index < 0 || index >= cues.length) return state; // clamp at the ends, never wrap
    return next({ status: 'live', activeCueId: cues[index]!.id, restoreCueId: null, cueIndex: index });
  };

  switch (intent.type) {
    case 'goLive': {
      const index = cues.findIndex((c) => c.id === intent.cueId);
      if (index === -1) return state; // unknown cue: refuse rather than blank the screen
      return at(index);
    }

    case 'next':
      // From black/clear, advancing resumes visibility at the following cue.
      return at(state.cueIndex + 1);

    case 'previous':
      return at(state.cueIndex - 1);

    case 'goToIndex':
      return at(intent.index);

    case 'black':
    case 'clear': {
      const target: LiveStatus = intent.type === 'black' ? 'black' : 'clear';
      if (state.status === target) {
        // Pressing B twice restores — operators expect the key to toggle.
        return state.restoreCueId
          ? next({ status: 'live', activeCueId: state.restoreCueId, restoreCueId: null })
          : state;
      }
      if (state.activeCueId === null) return state; // nothing live; nothing to hide
      return next({
        status: target,
        restoreCueId: state.activeCueId,
        // activeCueId is deliberately preserved: the output keeps the slide mounted
        // (background video keeps playing) and simply covers or hides layers.
      });
    }

    case 'pause':
      if (state.status !== 'live') return state;
      return next({ status: 'paused' });

    case 'resume':
      if (state.status === 'live' || state.status === 'idle') return state;
      return next({
        status: 'live',
        activeCueId: state.restoreCueId ?? state.activeCueId,
        restoreCueId: null,
      });

    case 'stop':
      return next({ status: 'idle', activeCueId: null, restoreCueId: null, cueIndex: -1 });

    case 'setTheme':
      if (state.themeId === intent.themeId) return state;
      return next({ themeId: intent.themeId });
  }
}

/** What the audience display must actually paint. Section 21 / §5 layer stack. */
export function resolveAudienceVisibility(state: LiveState): {
  showBase: boolean;
  showCamera: boolean;
  showMedia: boolean;
  showText: boolean;
  opaqueBlack: boolean;
} {
  switch (state.status) {
    case 'black':
      return { showBase: false, showCamera: false, showMedia: false, showText: false, opaqueBlack: true };
    case 'clear':
      // Clear hides text only — camera and background stay live. This distinction is
      // the whole point of having both buttons.
      return { showBase: true, showCamera: true, showMedia: true, showText: false, opaqueBlack: false };
    case 'idle':
      return { showBase: false, showCamera: false, showMedia: false, showText: false, opaqueBlack: true };
    case 'live':
    case 'paused':
      return { showBase: true, showCamera: true, showMedia: true, showText: true, opaqueBlack: false };
  }
}

/** Confidence-monitor helper (Section 23). */
export function serviceProgress(state: LiveState, cues: readonly Cue[]): {
  current: Cue | null;
  next: Cue | null;
  position: string;
} {
  const current = state.cueIndex >= 0 ? cues[state.cueIndex] ?? null : null;
  const upcoming = state.cueIndex >= 0 ? cues[state.cueIndex + 1] ?? null : (cues[0] ?? null);
  return {
    current,
    next: upcoming,
    position: cues.length ? `${Math.max(state.cueIndex + 1, 0)} / ${cues.length}` : '0 / 0',
  };
}
