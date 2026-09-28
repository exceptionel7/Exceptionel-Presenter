import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { createLiveStateService, type LiveStateService } from '../src/main/services/live-state-service.ts';
import { createBibleService, type BibleService } from '../src/main/services/bible-service.ts';
import { openService } from '../src/main/services/service-opener.ts';
import { validateBiblePackage } from '../src/shared/domain/bible-package.ts';
import { packPassageIntoSlides, slideReference, type ScripturePassage } from '../src/shared/domain/scripture.ts';
import { BASE_THEME_SPEC, mergeSpec } from '../src/shared/domain/theme.ts';
import { validatorFor } from '../src/shared/validation/ipc-validators.ts';
import type { ThemeSpec } from '../src/shared/domain/entities.ts';

/**
 * EXCEPTIONEL PRESENTER — Scripture as cues, through the EXISTING presentation engine.
 *
 * The architectural rule under test: scripture must plug into the same cue list, the same live state
 * and the same renderer as lyrics. There is no second presentation path, and these tests would fail if
 * one were introduced.
 *
 * NO REAL SCRIPTURE IN THIS FILE. The verse text is obviously synthetic, for the same reason the
 * application bundles none.
 */

interface Harness {
  db: AppDatabase;
  live: LiveStateService;
  bible: BibleService;
}

const withHarness = (fn: (h: Harness) => void): void => {
  const db = openDatabase({ path: ':memory:' });
  try {
    const live = createLiveStateService();
    const bible = createBibleService({ db, chooseFile: () => Promise.resolve(null) });

    // A small synthetic translation: John 3 with 21 verses of placeholder prose.
    const validated = validateBiblePackage({
      translation: {
        id: 'sample',
        abbreviation: 'SMP',
        name: 'Sample Edition',
        language: 'en',
        license: 'Public domain',
      },
      books: [
        {
          number: 43,
          chapters: [
            ['john one one', 'john one two'],
            ['john two one'],
            Array.from({ length: 21 }, (_, index) => `placeholder verse ${String(index + 1)} of chapter three`),
          ],
        },
      ],
    });
    assert.ok(validated.ok);
    db.bible.install(validated.value);

    fn({ db, live, bible });
  } finally {
    db.close();
  }
};

/** A service containing one scripture reading. */
const scriptureService = (
  db: AppDatabase,
  reference: string,
  over: { translationId?: string; themeId?: string | null } = {},
): string =>
  db.services.save({
    name: 'Sunday',
    ...(over.themeId === undefined ? {} : { themeId: over.themeId }),
    items: [
      {
        kind: 'scripture',
        label: reference,
        sortOrder: 0,
        // The reference and translation live in the item's config — which is how two readings in one
        // service can come from different translations.
        config: { reference, translationId: over.translationId ?? 'sample' },
      },
    ],
  }).id;

// ── cue creation ────────────────────────────────────────────────────────────────

test('A SCRIPTURE ITEM BECOMES CUES CARRYING STRUCTURE, NOT A TEXT BLOB', () => {
  withHarness(({ db, live, bible }) => {
    const serviceId = scriptureService(db, 'John 3:16-18');
    const opened = openService(db, live, serviceId, bible);

    assert.ok(opened);
    assert.equal(opened.skipped.length, 0, 'scripture is implemented, not skipped');
    assert.ok(opened.cues.length >= 1);

    const cue = opened.cues[0]!;
    assert.equal(cue.kind, 'scripture');
    assert.ok(cue.scripture, 'the structured citation is present');
    assert.equal(cue.scripture.translationId, 'sample');
    assert.equal(cue.scripture.translationAbbreviation, 'SMP');
    assert.equal(cue.scripture.bookNumber, 43);
    assert.equal(cue.scripture.bookName, 'John');
    assert.equal(cue.scripture.chapter, 3);
    assert.equal(cue.scripture.copyrightNotice, 'Public domain', 'attribution travels with the cue');

    // And the words themselves, in the same `lines` field lyrics use.
    assert.ok(cue.lines.length > 0);
    assert.match(cue.lines[0] ?? '', /placeholder verse/);
  });
});

