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


// ── disabled controls must explain themselves ───────────────────────────────────

test('EVERY DISABLED BUTTON SAYS WHY IT IS DISABLED', () => {
  /*
   * Reported from a real session: the Songs editor's Save button was dim and nothing on screen said
   * why. The reason was a required, empty title — in a field with no label, no border and no required
   * marker, whose placeholder read "Song title" in the same grey as a heading. Every other field sat
   * in a bordered box under a caption, so the one mandatory field was the only one that did not look
   * like a field. The operator filled in the artist, key, CCLI number and lyrics, then reasonably
   * concluded the button was broken.
   *
   * A dimmed control with no explanation IS indistinguishable from a broken one. So every disabled
   * button carries a `title` (a tooltip) or an `aria-label` giving the reason. Ten buttons across the
   * application failed this when it was first written.
   *
   * Source-level and crude — it parses opening tags, not a DOM — but it holds the line on a rule that
   * is otherwise impossible to remember at the moment it matters.
   */
  const files = [
    'operator/App.tsx',
    'operator/sections/Camera.tsx',
    'operator/sections/Service.tsx',
    'operator/sections/Settings.tsx',
    'operator/sections/Songs.tsx',
    'operator/sections/Bible.tsx',
    'operator/sections/Themes.tsx',
    'operator/sections/Dashboard.tsx',
    'operator/sections/Help.tsx',
  ];

  const offenders: string[] = [];
  let checked = 0;

  for (const file of files) {
    const source = read('renderer', ...file.split('/'));

    for (const match of source.matchAll(/<button\b/g)) {
      const start = match.index;

      // Walk to the end of the opening tag, tracking brace depth so a JSX expression containing
      // `>` (an arrow function, a comparison) does not terminate it early.
      let index = start + match[0].length;
      let depth = 0;
      while (index < source.length) {
        const character = source[index];
        if (character === '{') depth += 1;
        else if (character === '}') depth -= 1;
        else if (character === '>' && depth === 0) break;
        index += 1;
      }

      const tag = source.slice(start, index);
      if (!tag.includes('disabled')) continue;

      checked += 1;
      if (!tag.includes('title=') && !tag.includes('aria-label=')) {
        offenders.push(`${file}:${String(source.slice(0, start).split('\n').length)}`);
      }
    }
  }

  assert.ok(checked >= 10, `expected to find disabled buttons to check, found ${String(checked)}`);
  assert.deepEqual(offenders, [], `these disabled buttons give no reason:\n  ${offenders.join('\n  ')}`);
});

test('the required song title is visibly required, not just enforced', () => {
  const songs = read('renderer', 'operator', 'sections', 'Songs.tsx');

  assert.match(songs, /htmlFor="song-title"/, 'the title field has a real label');
  assert.match(songs, /aria-required="true"/);
  assert.match(songs, /A title is required before this song can be saved/, 'and says so in plain words');
  // A bare, borderless input styled like a heading is what caused the confusion.
  assert.equal(
    /placeholder="Song title"/.test(songs),
    false,
    'the field must not rely on a heading-styled placeholder to name itself',
  );
});


// ── scripture uses the existing engine, not a second one ────────────────────────

const SCRIPTURE_DOMAIN = readFileSync(join(process.cwd(), 'src', 'shared', 'domain', 'scripture.ts'), 'utf8');

test('SCRIPTURE PLUGS INTO THE EXISTING RENDERER, WITH NO SECOND PATH', () => {
  /*
   * The architectural rule for Phase 4. Scripture could have been given its own component — it has a
   * caption, verse numbers and a licence line that lyrics do not — and that would have been the
   * beginning of two renderers drifting apart. Instead it is the same `SlideCanvas` with one extra
   * prop.
   */
  assert.equal(
    /ScriptureCanvas|ScriptureSlide.*Element|function ScriptureView/.test(SERVICE_SECTION + OUTPUT_APP),
    false,
    'no separate scripture renderer may exist',
  );

  // The caption is a prop on the one canvas, not a layer of its own.
  assert.match(SLIDE_CANVAS, /caption\?: string/);
  assert.match(OUTPUT_APP, /caption: cue\.caption/, 'the audience output passes it through');
  assert.match(SERVICE_SECTION, /caption: selectedCue\.caption/, 'and so does the operator preview');
  assert.match(SERVICE_SECTION, /caption: liveCue\.caption/, 'and the live pane');
});

test('the caption lives INSIDE the text layer, so Clear hides it with its verses', () => {
  /*
   * A reference that outlived the verse it names would be worse than no reference: the congregation
   * would be looking at a citation for text that is no longer on screen. Being inside the text block
   * also means it inherits the theme's alignment and scrim and animates with the words.
   */
  const textLayer = SLIDE_CANVAS.slice(
    SLIDE_CANVAS.indexOf('z3 TEXT'),
    SLIDE_CANVAS.indexOf('z4 FOREGROUND'),
  );
  assert.ok(textLayer.length > 0, 'the text layer is identifiable');
  assert.match(textLayer, /captionStyle/, 'the caption is rendered within the text layer');

  // Gated by showText along with the body.
  assert.match(SLIDE_CANVAS, /visibility\.showText && \(lines\.length > 0 \|\| hasCaption\)/);
});

test('the caption is sized from the FITTED body size, not the theme size', () => {
  // Otherwise a dense slide that auto-fit has shrunk would end up with a caption larger than its verses.
  assert.match(SLIDE_CANVAS, /captionStyle\(spec, fit\.fontSize\)/);
  assert.match(SLIDE_CANVAS, /bodyFontSize \* CAPTION_SCALE/);
});

