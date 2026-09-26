import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AVERAGE_GLYPH_WIDTH_RATIO,
  BASE_THEME_SPEC,
  DESIGN_CANVAS,
  backgroundCss,
  fitSlideText,
  mergeSpec,
  resolveThemeSpec,
  resolveThemeSpecOrBase,
  withOpacity,
} from '../src/shared/domain/theme.ts';
import type { Theme, ThemeSpec } from '../src/shared/domain/entities.ts';

/**
 * EXCEPTIONEL PRESENTER — theme resolution and text fitting.
 *
 * These decide what the audience literally sees. The fitting tests in particular guard against the
 * most visible failure this application can have: text running off the bottom of a projector in
 * front of a congregation.
 */

const theme = (id: string, spec: Partial<ThemeSpec>, parentThemeId: string | null = null): Theme => ({
  id,
  name: id,
  parentThemeId,
  isBuiltin: false,
  spec,
});

// ── merging ─────────────────────────────────────────────────────────────────────

test('A THEME MAY OVERRIDE ONE FIELD WITHOUT LOSING ITS SIBLINGS', () => {
  // A blind spread would wipe fontFamily, fontSize, weight and the shadow, so a theme that set
  // only a colour would silently lose its typography.
  const merged = mergeSpec(BASE_THEME_SPEC, { text: { color: '#FF0000' } as Partial<ThemeSpec>['text'] });

  assert.equal(merged.text.color, '#FF0000');
  assert.equal(merged.text.fontFamily, BASE_THEME_SPEC.text.fontFamily);
  assert.equal(merged.text.fontSize, BASE_THEME_SPEC.text.fontSize);
  assert.equal(merged.text.fontWeight, BASE_THEME_SPEC.text.fontWeight);
  assert.deepEqual(merged.text.shadow, BASE_THEME_SPEC.text.shadow);
  assert.deepEqual(merged.text.autoFit, BASE_THEME_SPEC.text.autoFit);
});

test('nested groups merge one level deep, not wholesale', () => {
  const merged = mergeSpec(BASE_THEME_SPEC, {
    text: { shadow: { blur: 40 } } as Partial<ThemeSpec>['text'],
  });
  assert.equal(merged.text.shadow.blur, 40);
  assert.equal(merged.text.shadow.enabled, BASE_THEME_SPEC.text.shadow.enabled, 'siblings survive');
  assert.equal(merged.text.shadow.color, BASE_THEME_SPEC.text.shadow.color);
});

test('merging never mutates the base spec', () => {
  // BASE_THEME_SPEC is shared by every resolution in the process. Mutating it would corrupt every
  // theme at once, mid-service.
  const before = JSON.stringify(BASE_THEME_SPEC);
  mergeSpec(BASE_THEME_SPEC, { text: { color: '#00FF00' } as Partial<ThemeSpec>['text'] });
  assert.equal(JSON.stringify(BASE_THEME_SPEC), before);
});

// ── inheritance ─────────────────────────────────────────────────────────────────

test('a child theme inherits from its parent, and nearer definitions win', () => {
  const themes = [
    theme('grandparent', { text: { color: '#111111', fontSize: 100 } as Partial<ThemeSpec>['text'] }),
    theme('parent', { text: { fontSize: 90 } as Partial<ThemeSpec>['text'] }, 'grandparent'),
    theme('child', { text: { fontWeight: 800 } as Partial<ThemeSpec>['text'] }, 'parent'),
  ];

  const spec = resolveThemeSpec(themes, 'child');
  assert.ok(spec);
  assert.equal(spec.text.color, '#111111', 'from the grandparent');
  assert.equal(spec.text.fontSize, 90, 'the parent overrides the grandparent');
  assert.equal(spec.text.fontWeight, 800, 'the child overrides both');
  assert.equal(spec.text.fontFamily, BASE_THEME_SPEC.text.fontFamily, 'and the base fills the rest');
});

test('an unknown theme resolves to null rather than a silent default', () => {
  // A service naming a theme that no longer exists is a real problem. Rendering something plausible
  // would hide it.
  assert.equal(resolveThemeSpec([], 'theme-missing'), null);
  assert.equal(resolveThemeSpec([theme('a', {})], 'b'), null);
});

test('resolveThemeSpecOrBase never leaves a live service with nothing', () => {
  assert.deepEqual(resolveThemeSpecOrBase([], 'theme-missing'), BASE_THEME_SPEC);
  assert.deepEqual(resolveThemeSpecOrBase([], null), BASE_THEME_SPEC);
});

