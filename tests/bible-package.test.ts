import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBiblePackage, validateBiblePackage, type BiblePackage } from '../src/shared/domain/bible-package.ts';

/**
 * EXCEPTIONEL PRESENTER — translation package validation.
 *
 * The licence tests are the ones that matter most. Bible translations are, with few exceptions, under
 * copyright, so this application ships none and installs text only from a package that states its
 * terms. A validator that let a package through without them would put the application in the business
 * of distributing text nobody had checked the rights to.
 */

const validPackage = (over: Partial<BiblePackage> = {}): unknown => ({
  translation: {
    id: 'sample',
    abbreviation: 'SMP',
    name: 'Sample Edition',
    language: 'en',
    license: 'Public domain',
    ...(over.translation ?? {}),
  },
  books: over.books ?? [
    { number: 43, chapters: [['first verse', 'second verse'], ['next chapter']] },
  ],
});

const expectOk = (input: unknown): Extract<ReturnType<typeof validateBiblePackage>, { ok: true }> => {
  const result = validateBiblePackage(input);
  assert.ok(result.ok, `expected valid, got: ${result.ok ? '' : JSON.stringify(result.problems)}`);
  return result;
};

const expectProblem = (input: unknown, pathFragment: string): string => {
  const result = validateBiblePackage(input);
  assert.equal(result.ok, false, 'expected the package to be refused');
  assert.ok(!result.ok);
  const match = result.problems.find((problem) => problem.path.includes(pathFragment));
  assert.ok(match, `expected a problem at "${pathFragment}", got: ${JSON.stringify(result.problems)}`);
  return match.message;
};

// ── licensing ───────────────────────────────────────────────────────────────────

test('A PACKAGE WITHOUT A LICENCE IS REFUSED', () => {
  /*
   * Refused, not defaulted and not merely warned about. This is the check that keeps unlicensed
   * scripture out of the application, and the database agrees: `bible_translations.license` is NOT NULL.
   */
  const message = expectProblem(validPackage({ translation: { license: '' } as never }), 'translation.license');
  assert.match(message, /licence is required/i);
  assert.match(message, /Public domain/, 'and shows what an acceptable answer looks like');

  expectProblem(validPackage({ translation: { license: '   ' } as never }), 'translation.license');
  expectProblem({ ...(validPackage() as object), translation: { id: 'x', abbreviation: 'X', name: 'X' } }, 'translation.license');
});

test('A NON-ANSWER IN THE LICENCE FIELD IS REFUSED, BUT A SHORT REAL LICENCE IS NOT', () => {
  /*
   * The first version of this check rejected anything shorter than four characters, which would have
   * refused "MIT" — a complete, real licence statement. Length says nothing about whether terms were
   * stated; what needs catching is the non-answer.
   */
  for (const nonAnswer of ['n/a', 'N/A', 'none', '-', 'unknown', 'TBD', 'all rights reserved']) {
    expectProblem(validPackage({ translation: { license: nonAnswer } as never }), 'translation.license');
  }

  for (const real of ['MIT', 'CC0', 'Public domain', 'Licensed by the rights holder for church use']) {
    expectOk(validPackage({ translation: { license: real } as never }));
  }
});

test('a stated licence is preserved verbatim for attribution', () => {
  const licence = 'Public domain in the United States; Crown copyright in the United Kingdom.';
  const result = expectOk(validPackage({ translation: { license: licence } as never }));
  assert.equal(result.value.translation.license, licence, 'not paraphrased or truncated');
});

test('a source URL is optional and preserved', () => {
  const withSource = expectOk(validPackage({ translation: { sourceUrl: 'https://example.org/kjv.json' } as never }));
  assert.equal(withSource.value.translation.sourceUrl, 'https://example.org/kjv.json');

  const without = expectOk(validPackage());
  assert.equal(without.value.translation.sourceUrl, null, 'absent becomes null, not undefined');
});

// ── metadata ────────────────────────────────────────────────────────────────────

test('translation metadata is required and bounded', () => {
  expectProblem(validPackage({ translation: { id: '' } as never }), 'translation.id');
  expectProblem(validPackage({ translation: { abbreviation: '' } as never }), 'translation.abbreviation');
  expectProblem(validPackage({ translation: { name: '' } as never }), 'translation.name');
  expectProblem(validPackage({ translation: { abbreviation: 'X'.repeat(20) } as never }), 'translation.abbreviation');
});

test('THE TRANSLATION ID MUST BE SAFE TO USE AS AN ID', () => {
  // It becomes a primary key and travels over IPC through `vId()`. A path separator or a quote in it
  // would be a problem looking for somewhere to happen.
  for (const bad of ['../etc/passwd', 'kjv edition', "kjv'; DROP TABLE", 'kjv/1', 'kjv.json']) {
    expectProblem(validPackage({ translation: { id: bad } as never }), 'translation.id');
  }
  for (const good of ['kjv', 'KJV-1769', 'web_2020', 'asv']) {
    expectOk(validPackage({ translation: { id: good } as never }));
  }
});