test('VERSE PACKING REUSES THE TESTED FITTING FUNCTION', () => {
  /*
   * Scripture is split at verse boundaries by the same geometry that decides whether lyrics fit. A
   * hard-coded verses-per-slide constant would disagree with the renderer the moment a theme changed
   * its type size.
   */
  assert.match(SCRIPTURE_DOMAIN, /import \{[^}]*\bfitSlideText\b[^}]*\} from '\.\/theme\.ts'/);
  assert.match(SCRIPTURE_DOMAIN, /fitSlideText\(\s*linesFor\(candidate\),\s*spec,\s*DESIGN_CANVAS,\s*\{ hasCaption: true \},?\s*\)\.scale === 1/);
  // `hasCaption: true` is not optional here: every scripture slide carries a reference, and omitting it
  // packed one verse too many so the last line was clipped off the bottom of the screen.
});

test('camera + scripture composes exactly as camera + lyrics does', () => {
  // Both are text over the same z1 camera layer. If scripture needed special handling in the canvas,
  // that would be evidence of a second path.
  const cameraLayer = SLIDE_CANVAS.slice(
    SLIDE_CANVAS.indexOf('z1 CAMERA'),
    SLIDE_CANVAS.indexOf('z2 MEDIA'),
  );
  assert.equal(/scripture/i.test(cameraLayer), false, 'the camera layer knows nothing about scripture');

  const canvasWithoutComments = SLIDE_CANVAS.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  assert.equal(
    /scripture/i.test(canvasWithoutComments),
    false,
    'the renderer has no scripture-specific branch at all — only a generic caption',
  );
});

test('the confidence monitor prefers the slide reference over the cue label', () => {
  // Someone about to read aloud needs "John 3:17", not "John 3:16-18 (SMP)".
  assert.match(CONFIDENCE_APP, /current\.caption \?\? progress\.current\.label/);
});


// ── safe-area insets (the clipping bug) ──────────────────────────────────────────

test('SAFE-AREA INSETS USE CONTAINER UNITS, NOT PERCENTAGES', () => {
  /*
   * The bug that was actually clipping text on the audience screen, reported twice from real sessions:
   * a verse ending mid-word and no reference beneath it.
   *
   * In CSS a percentage padding resolves against the containing block's WIDTH — for `padding-top` and
   * `padding-bottom` as much as for left and right. It is the mechanism behind the old aspect-ratio
   * padding hack and it is very easy to write without noticing.
   *
   * On the 16:9 canvas the width is 1.78x the height, so the Live Worship theme's `padding.top: 0.55`
   * was applied as 55% of WIDTH = 98% of HEIGHT. With its bottom inset that came to 112% of the height:
   * the content box collapsed to LESS THAN ZERO, `justifyContent: center` centred the text around that
   * collapsed point, and everything past the bottom edge was removed by `overflow: hidden`.
   *
   * The lower-third placement that looked right was an accident of the wrong padding, not the theme
   * being honoured — and `fitSlideText`'s arithmetic, which was correct, was computing for a box the CSS
   * never produced.
   */
  const textLayer = SLIDE_CANVAS.slice(
    SLIDE_CANVAS.indexOf('z3 TEXT'),
    SLIDE_CANVAS.indexOf('z4 FOREGROUND'),
  );

  // Vertical insets are fractions of HEIGHT, so they must be expressed in cqh.
  assert.match(textLayer, /paddingTop: `\$\{String\(spec\.padding\.top \* 100\)\}cqh`/);
  assert.match(textLayer, /paddingBottom: `\$\{String\(spec\.padding\.bottom \* 100\)\}cqh`/);
  // Horizontal insets are fractions of WIDTH, so cqw.
  assert.match(textLayer, /paddingLeft: `\$\{String\(spec\.padding\.left \* 100\)\}cqw`/);
  assert.match(textLayer, /paddingRight: `\$\{String\(spec\.padding\.right \* 100\)\}cqw`/);

  assert.equal(
    /padding(?:Top|Bottom|Left|Right): `\$\{String\([^`]*\)\}%`/.test(textLayer),
    false,
    'a percentage inset silently resolves against width and collapses the box',
  );
});

test('the container establishes BOTH axes, or cqw and cqh do not resolve', () => {
  // `containerType: 'size'` queries both dimensions. `inline-size` would give cqw only, and every
  // vertical inset would silently become zero.
  assert.match(SLIDE_CANVAS, /containerType: 'size'/);
  assert.equal(/containerType: 'inline-size'/.test(SLIDE_CANVAS), false);
});

test('a collapsed content box is arithmetically impossible for every built-in theme', () => {
  /*
   * Guards the class of failure rather than the one instance. Percentage padding turned a 37% content
   * band into a negative one; this asserts that every seeded theme leaves real room once its insets are
   * read the way the spec means them.
   */
  const seed = readFileSync(join(process.cwd(), 'src', 'main', 'db', 'migrations', '0002-seed.ts'), 'utf8');

  const insets = [...seed.matchAll(/"padding":\s*\{\s*"top":\s*([0-9.]+),\s*"right":\s*([0-9.]+),\s*"bottom":\s*([0-9.]+),\s*"left":\s*([0-9.]+)/g)];
  assert.ok(insets.length >= 6, `expected the seeded themes' insets, found ${String(insets.length)}`);

  for (const [, top, right, bottom, left] of insets) {
    const verticalBand = 1 - Number(top) - Number(bottom);
    const horizontalBand = 1 - Number(left) - Number(right);
    assert.ok(verticalBand > 0.1, `vertical band ${verticalBand.toFixed(2)} is too small to hold text`);
    assert.ok(horizontalBand > 0.1, `horizontal band ${horizontalBand.toFixed(2)} is too small`);
  }
});
