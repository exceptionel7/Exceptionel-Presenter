import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countSectionSlides,
  nextSectionLabel,
  songToSlides,
  splitSectionIntoSlides,
  type SectionLike,
} from '../src/shared/domain/song.ts';

const section = (overrides: Partial<SectionLike>): SectionLike => ({
  kind: 'verse',
  label: 'Verse 1',
  lyrics: '',
  slideBreakMode: 'blank-line',
  ...overrides,
});

test('blank lines split a section into slides — the convention worship teams already use', () => {
  const slides = splitSectionIntoSlides(
    section({
      lyrics: 'You are here\nMoving in our midst\n\nYou are here\nWorking in this place',
    }),
  );
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0]?.lines, ['You are here', 'Moving in our midst']);
  assert.deepEqual(slides[1]?.lines, ['You are here', 'Working in this place']);
  assert.deepEqual(slides.map((s) => s.indexInSection), [0, 1]);
});

test('several consecutive blank lines still make one break, not empty slides', () => {
  const slides = splitSectionIntoSlides(section({ lyrics: 'A\n\n\n\nB' }));
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[1]?.lines, ['B']);
});

test('lines of only spaces or tabs count as blank', () => {
  // Invisible whitespace is the most common thing to find in pasted lyrics.
  const slides = splitSectionIntoSlides(section({ lyrics: 'A\n   \nB\n\t\nC' }));
  assert.equal(slides.length, 3);
});

test('CRLF from Windows song sheets is normalised', () => {
  const slides = splitSectionIntoSlides(section({ lyrics: 'A\r\nB\r\n\r\nC' }));
  assert.equal(slides.length, 2, 'a stray \\r must not defeat blank-line detection');
  assert.deepEqual(slides[0]?.lines, ['A', 'B']);
  assert.deepEqual(slides[1]?.lines, ['C']);
  for (const slide of slides) {
    for (const line of slide.lines) {
      assert.doesNotMatch(line, /\r/, 'no carriage return may survive into a rendered slide');
    }
  }
});

test('whole-section mode always produces exactly one slide', () => {
  const slides = splitSectionIntoSlides(
    section({ slideBreakMode: 'whole-section', lyrics: 'A\n\nB\n\nC\n\nD' }),
  );
  assert.equal(slides.length, 1);
  assert.deepEqual(slides[0]?.lines, ['A', 'B', 'C', 'D'], 'blank lines are dropped, not honoured');
});

test('every-2-lines chunks, with a short final slide', () => {
  const slides = splitSectionIntoSlides(
    section({ slideBreakMode: 'every-2-lines', lyrics: 'L1\nL2\nL3\nL4\nL5' }),
  );
  assert.equal(slides.length, 3);
  assert.deepEqual(slides[0]?.lines, ['L1', 'L2']);
  assert.deepEqual(slides[2]?.lines, ['L5'], 'the remainder must not be dropped');
});

test('every-4-lines chunks correctly', () => {
  const slides = splitSectionIntoSlides(
    section({
      slideBreakMode: 'every-4-lines',
      lyrics: 'Way maker\nMiracle worker\nPromise keeper\nLight in the darkness\nMy God\nThat is who You are',
    }),
  );
  assert.equal(slides.length, 2);
  assert.equal(slides[0]?.lines.length, 4);
  assert.deepEqual(slides[1]?.lines, ['My God', 'That is who You are']);
});

test('fixed-line modes ignore blank lines rather than emitting empty slides', () => {
  const slides = splitSectionIntoSlides(
    section({ slideBreakMode: 'every-2-lines', lyrics: 'L1\n\n\nL2\n\nL3' }),
  );
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0]?.lines, ['L1', 'L2']);
});

