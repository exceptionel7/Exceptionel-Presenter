/**
 * EXCEPTIONEL PRESENTER — the translation package format and its validator (Phase 4).
 *
 * ZERO dependencies and pure, so the whole of import validation is testable without a database or a
 * file dialog.
 *
 * WHY THERE IS AN IMPORT FORMAT AT ALL, AND NO BUNDLED TEXT. Bible translations are, with few
 * exceptions, under copyright. Shipping verse text inside the application would mean either
 * distributing someone's work without permission or quietly restricting which churches may use the
 * software. So no scripture ships here: a translation arrives as a package the operator installs, and
 * `license` is a REQUIRED field that the validator refuses to accept as blank. The database agrees —
 * `bible_translations.license` is `NOT NULL`.
 *
 * That is a deliberate trade. It means a fresh installation cannot show scripture until a translation
 * is installed, and the Bible workspace says exactly that rather than pretending otherwise.
 */

import { BOOK_COUNT, bookByExactName, bookByNumber, type BibleBookMeta } from './bible.ts';

/**
 * The package, as JSON.
 *
 * `chapters[c][v]` is the text of chapter c+1, verse v+1 — nested arrays rather than a flat list of
 * `{chapter, verse, text}` objects because a whole Bible is around 31,000 verses and the flat form
 * triples the file size in repeated key names for no gain.
 */
export interface BiblePackage {
  translation: {
    /** Slug, safe for an id: letters, digits, hyphen, underscore. */
    id: string;
    abbreviation: string;
    name: string;
    /** BCP-47-ish language tag. Not validated beyond being non-empty; it is a label. */
    language: string;
    /** REQUIRED and non-blank. See the note at the top of this file. */
    license: string;
    sourceUrl?: string | null;
  };
  books: BiblePackageBook[];
}

export interface BiblePackageBook {
  /** Canonical position, 1–66. Either this or `name` must identify the book. */
  number?: number;
  /** A canonical name or any accepted alias, for packages that identify books by name. */
  name?: string;
  abbreviation?: string;
  /** Outer array = chapters, inner array = verses. */
  chapters: string[][];
}

/** One thing wrong with a package, located precisely enough to fix. */
export interface PackageProblem {
  /** A JSON-ish path: `books[12].chapters[3][5]`. */
  path: string;
  message: string;
}

export interface ValidatedPackage {
  translation: {
    id: string;
    abbreviation: string;
    name: string;
    language: string;
    license: string;
    sourceUrl: string | null;
  };
  books: {
    meta: BibleBookMeta;
    /** The name as supplied, or the canonical one. Lets a package use local-language names. */
    name: string;
    abbreviation: string;
    chapters: string[][];
  }[];
  verseCount: number;
}

export type PackageValidation =
  | { ok: true; value: ValidatedPackage; warnings: PackageProblem[] }
  | { ok: false; problems: PackageProblem[] };

/*
 * Bounds. A malformed or hostile file must fail fast rather than exhausting memory in the main
 * process — which on this application is the process driving the projector.
 */
const MAX_VERSES = 200_000; // a whole Bible is ~31,000; this allows for combined or annotated editions
const MAX_VERSE_LENGTH = 5_000;
const MAX_CHAPTERS_PER_BOOK = 150;
const MAX_VERSES_PER_CHAPTER = 200;
const MAX_PROBLEMS = 50; // enough to be useful, not so many that the UI drowns

/**
 * Things people type into a licence field instead of a licence.
 *
 * Compared with letters only, so "N/A", "n.a.", "-" and "N / A" all collapse to the same answer.
 */
const NON_ANSWERS: ReadonlySet<string> = new Set([
  '',
  'na',
  'none',
  'nil',
  'unknown',
  'unspecified',
  'tbd',
  'tba',
  'todo',
  'free',
  'copyright',
  'allrightsreserved',
]);

/**
 * Validates a parsed JSON package.
 *
 * Collects problems rather than throwing on the first, because an operator fixing a hand-made package
 * wants the list, not a game of whack-a-mole. Capped at 50 so a wholly wrong file does not produce a
 * thousand-line error.
 */