test('A HAND-EDITED INHERITANCE CYCLE DEGRADES INSTEAD OF HANGING', () => {
  /*
   * The repository refuses to save a cycle, but the database is a file on disk that a determined
   * user can edit. An infinite walk here would hang the MAIN process — the one driving the
   * projector — so it must terminate even on corrupt data.
   */
  const themes = [theme('a', {}, 'b'), theme('b', {}, 'a')];
  const spec = resolveThemeSpec(themes, 'a');
  assert.ok(spec, 'it returns rather than spinning');
  assert.equal(spec.text.fontSize, BASE_THEME_SPEC.text.fontSize);
});

test('a theme that is its own parent also terminates', () => {
  const spec = resolveThemeSpec([theme('a', { text: { fontSize: 50 } as Partial<ThemeSpec>['text'] }, 'a')], 'a');
  assert.equal(spec?.text.fontSize, 50);
});

// ── fitting text ────────────────────────────────────────────────────────────────

const specWith = (over: Partial<ThemeSpec['text']>): ThemeSpec =>
  mergeSpec(BASE_THEME_SPEC, { text: over as Partial<ThemeSpec>['text'] });

test('a slide that already fits is left at its declared size', () => {
  const spec = specWith({ fontSize: 72, lineHeight: 1.3 });
  const fit = fitSlideText(['Way maker', 'Miracle worker'], spec);

  assert.equal(fit.fontSize, 72, 'no gratuitous shrinking');
  assert.equal(fit.scale, 1);
  assert.equal(fit.limitedBy, 'none');
  assert.equal(fit.estimatedLineCount, 2);
});

test('A SLIDE TOO TALL IS SHRUNK UNTIL IT FITS', () => {
  const spec = specWith({ fontSize: 84, lineHeight: 1.3 });
  // Twelve short lines at 84pt need 12 * 84 * 1.3 = 1310px; the safe area is 1080 * 0.8 = 864px.
  const lines = Array.from({ length: 12 }, (_, index) => `line ${String(index)}`);
  const fit = fitSlideText(lines, spec);

  assert.equal(fit.limitedBy, 'fit');
  assert.ok(fit.fontSize < 84, 'it was reduced');

  const available = DESIGN_CANVAS.height * (1 - spec.padding.top - spec.padding.bottom);
  const used = fit.estimatedLineCount * fit.fontSize * spec.text.lineHeight;
  assert.ok(used <= available + 1e-6, `the result must actually fit: ${String(used)} > ${String(available)}`);
});

