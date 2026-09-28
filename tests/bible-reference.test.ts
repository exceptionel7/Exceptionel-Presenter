import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIBLE_BOOKS,
  BOOK_COUNT,
  bookByExactName,
  bookByNumber,
  matchBook,
  normaliseBookKey,
} from '../src/shared/domain/bible.ts';
import {
  formatReference,
  formatReferenceShort,
  isWholeChapter,
  parseReference,
  referenceKey,
  verseCount,
} from '../src/shared/domain/bible-reference.ts';

/**
 * EXCEPTIONEL PRESENTER — Bible reference parsing.
 *
 * The operator types a reference under pressure, mid-service, and whatever comes back goes on the
 * projector. So the two things these tests care about are: every spelling a person plausibly types
 * resolves to the right passage, and anything uncertain is REFUSED rather than guessed.
 */

const ok = (input: string): { normalised: string; book: string; chapter: number; start: number | null; end: number | null } => {
  const result = parseReference(input);
  assert.ok(result.ok, `expected "${input}" to parse, got: ${result.ok ? '' : result.problem.message}`);
  return {
    normalised: result.normalised,
    book: result.reference.book.name,
    chapter: result.reference.chapter,
    start: result.reference.startVerse,
    end: result.reference.endVerse,
  };
};

const bad = (input: string): { code: string; message: string } => {
  const result = parseReference(input);
  assert.equal(result.ok, false, `expected "${input}" to be refused`);
  assert.ok(!result.ok);
  return { code: result.problem.code, message: result.problem.message };
};

// ── the canon table ─────────────────────────────────────────────────────────────

test('the canon is complete and correctly ordered', () => {
  assert.equal(BOOK_COUNT, 66);
  assert.equal(BIBLE_BOOKS.filter((book) => book.section === 'old').length, 39);
  assert.equal(BIBLE_BOOKS.filter((book) => book.section === 'new').length, 27);

  BIBLE_BOOKS.forEach((book, index) => {
    assert.equal(book.number, index + 1, `${book.name} must be at canonical position ${String(index + 1)}`);
  });

  assert.equal(bookByNumber(1)?.name, 'Genesis');
  assert.equal(bookByNumber(40)?.name, 'Matthew');
  assert.equal(bookByNumber(66)?.name, 'Revelation');
  assert.equal(bookByNumber(67), null);
  assert.equal(bookByNumber(0), null);
});

test('NO SPELLING IS CLAIMED BY TWO BOOKS', () => {
  /*
   * The lookup map is insertion-ordered, so a duplicated alias does not error — the later book simply
   * wins, silently. The first draft of the table gave "hb" to both Habakkuk and Hebrews, so "Hb 2:4"
   * would have produced Hebrews with no warning at all. Judges/Jude/Judith and
   * Philippians/Philemon are the other traps.
   */
  const owners = new Map<string, string[]>();
  for (const book of BIBLE_BOOKS) {
    for (const key of [normaliseBookKey(book.name), normaliseBookKey(book.abbreviation), ...book.aliases]) {
      owners.set(key, [...(owners.get(key) ?? []), book.name]);
    }
  }

  const collisions = [...owners]
    .filter(([, books]) => new Set(books).size > 1)
    .map(([key, books]) => `${key} → ${books.join(' / ')}`);

  assert.deepEqual(collisions, [], `these spellings are claimed by more than one book:\n  ${collisions.join('\n  ')}`);
});

test('every book resolves from its own name and abbreviation', () => {
  for (const book of BIBLE_BOOKS) {
    assert.equal(bookByExactName(book.name)?.number, book.number, book.name);
    assert.equal(bookByExactName(book.abbreviation)?.number, book.number, book.abbreviation);
  }
});

test('AMBIGUITY IS REFUSED, NOT RESOLVED BY LIST ORDER', () => {
  // Judges and Jude are different books. Silently choosing one would put the wrong passage in front
  // of a congregation, and nobody would notice until it was read aloud.
  const jud = matchBook('Jud');
  assert.equal(jud.kind, 'ambiguous');
  assert.ok(jud.kind === 'ambiguous');
  assert.deepEqual(jud.candidates.map((book) => book.name), ['Judges', 'Jude']);

  const ph = matchBook('Ph');
  assert.equal(ph.kind, 'ambiguous');
  assert.ok(ph.kind === 'ambiguous');
  assert.deepEqual(ph.candidates.map((book) => book.name), ['Philippians', 'Philemon']);

  // A single letter is hopeless and must say so rather than picking the first J book.
  assert.equal(matchBook('J').kind, 'ambiguous');
});