test('empty and whitespace-only lyrics produce no slides', () => {
  for (const lyrics of ['', '   ', '\n\n\n', '\t\n \n']) {
    for (const mode of ['blank-line', 'whole-section', 'every-2-lines', 'every-4-lines'] as const) {
      assert.equal(
        splitSectionIntoSlides(section({ lyrics, slideBreakMode: mode })).length,
        0,
        `${JSON.stringify(lyrics)} in ${mode} must produce nothing to present`,
      );
    }
  }
});

test('trailing whitespace is trimmed but leading indentation is preserved', () => {
  const slides = splitSectionIntoSlides(section({ lyrics: '  Indented line   \nNormal  ' }));
  assert.deepEqual(
    slides[0]?.lines,
    ['  Indented line', 'Normal'],
    'trailing space would shift centred text; leading space may be deliberate',
  );
});

test('every slide carries its section label and kind for the operator list', () => {
  const slides = splitSectionIntoSlides(
    section({ kind: 'chorus', label: 'Chorus', lyrics: 'Way maker\n\nMiracle worker' }),
  );
  assert.equal(slides.length, 2);
  for (const slide of slides) {
    assert.equal(slide.sectionLabel, 'Chorus');
    assert.equal(slide.sectionKind, 'chorus');
  }
});

test('countSectionSlides agrees with splitSectionIntoSlides', () => {
  // The editor shows this count while typing; if it disagreed with the engine, the
  // operator would be surprised live.
  const cases: SectionLike[] = [
    section({ lyrics: 'A\n\nB' }),
    section({ lyrics: '', slideBreakMode: 'whole-section' }),
    section({ lyrics: 'A\nB\nC', slideBreakMode: 'every-2-lines' }),
    section({ lyrics: 'A\r\nB\r\n\r\nC' }),
  ];
  for (const candidate of cases) {
    assert.equal(countSectionSlides(candidate), splitSectionIntoSlides(candidate).length);
  }
});

test('a whole song flattens in section order', () => {
  const slides = songToSlides([
    section({ kind: 'verse', label: 'Verse 1', lyrics: 'V1a\n\nV1b' }),
    section({ kind: 'chorus', label: 'Chorus', lyrics: 'C1' }),
    section({ kind: 'bridge', label: 'Bridge', lyrics: '' }),
  ]);
  assert.deepEqual(
    slides.map((s) => s.sectionLabel),
    ['Verse 1', 'Verse 1', 'Chorus'],
    'an empty bridge contributes nothing',
  );
  assert.deepEqual(slides.map((s) => s.indexInSection), [0, 1, 0]);
});

// ── section labelling ───────────────────────────────────────────────────────────

test('the first section of a kind is unnumbered', () => {
  assert.equal(nextSectionLabel('chorus', []), 'Chorus');
  assert.equal(nextSectionLabel('pre-chorus', []), 'Pre-Chorus');
});

test('labels number upward from the highest existing number', () => {
  const existing = [section({ kind: 'verse', label: 'Verse 1' }), section({ kind: 'verse', label: 'Verse 2' })];
  assert.equal(nextSectionLabel('verse', existing), 'Verse 3');
});

test('deleting a middle section does not create a duplicate label', () => {
  // Verse 2 was deleted; the next verse must be 4, not 3, since Verse 3 still exists.
  const existing = [section({ kind: 'verse', label: 'Verse 1' }), section({ kind: 'verse', label: 'Verse 3' })];
  assert.equal(nextSectionLabel('verse', existing), 'Verse 4');
});

test('a second section of a previously unnumbered kind becomes 2', () => {
  assert.equal(nextSectionLabel('chorus', [section({ kind: 'chorus', label: 'Chorus' })]), 'Chorus 2');
});

test('other kinds do not affect numbering', () => {
  const existing = [
    section({ kind: 'verse', label: 'Verse 1' }),
    section({ kind: 'verse', label: 'Verse 2' }),
    section({ kind: 'chorus', label: 'Chorus' }),
  ];
  assert.equal(nextSectionLabel('bridge', existing), 'Bridge');
  assert.equal(nextSectionLabel('chorus', existing), 'Chorus 2');
});
