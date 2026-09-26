import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_ALLOWED_CHANNELS, CONFIDENCE_ALLOWED_CHANNELS } from '../src/shared/ipc-contract.ts';

/**
 * EXCEPTIONEL PRESENTER — structural invariants of the presentation engine (Phase 3).
 *
 * WHAT THESE ARE. Assertions about source text. There is no DOM here, so a real render test is not
 * possible and these are weaker than one; the file says so rather than implying otherwise.
 *
 * WHY THEY EARN THEIR PLACE. Every rule below has already been broken once in this codebase, and each
 * break was invisible: text that ignored the theme, a preview that duplicated the renderer, a screen
 * that displayed an operator label where the audience needed words. None of them throws, none of them
 * logs, and none is visible until a service is running.
 */

const SRC = join(process.cwd(), 'src');
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const OUTPUT_APP = read('renderer', 'output', 'OutputApp.tsx');
const SERVICE_SECTION = read('renderer', 'operator', 'sections', 'Service.tsx');
const THEMES_SECTION = read('renderer', 'operator', 'sections', 'Themes.tsx');
const CONFIDENCE_APP = read('renderer', 'confidence', 'ConfidenceApp.tsx');
const SLIDE_CANVAS = read('renderer', 'shared-ui', 'SlideCanvas.tsx');

// ── one renderer, not several ────────────────────────────────────────────────────

test('EVERY SURFACE THAT PAINTS A SLIDE USES THE SAME COMPONENT', () => {
  /*
   * The single most important structural rule in Phase 3. A preview exists so the operator can trust
   * it; a second implementation of "how a theme renders" would eventually disagree with the first, and
   * they would find out on the projector with no way to tell which had been lying.
   */
  for (const [name, source] of [
    ['the audience output', OUTPUT_APP],
    ['the operator workspace', SERVICE_SECTION],
    ['the theme gallery', THEMES_SECTION],
  ] as const) {
    assert.match(source, /<SlideCanvas/, `${name} must render through SlideCanvas`);
    assert.match(source, /from '@ui\/SlideCanvas\.tsx'/, `${name} must import it`);
  }
});

test('the operator renders BOTH preview and live through it, not just one', () => {
  // A preview drawn by shared code and a live pane drawn by hand would be the same bug wearing a
  // different hat.
  const uses = SERVICE_SECTION.match(/<SlideCanvas/g) ?? [];
  assert.ok(uses.length >= 2, `expected preview and live panes, found ${String(uses.length)}`);
});

test('THERE IS EXACTLY ONE DEFINITION OF A THEME DEFAULT', () => {
  /*
   * `BASE_THEME_SPEC` and `mergeSpec` were copied into Themes.tsx as `FALLBACK`/`mergePreview`,
   * because a renderer cannot import from main. Two definitions of what a theme defaults to is a
   * guarantee that the preview and the audience screen eventually disagree.
   */
  for (const [name, source] of [
    ['Themes.tsx', THEMES_SECTION],
    ['SlideCanvas.tsx', SLIDE_CANVAS],
    ['OutputApp.tsx', OUTPUT_APP],
    ['Service.tsx', SERVICE_SECTION],
  ] as const) {
    assert.equal(/const FALLBACK\s*[:=]/.test(source), false, `${name} must not redefine the base spec`);
    assert.equal(/function mergePreview/.test(source), false, `${name} must not reimplement the merge`);
    assert.equal(
      /fontFamily:\s*'Inter'/.test(source),
      false,
      `${name} must not hard-code theme defaults — they belong in shared/domain/theme.ts`,
    );
  }
});

// ── the audience sees words, not labels ─────────────────────────────────────────

test('THE AUDIENCE OUTPUT RENDERS THE LYRICS, NOT THE OPERATOR LABEL', () => {
  /*
   * Through Phase 2 the output printed `cue.label` — "Way Maker — Chorus" — because a cue had no body
   * to print. It also hard-coded 84pt, so every theme's typography was silently ignored on the one
   * screen that matters.
   */
  assert.match(OUTPUT_APP, /cue\?\.lines/, 'it must render the cue lines');
  assert.equal(/\{cue\.label\}/.test(OUTPUT_APP), false, 'and must never print the operator label');
  assert.equal(/fontSize:\s*84/.test(OUTPUT_APP), false, 'nor a hard-coded size');
  assert.equal(/textShadow:\s*'/.test(OUTPUT_APP), false, 'nor hard-coded legibility styling');
});

test('the confidence monitor shows the words the person on stage has to sing', () => {
  // It showed `progress.current.label`, which is no use to a worship leader who needs the line.
  assert.match(CONFIDENCE_APP, /current\.lines/, 'the current slide must show its lines');
  assert.match(CONFIDENCE_APP, /next\.lines/, 'and the next slide must preview its opening words');
});

test('THE AUDIENCE OUTPUT IS NEVER ANNOTATED', () => {
  /*
   * `annotate` draws honest diagnostics — "no camera signal", "too much text to fit". They belong on
   * operator surfaces. A caption on a projector telling a congregation about our backlog is worse
   * than showing nothing at all.
   */
  assert.equal(/annotate/.test(OUTPUT_APP.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), false);
  assert.match(SERVICE_SECTION, /annotate/, 'but the operator panes are annotated');
});

// ── the layer stack ─────────────────────────────────────────────────────────────

test('a black-out hides the camera without unmounting it', () => {
  // Unmounting destroys the video element, so restoring from black would cost a visible re-buffer —
  // and restoring from black is exactly when the picture must come straight back.
  assert.match(SLIDE_CANVAS, /visibility:\s*visibility\.showCamera\s*\?\s*'visible'\s*:\s*'hidden'/);
});

test('only the text layer animates', () => {
  // A lyric change must not restart a background video or make a live camera feed flicker.
  const css = readFileSync(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /@keyframes ep-slide-fade/);
  assert.match(css, /@keyframes ep-slide-in/);
  assert.match(css, /prefers-reduced-motion/, 'a system-wide motion preference must be respected');
  // The animation is applied to the text block, which is keyed by cue id.
  assert.match(SLIDE_CANVAS, /key=\{transitionKey\}/);
});

test('geometry is expressed in canvas-relative units, so one slide fits every display', () => {
  assert.match(SLIDE_CANVAS, /cqh/, 'container-query height units');
  assert.match(SLIDE_CANVAS, /containerType: 'size'/);
  assert.equal(/window\.addEventListener\('resize'/.test(SLIDE_CANVAS), false, 'no resize listeners needed');
});

// ── the output window stays walled off from the library ─────────────────────────

test('THE AUDIENCE OUTPUT STILL CANNOT READ THE LIBRARY', () => {
  /*
   * This is why `Cue` carries its own `lines`. Phase 3 could have been built by letting the output
   * window fetch songs, which would have been less code and a worse design: the audience screen must
   * stay incapable of reaching the library, so one broadcast carries one complete truth.
   */
  for (const channel of ['services:open', 'services:get', 'songs:get', 'songs:list'] as const) {
    assert.equal(
      OUTPUT_ALLOWED_CHANNELS.includes(channel as never),
      false,
      `${channel} must not be reachable from the audience output`,
    );
  }

  // Styling is the one exception, and it is read-only.
  assert.ok(OUTPUT_ALLOWED_CHANNELS.includes('themes:list'));
  assert.match(OUTPUT_APP, /themes:list/, 'so the output resolves themes locally, with no per-slide IPC');
});

test('opening a service is an operator action, not something a display can trigger', () => {
  assert.equal(CONFIDENCE_ALLOWED_CHANNELS.includes('services:open' as never), false);
});