test('language defaults to English rather than failing', () => {
  const result = expectOk({
    translation: { id: 'x', abbreviation: 'X', name: 'X', license: 'Public domain' },
    books: [{ number: 1, chapters: [['a']] }],
  });
  assert.equal(result.value.translation.language, 'en');

  // And an explicit language is kept.
  const french = expectOk(validPackage({ translation: { language: 'fr' } as never }));
  assert.equal(french.value.translation.language, 'fr');
});

// ── books ───────────────────────────────────────────────────────────────────────

test('a book may be identified by canonical number or by name', () => {
  const byNumber = expectOk(validPackage({ books: [{ number: 43, chapters: [['a']] }] }));
  assert.equal(byNumber.value.books[0]?.meta.name, 'John');

  const byName = expectOk(validPackage({ books: [{ name: 'John', chapters: [['a']] }] }));
  assert.equal(byName.value.books[0]?.meta.number, 43);

  // Any accepted alias works, so a third-party dataset usually imports unmodified.
  const byAlias = expectOk(validPackage({ books: [{ name: '1Jn', chapters: [['a']] }] }));
  assert.equal(byAlias.value.books[0]?.meta.name, '1 John');
});

test('an unrecognised or out-of-range book is refused', () => {
  expectProblem(validPackage({ books: [{ number: 0, chapters: [['a']] }] }), 'books[0].number');
  expectProblem(validPackage({ books: [{ number: 67, chapters: [['a']] }] }), 'books[0].number');
  expectProblem(validPackage({ books: [{ name: 'Book of Mormon', chapters: [['a']] }] }), 'books[0].name');
  expectProblem(validPackage({ books: [{ chapters: [['a']] }] }), 'books[0]');
});

test('a duplicated book is refused rather than silently overwriting', () => {
  const message = expectProblem(
    validPackage({
      books: [
        { number: 43, chapters: [['a']] },
        { number: 43, chapters: [['b']] },
      ],
    }),
    'books[1]',
  );
  assert.match(message, /John appears more than once/);
});

test('BOOKS COME OUT IN CANONICAL ORDER WHATEVER ORDER THE FILE USED', () => {
  // Otherwise the operator's book list is shuffled according to how a dataset happened to be built.
  const result = expectOk(
    validPackage({
      books: [
        { number: 66, chapters: [['a']] },
        { number: 1, chapters: [['b']] },
        { number: 40, chapters: [['c']] },
      ],
    }),
  );
  assert.deepEqual(result.value.books.map((book) => book.meta.name), ['Genesis', 'Matthew', 'Revelation']);
});

test('a package may keep its own book names, for a non-English edition', () => {
  const result = expectOk(validPackage({ books: [{ number: 1, name: 'Genèse', chapters: [['a']] }] }));
  // The canonical identity is resolved, but the supplied label is kept for display.
  assert.equal(result.value.books[0]?.meta.number, 1);
  assert.equal(result.value.books[0]?.name, 'Genèse');
});

// ── verse text ──────────────────────────────────────────────────────────────────

test('verse text is normalised once, at import', () => {
  // Scraped datasets carry line breaks and runs of spaces. Cleaning here means the stored text is
  // already correct and every consumer agrees, rather than each render guessing.
  const result = expectOk(
    validPackage({ books: [{ number: 43, chapters: [['  For   God\n\tso loved   the world  ']] }] }),
  );
  assert.equal(result.value.books[0]?.chapters[0]?.[0], 'For God so loved the world');
});

test('non-string verse text is refused', () => {
  expectProblem(validPackage({ books: [{ number: 43, chapters: [[42 as never]] }] }), 'chapters[0][0]');
  expectProblem(validPackage({ books: [{ number: 43, chapters: [[null as never]] }] }), 'chapters[0][0]');
});

test('an empty verse is a warning, not a refusal', () => {
  // Some editions genuinely omit a verse. Rejecting a whole translation over one blank line would be
  // unhelpful, but the operator should still be told.
  const result = expectOk(validPackage({ books: [{ number: 43, chapters: [['first', '', 'third']] }] }));
  assert.equal(result.warnings.some((warning) => /is empty/.test(warning.message)), true);
  assert.equal(result.value.verseCount, 3, 'and it still occupies its verse number');
});

test('structurally empty books and chapters are refused', () => {
  expectProblem(validPackage({ books: [{ number: 43, chapters: [] }] }), 'chapters');
  expectProblem(validPackage({ books: [{ number: 43, chapters: [[]] }] }), 'chapters[0]');
  expectProblem(validPackage({ books: [] }), 'books');
});

test('IMPLAUSIBLE SIZES ARE REFUSED SO A BAD FILE CANNOT EXHAUST MAIN', () => {
  /*
   * Import runs in the main process — the one driving the projector. A hostile or corrupt file must
   * fail fast rather than being loaded in full first.
   */
  expectProblem(
    validPackage({ books: [{ number: 43, chapters: [['x'.repeat(6_000)]] }] }),
    'chapters[0][0]',
  );
  expectProblem(
    validPackage({ books: [{ number: 43, chapters: Array.from({ length: 200 }, () => ['a']) }] }),
    'chapters',
  );
  expectProblem(
    validPackage({ books: [{ number: 43, chapters: [Array.from({ length: 300 }, () => 'a')] }] }),
    'chapters[0]',
  );
});