export function validateBiblePackage(input: unknown): PackageValidation {
  const problems: PackageProblem[] = [];
  const warnings: PackageProblem[] = [];
  const fail = (path: string, message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push({ path, message });
  };

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, problems: [{ path: '', message: 'The file must contain a JSON object.' }] };
  }

  const root = input as Record<string, unknown>;

  // ── translation metadata ──────────────────────────────────────────────────────
  const rawTranslation = root['translation'];
  if (typeof rawTranslation !== 'object' || rawTranslation === null || Array.isArray(rawTranslation)) {
    return {
      ok: false,
      problems: [{ path: 'translation', message: 'A "translation" object is required, naming the edition and its licence.' }],
    };
  }

  const meta = rawTranslation as Record<string, unknown>;
  const id = text(meta['id']);
  const abbreviation = text(meta['abbreviation']);
  const name = text(meta['name']);
  const language = text(meta['language']) ?? 'en';
  const license = text(meta['license']);
  const sourceUrl = text(meta['sourceUrl']);

  if (id === null) fail('translation.id', 'An id is required, for example "kjv".');
  else if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    fail('translation.id', 'The id may contain only letters, digits, hyphens and underscores (max 64).');
  }

  if (abbreviation === null) fail('translation.abbreviation', 'An abbreviation is required, for example "KJV".');
  else if (abbreviation.length > 16) fail('translation.abbreviation', 'Keep the abbreviation to 16 characters or fewer.');

  if (name === null) fail('translation.name', 'A name is required, for example "King James Version".');

  /*
   * The licence check is the reason this validator exists.
   *
   * Refused, not defaulted, and not warned about: accepting a package with no stated terms would put
   * this application in the business of distributing text nobody has checked the rights to.
   */
  if (license === null) {
    fail(
      'translation.license',
      'A licence is required. State the terms under which this text may be used — for example "Public domain" — or the licence granted by the rights holder.',
    );
  } else if (NON_ANSWERS.has(license.toLowerCase().replace(/[^a-z]/g, ''))) {
    /*
     * A named blocklist rather than a minimum length.
     *
     * The first version of this check rejected anything under four characters, which would have
     * refused "MIT" — a real, complete licence statement — while a length rule tells you nothing about
     * whether terms were actually stated. What needs catching is the non-answer: "n/a", "none", "?".
     */
    fail(
      'translation.license',
      `"${license}" does not state any terms. Write the licence, for example "Public domain" or the permission granted by the rights holder.`,
    );
  }

  // ── books ────────────────────────────────────────────────────────────────────
  const rawBooks = root['books'];
  if (!Array.isArray(rawBooks)) {
    fail('books', 'A "books" array is required.');
    return { ok: false, problems };
  }
  if (rawBooks.length === 0) fail('books', 'The package contains no books.');

  const books: ValidatedPackage['books'] = [];
  const seenNumbers = new Set<number>();
  let verseCount = 0;

  rawBooks.forEach((rawBook, bookIndex) => {
    const at = `books[${String(bookIndex)}]`;

    if (typeof rawBook !== 'object' || rawBook === null || Array.isArray(rawBook)) {
      fail(at, 'Each book must be an object.');
      return;
    }

    const book = rawBook as Record<string, unknown>;

    // Identified by canonical number, or by any name the canon table accepts. Supporting both means a
    // third-party dataset usually imports without being rewritten first.
    const numberValue = book['number'];
    const nameValue = text(book['name']);
    let resolved: BibleBookMeta | null = null;

    if (typeof numberValue === 'number' && Number.isInteger(numberValue)) {
      resolved = bookByNumber(numberValue);
      if (!resolved) fail(`${at}.number`, `${String(numberValue)} is not a canonical book number (1–${String(BOOK_COUNT)}).`);
    } else if (nameValue !== null) {
      resolved = bookByExactName(nameValue);
      if (!resolved) {
        fail(`${at}.name`, `"${nameValue}" is not a book this application recognises.`);
      }
    } else {
      fail(at, 'Each book needs a "number" (1–66) or a recognised "name".');
    }

    if (!resolved) return;

    if (seenNumbers.has(resolved.number)) {
      fail(at, `${resolved.name} appears more than once.`);
      return;
    }
    seenNumbers.add(resolved.number);

    const chapters = book['chapters'];
    if (!Array.isArray(chapters)) {
      fail(`${at}.chapters`, 'A "chapters" array is required: chapters of verses.');
      return;
    }
    if (chapters.length === 0) {
      fail(`${at}.chapters`, `${resolved.name} has no chapters.`);
      return;
    }
    if (chapters.length > MAX_CHAPTERS_PER_BOOK) {
      fail(`${at}.chapters`, `${String(chapters.length)} chapters is more than any book in the canon has.`);
      return;
    }

    const cleanChapters: string[][] = [];

    chapters.forEach((rawChapter, chapterIndex) => {
      const chapterAt = `${at}.chapters[${String(chapterIndex)}]`;

      if (!Array.isArray(rawChapter)) {
        fail(chapterAt, 'Each chapter must be an array of verse strings.');
        return;
      }
      if (rawChapter.length === 0) {
        fail(chapterAt, `${resolved.name} chapter ${String(chapterIndex + 1)} has no verses.`);
        return;
      }
      if (rawChapter.length > MAX_VERSES_PER_CHAPTER) {
        fail(chapterAt, `${String(rawChapter.length)} verses is more than any chapter in the canon has.`);
        return;
      }

      const cleanVerses: string[] = [];

      rawChapter.forEach((rawVerse, verseIndex) => {
        if (typeof rawVerse !== 'string') {
          fail(`${chapterAt}[${String(verseIndex)}]`, 'Verse text must be a string.');
          return;
        }
        // Collapse the whitespace a scraped dataset invariably carries. Done here rather than at
        // render time so the stored text is already clean and every consumer agrees.
        const clean = rawVerse.replace(/\s+/g, ' ').trim();

        if (clean === '') {
          // A warning, not a failure: some editions genuinely omit a verse, and refusing the whole
          // package over one blank line would be unhelpful.
          warnings.push({
            path: `${chapterAt}[${String(verseIndex)}]`,
            message: `${resolved.name} ${String(chapterIndex + 1)}:${String(verseIndex + 1)} is empty.`,
          });
        }
        if (clean.length > MAX_VERSE_LENGTH) {
          fail(`${chapterAt}[${String(verseIndex)}]`, 'That verse is implausibly long — is this file really a Bible?');
          return;
        }

        cleanVerses.push(clean);
        verseCount += 1;
      });

      cleanChapters.push(cleanVerses);
    });

    books.push({
      meta: resolved,
      name: nameValue ?? resolved.name,
      abbreviation: text(book['abbreviation']) ?? resolved.abbreviation,
      chapters: cleanChapters,
    });
  });

  if (verseCount > MAX_VERSES) {
    fail('books', `${String(verseCount)} verses is beyond anything this is designed to hold.`);
  }
  if (verseCount === 0 && problems.length === 0) {
    fail('books', 'The package contains no verses.');
  }

  if (problems.length > 0) return { ok: false, problems };

  // A partial translation is legitimate — a New Testament, or a single book for testing — but the
  // operator should know before they rely on it mid-service.
  if (seenNumbers.size < BOOK_COUNT) {
    warnings.push({
      path: 'books',
      message: `This package contains ${String(seenNumbers.size)} of ${String(BOOK_COUNT)} books. References outside them will not be found.`,
    });
  }

  return {
    ok: true,
    warnings,
    value: {
      translation: {
        id: id!,
        abbreviation: abbreviation!,
        name: name!,
        language,
        license: license!,
        sourceUrl: sourceUrl ?? null,
      },
      // Canonical order regardless of the order in the file, so book lists never come out shuffled.
      books: books.sort((left, right) => left.meta.number - right.meta.number),
      verseCount,
    },
  };
}

/** Parses and validates in one step, turning a JSON syntax error into the same problem shape. */
export function parseBiblePackage(json: string): PackageValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message: `That file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return validateBiblePackage(parsed);
}

/** Trims a value to a non-empty string, or null. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
