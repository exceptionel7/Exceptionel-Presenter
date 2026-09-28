/**
 * EXCEPTIONEL PRESENTER — Bible translations, passages and search (Phase 4).
 *
 * NO SCRIPTURE SHIPS WITH THIS APPLICATION. A translation arrives as a package whose licence the
 * operator supplies, `bible_translations.license` is `NOT NULL`, and the validator in
 * shared/domain/bible-package.ts refuses a package that states no terms. See docs/BIBLE.md.
 *
 * TRANSLATIONS ARE LOCAL INSTALLATIONS, NOT SYNCED LIBRARY CONTENT. Migration 0003 deliberately gave
 * these tables no `revision`, `origin_device_id` or `deleted_at`, and this repository records no sync
 * operations. A whole Bible is around 31,000 rows and several megabytes; pushing that through the
 * change log would swamp it to replicate something every machine can reinstall from its source. The
 * consequence is stated plainly rather than hidden: installing a translation on the booth machine does
 * not install it on the office machine.
 *
 * Deletes here are REAL deletes, for the same reason. There is nothing to tombstone.
 */

import { bookByNumber, type BibleBookMeta } from '../../../shared/domain/bible.ts';
import type { BibleTranslation } from '../../../shared/domain/entities.ts';
import {
  formatReference,
  type ParsedReference,
} from '../../../shared/domain/bible-reference.ts';
import type { ValidatedPackage } from '../../../shared/domain/bible-package.ts';
import type { SqliteDriver } from '../driver.ts';
import { asInt, asText, asTextOrNull, ftsQuery } from './support.ts';

/*
 * `BibleTranslation` comes from shared/domain/entities.ts rather than being redeclared here.
 *
 * The same reasoning as the theme spec: a second definition of the same record is a guarantee that the
 * two eventually disagree, and the renderer — which cannot import from main — would be reading one
 * while this file wrote the other.
 */
export type { BibleTranslation } from '../../../shared/domain/entities.ts';

export interface BibleBookSummary {
  bookNumber: number;
  name: string;
  abbreviation: string;
  chapterCount: number;
}

export interface BibleVerse {
  bookNumber: number;
  chapter: number;
  verse: number;
  text: string;
}

/**
 * A resolved passage: the reference, and the verses that actually exist for it.
 *
 * `reference` is the normalised display string and `verses` is what was found. They are separate
 * because a well-formed reference can ask for verses a translation does not have, and the caller must
 * be able to tell the difference between "John 3:16" and "John 3:16-99, of which 21 exist".
 */
export interface BiblePassage {
  translation: BibleTranslation;
  book: BibleBookMeta;
  /** Book name as this translation calls it, which may not be the canonical English. */
  bookName: string;
  chapter: number;
  startVerse: number;
  endVerse: number;
  reference: string;
  verses: BibleVerse[];
  /** Verses inside the requested range that the translation does not contain. */
  missingVerses: number[];
}

export interface BibleSearchHit {
  translationId: string;
  bookNumber: number;
  bookName: string;
  chapter: number;
  verse: number;
  text: string;
  reference: string;
}

export type PassageLookup =
  | { ok: true; passage: BiblePassage }
  | { ok: false; code: 'no-translation'; message: string }
  | { ok: false; code: 'book-missing'; message: string }
  | { ok: false; code: 'chapter-missing'; message: string }
  | { ok: false; code: 'verses-missing'; message: string };

export interface BibleRepository {
  listTranslations(): BibleTranslation[];
  getTranslation(id: string): BibleTranslation | null;
  /** The translation to use when the operator has not chosen one. */
  defaultTranslation(): BibleTranslation | null;
  /** Installs (or replaces) a validated package. Returns the stored translation. */
  install(pkg: ValidatedPackage): BibleTranslation;
  removeTranslation(id: string): void;
  listBooks(translationId: string): BibleBookSummary[];
  /** Verse count per chapter, so the UI can offer real choices rather than guesses. */
  chapterVerseCounts(translationId: string, bookNumber: number): number[];
  lookup(translationId: string, reference: ParsedReference): PassageLookup;
  search(translationId: string, query: string, limit?: number): BibleSearchHit[];
}

/** Bound on a search result set: enough to choose from, not enough to stall the UI. */
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