test('the cues land in live state and are steppable like any others', () => {
  withHarness(({ db, live, bible }) => {
    const serviceId = scriptureService(db, 'John 3:16-18');
    const opened = openService(db, live, serviceId, bible);
    assert.ok(opened);

    // Installed as live cues by the same path lyrics use.
    assert.deepEqual(live.getCues().map((cue) => cue.id), opened.cues.map((cue) => cue.id));

    live.apply({ type: 'goLive', cueId: opened.cues[0]!.id });
    assert.equal(live.getState().status, 'live');
    assert.equal(live.getState().cueIndex, 0);
  });
});

test('A CAPTION DESCRIBES THE SLIDE ON SCREEN, NOT THE WHOLE PASSAGE', () => {
  /*
   * A long passage spans several slides. Captioning each with "John 3:1-21" would name verses the
   * congregation cannot see, which is worse than no caption at all.
   */
  withHarness(({ db, live, bible }) => {
    const serviceId = scriptureService(db, 'John 3');
    const opened = openService(db, live, serviceId, bible);
    assert.ok(opened);
    assert.ok(opened.cues.length > 1, 'a 21-verse chapter must not be one slide');

    for (const cue of opened.cues) {
      assert.ok(cue.caption, 'every scripture slide is captioned');
      assert.match(cue.caption, /^John 3:\d+(-\d+)? \(SMP\)$/, cue.caption);
      // The caption and the structured citation must agree about which verses these are.
      assert.match(cue.caption, new RegExp(`:${String(cue.scripture?.startVerse)}`));
    }

    // Together the slides cover the chapter, in order, without gaps or repeats.
    const covered = opened.cues.flatMap((cue) =>
      Array.from(
        { length: (cue.scripture!.endVerse - cue.scripture!.startVerse) + 1 },
        (_, index) => cue.scripture!.startVerse + index,
      ),
    );
    assert.deepEqual(covered, Array.from({ length: 21 }, (_, index) => index + 1));
  });
});

test('cue ids are stable, so reopening keeps the operator on the same slide', () => {
  withHarness(({ db, live, bible }) => {
    const serviceId = scriptureService(db, 'John 3');
    const first = openService(db, live, serviceId, bible);
    assert.ok(first);

    live.apply({ type: 'goLive', cueId: first.cues[2]!.id });
    assert.equal(live.getState().cueIndex, 2);

    const second = openService(db, live, serviceId, bible);
    assert.ok(second);
    assert.deepEqual(second.cues.map((cue) => cue.id), first.cues.map((cue) => cue.id));
    assert.equal(live.getState().status, 'live', 'reopening must not black the projector');
    assert.equal(live.getState().cueIndex, 2);
  });
});

test('EVERY SCRIPTURE CUE SURVIVES THE IPC VALIDATOR', () => {
  /*
   * Cues cross to the audience window, where `vCue` validates them. A cue the engine can build but the
   * validator rejects would be a feature that works everywhere except on the projector.
   */
  withHarness(({ db, live, bible }) => {
    const serviceId = scriptureService(db, 'John 3');
    const opened = openService(db, live, serviceId, bible);
    assert.ok(opened);

    const validator = validatorFor('live:setCues');
    assert.ok(validator, 'the channel must have a validator registered');

    const result = validator.parse({ cues: opened.cues });
    assert.equal(result.ok, true, result.ok ? '' : `${result.path}: ${result.message}`);
  });
});

// ── failures the operator can act on ────────────────────────────────────────────

test('AN UNRESOLVABLE PASSAGE IS REPORTED, AND THE SERVICE STILL OPENS', () => {
  withHarness(({ db, live, bible }) => {
    // Well-formed, but this translation has no Romans.
    const serviceId = scriptureService(db, 'Romans 8:28');
    const opened = openService(db, live, serviceId, bible);

    assert.ok(opened, 'the rest of the service is still usable');
    assert.equal(opened.cues.length, 0);
    assert.equal(opened.skipped[0]?.reason.code, 'scripture-unavailable');
    assert.match(opened.skipped[0]?.reason.detail ?? '', /Check the reference/);
  });
});

