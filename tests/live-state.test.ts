import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialLiveState,
  reduceLive,
  resolveAudienceVisibility,
  serviceProgress,
  type Cue,
  type LiveIntent,
  type LiveState,
} from '../src/shared/domain/live-state.ts';

const cues: Cue[] = [
  { id: 'c1', kind: 'slide', itemId: 'i1', label: 'Welcome' },
  { id: 'c2', kind: 'scripture', itemId: 'i2', label: 'John 3:16' },
  { id: 'c3', kind: 'lyric', itemId: 'i3', label: 'Way Maker — Verse 1' },
  { id: 'c4', kind: 'lyric', itemId: 'i3', label: 'Way Maker — Chorus' },
];

const run = (state: LiveState, ...intents: LiveIntent[]): LiveState =>
  intents.reduce((s, i) => reduceLive(s, i, cues), state);

test('idle audience screen is black — never a flash of operator UI', () => {
  const v = resolveAudienceVisibility(createInitialLiveState());
  assert.equal(v.opaqueBlack, true);
  assert.equal(v.showText, false);
});

test('goLive activates the requested cue', () => {
  const s = run(createInitialLiveState(), { type: 'goLive', cueId: 'c3' });
  assert.equal(s.status, 'live');
  assert.equal(s.activeCueId, 'c3');
  assert.equal(s.cueIndex, 2);
});

test('goLive on an unknown cue is refused, not blanked', () => {
  const live = run(createInitialLiveState(), { type: 'goLive', cueId: 'c2' });
  const after = reduceLive(live, { type: 'goLive', cueId: 'nope' }, cues);
  assert.equal(after, live, 'must return the same object so main skips the broadcast');
});

test('next/previous clamp at the ends and never wrap', () => {
  let s = run(createInitialLiveState(), { type: 'goLive', cueId: 'c4' });
  const atEnd = reduceLive(s, { type: 'next' }, cues);
  assert.equal(atEnd, s, 'advancing past the last cue must not wrap to the top mid-service');

  s = run(createInitialLiveState(), { type: 'goLive', cueId: 'c1' });
  assert.equal(reduceLive(s, { type: 'previous' }, cues), s);
});

test('SECTION 21 — black hides the audience screen and restores the exact prior slide', () => {
  const live = run(createInitialLiveState(), { type: 'goLive', cueId: 'c3' });

  const black = reduceLive(live, { type: 'black' }, cues);
  assert.equal(black.status, 'black');
  assert.equal(black.restoreCueId, 'c3');
  assert.equal(resolveAudienceVisibility(black).opaqueBlack, true);

  const restored = reduceLive(black, { type: 'black' }, cues);
  assert.equal(restored.status, 'live');
  assert.equal(restored.activeCueId, 'c3', 'the previous presentation must return');
  assert.equal(restored.restoreCueId, null);
});

test('clear hides lyrics but keeps camera and background live', () => {
  const live = run(createInitialLiveState(), { type: 'goLive', cueId: 'c3' });
  const cleared = reduceLive(live, { type: 'clear' }, cues);
  const v = resolveAudienceVisibility(cleared);
  assert.equal(v.showText, false, 'text must go');
  assert.equal(v.showCamera, true, 'camera must stay — this is why Clear differs from Black');
  assert.equal(v.opaqueBlack, false);
});

test('advancing while black moves on and returns to visible', () => {
  const s = run(createInitialLiveState(), { type: 'goLive', cueId: 'c2' }, { type: 'black' }, { type: 'next' });
  assert.equal(s.status, 'live');
  assert.equal(s.activeCueId, 'c3');
});

test('black with nothing live is a no-op', () => {
  const idle = createInitialLiveState();
  assert.equal(reduceLive(idle, { type: 'black' }, cues), idle);
});

test('revision increases on every real change so outputs can discard stale frames', () => {
  const a = createInitialLiveState();
  const b = run(a, { type: 'goLive', cueId: 'c1' }, { type: 'next' }, { type: 'black' });
  assert.equal(b.revision, 3);
  assert.equal(reduceLive(b, { type: 'setTheme', themeId: b.themeId }, cues).revision, 3);
});

test('confidence monitor reports current, next and position', () => {
  const s = run(createInitialLiveState(), { type: 'goLive', cueId: 'c3' });
  const p = serviceProgress(s, cues);
  assert.equal(p.current?.label, 'Way Maker — Verse 1');
  assert.equal(p.next?.label, 'Way Maker — Chorus');
  assert.equal(p.position, '3 / 4');
});

test('stop returns to a black audience screen', () => {
  const s = run(createInitialLiveState(), { type: 'goLive', cueId: 'c3' }, { type: 'stop' });
  assert.equal(s.activeCueId, null);
  assert.equal(resolveAudienceVisibility(s).opaqueBlack, true);
});
