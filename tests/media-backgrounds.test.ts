/**
 * EXCEPTIONEL PRESENTER — media backgrounds through the EXISTING layer stack (Phase 5).
 *
 * Two kinds of assertion, and the file is explicit about which is which:
 *
 *  - the resolution rules, tested as pure functions;
 *  - structural invariants of `SlideCanvas`, tested against its SOURCE TEXT. There is no DOM here, so
 *    these are weaker than a render test. They earn their place because each rule below is one whose
 *    breakage is silent — a background video that restarts on every lyric, or an unmuted loop talking
 *    over the worship leader, neither of which throws or logs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_THEME_SPEC,
  backgroundCss,
  backgroundMedia,
  describeBackground,
  isMediaBackgroundUnset,
  mergeSpec,
  resolveSlideMedia,
} from '../src/shared/domain/theme.ts';
import { mediaUrl } from '../src/shared/domain/media.ts';
import type { ThemeSpec } from '../src/shared/domain/entities.ts';

const SLIDE_CANVAS = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'shared-ui', 'SlideCanvas.tsx'),
  'utf8',
);

const withBackground = (background: Partial<ThemeSpec['background']>): ThemeSpec =>
  mergeSpec(BASE_THEME_SPEC, { background: { kind: 'solid', value: '#000000', ...background } });

// ── what the media layer shows ──────────────────────────────────────────────────

test('an image background resolves to its asset, covering by default', () => {
  const spec = withBackground({ kind: 'image', mediaAssetId: 'media_abc' });
  assert.deepEqual(backgroundMedia(spec), {
    assetId: 'media_abc',
    kind: 'image',
    // `cover` is right for nearly every background; a theme has to ask for letterboxing.
    fit: 'cover',
  });
});

test('letterboxing is honoured when the theme asks for it', () => {
  const spec = withBackground({ kind: 'video', mediaAssetId: 'media_abc', fit: 'contain' });
  assert.deepEqual(backgroundMedia(spec), {
    assetId: 'media_abc',
    kind: 'video',
    fit: 'contain',
  });
});

test('a media background with no asset chosen resolves to nothing, and is named as unfinished', () => {
  for (const background of [
    { kind: 'image' as const, mediaAssetId: null },
    { kind: 'image' as const },
    { kind: 'video' as const, mediaAssetId: '' },
  ]) {
    const spec = withBackground(background);
    assert.equal(backgroundMedia(spec), null);
    /*
     * The distinction that matters. `backgroundMedia` returning null means both "no media background"
     * and "an unfinished one", and only the second is worth telling someone about — rendering black
     * for it would be indistinguishable from a working solid background.
     */
    assert.equal(isMediaBackgroundUnset(spec), true);
  }
});

test('a solid, gradient or camera background is not an unfinished media one', () => {
  for (const kind of ['solid', 'gradient', 'camera'] as const) {
    const spec = withBackground({ kind, value: '#101010' });
    assert.equal(backgroundMedia(spec), null);
    assert.equal(isMediaBackgroundUnset(spec), false, `${kind} must not be annotated`);
  }
});

test('the base layer paints nothing for camera, image or video', () => {
  /*
   * All three are painted by a layer ABOVE the base. A colour underneath would only be something for
   * them to fail to cover — and for camera it would hide the feed entirely.
   */
  for (const kind of ['camera', 'image', 'video'] as const) {
    assert.equal(backgroundCss(withBackground({ kind, mediaAssetId: 'media_a' })), null);
  }
  assert.equal(backgroundCss(withBackground({ kind: 'solid', value: '#123456' })), '#123456');
});

test('a cue that IS media overrides the theme background', () => {
  const themed = withBackground({ kind: 'image', mediaAssetId: 'media_theme' });
  const cueMedia = { assetId: 'media_cue', kind: 'video' as const, fit: 'cover' as const };

  assert.deepEqual(resolveSlideMedia(themed, cueMedia), cueMedia);
  // No opinion from the cue: the theme's background shows through.
  assert.equal(resolveSlideMedia(themed, undefined)?.assetId, 'media_theme');
  // An explicit null means "paint nothing", which is not the same as having no opinion.
  assert.equal(resolveSlideMedia(themed, null), null);
});

test('a cue’s media shows even when the theme has none', () => {
  const plain = withBackground({ kind: 'solid', value: '#000000' });
  const cueMedia = { assetId: 'media_cue', kind: 'image' as const, fit: 'contain' as const };
  assert.deepEqual(resolveSlideMedia(plain, cueMedia), cueMedia);
});