test('a unique prefix resolves even when it is not a listed alias', () => {
  // Partial words an operator types while still typing. None of these is in the alias table.
  for (const [typed, expected] of [
    ['Ephesi', 'Ephesians'],
    ['Revel', 'Revelation'],
    ['Deuteron', 'Deuteronomy'],
    ['Coloss', 'Colossians'],
    ['Habak', 'Habakkuk'],
  ] as const) {
    const match = matchBook(typed);
    assert.equal(match.kind, 'prefix', `${typed} should be a unique prefix`);
    assert.ok(match.kind === 'prefix');
    assert.equal(match.book.name, expected);
  }

  // And an exact alias is reported as exact, not as a prefix.
  assert.equal(matchBook('Ephes').kind, 'exact');
  assert.equal(bookByExactName('Matt')?.name, 'Matthew');
});

test('book keys fold the ways people actually write numbered books', () => {
  for (const spelling of ['1 John', '1John', '1jn', 'I John', 'i john', 'First John', '1st John']) {
    assert.equal(bookByExactName(spelling)?.name, '1 John', spelling);
  }
  for (const spelling of ['2 Corinthians', 'II Corinthians', '2Cor', 'Second Corinthians']) {
    assert.equal(bookByExactName(spelling)?.name, '2 Corinthians', spelling);
  }
  assert.equal(bookByExactName('III John')?.name, '3 John');
});

test('a leading Roman numeral is only read as a book number in the leading position', () => {
  // Folding "ii" anywhere would corrupt names that contain it.
  assert.equal(normaliseBookKey('II Timothy'), '2timothy');
  assert.equal(normaliseBookKey('Philippians'), 'philippians');
});

// ── the required reference forms ─────────────────────────────────────────────────

test('EVERY REFERENCE FORM IN THE BRIEF PARSES', () => {
  assert.deepEqual(ok('John 3:16'), { normalised: 'John 3:16', book: 'John', chapter: 3, start: 16, end: 16 });
  assert.deepEqual(ok('Psalm 23:1-6'), { normalised: 'Psalm 23:1-6', book: 'Psalms', chapter: 23, start: 1, end: 6 });
  assert.deepEqual(ok('Romans 8:28'), { normalised: 'Romans 8:28', book: 'Romans', chapter: 8, start: 28, end: 28 });
  assert.deepEqual(ok('Matthew 5:3-12'), { normalised: 'Matthew 5:3-12', book: 'Matthew', chapter: 5, start: 3, end: 12 });
  assert.deepEqual(ok('Genesis 1:1-5'), { normalised: 'Genesis 1:1-5', book: 'Genesis', chapter: 1, start: 1, end: 5 });
});

test('A WHOLE CHAPTER IS NOT THE SAME AS ITS FIRST VERSE', () => {
  /*
   * "Romans 8" and "Romans 8:1" mean different things. Flattening the first into the second would
   * present a single verse where a whole chapter was asked for — a silent, hard-to-spot wrong answer.
   */
  const chapter = ok('Romans 8');
  assert.equal(chapter.start, null);
  assert.equal(chapter.end, null);
  assert.equal(chapter.normalised, 'Romans 8');

  const verse = ok('Romans 8:1');
  assert.equal(verse.start, 1);
  assert.equal(verse.end, 1);

  const wholeChapter = parseReference('Romans 8');
  const singleVerse = parseReference('Romans 8:1');
  assert.ok(wholeChapter.ok);
  assert.ok(singleVerse.ok);
  assert.equal(isWholeChapter(wholeChapter.reference), true);
  assert.equal(isWholeChapter(singleVerse.reference), false);
});

