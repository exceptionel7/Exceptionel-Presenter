/**
 * EXCEPTIONEL PRESENTER — the Media section and the theme background editor (Phase 5).
 *
 * SOURCE-TEXT assertions. There is no DOM here, so these are weaker than a render test and the file
 * says so rather than implying otherwise. Each rule below is one whose breakage is silent: a section
 * that exists but is unreachable, a capability with no control to invoke it, a path leaking into the
 * renderer, a placeholder that claims a feature works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECTIONS, sectionById } from '../src/renderer/operator/navigation.ts';
import { IPC_CHANNELS } from '../src/shared/ipc-contract.ts';

const SRC = join(process.cwd(), 'src');
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const MEDIA = read('renderer', 'operator', 'sections', 'Media.tsx');
const THEMES = read('renderer', 'operator', 'sections', 'Themes.tsx');
const APP = read('renderer', 'operator', 'App.tsx');

// ── reachable at all ────────────────────────────────────────────────────────────

test('the Media section is available and actually wired up', () => {
  /*
   * Three things have to agree or the section is unreachable: the navigation entry says it is
   * available, App.tsx has a case for it, and the component exists. `available: true` with no case
   * renders a spinner forever, which looks exactly like a hang.
   */
  assert.equal(sectionById('media').available, true);
  assert.match(APP, /case 'media':/);
  assert.match(APP, /<MediaSection \/>/);
  assert.match(APP, /from '\.\/sections\/Media\.tsx'/);
});

test('every available section has a case in App.tsx', () => {
  // The general form of the rule above, so the next section to land cannot miss it either.
  for (const section of SECTIONS) {
    if (!section.available) continue;
    assert.match(APP, new RegExp(`case '${section.id}':`), `${section.id} must be rendered`);
  }
});

test('the Media section describes what it does NOT do', () => {
  const requirement = sectionById('media').requirement;
  // Video thumbnails and audio playback are both absent, and the operator finds that out here rather
  // than by staring at a blank tile wondering whether the import failed.
  assert.match(requirement, /thumbnail/i);
  assert.match(requirement, /[Aa]udio is stored but nothing plays it/);
  assert.match(requirement, /COPIED|copied/, 'and that import copies rather than references');
});

// ── the boundary holds in the renderer too ──────────────────────────────────────