test('a removed translation degrades to a reported problem, not a crash', () => {
  withHarness(({ db, live, bible }) => {
    const serviceId = scriptureService(db, 'John 3:16');
    assert.equal(openService(db, live, serviceId, bible)?.cues.length, 1);

    // The operator uninstalls the translation the service depends on.
    db.bible.removeTranslation('sample');

    const after = openService(db, live, serviceId, bible);
    assert.ok(after, 'the service still opens');
    assert.equal(after.cues.length, 0);
    assert.equal(after.skipped[0]?.reason.code, 'scripture-unavailable');
  });
});

test('without a Bible service, scripture is unavailable rather than fatal', () => {
  // Every pre-Phase-4 caller of openService passes no bible argument.
  withHarness(({ db, live }) => {
    const serviceId = scriptureService(db, 'John 3:16');
    const opened = openService(db, live, serviceId);
    assert.ok(opened);
    assert.equal(opened.skipped[0]?.reason.code, 'scripture-unavailable');
  });
});

// ── translations and themes ─────────────────────────────────────────────────────

test('two readings in one service may use different translations', () => {
  withHarness(({ db, live, bible }) => {
    const second = validateBiblePackage({
      translation: {
        id: 'other',
        abbreviation: 'OTH',
        name: 'Other Edition',
        language: 'fr',
        license: 'Public domain',
      },
      books: [{ number: 43, chapters: [['une'], ['deux'], ['trois']] }],
    });
    assert.ok(second.ok);
    db.bible.install(second.value);

    const serviceId = db.services.save({
      name: 'Bilingual',
      items: [
        { kind: 'scripture', label: 'John 3:16', sortOrder: 0, config: { reference: 'John 3:16', translationId: 'sample' } },
        { kind: 'scripture', label: 'John 3:1', sortOrder: 1, config: { reference: 'John 3:1', translationId: 'other' } },
      ],
    }).id;

    const opened = openService(db, live, serviceId, bible);
    assert.ok(opened);
    assert.equal(opened.cues.length, 2);
    assert.equal(opened.cues[0]?.scripture?.translationAbbreviation, 'SMP');
    assert.equal(opened.cues[1]?.scripture?.translationAbbreviation, 'OTH');
  });
});

test('scripture uses the scripture theme by default, and the service theme when one is set', () => {
  withHarness(({ db, live, bible }) => {
    const plain = scriptureService(db, 'John 3:16');
    assert.equal(openService(db, live, plain, bible)?.cues[0]?.themeId, 'theme-scripture');

    const themed = scriptureService(db, 'John 3:16', { themeId: 'theme-announcement' });
    assert.equal(openService(db, live, themed, bible)?.cues[0]?.themeId, 'theme-announcement');
  });
});

test('an item with no reference is left alone rather than guessed at', () => {
  withHarness(({ db, live, bible }) => {
    const serviceId = db.services.save({
      name: 'Sunday',
      items: [{ kind: 'scripture', label: 'Reading', sortOrder: 0, config: {} }],
    }).id;

    const opened = openService(db, live, serviceId, bible);
    assert.ok(opened);
    assert.equal(opened.cues.length, 0);
    assert.equal(opened.skipped.length, 1);
  });
});

// ── packing, in isolation ───────────────────────────────────────────────────────

const verses = (count: number, text = 'a short verse'): ScripturePassage['verses'] =>
  Array.from({ length: count }, (_, index) => ({
    book: 'John',
    bookNumber: 43,
    chapter: 3,
    verse: index + 1,
    text,
  }));

