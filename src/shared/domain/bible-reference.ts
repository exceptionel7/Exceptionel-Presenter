/**
 * EXCEPTIONEL PRESENTER — Bible reference parsing and normalisation (Phase 4).
 *
 * ZERO dependencies and completely pure, so every rule below is unit-testable without a database, a
 * translation or a display.
 *
 * SYNTAX ONLY. This file decides whether "Psalm 23:1-6" is a well-formed reference and what it
 * canonically means. It does NOT decide whether Psalm 23 has six verses — that depends on the
 * installed translation and belongs to the repository. Keeping the two apart matters: a reference can
 * be perfectly well formed and still not exist in the translation on this machine, and those are
 * different problems with different remedies.
 *
 * NOTHING HERE GUESSES. An ambiguous book is refused with the candidates listed, because silently
 * choosing between Judges and Jude would put the wrong passage in front of a congregation and nobody
 * would notice until it was read aloud.
 */

import { BIBLE_BOOKS, matchBook, type BibleBookMeta } from './bible.ts';

export interface ParsedReference {
  book: BibleBookMeta;
  chapter: number;
  /**
   * null for a whole-chapter reference such as "Romans 8".
   *
   * Distinct from `1`, deliberately: "Romans 8" and "Romans 8:1" mean different things, and flattening
   * the first into the second would present one verse where a whole chapter was asked for.
   */
  startVerse: number | null;
  /** Equal to `startVerse` for a single verse; null when the whole chapter is meant. */
  endVerse: number | null;
}

export type ReferenceProblem =
  | { code: 'empty'; message: string }
  | { code: 'no-book'; message: string; typed: string }
  | { code: 'ambiguous-book'; message: string; candidates: readonly string[] }
  | { code: 'no-chapter'; message: string }
  | { code: 'bad-number'; message: string }
  | { code: 'reversed-range'; message: string }
  | { code: 'unparsed-trailing'; message: string; trailing: string };

export type ReferenceParse =
  | { ok: true; reference: ParsedReference; normalised: string }
  | { ok: false; problem: ReferenceProblem };

/** Upper bounds that reject nonsense without encoding any translation's structure. */
const MAX_CHAPTER = 150; // Psalms, the longest book by chapter count
const MAX_VERSE = 176; // Psalm 119, the longest chapter in the canon

/**
 * Splits the leading book name from the trailing numbers.
 *
 * Done by scanning from the END rather than the start, because a book name can itself begin with a
 * digit ("1 John", "2 Chronicles") and can contain spaces ("Song of Solomon"). Anchoring on the last
 * run of digits-and-separators is the only reading that handles both without a table of special
 * cases.
 */
function splitBookAndNumbers(input: string): { bookPart: string; numberPart: string } {
  const match = /^(.*?)\s*([0-9]+\s*(?:[:.]\s*[0-9]+\s*(?:[-–—]\s*[0-9]+\s*)?)?)$/.exec(input);
  if (!match) return { bookPart: input.trim(), numberPart: '' };
  return { bookPart: (match[1] ?? '').trim(), numberPart: (match[2] ?? '').trim() };
}

/**
 * Parses whatever the operator typed.
 *
 * Accepts: "John 3:16", "John 3:16-18", "John 3", "Psalm 23:1-6", "1 John 2:1", "Rom 8",
 * "Matthew 5:3-12", "Gen 1.1-5", "III John 4", "Jude 3". Case, punctuation, extra whitespace and
 * en/em dashes are all tolerated; ambiguity is not.
 */