test('a background is described honestly, including its limitations', () => {
  assert.equal(describeBackground(withBackground({ kind: 'image', mediaAssetId: 'media_a' })), 'image');
  // Stated because it is a real limitation rather than an oversight: a background loop is silent.
  assert.match(
    describeBackground(withBackground({ kind: 'video', mediaAssetId: 'media_a' })),
    /silent, looping/,
  );
  assert.match(describeBackground(withBackground({ kind: 'image' })), /none chosen/);
  assert.match(describeBackground(withBackground({ kind: 'video' })), /none chosen/);
  // No phase numbers any more: this is implemented.
  assert.equal(/Phase/.test(describeBackground(withBackground({ kind: 'image', mediaAssetId: 'a' }))), false);
});

test('a theme setting only its background keeps the rest of the theme', () => {
  // The field-level merge has to reach the new fields too, or choosing a background would silently
  // reset the font.
  const merged = mergeSpec(BASE_THEME_SPEC, {
    background: { kind: 'video', value: '', mediaAssetId: 'media_a', fit: 'contain' },
  });
  assert.equal(merged.text.fontFamily, BASE_THEME_SPEC.text.fontFamily);
  assert.equal(merged.background.mediaAssetId, 'media_a');
  assert.equal(merged.background.fit, 'contain');
});

// ── how the ONE renderer paints it ──────────────────────────────────────────────

test('the media layer fetches by protocol URL, never by path', () => {
  assert.match(SLIDE_CANVAS, /mediaUrl\(media\.assetId\)/, 'both elements address the asset by id');
  // A path in the renderer would defeat the entire reason the protocol exists.
  assert.equal(/file:\/\//.test(SLIDE_CANVAS), false);
  assert.equal(/absPath/.test(SLIDE_CANVAS), false);
  assert.equal(mediaUrl('media_abc'), 'app-media://media_abc');
});

test('a background video is muted and looping', () => {
  const stripped = SLIDE_CANVAS.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
  /*
   * Muted is not a preference. A background is scenery, the church PA carries the service's sound, and
   * a loop with its own audio would talk over the worship leader. It is also what makes autoplay work
   * at all — Chromium refuses to autoplay a video with sound, so an unmuted background would sit on
   * its first frame and look broken.
   */
  assert.match(stripped, /loop/, 'a background must repeat rather than end on a frozen frame');
  const videoTags = stripped.match(/<video[\s\S]*?\/>/g) ?? [];
  assert.equal(videoTags.length, 2, 'the camera element and the media element');
  for (const tag of videoTags) {
    assert.match(tag, /\bmuted\b/, 'every video element in the stack is muted');
    assert.match(tag, /playsInline/);
  }
});

test('the media layer is keyed on the ASSET, not on the cue', () => {
  /*
   * The bug this prevents: keying on `transitionKey` would remount the element on every slide change,
   * so a background video would restart from frame one — and re-buffer — each time the operator
   * advanced a lyric over it.
   */
  assert.match(SLIDE_CANVAS, /key=\{media\.assetId\}/);
  const mediaBlock = SLIDE_CANVAS.slice(SLIDE_CANVAS.indexOf('z2 MEDIA'), SLIDE_CANVAS.indexOf('z3 TEXT'));
  assert.equal(/transitionKey/.test(mediaBlock), false, 'the media layer must not see the cue key');
});

test('a black-out hides the media layer without unmounting it', () => {
  // Same rule as the camera, for the same reason: unmounting would destroy the element, so coming back
  // from black would restart the clip instead of resuming it.
  const matches = SLIDE_CANVAS.match(/visibility\.showMedia\s*\?\s*'visible'\s*:\s*'hidden'/g) ?? [];
  assert.equal(matches.length, 2, 'both the image and the video element honour it');
  assert.equal(
    /showMedia\s*&&/.test(SLIDE_CANVAS),
    false,
    'a conditional render would unmount it instead of hiding it',
  );
});

test('an unfinished media background is annotated on operator surfaces only', () => {
  // `annotate` gates it, so the congregation is never shown the state of a half-configured theme.
  assert.match(SLIDE_CANVAS, /annotate && media === null && isMediaBackgroundUnset\(spec\)/);
  // And the old placeholder is gone: this is implemented, so claiming otherwise would be a lie.
  assert.equal(/backgrounds arrive in Phase 5/.test(SLIDE_CANVAS), false);
});

test('SlideCanvas still contains no media-specific text branch', () => {
  /*
   * The same rule Phase 4 applied to scripture. The media layer is a background; it must not have
   * grown its own way of drawing words, or there would be two text renderers again.
   */
  const stripped = SLIDE_CANVAS.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
  const textBlock = stripped.slice(stripped.indexOf('hasText &&'));
  assert.equal(/media/.test(textBlock), false, 'the text layer must not know about media');
});