export function createBibleRepository(db: SqliteDriver): BibleRepository {
  const toTranslation = (row: Record<string, unknown>): BibleTranslation => ({
    id: asText((row['id'] ?? null) as never),
    abbreviation: asText((row['abbreviation'] ?? null) as never),
    name: asText((row['name'] ?? null) as never),
    language: asText((row['language'] ?? null) as never),
    license: asText((row['license'] ?? null) as never),
    sourceUrl: asTextOrNull((row['source_url'] ?? null) as never),
    // Only installed translations are ever read back, but the field is part of the record and is
    // carried honestly rather than being invented at the edge.
    installState: 'installed',
    verseCount: asInt((row['verse_count'] ?? null) as never),
    installedAt: asTextOrNull((row['installed_at'] ?? null) as never),
  });

  const TRANSLATION_COLUMNS =
    'id, abbreviation, name, language, license, source_url, verse_count, installed_at';

  /*
   * A plain local function rather than a method on the returned object.
   *
   * Several other functions here need it, and reaching it as `this.getTranslation()` would silently
   * lose its binding the moment anything destructured the repository — `const { lookup } = db.bible`
   * is a reasonable thing to write and would throw at the worst possible moment.
   */
  const getTranslation = (id: string): BibleTranslation | null => {
    const row = db
      .prepare(
        `SELECT ${TRANSLATION_COLUMNS} FROM bible_translations
         WHERE id = ? AND install_state = 'installed'`,
      )
      .get(id);
    return row ? toTranslation(row) : null;
  };

  const listTranslations = (): BibleTranslation[] =>
    db
      .prepare(
        `SELECT ${TRANSLATION_COLUMNS} FROM bible_translations
         WHERE install_state = 'installed'
         ORDER BY name COLLATE NOCASE`,
      )
      .all()
      .map(toTranslation);

  /** The name this translation uses for a book, falling back to the canonical English. */
  const bookNameIn = (translationId: string, bookNumber: number): string => {
    const row = db
      .prepare('SELECT name FROM bible_books WHERE translation_id = ? AND book_number = ?')
      .get(translationId, bookNumber);
    return row ? asText((row['name'] ?? null) as never) : (bookByNumber(bookNumber)?.name ?? '');
  };

  return {
    listTranslations,
    getTranslation,

    defaultTranslation: () => listTranslations()[0] ?? null,

    install(pkg) {
      return db.transaction(() => {
        /*
         * Replaces any existing installation of the same id outright.
         *
         * A partial reinstall would be worse than either state: the FTS index and the verse table
         * would disagree, so a search would return hits whose text no longer existed. The ON DELETE
         * CASCADE on books and verses plus the delete trigger on the FTS table make this clean.
         */
        db.prepare('DELETE FROM bible_translations WHERE id = ?').run(pkg.translation.id);

        db.prepare(
          `INSERT INTO bible_translations
             (id, abbreviation, name, language, license, source_url, install_state, verse_count, installed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'installed', ?, ?)`,
        ).run(
          pkg.translation.id,
          pkg.translation.abbreviation,
          pkg.translation.name,
          pkg.translation.language,
          pkg.translation.license,
          pkg.translation.sourceUrl,
          pkg.verseCount,
          new Date().toISOString(),
        );

        const insertBook = db.prepare(
          `INSERT INTO bible_books (id, translation_id, book_number, name, abbreviation, chapter_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const insertVerse = db.prepare(
          `INSERT INTO bible_verses (translation_id, book_number, chapter, verse, text)
           VALUES (?, ?, ?, ?, ?)`,
        );
        const insertFts = db.prepare(
          `INSERT INTO bible_verses_fts (translation_id, book_number, chapter, verse, text)
           VALUES (?, ?, ?, ?, ?)`,
        );

        for (const book of pkg.books) {
          insertBook.run(
            `${pkg.translation.id}_${String(book.meta.number)}`,
            pkg.translation.id,
            book.meta.number,
            book.name,
            book.abbreviation,
            book.chapters.length,
          );

          book.chapters.forEach((verses, chapterIndex) => {
            verses.forEach((text, verseIndex) => {
              const chapter = chapterIndex + 1;
              const verse = verseIndex + 1;
              insertVerse.run(pkg.translation.id, book.meta.number, chapter, verse, text);
              insertFts.run(pkg.translation.id, book.meta.number, chapter, verse, text);
            });
          });
        }

        const stored = getTranslation(pkg.translation.id);
        if (!stored) throw new Error(`translation ${pkg.translation.id} vanished immediately after install`);
        return stored;
      });
    },

    removeTranslation(id) {
      // A real delete, not a tombstone: there is nothing to replicate, and the text is reinstallable
      // from its source. Books and verses cascade; the FTS rows go with the trigger from 0001.
      db.transaction(() => {
        db.prepare('DELETE FROM bible_translations WHERE id = ?').run(id);
      });
    },

    listBooks(translationId) {
      return db
        .prepare(
          `SELECT book_number, name, abbreviation, chapter_count FROM bible_books
           WHERE translation_id = ?
           ORDER BY book_number`,
        )
        .all(translationId)
        .map((row) => ({
          bookNumber: asInt((row['book_number'] ?? null) as never),
          name: asText((row['name'] ?? null) as never),
          abbreviation: asText((row['abbreviation'] ?? null) as never),
          chapterCount: asInt((row['chapter_count'] ?? null) as never),
        }));
    },

    chapterVerseCounts(translationId, bookNumber) {
      /*
       * Real counts from the installed text, so the operator's verse selector offers only verses that
       * exist. Guessing from a hard-coded table would eventually disagree with some translation's
       * versification and offer a verse that comes back empty.
       */
      const rows = db
        .prepare(
          `SELECT chapter, COUNT(*) AS n FROM bible_verses
           WHERE translation_id = ? AND book_number = ?
           GROUP BY chapter
           ORDER BY chapter`,
        )
        .all(translationId, bookNumber);

      const counts: number[] = [];
      for (const row of rows) {
        // Indexed by chapter number so a gap (a translation missing a chapter) reads as 0 rather than
        // shifting every later chapter by one.
        counts[asInt((row['chapter'] ?? null) as never) - 1] = asInt((row['n'] ?? null) as never);
      }
      for (let index = 0; index < counts.length; index += 1) counts[index] ??= 0;
      return counts;
    },

    lookup(translationId, reference) {
      const translation = getTranslation(translationId);
      if (!translation) {
        return {
          ok: false,
          code: 'no-translation',
          message: 'That translation is not installed.',
        };
      }

      const book = reference.book;
      const bookRow = db
        .prepare('SELECT chapter_count FROM bible_books WHERE translation_id = ? AND book_number = ?')
        .get(translationId, book.number);

      if (!bookRow) {
        return {
          ok: false,
          code: 'book-missing',
          message: `${translation.abbreviation} does not include ${book.name}.`,
        };
      }

      const chapterCount = asInt((bookRow['chapter_count'] ?? null) as never);
      if (reference.chapter > chapterCount) {
        return {
          ok: false,
          code: 'chapter-missing',
          message: `${book.name} has ${String(chapterCount)} chapter${chapterCount === 1 ? '' : 's'} in ${translation.abbreviation}.`,
        };
      }

      /*
       * A whole-chapter reference resolves to every verse present, rather than assuming a length.
       * `startVerse === null` is how the parser records "Romans 8" as distinct from "Romans 8:1".
       */
      const wholeChapter = reference.startVerse === null;
      const rows = wholeChapter
        ? db
            .prepare(
              `SELECT book_number, chapter, verse, text FROM bible_verses
               WHERE translation_id = ? AND book_number = ? AND chapter = ?
               ORDER BY verse`,
            )
            .all(translationId, book.number, reference.chapter)
        : db
            .prepare(
              `SELECT book_number, chapter, verse, text FROM bible_verses
               WHERE translation_id = ? AND book_number = ? AND chapter = ?
                 AND verse BETWEEN ? AND ?
               ORDER BY verse`,
            )
            .all(
              translationId,
              book.number,
              reference.chapter,
              reference.startVerse,
              reference.endVerse ?? reference.startVerse,
            );

      const verses: BibleVerse[] = rows.map((row) => ({
        bookNumber: asInt((row['book_number'] ?? null) as never),
        chapter: asInt((row['chapter'] ?? null) as never),
        verse: asInt((row['verse'] ?? null) as never),
        text: asText((row['text'] ?? null) as never),
      }));

      if (verses.length === 0) {
        return {
          ok: false,
          code: 'verses-missing',
          message: `${formatReference(reference)} is not in ${translation.abbreviation}.`,
        };
      }

      const startVerse = verses[0]!.verse;
      const endVerse = verses[verses.length - 1]!.verse;

      /*
       * Verses inside the requested range that are absent.
       *
       * Reported rather than ignored: asking for John 3:16-20 in a translation that omits verse 18
       * should not silently present four verses as though five had been found.
       */
      const missingVerses: number[] = [];
      if (!wholeChapter) {
        const present = new Set(verses.map((entry) => entry.verse));
        for (let verse = reference.startVerse!; verse <= (reference.endVerse ?? reference.startVerse!); verse += 1) {
          if (!present.has(verse)) missingVerses.push(verse);
        }
      }

      return {
        ok: true,
        passage: {
          translation,
          book,
          bookName: bookNameIn(translationId, book.number),
          chapter: reference.chapter,
          startVerse,
          endVerse,
          reference: formatReference(reference),
          verses,
          missingVerses,
        },
      };
    },

    search(translationId, query, limit = DEFAULT_SEARCH_LIMIT) {
      const match = ftsQuery(query);
      if (match === '') return [];

      const bounded = Math.min(Math.max(limit, 1), MAX_SEARCH_LIMIT);

      /*
       * `translation_id` is an UNINDEXED column on the FTS table, so it filters after matching rather
       * than narrowing the index. That is the right trade here: the alternative is one FTS table per
       * translation, and a church has one or two installed, not fifty.
       */
      const rows = db
        .prepare(
          `SELECT book_number, chapter, verse, text FROM bible_verses_fts
           WHERE bible_verses_fts MATCH ? AND translation_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(match, translationId, bounded);

      return rows.map((row) => {
        const bookNumber = asInt((row['book_number'] ?? null) as never);
        const chapter = asInt((row['chapter'] ?? null) as never);
        const verse = asInt((row['verse'] ?? null) as never);
        const meta = bookByNumber(bookNumber);
        const name = bookNameIn(translationId, bookNumber);

        return {
          translationId,
          bookNumber,
          bookName: name,
          chapter,
          verse,
          text: asText((row['text'] ?? null) as never),
          // Built from the canonical table so a hit reads as a proper reference the operator can act on.
          reference: meta
            ? formatReference({ book: meta, chapter, startVerse: verse, endVerse: verse })
            : `${name} ${String(chapter)}:${String(verse)}`,
        };
      });
    },
  };
}