test('the vertical arithmetic is exact, not approximate', () => {
  /*
   * Only WRAPPING is estimated. Given lines short enough that none wrap, the fit is pure arithmetic
   * and can be asserted to the pixel.
   */
  const spec = mergeSpec(BASE_THEME_SPEC, {
    text: { fontSize: 100, lineHeight: 1.0, autoFit: { enabled: true, minScale: 0.1 } } as Partial<ThemeSpec>['text'],
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  // Ten lines at 100pt with lineHeight 1 is exactly 1000px, inside a 1080px canvas.
  const fit = fitSlideText(Array.from({ length: 10 }, () => 'a'), spec);
  assert.equal(fit.fontSize, 100, 'exactly fits, so untouched');

  // Eleven lines needs 1100px and must shrink.
  const tighter = fitSlideText(Array.from({ length: 11 }, () => 'a'), spec);
  assert.ok(tighter.fontSize < 100);
  assert.ok(tighter.estimatedLineCount * tighter.fontSize * 1.0 <= 1080 + 1e-6);
});

test('LONG LINES ARE ACCOUNTED FOR, BECAUSE WRAPPING IS WHAT CAUSES OVERFLOW', () => {
  const spec = specWith({ fontSize: 84 });
  const short = fitSlideText(['Holy'], spec);
  const long = fitSlideText([
    'Blessed be the name of the Lord God Almighty who was and is and is to come forever and ever amen',
  ], spec);

  assert.equal(short.estimatedLineCount, 1);
  assert.ok(long.estimatedLineCount > 1, 'a very long line is predicted to wrap');
  assert.ok(long.fontSize <= short.fontSize);
});

test('letter spacing widens text and therefore affects wrapping', () => {
  const line = ['Blessed be the name of the Lord, the God of Israel, from everlasting to everlasting'];
  const tight = fitSlideText(line, specWith({ fontSize: 84, letterSpacing: 0 }));
  const loose = fitSlideText(line, specWith({ fontSize: 84, letterSpacing: 0.3 }));
  assert.ok(loose.estimatedLineCount >= tight.estimatedLineCount, 'tracking cannot make text narrower');
});

test('padding reduces the space available, so a tighter safe area shrinks type', () => {
  const lines = Array.from({ length: 8 }, (_, index) => `line ${String(index)}`);
  const generous = mergeSpec(BASE_THEME_SPEC, { padding: { top: 0, right: 0, bottom: 0, left: 0 } });
  const tight = mergeSpec(BASE_THEME_SPEC, { padding: { top: 0.3, right: 0.1, bottom: 0.3, left: 0.1 } });

  assert.ok(fitSlideText(lines, tight).fontSize <= fitSlideText(lines, generous).fontSize);
});

test('AN IMPOSSIBLE SLIDE IS REPORTED AS SUCH, NOT SHRUNK TO NOTHING', () => {
  /*
   * There has to be a floor: text at 8pt on a projector is unreadable, which is a different failure
   * from overflow but a failure all the same. When even the floor does not fit, the operator is told
   * so they can split the slide — the honest outcome.
   */
  const spec = specWith({ fontSize: 84, autoFit: { enabled: true, minScale: 0.5 } });
  const fit = fitSlideText(Array.from({ length: 60 }, (_, index) => `line ${String(index)}`), spec);

  assert.equal(fit.limitedBy, 'minimum');
  assert.equal(fit.scale, 0.5);
  assert.equal(fit.fontSize, 42, 'clamped at the floor rather than vanishing');
});

test('a theme may switch auto-fit off, and that choice is reported honestly', () => {
  const spec = specWith({ fontSize: 84, autoFit: { enabled: false, minScale: 0.4 } });
  const fit = fitSlideText(Array.from({ length: 30 }, () => 'line'), spec);

  assert.equal(fit.fontSize, 84, 'the theme asked for a fixed size');
  assert.equal(fit.limitedBy, 'disabled', 'so overflow is a deliberate authoring choice, and is named');
});

test('an empty slide is not a fitting problem', () => {
  const fit = fitSlideText([], specWith({ fontSize: 84 }));
  assert.equal(fit.estimatedLineCount, 0);
  assert.equal(fit.limitedBy, 'none');
});

test('a blank line still occupies a line box', () => {
  // That is how a lyric slide spaces a stanza; treating it as zero-height would overflow.
  const spec = specWith({ fontSize: 72 });
  assert.equal(fitSlideText(['a', '', 'b'], spec).estimatedLineCount, 3);
});

test('fitting is deterministic — the same slide always renders at the same size', () => {
  // Two windows render the same cue. If fitting were not deterministic, the operator preview and
  // the audience screen would disagree about the type size.
  const spec = specWith({ fontSize: 84 });
  const lines = Array.from({ length: 11 }, (_, index) => `a somewhat longer line number ${String(index)}`);
  assert.deepEqual(fitSlideText(lines, spec), fitSlideText(lines, spec));
});

test('the glyph width ratio is a documented estimate in a plausible range', () => {
  // It predicts wrapping only. If it ever drifts to something absurd the tests above would still
  // pass while the preview silently diverged from reality, so it is pinned.
  assert.ok(AVERAGE_GLYPH_WIDTH_RATIO > 0.4 && AVERAGE_GLYPH_WIDTH_RATIO < 0.7);
});

// ── CSS helpers ─────────────────────────────────────────────────────────────────

test('UNIMPLEMENTED BACKGROUNDS RETURN NOTHING RATHER THAN A PLAUSIBLE COLOUR', () => {
  /*
   * Painting a dark rectangle for an image background would present Phase 5 as working. Returning
   * null lets the renderer show the truth — and for `camera` it is essential, because the real
   * camera layer sits underneath and must show through.
   */
  assert.equal(backgroundCss(mergeSpec(BASE_THEME_SPEC, { background: { kind: 'image', value: 'x' } })), null);
  assert.equal(backgroundCss(mergeSpec(BASE_THEME_SPEC, { background: { kind: 'video', value: 'x' } })), null);
  assert.equal(backgroundCss(mergeSpec(BASE_THEME_SPEC, { background: { kind: 'camera', value: '' } })), null);
});

test('solid and gradient backgrounds pass their CSS through', () => {
  assert.equal(backgroundCss(mergeSpec(BASE_THEME_SPEC, { background: { kind: 'solid', value: '#123456' } })), '#123456');
  const gradient = 'linear-gradient(160deg,#0A1421 0%,#050B14 100%)';
  assert.equal(backgroundCss(mergeSpec(BASE_THEME_SPEC, { background: { kind: 'gradient', value: gradient } })), gradient);
});

test('withOpacity converts hex to rgba and leaves anything else alone', () => {
  assert.equal(withOpacity('#000000', 0.38), 'rgba(0, 0, 0, 0.38)');
  assert.equal(withOpacity('#FFFFFF', 1), 'rgba(255, 255, 255, 1)');
  assert.equal(withOpacity('#1E8FEF', 0.5), 'rgba(30, 143, 239, 0.5)');
  // Already-rgba or a named colour must survive untouched rather than becoming "rgba(0,0,0,…)".
  assert.equal(withOpacity('rgba(1,2,3,0.5)', 0.2), 'rgba(1,2,3,0.5)');
  assert.equal(withOpacity('transparent', 0.2), 'transparent');
});