test('abbreviations, case, spacing and dash styles are all tolerated', () => {
  assert.equal(ok('Rom 8').normalised, 'Romans 8');
  assert.equal(ok('rom 8:28').normalised, 'Romans 8:28');
  assert.equal(ok('ROM 8:28').normalised, 'Romans 8:28');
  assert.equal(ok('john   3 : 16').normalised, 'John 3:16');
  assert.equal(ok('1Jn 2:1').normalised, '1 John 2:1');
  // A full stop as the chapter separator, which some traditions prefer.
  assert.equal(ok('gen 1.1-5').normalised, 'Genesis 1:1-5');
  // En dash and em dash, which is what a word processor produces.
  assert.equal(ok('Matthew 5:3–12').normalised, 'Matthew 5:3-12');
  assert.equal(ok('Matthew 5:3—12').normalised, 'Matthew 5:3-12');
});

test('multi-word book names parse, including one beginning with a digit', () => {
  assert.equal(ok('Song of Solomon 1:1').normalised, 'Song of Solomon 1:1');
  assert.equal(ok('Song of Songs 2:1').book, 'Song of Solomon');
  assert.equal(ok('1 Corinthians 13:4-7').normalised, '1 Corinthians 13:4-7');
  assert.equal(ok('2 Chronicles 7:14').normalised, '2 Chronicles 7:14');
});

// ── normalisation ───────────────────────────────────────────────────────────────

test('A SINGLE PSALM IS CITED IN THE SINGULAR', () => {
  // Read aloud in front of people: "Psalm 23", never "Psalms 23".
  assert.equal(ok('Psalms 23').normalised, 'Psalm 23');
  assert.equal(ok('ps 23:1').normalised, 'Psalm 23:1');
  assert.equal(ok('PSALM 119:105').normalised, 'Psalm 119:105');
  // The book itself keeps its plural name.
  assert.equal(ok('Psalm 23').book, 'Psalms');
});

test('normalisation is idempotent — reparsing a normalised reference gives the same string', () => {
  for (const input of ['John 3:16', 'Psalm 23:1-6', 'Rom 8', 'Jude 3', '1 John 2:1', 'Obadiah', 'Song of Solomon 1:1']) {
    const once = ok(input).normalised;
    assert.equal(ok(once).normalised, once, input);
  }
});

test('a one-verse range collapses rather than reading "16-16"', () => {
  assert.equal(ok('John 3:16-16').normalised, 'John 3:16');
});

test('the short form uses the abbreviation, for a cramped running order', () => {
  const parsed = parseReference('1 Corinthians 13:4-7');
  assert.ok(parsed.ok);
  assert.equal(formatReference(parsed.reference), '1 Corinthians 13:4-7');
  assert.equal(formatReferenceShort(parsed.reference), '1 Cor 13:4-7');
});

// ── single-chapter books ────────────────────────────────────────────────────────

test('IN A ONE-CHAPTER BOOK A BARE NUMBER IS A VERSE', () => {
  /*
   * "Jude 3" means the third verse. There is no third chapter of Jude, and reading it as one would
   * either fail or, worse, silently return nothing.
   */
  assert.deepEqual(ok('Jude 3'), { normalised: 'Jude 1:3', book: 'Jude', chapter: 1, start: 3, end: 3 });
  assert.deepEqual(ok('Philemon 6'), { normalised: 'Philemon 1:6', book: 'Philemon', chapter: 1, start: 6, end: 6 });
  assert.equal(ok('2 John 4').normalised, '2 John 1:4');
  assert.equal(ok('III John 4').normalised, '3 John 1:4');
  assert.equal(ok('Obadiah 1').normalised, 'Obadiah 1:1');

  // An explicit chapter:verse still works the ordinary way.
  assert.equal(ok('Jude 1:3').normalised, 'Jude 1:3');
});

test('a one-chapter book on its own means the whole book', () => {
  // "Jude" is already a complete reference. Demanding a chapter number for a book with one chapter is
  // pedantry that costs a keystroke and teaches the operator the parser is fussy.
  const jude = ok('Jude');
  assert.equal(jude.chapter, 1);
  assert.equal(jude.start, null);
  assert.equal(jude.normalised, 'Jude', 'and it is cited without a chapter number');
  assert.equal(ok('Philemon').normalised, 'Philemon');
});

test('a multi-chapter book on its own is still incomplete', () => {
  const problem = bad('1 John');
  assert.equal(problem.code, 'no-chapter');
  assert.match(problem.message, /1 John 3/, 'and the example uses the book they typed');
});

