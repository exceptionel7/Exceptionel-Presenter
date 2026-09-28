/**
 * EXCEPTIONEL PRESENTER — the Bible service (Phase 4).
 *
 * Joins the pure reference parser to the stored translations, and owns the import path.
 *
 * WHY THIS SITS BETWEEN THE HANDLERS AND THE REPOSITORY. A lookup has two quite different ways of
 * failing — the reference was not well formed, or it was well formed but the installed translation
 * does not contain it — and they live on opposite sides of that boundary. Collapsing them at the IPC
 * edge would leave the operator with "bad reference" when the truth is "this translation has no
 * Romans", which is a different problem with a different fix.
 *
 * NO SCRIPTURE SHIPS WITH THIS APPLICATION. Import is the only way text arrives, and the validator
 * refuses a package that states no licence. See docs/BIBLE.md.
 */

import { readFileSync } from 'node:fs';
import { matchBook } from '../../shared/domain/bible.ts';
import { parseReference } from '../../shared/domain/bible-reference.ts';
import { parseBiblePackage } from '../../shared/domain/bible-package.ts';
import type {
  BibleBookSummary,
  BibleSearchHit,
  ScriptureLookup,
  ScripturePassage,
  TranslationImportReport,
} from '../../shared/ipc-contract.ts';
import type { BibleTranslation } from '../../shared/domain/entities.ts';
import type { AppDatabase } from '../db/database.ts';

/** Picks a translation package file. Injected so the service is testable without Electron. */
export type ChooseFile = () => Promise<string | null>;

export interface BibleService {
  translations(): BibleTranslation[];
  books(translationId: string): BibleBookSummary[];
  chapters(translationId: string, bookNumber: number): number[];
  lookup(translationId: string, reference: string): ScriptureLookup;
  search(translationId: string, query: string, limit?: number): BibleSearchHit[];
  importTranslation(): Promise<TranslationImportReport>;
  removeTranslation(id: string): void;
}

/** A package larger than this is not a Bible; reading it would only waste the operator's time. */
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

export function createBibleService(options: {
  db: AppDatabase;
  chooseFile: ChooseFile;
  onLog?: (line: string) => void;
}): BibleService {
  const { db } = options;
  const log = options.onLog ?? (() => undefined);

  return {
    translations: () => db.bible.listTranslations(),
    books: (translationId) => db.bible.listBooks(translationId),
    chapters: (translationId, bookNumber) => db.bible.chapterVerseCounts(translationId, bookNumber),
    search: (translationId, query, limit) => db.bible.search(translationId, query, limit),

    lookup(translationId, reference) {
      const parsed = parseReference(reference);

      if (!parsed.ok) {
        /*
         * A parse failure. Carries the candidate list through when the cause was ambiguity, so the
         * interface can offer "Judges or Jude?" rather than a dead end.
         */
        const candidates =
          parsed.problem.code === 'ambiguous-book' ? [...parsed.problem.candidates] : undefined;

        return {
          found: false,
          code: 'bad-reference',
          message: parsed.problem.message,
          ...(candidates ? { candidates } : {}),
        };
      }

      const result = db.bible.lookup(translationId, parsed.reference);
      if (!result.ok) {
        // Passed through with its own code: "this translation has no Romans" is not a bad reference.
        return { found: false, code: result.code, message: result.message };
      }

      const passage: ScripturePassage = {
        translationId: result.passage.translation.id,
        translationAbbreviation: result.passage.translation.abbreviation,
        bookNumber: result.passage.book.number,
        bookName: result.passage.bookName,
        chapter: result.passage.chapter,
        startVerse: result.passage.startVerse,
        endVerse: result.passage.endVerse,
        reference: result.passage.reference,
        verses: result.passage.verses.map((verse) => ({
          book: result.passage.bookName,
          bookNumber: verse.bookNumber,
          chapter: verse.chapter,
          verse: verse.verse,
          text: verse.text,
        })),
        missingVerses: result.passage.missingVerses,
        // The licence, verbatim. Carried on every passage so attribution is always available to
        // whatever displays it, rather than needing a separate lookup at render time.
        copyrightNotice: result.passage.translation.license,
      };

      return { found: true, passage };
    },

    async importTranslation() {
      const path = await options.chooseFile();
      // Closing the dialog is not an error and must not produce a failure banner.
      if (path === null) return { outcome: 'cancelled' };

      let json: string;
      try {
        const buffer = readFileSync(path);
        if (buffer.byteLength > MAX_PACKAGE_BYTES) {
          return {
            outcome: 'rejected',
            problems: [
              {
                path: '',
                message: `That file is ${String(Math.round(buffer.byteLength / 1_048_576))} MB. A Bible package should be a few megabytes — is this the right file?`,
              },
            ],
          };
        }
        json = buffer.toString('utf8');
      } catch (error) {
        return {
          outcome: 'rejected',
          problems: [
            { path: '', message: `Could not read that file: ${error instanceof Error ? error.message : String(error)}` },
          ],
        };
      }

      const validated = parseBiblePackage(json);
      if (!validated.ok) {
        log(`[bible] import rejected: ${String(validated.problems.length)} problem(s)`);
        return { outcome: 'rejected', problems: validated.problems };
      }

      const translation = db.bible.install(validated.value);
      log(
        `[bible] installed ${translation.name} (${translation.abbreviation}): ` +
          `${String(translation.verseCount)} verses, licence "${translation.license}"`,
      );

      return { outcome: 'installed', translation, warnings: validated.warnings };
    },

    removeTranslation(id) {
      db.bible.removeTranslation(id);
      log(`[bible] removed translation ${id}`);
    },
  };
}

/**
 * Suggests what the operator might have meant, for a reference that did not resolve.
 *
 * Exposed separately from `lookup` because the Bible workspace offers it as they type, before there is
 * anything worth looking up.
 */
export function suggestBookNames(typed: string): string[] {
  const match = matchBook(typed);
  if (match.kind === 'ambiguous') return match.candidates.map((book) => book.name);
  if (match.kind === 'exact' || match.kind === 'prefix') return [match.book.name];
  return [];
}