test('the Media section never handles a filesystem path', () => {
  /*
   * The renderer cannot be handed a path (media:list returns MediaAssetView) and cannot supply one
   * (media:import takes no payload). This checks the source has not grown a way around either.
   */
  for (const [name, source] of [
    ['Media.tsx', MEDIA],
    ['Themes.tsx', THEMES],
  ] as const) {
    assert.equal(/absPath/.test(source), false, `${name} must not mention absPath`);
    assert.equal(/thumbnailPath/.test(source), false, `${name} must use thumbnailUrl`);
    assert.equal(/file:\/\//.test(source), false, `${name} must not build a file URL`);
    assert.equal(
      /showOpenDialog/.test(source),
      false,
      `${name} must not try to open a dialog — that is main's job`,
    );
  }
});

test('previews are fetched through the protocol URL the view provides', () => {
  assert.match(MEDIA, /asset\.thumbnailUrl/);
  assert.match(THEMES, /asset\.thumbnailUrl/);
});

test('the section only calls media channels that exist', () => {
  const called = [...MEDIA.matchAll(/'(media:[a-zA-Z]+)'/g)].map((match) => match[1]);
  assert.ok(called.length >= 5, `expected several media channels, found ${String(called.length)}`);
  for (const channel of called) {
    assert.ok(
      (IPC_CHANNELS as readonly string[]).includes(channel ?? ''),
      `${String(channel)} is not a declared channel`,
    );
  }
});

// ── honesty about what is missing ───────────────────────────────────────────────

test('a video tile says there is no preview frame, rather than showing a blank square', () => {
  /*
   * Video thumbnails are NOT IMPLEMENTED: nativeImage has no video decoder. An empty tile would read
   * as a failed import and the operator would import the file again — the exact confusion this
   * screen exists to prevent.
   */
  assert.match(MEDIA, /Video — no preview frame/);
  assert.match(THEMES, /No preview frame/, 'and the same in the background picker');
});

test('audio is labelled as stored-only, because nothing plays it yet', () => {
  assert.match(MEDIA, /audio playback is NOT IMPLEMENTED/);
});

test('the background picker offers only kinds the media layer can paint', () => {
  // Audio is in the library and cannot be a background. Offering it would be a choice that silently
  // does nothing.
  assert.match(THEMES, /useQuery\('media:list', \{ kind: 'image' \}\)/);
  assert.match(THEMES, /useQuery\('media:list', \{ kind: 'video' \}\)/);
  assert.equal(/kind: 'audio'/.test(THEMES), false);
});

test('a background video is described as silent and looping wherever it is offered', () => {
  // A real limitation, stated at the moment of choosing rather than discovered during a service.
  assert.match(THEMES, /silent, looping/);
});

// ── the capability is invocable ──────────────────────────────────────────────────

test('A MEDIA BACKGROUND CAN ACTUALLY BE CHOSEN FROM THE INTERFACE', () => {
  /*
   * THE RULE THIS FILE EXISTS FOR. `background.mediaAssetId` is honoured by SlideCanvas, carried by
   * the theme spec and served by the protocol — all of which is worth nothing if no screen can set
   * it. This project has already shipped that mistake once: the service theme picker saved a field
   * that precedence made inert, so a control the operator could set did nothing at all.
   */
  assert.match(THEMES, /mediaAssetId/, 'the editor must write the field');
  assert.match(THEMES, /setAssetId/, 'and offer a way to pick one');
  assert.match(THEMES, /themes:save/, 'and persist it');
  assert.match(THEMES, /\bfit\b/, 'including how it fills the screen');
});

test('A MEDIA FILE CAN ACTUALLY BE PUT INTO A SERVICE', () => {
  /*
   * The other half of the same rule. `buildCues` turns an `image` or `video` item into a real cue and
   * `SlideCanvas` paints it — but the minimal service builder adds SONGS ONLY, and the full builder is
   * Phase 8. Without this control the media-cue path would be implemented and unreachable.
   */
  assert.match(MEDIA, /services:save/, 'the section must be able to append an item');
  assert.match(MEDIA, /kind: asset\.kind === 'video' \? 'video' : 'image'/);
  assert.match(MEDIA, /refId: asset\.id/, 'the item points at the asset by id');
});

test('appending to a service preserves existing item ids', () => {
  /*
   * `services:save` REPLACES the item rows, and cue ids derive from item ids. Omitting them would
   * regenerate every cue, and `setCues` would find the live one gone — blacking the projector in the
   * middle of a service.
   */
  assert.match(MEDIA, /id: item\.id/);
});

test('audio is not offered as a service slide, because nothing would show', () => {
  // Gated on the same predicate the presentation engine uses.
  assert.match(MEDIA, /canBeBackground\(asset\.kind\)/);
});

test('built-in themes are customised by INHERITING, not by copying their fields', () => {
  /*
   * A child overriding only its background keeps receiving later corrections to the parent — a
   * legibility fix, say. Flattening the parent's spec into the child would freeze today's defaults
   * forever, and the repository refuses to modify a built-in anyway.
   */
  assert.match(THEMES, /parentThemeId: parent\.id/);
  assert.match(THEMES, /spec: \{\}/, 'the new child starts with no overrides of its own');
});

test('the theme gallery still resolves through the SHARED resolver', () => {
  /*
   * Themes.tsx kept its own `FALLBACK` and `mergePreview` once, because a renderer cannot import from
   * main. Two definitions of what a theme resolves to is a guarantee that the preview and the audience
   * screen eventually disagree — and no way for the operator to tell which is lying.
   */
  assert.match(THEMES, /resolveThemeSpecOrBase/);
  assert.equal(/function resolveFromChain/.test(THEMES), false, 'no local re-implementation');
  assert.equal(/const FALLBACK\s*[:=]/.test(THEMES), false);
  assert.equal(/function mergePreview/.test(THEMES), false);
});

test('the theme editor states what it does NOT edit', () => {
  // It edits backgrounds only. Saying so beats letting an operator hunt for a font control that is
  // not there.
  assert.match(THEMES, /Phase&nbsp;9|Phase 9/);
  assert.match(THEMES, /typography/i);
});

// ── import reporting ────────────────────────────────────────────────────────────

test('an import reports duplicates and refusals per file, not just a count', () => {
  /*
   * "Added 40 files" when eight were duplicates and two were refused is a lie of omission the
   * operator discovers later, in the grid, looking for a file that is not there.
   */
  assert.match(MEDIA, /duplicates/);
  assert.match(MEDIA, /refused/);
  assert.match(MEDIA, /entry\.reason/, 'a refusal shows WHY, which is what says what to do next');
  assert.match(MEDIA, /entry\.filename/, 'and which file it was');
});

test('a cancelled import produces no report at all', () => {
  // Closing a dialog is not an event worth a banner; banners that fire on non-events train operators
  // to ignore banners.
  assert.match(MEDIA, /outcome === 'cancelled'/);
});

test('deleting warns that services using the file will have nothing to show', () => {
  // Stated before confirming, not discovered on Sunday.
  assert.match(MEDIA, /will have nothing to show/);
  assert.match(MEDIA, /confirm/i, 'and it takes a second click');
});