// ── refusals ────────────────────────────────────────────────────────────────────

test('EMPTY AND UNKNOWN INPUT IS REFUSED WITH SOMETHING ACTIONABLE', () => {
  assert.equal(bad('').code, 'empty');
  assert.match(bad('').message, /John 3:16/, 'the error shows the shape of a valid reference');

  const unknown = bad('Xyzzy 1:1');
  assert.equal(unknown.code, 'no-book');
  assert.match(unknown.message, /Xyzzy/, 'and quotes back what was typed');
});

test('a near-miss book name offers a suggestion', () => {
  // Typing under pressure produces "Genisis", not nothing.
  assert.match(bad('Genisis 1:1').message, /Did you mean/);
});

test('AN AMBIGUOUS BOOK LISTS THE CANDIDATES', () => {
  const jud = bad('Jud 3');
  assert.equal(jud.code, 'ambiguous-book');
  assert.match(jud.message, /Judges or Jude/);

  const ph = bad('Ph 1:1');
  assert.equal(ph.code, 'ambiguous-book');
  assert.match(ph.message, /Philippians or Philemon/);
});

test('A REVERSED RANGE IS REFUSED, NOT SILENTLY SWAPPED', () => {
  // It is usually a typo in one of the two numbers, and guessing which would as often as not present
  // the wrong passage.
  const problem = bad('John 3:18-16');
  assert.equal(problem.code, 'reversed-range');
  assert.match(problem.message, /16 comes before verse 18/);
});

test('impossible chapter and verse numbers are refused', () => {
  assert.equal(bad('John 0:1').code, 'bad-number');
  assert.equal(bad('John 3:0').code, 'bad-number');
  // Beyond anything in the canon: Psalms has 150 chapters, Psalm 119 has 176 verses.
  assert.equal(bad('John 151:1').code, 'bad-number');
  assert.equal(bad('John 3:177').code, 'bad-number');
  // But the real maxima are accepted.
  assert.equal(ok('Psalm 150:6').normalised, 'Psalm 150:6');
  assert.equal(ok('Psalm 119:176').normalised, 'Psalm 119:176');
});

test('a reference with no book at all is refused', () => {
  assert.equal(bad('3:16').code, 'no-book');
});

// ── derived helpers ─────────────────────────────────────────────────────────────

test('verse counts are reported, and a whole chapter reports unknown length', () => {
  const range = parseReference('Matthew 5:3-12');
  assert.ok(range.ok);
  assert.equal(verseCount(range.reference), 10);

  const single = parseReference('John 3:16');
  assert.ok(single.ok);
  assert.equal(verseCount(single.reference), 1);

  // A whole chapter's length depends on the installed translation, so it is not invented here.
  const chapter = parseReference('Romans 8');
  assert.ok(chapter.ok);
  assert.equal(verseCount(chapter.reference), null);
});

test('CUE KEYS ARE STABLE AND DERIVED FROM THE BOOK NUMBER', () => {
  /*
   * Cue ids are built from this, and `setCues` re-points the live cue by id — so an unstable key would
   * throw the operator back to black every time a service was reopened. Built from the book NUMBER so
   * it survives any change to a display name.
   */
  const first = parseReference('John 3:16');
  const again = parseReference('john 3 : 16');
  assert.ok(first.ok);
  assert.ok(again.ok);
  assert.equal(referenceKey(first.reference), referenceKey(again.reference));
  assert.equal(referenceKey(first.reference), '43_3_16');

  const range = parseReference('Psalm 23:1-6');
  assert.ok(range.ok);
  assert.equal(referenceKey(range.reference), '19_23_1_6');

  const chapter = parseReference('Romans 8');
  assert.ok(chapter.ok);
  assert.equal(referenceKey(chapter.reference), '45_8');

  // Keys must be safe for the `vId()` validator that guards every cue id over IPC.
  for (const input of ['John 3:16', 'Psalm 23:1-6', 'Romans 8', 'Jude 3', '1 John 2:1']) {
    const parsed = parseReference(input);
    assert.ok(parsed.ok);
    assert.match(referenceKey(parsed.reference), /^[A-Za-z0-9_-]+$/, input);
  }
});
