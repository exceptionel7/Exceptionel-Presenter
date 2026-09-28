import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { validateBiblePackage, type ValidatedPackage } from '../src/shared/domain/bible-package.ts';
import { parseReference, type ParsedReference } from '../src/shared/domain/bible-reference.ts';

/**
 * EXCEPTIONEL PRESENTER — Bible storage, lookup and search, against real SQLite.
 *
 * Nothing is mocked: real migrations, the real `WITHOUT ROWID` verse table, the real FTS5 index.
 *
 * NO REAL SCRIPTURE APPEARS IN THIS FILE. The verse text below is obviously synthetic placeholder
 * prose. That is deliberate and it is the same rule the application follows: translations are under
 * copyright with few exceptions, so none is bundled — not in the product and not in its tests.
 * Structure is what is being tested here, and structure does not need real verses.
 */

const withDb = (fn: (db: AppDatabase) => void): void => {
  const db = openDatabase({ path: ':memory:' });
  try {
    fn(db);
  } finally {
    db.close();
  }
};

/** Synthetic text, deliberately unmistakable for scripture. */
const verseText = (book: number, chapter: number, verse: number): string =>
  `Placeholder line for book ${String(book)} chapter ${String(chapter)} verse ${String(verse)}`;

const pkg = (options: {
  id?: string;
  abbreviation?: string;
  name?: string;
  license?: string;
  books?: { number: number; name?: string; chapters: string[][] }[];
} = {}): ValidatedPackage => {
  const result = validateBiblePackage({
    translation: {
      id: options.id ?? 'sample',
      abbreviation: options.abbreviation ?? 'SMP',
      name: options.name ?? 'Sample Edition',
      language: 'en',
      license: options.license ?? 'Public domain',
    },
    books:
      options.books ??
      [
        {
          number: 43, // John
          chapters: [
            Array.from({ length: 5 }, (_, index) => verseText(43, 1, index + 1)),
            Array.from({ length: 4 }, (_, index) => verseText(43, 2, index + 1)),
            Array.from({ length: 21 }, (_, index) => verseText(43, 3, index + 1)),
          ],
        },
        {
          number: 19, // Psalms
          chapters: [Array.from({ length: 6 }, (_, index) => verseText(19, 1, index + 1))],
        },
      ],
  });
  assert.ok(result.ok, 'the test fixture must itself be a valid package');
  return result.value;
};

const ref = (input: string): ParsedReference => {
  const parsed = parseReference(input);
  assert.ok(parsed.ok, `fixture reference "${input}" must parse`);
  return parsed.reference;
};

// ── installation ────────────────────────────────────────────────────────────────

test('A TRANSLATION INSTALLS WITH ITS LICENCE RECORDED VERBATIM', () => {
  withDb((db) => {
    const licence = 'Public domain in the United States; Crown copyright in the United Kingdom.';
    const installed = db.bible.install(pkg({ license: licence }));

    assert.equal(installed.id, 'sample');
    assert.equal(installed.abbreviation, 'SMP');
    // Kept exactly as supplied: this is the attribution the operator is relying on.
    assert.equal(installed.license, licence);
    assert.equal(installed.verseCount, 36);
    assert.ok(installed.installedAt, 'and the install is timestamped');

    assert.deepEqual(db.bible.listTranslations().map((entry) => entry.id), ['sample']);
  });
});

test('a fresh library has no translations, and says so rather than pretending', () => {
  withDb((db) => {
    assert.deepEqual(db.bible.listTranslations(), []);
    assert.equal(db.bible.defaultTranslation(), null);
    assert.equal(db.bible.getTranslation('sample'), null);
  });
});

test('books are stored in canonical order with real chapter counts', () => {
  withDb((db) => {
    db.bible.install(pkg());
    const books = db.bible.listBooks('sample');

    // Psalms (19) before John (43), whatever order the package listed them in.
    assert.deepEqual(books.map((book) => book.bookNumber), [19, 43]);
    assert.equal(books[0]?.name, 'Psalms');
    assert.equal(books[1]?.chapterCount, 3);
  });
});

