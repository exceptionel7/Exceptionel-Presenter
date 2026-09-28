/**
 * EXCEPTIONEL PRESENTER — the shape of a resolved passage, and how it becomes slides (Phase 4).
 *
 * ZERO dependencies apart from the theme spec, so packing verses into slides is unit-testable without
 * a database, a translation or a display.
 *
 * ONE DEFINITION, used by the repository, the IPC payload, the cue builder and every renderer.
 * `ipc-contract.ts` re-exports these rather than declaring its own — the same rule that was applied to
 * the theme spec after it had been copied into a renderer and started drifting.
 *
 * STRUCTURE, NOT A TEXT BLOB. Each field below is something a consumer needs *separately*: the
 * confidence monitor shows the reference, the cue builder needs verse numbers to split a long passage
 * across slides, and the licence has to be available wherever the text is displayed. Flattening this
 * to one string would force every one of them to re-parse what was already known.
 */

import type { ThemeSpec } from './entities.ts';
import { fitSlideText } from './theme.ts';

export interface ScriptureVerse {
  /** As this translation names the book, which may not be the canonical English. */
  book: string;
  bookNumber: number;
  chapter: number;
  verse: number;
  text: string;
}

/**
 * What identifies a passage, without its text.
 *
 * Carried on every Scripture cue so the operator, the confidence monitor and any later feature can
 * answer "which verses are these?" without a lookup.
 */
export interface ScriptureCitation {
  translationId: string;
  translationAbbreviation: string;
  bookNumber: number;
  bookName: string;
  chapter: number;
  startVerse: number;
  endVerse: number;
  /** Canonical display form, e.g. "John 3:16-18". */
  reference: string;
}

export interface ScripturePassage extends ScriptureCitation {
  verses: ScriptureVerse[];
  /**
   * Verses inside the requested range the translation does not contain.
   *
   * Reported so asking for John 3:16-20 in an edition that omits verse 18 cannot silently present four
   * verses as though five had been found.
   */
  missingVerses: number[];
  /** Attribution/licence line, verbatim as the package declared it. */
  copyrightNotice: string | null;
}

// ── turning a passage into slides ───────────────────────────────────────────────

export interface ScriptureSlide {
  /** The lines the audience reads. One entry per verse. */
  lines: string[];
  startVerse: number;
  endVerse: number;
}

export interface PackOptions {
  /**
   * Prefix each verse with its number.
   *
   * On by default, but SUPPRESSED on a slide holding a single verse: the reference caption beneath
   * already says which verse it is, so repeating it in the body is noise the congregation has to read
   * past.
   */
  showVerseNumbers?: boolean;
  /**
   * Hard ceiling on verses per slide, regardless of whether more would fit.
   *
   * Exists because "it fits" and "it can be read from the back row in the time it is on screen" are
   * different questions, and only the first can be computed.
   */
  maxVersesPerSlide?: number;
}

const DEFAULT_MAX_VERSES_PER_SLIDE = 6;

/**
 * Splits a passage across as many slides as it needs, packing greedily.
 *
 * REUSES `fitSlideText`, the same tested function the renderer uses to size type. A verse is added to
 * the current slide only while the result still fits at the theme's full font size; the moment it would
 * force a shrink, the slide is closed and a new one started. So scripture is broken at verse
 * boundaries by the same geometry that decides whether lyrics fit, rather than by a guessed
 * verses-per-slide constant.
 *
 * A single verse too long to fit alone still gets its own slide, and auto-fit shrinks it there — the
 * alternative would be an infinite loop or a dropped verse.
 */
export function packPassageIntoSlides(
  passage: Pick<ScripturePassage, 'verses'>,
  spec: ThemeSpec,
  options: PackOptions = {},
): ScriptureSlide[] {
  const showNumbers = options.showVerseNumbers ?? true;
  const maxVerses = Math.max(options.maxVersesPerSlide ?? DEFAULT_MAX_VERSES_PER_SLIDE, 1);

  if (passage.verses.length === 0) return [];

  const slides: ScriptureSlide[] = [];
  let current: ScriptureVerse[] = [];

  /** Renders the accumulated verses. Numbers are dropped when the slide holds only one. */
  const linesFor = (verses: readonly ScriptureVerse[]): string[] =>
    verses.map((verse) =>
      showNumbers && verses.length > 1 ? `${String(verse.verse)}  ${verse.text}` : verse.text,
    );

  const close = (): void => {
    if (current.length === 0) return;
    slides.push({
      lines: linesFor(current),
      startVerse: current[0]!.verse,
      endVerse: current[current.length - 1]!.verse,
    });
    current = [];
  };

  for (const verse of passage.verses) {
    const candidate = [...current, verse];

    if (candidate.length > maxVerses) {
      close();
      current = [verse];
      continue;
    }

    // Does the candidate still fit at the theme's declared size?
    if (fitSlideText(linesFor(candidate), spec).scale === 1) {
      current = candidate;
      continue;
    }

    /*
     * It would have to shrink. Close the slide and start a new one — unless this verse is the only
     * thing on it, in which case there is nothing to close and auto-fit deals with it. Without that
     * exception a single long verse would loop forever or be silently dropped.
     */
    if (current.length === 0) {
      current = candidate;
      close();
      continue;
    }

    close();
    current = [verse];
  }

  close();
  return slides;
}

/**
 * The reference for one slide of a multi-slide passage.
 *
 * "John 3:16-18" as a whole, but "John 3:17" on the slide that only shows verse 17 — because the
 * caption on screen must describe what is on screen. A caption naming verses the congregation cannot
 * see is worse than none.
 */
export function slideReference(citation: ScriptureCitation, slide: ScriptureSlide): string {
  /*
   * Strip only the VERSE part — everything from the last colon.
   *
   * The first version of this used `/[:\s]\d+(?:-\d+)?$/`, which also ate a chapter number when the
   * reference had no verses at all: "John 3" became "John", and every caption on a whole-chapter reading
   * read "John:1-6". Splitting on the colon cannot make that mistake, because a chapter number is never
   * preceded by one.
   */
  const withoutVerses = citation.reference.includes(':')
    ? citation.reference.slice(0, citation.reference.lastIndexOf(':'))
    : citation.reference;

  /*
   * Restore the chapter if the reference never carried it.
   *
   * "Jude" is a complete reference — a one-chapter book is cited without a number — but a slide caption
   * needs "Jude 1:3" to be unambiguous about what is on screen.
   */
  const chapter = String(citation.chapter);
  const base = withoutVerses.endsWith(` ${chapter}`) || withoutVerses === chapter
    ? withoutVerses
    : `${withoutVerses} ${chapter}`;

  return slide.startVerse === slide.endVerse
    ? `${base}:${String(slide.startVerse)}`
    : `${base}:${String(slide.startVerse)}-${String(slide.endVerse)}`;
}
