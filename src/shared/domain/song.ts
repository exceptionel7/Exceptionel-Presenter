/**
 * EXCEPTIONEL PRESENTER — song → slide conversion (Section 7).
 *
 * The single source of truth for how a section's lyrics become presentation slides. The
 * song editor uses it to preview the slide count while typing, and Phase 3's presentation
 * engine uses it to build the actual cues — so what the operator previews is exactly what
 * the audience gets.
 *
 * Dependency-free and unit-tested.
 */

import type { SlideBreakMode, SongSectionKind } from './entities.ts';

export interface LyricSlide {
  /** Lines of text for one slide, already trimmed of trailing blank lines. */
  lines: string[];
  /** Index of this slide within its section, from 0. */
  indexInSection: number;
  sectionLabel: string;
  sectionKind: SongSectionKind;
}

export interface SectionLike {
  kind: SongSectionKind;
  label: string;
  lyrics: string;
  slideBreakMode: SlideBreakMode;
}

/**
 * Splits one section into slides.
 *
 * Normalises CRLF first: lyrics pasted from Windows song sheets or ChordPro exports arrive
 * with \r\n, and a stray \r would otherwise survive into the rendered slide and, worse,
 * break blank-line detection because "\r" is not an empty string.
 */
export function splitSectionIntoSlides(section: SectionLike): LyricSlide[] {
  const normalised = section.lyrics.replace(/\r\n?/g, '\n');

  const meta = { sectionLabel: section.label, sectionKind: section.kind };
  const build = (groups: string[][]): LyricSlide[] =>
    groups
      .map((lines) => lines.map((line) => line.trimEnd()))
      .filter((lines) => lines.some((line) => line.trim() !== ''))
      .map((lines, index) => ({ lines, indexInSection: index, ...meta }));

  switch (section.slideBreakMode) {
    case 'whole-section': {
      const lines = normalised.split('\n').filter((line) => line.trim() !== '');
      return build([lines]);
    }

    case 'blank-line': {
      // One or more blank lines separate slides. This is the convention worship teams
      // already use in plain-text lyric sheets.
      const blocks = normalised.split(/\n[ \t]*\n+/);
      return build(blocks.map((block) => block.split('\n').filter((line) => line.trim() !== '')));
    }

    case 'every-2-lines':
      return build(chunk(nonEmptyLines(normalised), 2));

    case 'every-4-lines':
      return build(chunk(nonEmptyLines(normalised), 4));
  }
}

/** Total slides a section produces — used for the editor's live count. */
export const countSectionSlides = (section: SectionLike): number => splitSectionIntoSlides(section).length;

/** Flattens a whole song, in section order. */
export function songToSlides(sections: readonly SectionLike[]): LyricSlide[] {
  return sections.flatMap((section) => splitSectionIntoSlides(section));
}

const nonEmptyLines = (text: string): string[] => text.split('\n').filter((line) => line.trim() !== '');

function chunk(lines: readonly string[], size: number): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += size) groups.push(lines.slice(i, i + size));
  return groups;
}

/**
 * Suggests the next label for a new section of a given kind, e.g. "Verse 3".
 *
 * Numbers by the highest existing number rather than by count, so deleting Verse 2 and
 * adding a new one gives "Verse 3" instead of a duplicate "Verse 2".
 */
export function nextSectionLabel(kind: SongSectionKind, existing: readonly SectionLike[]): string {
  const base = kind
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');

  const sameKind = existing.filter((section) => section.kind === kind);
  if (sameKind.length === 0) return base;

  const highest = sameKind.reduce((max, section) => {
    const match = /(\d+)\s*$/.exec(section.label);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  // A single unnumbered section (just "Chorus") becomes "Chorus 2" on the second one.
  return `${base} ${Math.max(highest + 1, sameKind.length + 1)}`;
}