test('a package may use its own book names', () => {
  withDb((db) => {
    db.bible.install(pkg({ books: [{ number: 1, name: 'Genèse', chapters: [['un']] }] }));
    assert.equal(db.bible.listBooks('sample')[0]?.name, 'Genèse');
  });
});

test('REINSTALLING REPLACES OUTRIGHT RATHER THAN MERGING', () => {
  /*
   * A partial reinstall would be worse than either state: the verse table and the FTS index would
   * disagree, so a search would return hits whose text no longer existed.
   */
  withDb((db) => {
    db.bible.install(pkg());
    assert.equal(db.bible.getTranslation('sample')?.verseCount, 36);

    db.bible.install(pkg({ books: [{ number: 43, chapters: [['only one verse now']] }] }));

    const after = db.bible.getTranslation('sample');
    assert.equal(after?.verseCount, 1);
    assert.deepEqual(db.bible.listBooks('sample').map((book) => book.bookNumber), [43], 'Psalms is gone');

    // And the old text is gone from search, not lingering as a phantom hit.
    assert.deepEqual(db.bible.search('sample', 'Placeholder'), []);
  });
});

test('removing a translation takes its verses and its search index with it', () => {
  withDb((db) => {
    db.bible.install(pkg());
    assert.ok(db.bible.search('sample', 'Placeholder').length > 0);

    db.bible.removeTranslation('sample');

    assert.deepEqual(db.bible.listTranslations(), []);
    assert.deepEqual(db.bible.listBooks('sample'), []);
    assert.deepEqual(db.bible.search('sample', 'Placeholder'), [], 'the FTS trigger cleaned up');
  });
});

test('two translations coexist without bleeding into each other', () => {
  withDb((db) => {
    db.bible.install(pkg({ id: 'first', abbreviation: 'FST', name: 'First Edition' }));
    db.bible.install(
      pkg({
        id: 'second',
        abbreviation: 'SND',
        name: 'Second Edition',
        books: [{ number: 43, chapters: [['second edition wording']] }],
      }),
    );

    assert.equal(db.bible.listTranslations().length, 2);
    assert.equal(db.bible.getTranslation('first')?.verseCount, 36);
    assert.equal(db.bible.getTranslation('second')?.verseCount, 1);

    // A search in one must not return the other's text.
    assert.deepEqual(db.bible.search('second', 'Placeholder'), []);
    assert.equal(db.bible.search('first', 'Placeholder').length > 0, true);

    db.bible.removeTranslation('first');
    assert.equal(db.bible.getTranslation('second')?.verseCount, 1, 'the survivor is untouched');
  });
});

// ── lookup ──────────────────────────────────────────────────────────────────────

test('A SINGLE VERSE RESOLVES TO ITS TEXT AND ITS NORMALISED REFERENCE', () => {
  withDb((db) => {
    db.bible.install(pkg());
    const result = db.bible.lookup('sample', ref('John 3:16'));

    assert.ok(result.ok);
    assert.equal(result.passage.reference, 'John 3:16');
    assert.equal(result.passage.bookName, 'John');
    assert.equal(result.passage.chapter, 3);
    assert.equal(result.passage.startVerse, 16);
    assert.equal(result.passage.endVerse, 16);
    assert.equal(result.passage.verses.length, 1);
    assert.equal(result.passage.verses[0]?.text, verseText(43, 3, 16));
    assert.deepEqual(result.passage.missingVerses, []);
  });
});

test('a verse range resolves in order', () => {
  withDb((db) => {
    db.bible.install(pkg());
    const result = db.bible.lookup('sample', ref('John 3:16-18'));

    assert.ok(result.ok);
    assert.deepEqual(result.passage.verses.map((verse) => verse.verse), [16, 17, 18]);
    assert.equal(result.passage.reference, 'John 3:16-18');
  });
});

test('A WHOLE CHAPTER RESOLVES TO EVERY VERSE PRESENT, NOT AN ASSUMED LENGTH', () => {
  /*
   * `startVerse === null` is how the parser records "John 3" as distinct from "John 3:1". Chapter
   * length varies between translations, so it is read from the installed text rather than a table.
   */
  withDb((db) => {
    db.bible.install(pkg());
    const result = db.bible.lookup('sample', ref('John 3'));

    assert.ok(result.ok);
    assert.equal(result.passage.verses.length, 21);
    assert.equal(result.passage.startVerse, 1);
    assert.equal(result.passage.endVerse, 21);
    assert.equal(result.passage.reference, 'John 3');
  });
});