test('PACKING SPLITS AT VERSE BOUNDARIES USING THE REAL TYPE SIZE', () => {
  /*
   * The same `fitSlideText` the renderer uses, not a guessed verses-per-slide constant. A theme with
   * large type therefore yields more slides than one with small type, automatically.
   */
  const large: ThemeSpec = mergeSpec(BASE_THEME_SPEC, {
    text: { fontSize: 120, autoFit: { enabled: true, minScale: 0.5 } } as Partial<ThemeSpec>['text'],
  });
  const small: ThemeSpec = mergeSpec(BASE_THEME_SPEC, {
    text: { fontSize: 30, autoFit: { enabled: true, minScale: 0.5 } } as Partial<ThemeSpec>['text'],
  });

  const passage = { verses: verses(12) };
  const atLarge = packPassageIntoSlides(passage, large);
  const atSmall = packPassageIntoSlides(passage, small);

  assert.ok(atLarge.length > atSmall.length, 'bigger type needs more slides');

  // Nothing is lost or repeated, at either size.
  for (const slides of [atLarge, atSmall]) {
    const covered = slides.flatMap((slide) =>
      Array.from({ length: slide.endVerse - slide.startVerse + 1 }, (_, index) => slide.startVerse + index),
    );
    assert.deepEqual(covered, Array.from({ length: 12 }, (_, index) => index + 1));
  }
});

test('verse numbers appear on multi-verse slides and are omitted on single-verse ones', () => {
  // On a single-verse slide the caption already says which verse it is, so repeating it in the body is
  // noise the congregation has to read past.
  const multi = packPassageIntoSlides({ verses: verses(3) }, BASE_THEME_SPEC);
  assert.equal(multi.length, 1);
  assert.match(multi[0]?.lines[0] ?? '', /^1\s/);

  const single = packPassageIntoSlides({ verses: [verses(1)[0]!] }, BASE_THEME_SPEC);
  assert.equal(single[0]?.lines[0], 'a short verse', 'no leading number');
});

test('verse numbers can be switched off entirely', () => {
  const slides = packPassageIntoSlides({ verses: verses(3) }, BASE_THEME_SPEC, { showVerseNumbers: false });
  assert.equal(slides[0]?.lines[0], 'a short verse');
});

test('A SINGLE VERSE TOO LONG TO FIT STILL GETS A SLIDE', () => {
  /*
   * Without the exception for this case the packer would either loop forever or drop the verse. It gets
   * its own slide and auto-fit shrinks it there — the honest outcome.
   */
  const long = [{ book: 'John', bookNumber: 43, chapter: 3, verse: 1, text: 'word '.repeat(400).trim() }];
  const slides = packPassageIntoSlides({ verses: long }, BASE_THEME_SPEC);

  assert.equal(slides.length, 1);
  assert.equal(slides[0]?.startVerse, 1);
  assert.equal(slides[0]?.endVerse, 1);
});

test('the verses-per-slide ceiling is respected even when more would fit', () => {
  // "It fits" and "it can be read from the back row in the time it is on screen" are different
  // questions, and only the first can be computed.
  const slides = packPassageIntoSlides({ verses: verses(10, 'tiny') }, BASE_THEME_SPEC, {
    maxVersesPerSlide: 2,
  });
  assert.equal(slides.length, 5);
  for (const slide of slides) assert.equal(slide.lines.length, 2);
});

test('an empty passage produces no slides rather than one blank one', () => {
  assert.deepEqual(packPassageIntoSlides({ verses: [] }, BASE_THEME_SPEC), []);
});

test('slide references are derived correctly from the passage reference', () => {
  const citation = {
    translationId: 'sample',
    translationAbbreviation: 'SMP',
    bookNumber: 43,
    bookName: 'John',
    chapter: 3,
    startVerse: 1,
    endVerse: 21,
    reference: 'John 3:1-21',
  };

  assert.equal(slideReference(citation, { lines: [], startVerse: 5, endVerse: 5 }), 'John 3:5');
  assert.equal(slideReference(citation, { lines: [], startVerse: 5, endVerse: 8 }), 'John 3:5-8');

  // A whole-chapter reference has no verse part to strip.
  const chapter = { ...citation, reference: 'John 3' };
  assert.equal(slideReference(chapter, { lines: [], startVerse: 1, endVerse: 4 }), 'John 3:1-4');

  // And a single-chapter book cited without a number still produces a usable slide reference.
  const jude = {
    ...citation,
    bookNumber: 65,
    bookName: 'Jude',
    chapter: 1,
    reference: 'Jude',
  };
  assert.equal(slideReference(jude, { lines: [], startVerse: 3, endVerse: 3 }), 'Jude 1:3');
});