export function parseReference(raw: string): ReferenceParse {
  const input = raw.replace(/\s+/g, ' ').trim();

  if (input === '') {
    return { ok: false, problem: { code: 'empty', message: 'Type a reference, for example John 3:16.' } };
  }

  const { bookPart, numberPart } = splitBookAndNumbers(input);

  if (bookPart === '') {
    return {
      ok: false,
      problem: { code: 'no-book', message: 'That reference has no book name.', typed: input },
    };
  }

  const match = matchBook(bookPart);

  if (match.kind === 'ambiguous') {
    const names = match.candidates.map((book) => book.name);
    return {
      ok: false,
      problem: {
        code: 'ambiguous-book',
        // The candidates are listed rather than one being chosen. See the note at the top.
        message: `"${bookPart}" could be ${listNames(names)}. Type more of the name.`,
        candidates: names,
      },
    };
  }

  if (match.kind === 'unknown') {
    const suggestions = suggestBooks(bookPart);
    return {
      ok: false,
      problem: {
        code: 'no-book',
        message:
          suggestions.length > 0
            ? `No book called "${bookPart}". Did you mean ${listNames(suggestions)}?`
            : `No book called "${bookPart}".`,
        typed: bookPart,
      },
    };
  }

  const book = match.book;

  if (numberPart === '') {
    /*
     * A single-chapter book on its own means the whole book — "Jude" is a complete, unambiguous
     * reference. Demanding a chapter number for a book that has only one would be pedantry that costs
     * the operator a keystroke and teaches them the parser is fussy.
     */
    if (book.singleChapter === true) {
      const whole: ParsedReference = { book, chapter: 1, startVerse: null, endVerse: null };
      return { ok: true, reference: whole, normalised: formatReference(whole) };
    }

    return {
      ok: false,
      problem: {
        code: 'no-chapter',
        message: `Add a chapter, for example ${displayBookName(book)} 3.`,
      },
    };
  }

  const numbers = /^([0-9]+)(?:\s*[:.]\s*([0-9]+)(?:\s*[-–—]\s*([0-9]+))?)?$/.exec(numberPart);
  if (!numbers) {
    return { ok: false, problem: { code: 'bad-number', message: `Could not read "${numberPart}".` } };
  }

  const first = Number(numbers[1]);
  const second = numbers[2] === undefined ? null : Number(numbers[2]);
  const third = numbers[3] === undefined ? null : Number(numbers[3]);

  /*
   * A single number in a single-chapter book is a VERSE, not a chapter.
   *
   * "Jude 3" means the third verse — there is no third chapter of Jude, and anyone writing it means
   * the verse. The five affected books are flagged in the canon table.
   */
  let chapter: number;
  let startVerse: number | null;
  let endVerse: number | null;

  if (second === null && book.singleChapter === true) {
    chapter = 1;
    startVerse = first;
    endVerse = first;
  } else {
    chapter = first;
    startVerse = second;
    endVerse = third ?? second;
  }

  if (chapter < 1 || chapter > MAX_CHAPTER) {
    return {
      ok: false,
      problem: { code: 'bad-number', message: `Chapter ${String(chapter)} is not a possible chapter.` },
    };
  }

  if (startVerse !== null && (startVerse < 1 || startVerse > MAX_VERSE)) {
    return {
      ok: false,
      problem: { code: 'bad-number', message: `Verse ${String(startVerse)} is not a possible verse.` },
    };
  }

  if (endVerse !== null && (endVerse < 1 || endVerse > MAX_VERSE)) {
    return {
      ok: false,
      problem: { code: 'bad-number', message: `Verse ${String(endVerse)} is not a possible verse.` },
    };
  }

  if (startVerse !== null && endVerse !== null && endVerse < startVerse) {
    return {
      ok: false,
      problem: {
        code: 'reversed-range',
        // Not silently swapped: a reversed range is usually a typo in one of the two numbers, and
        // guessing which would as often as not present the wrong passage.
        message: `Verse ${String(endVerse)} comes before verse ${String(startVerse)}.`,
      },
    };
  }

  const reference: ParsedReference = { book, chapter, startVerse, endVerse };
  return { ok: true, reference, normalised: formatReference(reference) };
}

/**
 * The canonical way to write a reference: what goes on the projector and into a service item.
 *
 * Uses the singular book name for a single chapter — "Psalm 23", never "Psalms 23" — because this is
 * read aloud in front of people.
 */
export function formatReference(reference: ParsedReference): string {
  const name = displayBookName(reference.book);

  if (reference.startVerse === null) {
    // "Jude", not "Jude 1": citing the only chapter of a one-chapter book by number reads oddly.
    return reference.book.singleChapter === true ? name : `${name} ${String(reference.chapter)}`;
  }
  if (reference.endVerse === null || reference.endVerse === reference.startVerse) {
    return `${name} ${String(reference.chapter)}:${String(reference.startVerse)}`;
  }
  return `${name} ${String(reference.chapter)}:${String(reference.startVerse)}-${String(reference.endVerse)}`;
}

/** The shorter form, for a running order where space is tight. */
export function formatReferenceShort(reference: ParsedReference): string {
  const full = formatReference(reference);
  return full.replace(displayBookName(reference.book), reference.book.abbreviation);
}

/** "Psalm" rather than "Psalms" where a book has a singular citation form. */
const displayBookName = (book: BibleBookMeta): string => book.singularName ?? book.name;

/**
 * A stable, filename-safe key for a reference.
 *
 * Used to derive cue ids, so reopening a service keeps the operator on the same slide. Built from the
 * book NUMBER rather than its name so it cannot change if a display name is ever adjusted.
 */
export function referenceKey(reference: ParsedReference): string {
  const parts = [String(reference.book.number), String(reference.chapter)];
  if (reference.startVerse !== null) parts.push(String(reference.startVerse));
  if (reference.endVerse !== null && reference.endVerse !== reference.startVerse) {
    parts.push(String(reference.endVerse));
  }
  return parts.join('_');
}

/** True when the reference asks for a whole chapter rather than a verse or range. */
export const isWholeChapter = (reference: ParsedReference): boolean => reference.startVerse === null;

/** How many verses a reference spans, or null when it is a whole chapter of unknown length. */
export function verseCount(reference: ParsedReference): number | null {
  if (reference.startVerse === null) return null;
  return (reference.endVerse ?? reference.startVerse) - reference.startVerse + 1;
}

/**
 * Book names that look like what was typed, for a "did you mean" hint.
 *
 * Substring rather than prefix, so a misplaced first letter still finds something: `matchBook` has
 * already failed on prefixes by the time this runs, and a hint that finds nothing is no worse than
 * no hint.
 */
function suggestBooks(typed: string, limit = 3): string[] {
  const needle = typed.toLowerCase().replace(/[^a-z]/g, '');
  if (needle.length < 2) return [];

  return BIBLE_BOOKS.filter((book) => {
    const name = book.name.toLowerCase().replace(/[^a-z]/g, '');
    return name.includes(needle.slice(0, 3)) || needle.includes(name.slice(0, 3));
  })
    .slice(0, limit)
    .map((book) => book.name);
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1] ?? ''}`;
}