test('a single psalm is reported in the singular', () => {
  withDb((db) => {
    db.bible.install(pkg());
    const result = db.bible.lookup('sample', ref('Psalm 1:1-6'));
    assert.ok(result.ok);
    assert.equal(result.passage.reference, 'Psalm 1:1-6');
    assert.equal(result.passage.bookName, 'Psalms', 'the book keeps its plural name');
  });
});

test('MISSING VERSES INSIDE A RANGE ARE REPORTED, NOT QUIETLY OMITTED', () => {
  /*
   * Asking for John 1:1-10 in a translation that has five verses must not silently present five as
   * though ten had been found. Some editions genuinely omit verses, and the operator needs to know
   * before it is read aloud.
   */
  withDb((db) => {
    db.bible.install(pkg());
    const result = db.bible.lookup('sample', ref('John 1:3-8'));

    assert.ok(result.ok);
    assert.deepEqual(result.passage.verses.map((verse) => verse.verse), [3, 4, 5]);
    assert.deepEqual(result.passage.missingVerses, [6, 7, 8]);
  });
});

test('every way a lookup can fail is named distinctly', () => {
  withDb((db) => {
    db.bible.install(pkg());

    const noTranslation = db.bible.lookup('nope', ref('John 3:16'));
    assert.equal(noTranslation.ok, false);
    assert.ok(!noTranslation.ok);
    assert.equal(noTranslation.code, 'no-translation');

    // A book the package did not include. Well-formed reference, absent text — a different problem
    // from a malformed reference, with a different remedy.
    const bookMissing = db.bible.lookup('sample', ref('Romans 8:28'));
    assert.ok(!bookMissing.ok);
    assert.equal(bookMissing.code, 'book-missing');
    assert.match(bookMissing.message, /SMP does not include Romans/);

    const chapterMissing = db.bible.lookup('sample', ref('John 9:1'));
    assert.ok(!chapterMissing.ok);
    assert.equal(chapterMissing.code, 'chapter-missing');
    assert.match(chapterMissing.message, /3 chapters in SMP/);

    const versesMissing = db.bible.lookup('sample', ref('John 1:40'));
    assert.ok(!versesMissing.ok);
    assert.equal(versesMissing.code, 'verses-missing');
    assert.match(versesMissing.message, /John 1:40 is not in SMP/);
  });
});

test('a well-formed reference to absent text is a lookup failure, not a parse failure', () => {
  // The parser is syntactic and knows nothing about what is installed. Keeping the two apart is what
  // lets the UI say "that translation does not have Romans" instead of "bad reference".
  assert.equal(parseReference('Romans 8:28').ok, true);
  withDb((db) => {
    db.bible.install(pkg());
    assert.equal(db.bible.lookup('sample', ref('Romans 8:28')).ok, false);
  });
});

// ── chapter and verse counts for the UI ─────────────────────────────────────────

test('VERSE COUNTS COME FROM THE INSTALLED TEXT, SO THE UI OFFERS ONLY REAL VERSES', () => {
  withDb((db) => {
    db.bible.install(pkg());
    // John: 5, 4 and 21 verses across three chapters.
    assert.deepEqual(db.bible.chapterVerseCounts('sample', 43), [5, 4, 21]);
    assert.deepEqual(db.bible.chapterVerseCounts('sample', 19), [6]);
    // A book that is not installed reports nothing rather than guessing.
    assert.deepEqual(db.bible.chapterVerseCounts('sample', 45), []);
  });
});

test('chapter counts are indexed by chapter number, so chapter N is always at index N-1', () => {
  /*
   * The array is built by assigning at `chapter - 1` rather than by pushing, so a missing chapter
   * cannot shift every later one down by a place — which would make the UI offer chapter 3's verse
   * count under chapter 2's heading.
   *
   * A genuine gap cannot arise through `install`, since a package supplies chapters as a contiguous
   * array. The zero-fill in `chapterVerseCounts` is therefore defensive, against a hand-edited
   * database; what is asserted here is the indexing, which the importer can and does exercise.
   */
  withDb((db) => {
    db.bible.install(
      pkg({ books: [{ number: 43, chapters: [['a'], ['b', 'c'], ['d', 'e', 'f']] }] }),
    );
    assert.deepEqual(db.bible.chapterVerseCounts('sample', 43), [1, 2, 3]);
  });
});