// ── counting and reporting ──────────────────────────────────────────────────────

test('the verse count is reported so the operator can sanity-check an import', () => {
  const result = expectOk(
    validPackage({
      books: [
        { number: 43, chapters: [['a', 'b', 'c'], ['d', 'e']] },
        { number: 45, chapters: [['f']] },
      ],
    }),
  );
  assert.equal(result.value.verseCount, 6);
});

test('a partial translation is allowed but flagged', () => {
  // A New Testament, or one book for testing, is legitimate — but the operator must know before they
  // rely on it mid-service.
  const result = expectOk(validPackage({ books: [{ number: 43, chapters: [['a']] }] }));
  const warning = result.warnings.find((entry) => /1 of 66 books/.test(entry.message));
  assert.ok(warning, `expected a partial-canon warning, got ${JSON.stringify(result.warnings)}`);
  assert.match(warning.message, /will not be found/, 'and says what the consequence is');
});

test('a complete canon produces no partial warning', () => {
  const result = expectOk(
    validPackage({ books: Array.from({ length: 66 }, (_, index) => ({ number: index + 1, chapters: [['a']] })) }),
  );
  assert.equal(result.warnings.some((entry) => /of 66 books/.test(entry.message)), false);
});

test('problems are collected, not thrown one at a time', () => {
  // An operator fixing a hand-made package wants the list, not a game of whack-a-mole.
  const result = validateBiblePackage({
    translation: { id: '', abbreviation: '', name: '' },
    books: [{ number: 999, chapters: [] }],
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.problems.length >= 4, `expected several problems, got ${String(result.problems.length)}`);
});

// ── the JSON wrapper ────────────────────────────────────────────────────────────

test('a JSON syntax error is reported in the same shape as a validation problem', () => {
  const result = parseBiblePackage('{ "translation": ');
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.problems[0]?.message ?? '', /not valid JSON/);
});

test('non-object top-level input is refused clearly', () => {
  for (const input of ['[]', '"a string"', '42', 'null']) {
    const result = parseBiblePackage(input);
    assert.equal(result.ok, false, input);
  }
});

test('a round trip through JSON validates identically', () => {
  const source = validPackage();
  const direct = expectOk(source);
  const viaJson = parseBiblePackage(JSON.stringify(source));
  assert.ok(viaJson.ok);
  assert.deepEqual(viaJson.value, direct.value);
});


// ── the shipped sample ──────────────────────────────────────────────────────────

test('THE SHIPPED SAMPLE PACKAGE VALIDATES, AND CONTAINS NO SCRIPTURE', () => {
  /*
   * `resources/sample-translation.json` exists so the import path and the Bible workspace can be
   * verified without publishing anyone's translation. Two things must stay true, and a sample that
   * silently stopped working would be worse than none at all:
   *
   *   1. it validates against the real validator;
   *   2. it contains NO scripture — every "verse" says so in plain words.
   */
  const raw = readFileSync(join(process.cwd(), 'resources', 'sample-translation.json'), 'utf8');
  const result = parseBiblePackage(raw);

  assert.ok(result.ok, `the sample must validate, got: ${result.ok ? '' : JSON.stringify(result.problems)}`);
  assert.match(result.value.translation.name, /not scripture/i, 'the name says what it is');

  for (const book of result.value.books) {
    for (const chapter of book.chapters) {
      for (const text of chapter) {
        assert.match(
          text,
          /NOT SCRIPTURE/,
          'every verse must declare itself placeholder text, so it can never be mistaken for a reading',
        );
      }
    }
  }
});

test('the sample resolves every reference the documentation offers as an example', () => {
  // docs/BIBLE.md tells the operator to try these. If the sample stopped covering them, the first
  // thing anyone did with the Bible section would fail.
  const raw = readFileSync(join(process.cwd(), 'resources', 'sample-translation.json'), 'utf8');
  const result = parseBiblePackage(raw);
  assert.ok(result.ok);

  const chapters = new Map(
    result.value.books.map((book) => [book.meta.number, book.chapters] as const),
  );

  // John 3:16 and the whole of John 3.
  assert.equal(chapters.get(43)?.[2]?.length, 21, 'John 3 has 21 verses');
  // Psalm 23:1-6 — the classic example, which needs the psalm at chapter 23, not chapter 1.
  assert.equal(chapters.get(19)?.length, 23, 'Psalms runs to chapter 23');
  assert.equal(chapters.get(19)?.[22]?.length, 6, 'Psalm 23 has 6 verses');
  // Jude 3, exercising the single-chapter rule.
  assert.equal(chapters.get(65)?.length, 1, 'Jude has one chapter');
  assert.ok((chapters.get(65)?.[0]?.length ?? 0) >= 3, 'and at least 3 verses');
});