test('a directly inserted gap reads as zero rather than shifting later chapters', () => {
  // The defensive path above, exercised the only way it can be: by writing the gap directly, as a
  // corrupt or hand-edited library would present it.
  withDb((db) => {
    db.bible.install(pkg({ books: [{ number: 43, chapters: [['a']] }] }));
    db.driver
      .prepare('INSERT INTO bible_verses (translation_id, book_number, chapter, verse, text) VALUES (?, ?, ?, ?, ?)')
      .run('sample', 43, 3, 1, 'chapter three, with chapter two absent');

    const counts = db.bible.chapterVerseCounts('sample', 43);
    assert.equal(counts.length, 3);
    assert.equal(counts[0], 1);
    assert.equal(counts[1], 0, 'the absent chapter reads as zero');
    assert.equal(counts[2], 1, 'and chapter 3 stays at index 2');
  });
});

// ── search ──────────────────────────────────────────────────────────────────────

test('SEARCH FINDS VERSES AND RETURNS USABLE REFERENCES', () => {
  withDb((db) => {
    db.bible.install(
      pkg({
        books: [
          {
            number: 43,
            chapters: [['the shepherd leads', 'unrelated wording', 'the shepherd calls']],
          },
        ],
      }),
    );

    const hits = db.bible.search('sample', 'shepherd');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((hit) => hit.reference).sort(), ['John 1:1', 'John 1:3']);
    assert.equal(hits[0]?.bookName, 'John');
    // The text comes back so the operator can recognise the verse without a second lookup.
    assert.match(hits[0]?.text ?? '', /shepherd/);
  });
});

test('search is diacritic-insensitive and case-insensitive', () => {
  withDb((db) => {
    db.bible.install(pkg({ books: [{ number: 43, chapters: [['Wörd with an umlaut']] }] }));
    assert.equal(db.bible.search('sample', 'word').length, 1, 'remove_diacritics is configured');
    assert.equal(db.bible.search('sample', 'WÖRD').length, 1);
  });
});

test('an empty or punctuation-only query returns nothing rather than everything', () => {
  withDb((db) => {
    db.bible.install(pkg());
    for (const query of ['', '   ', '***', '""']) {
      assert.deepEqual(db.bible.search('sample', query), [], JSON.stringify(query));
    }
  });
});

test('search results are bounded so a common word cannot stall the interface', () => {
  withDb((db) => {
    db.bible.install(
      pkg({
        books: [{ number: 19, chapters: [Array.from({ length: 120 }, () => 'common word here')] }],
      }),
    );

    assert.equal(db.bible.search('sample', 'common').length, 50, 'the default limit');
    assert.equal(db.bible.search('sample', 'common', 10).length, 10);
    // A caller asking for more than the ceiling gets the ceiling, not the whole table.
    assert.equal(db.bible.search('sample', 'common', 10_000).length, 120);
    assert.equal(db.bible.search('sample', 'common', 0).length, 1, 'a nonsense limit is clamped upward');
  });
});

test('a search that matches nothing returns an empty list, not an error', () => {
  withDb((db) => {
    db.bible.install(pkg());
    assert.deepEqual(db.bible.search('sample', 'zzzznotpresent'), []);
  });
});

// ── the default translation ─────────────────────────────────────────────────────

test('the default translation is deterministic, not whichever was installed last', () => {
  withDb((db) => {
    db.bible.install(pkg({ id: 'zed', abbreviation: 'ZED', name: 'Zed Edition' }));
    db.bible.install(pkg({ id: 'alpha', abbreviation: 'ALP', name: 'Alpha Edition' }));
    // Ordered by name, so the operator's list and the default agree.
    assert.equal(db.bible.defaultTranslation()?.id, 'alpha');
  });
});
