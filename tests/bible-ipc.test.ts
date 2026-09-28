import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { createLiveStateService } from '../src/main/services/live-state-service.ts';
import { createBibleService, type BibleService } from '../src/main/services/bible-service.ts';
import { createHandlers } from '../src/main/ipc/handlers.ts';
import { dispatch, isChannelAllowedForRole, type HandlerRegistry, type WindowRole } from '../src/main/ipc/dispatcher.ts';
import type { AppInfo, IpcResult, ScriptureLookup, TranslationImportReport } from '../src/shared/ipc-contract.ts';

/**
 * EXCEPTIONEL PRESENTER — the Bible over IPC, end to end through the real dispatcher.
 *
 * NO REAL SCRIPTURE IN THIS FILE. The verse text is obviously synthetic. Translations are under
 * copyright with few exceptions, so none is bundled — not in the product and not in its tests.
 */

const APP_INFO: AppInfo = {
  name: 'Exceptionel Presenter',
  version: '0.2.0',
  electronVersion: 'test',
  chromeVersion: 'test',
  nodeVersion: 'test',
  platform: 'linux',
  schemaVersion: 3,
  sqliteEngine: 'node:sqlite',
  userDataPath: '/tmp/ep',
  isPackaged: false,
};

interface Harness {
  db: AppDatabase;
  bible: BibleService;
  handlers: HandlerRegistry;
  call: (channel: string, payload?: unknown, role?: WindowRole) => Promise<IpcResult<unknown>>;
  /** What the next import dialog will "choose". */
  setFile: (path: string | null) => void;
  dir: string;
  cleanup: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ep-bible-'));
  const db = openDatabase({ path: ':memory:' });
  const live = createLiveStateService();

  let chosen: string | null = null;

  const bible = createBibleService({
    db,
    // The seam that keeps this testable: main supplies a real Electron dialog, tests supply a path.
    chooseFile: () => Promise.resolve(chosen),
  });

  const handlers = createHandlers({
    db,
    live,
    appInfo: () => APP_INFO,
    quit: () => undefined,
    bible,
  });

  return {
    db,
    bible,
    handlers,
    dir,
    setFile: (path) => {
      chosen = path;
    },
    call: (channel, payload, role = 'operator') => dispatch(channel, payload, role, { handlers }),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const unwrap = <T>(result: IpcResult<unknown>): T => {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return (result as { ok: true; data: T }).data;
};

const expectFailure = (result: IpcResult<unknown>, code: string): void => {
  assert.equal(result.ok, false, 'expected a failure');
  assert.equal((result as { ok: false; failure: { code: string } }).failure.code, code);
};

/** Writes a valid package file and returns its path. */
function writePackage(
  dir: string,
  over: { id?: string; license?: string; books?: unknown[] } = {},
): string {
  const path = join(dir, `${over.id ?? 'sample'}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      translation: {
        id: over.id ?? 'sample',
        abbreviation: 'SMP',
        name: 'Sample Edition',
        language: 'en',
        license: over.license ?? 'Public domain',
      },
      books:
        over.books ?? [
          {
            number: 43,
            chapters: [
              ['john one one', 'john one two', 'john one three'],
              ['john two one'],
              Array.from({ length: 21 }, (_, index) => `john three verse ${String(index + 1)}`),
            ],
          },
        ],
    }),
    'utf8',
  );
  return path;
}

// ── import ──────────────────────────────────────────────────────────────────────

test('A TRANSLATION IMPORTS THROUGH IPC AND BECOMES AVAILABLE', async () => {
  const h = harness();
  try {
    assert.deepEqual(unwrap(await h.call('bible:translations')), [], 'nothing is bundled');

    h.setFile(writePackage(h.dir));
    const report = unwrap<TranslationImportReport>(await h.call('bible:import'));

    assert.equal(report.outcome, 'installed');
    assert.ok(report.outcome === 'installed');
    assert.equal(report.translation.abbreviation, 'SMP');
    assert.equal(report.translation.verseCount, 25);

    const translations = unwrap<{ id: string }[]>(await h.call('bible:translations'));
    assert.deepEqual(translations.map((entry) => entry.id), ['sample']);
  } finally {
    h.cleanup();
  }
});

test('CANCELLING THE FILE DIALOG IS NOT AN ERROR', async () => {
  // A cancelled dialog producing a red failure banner would teach the operator that closing a dialog
  // breaks something.
  const h = harness();
  try {
    h.setFile(null);
    const report = unwrap<TranslationImportReport>(await h.call('bible:import'));
    assert.equal(report.outcome, 'cancelled');
    assert.deepEqual(unwrap(await h.call('bible:translations')), []);
  } finally {
    h.cleanup();
  }
});

test('A PACKAGE WITH NO LICENCE IS REJECTED AT THE IMPORT BOUNDARY', async () => {
  /*
   * The whole reason the import path exists. Refused as a REPORT rather than an exception, so the
   * interface can list the problems and the operator can fix the file.
   */
  const h = harness();
  try {
    h.setFile(writePackage(h.dir, { license: 'n/a' }));
    const report = unwrap<TranslationImportReport>(await h.call('bible:import'));

    assert.equal(report.outcome, 'rejected');
    assert.ok(report.outcome === 'rejected');
    assert.ok(report.problems.some((problem) => problem.path === 'translation.license'));
    assert.deepEqual(unwrap(await h.call('bible:translations')), [], 'and nothing was installed');
  } finally {
    h.cleanup();
  }
});

test('a malformed or missing file is reported, not thrown', async () => {
  const h = harness();
  try {
    const badJson = join(h.dir, 'broken.json');
    writeFileSync(badJson, '{ "translation": ', 'utf8');
    h.setFile(badJson);
    const broken = unwrap<TranslationImportReport>(await h.call('bible:import'));
    assert.equal(broken.outcome, 'rejected');

    h.setFile(join(h.dir, 'does-not-exist.json'));
    const missing = unwrap<TranslationImportReport>(await h.call('bible:import'));
    assert.equal(missing.outcome, 'rejected');
    assert.ok(missing.outcome === 'rejected');
    assert.match(missing.problems[0]?.message ?? '', /Could not read that file/);
  } finally {
    h.cleanup();
  }
});

test('a partial canon installs but warns', async () => {
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    const report = unwrap<TranslationImportReport>(await h.call('bible:import'));
    assert.ok(report.outcome === 'installed');
    assert.ok(
      report.warnings.some((warning) => /1 of 66 books/.test(warning.message)),
      'the operator must know before relying on it mid-service',
    );
  } finally {
    h.cleanup();
  }
});

test('removing a translation goes through IPC', async () => {
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    unwrap(await h.call('bible:import'));
    unwrap(await h.call('bible:removeTranslation', { id: 'sample' }));
    assert.deepEqual(unwrap(await h.call('bible:translations')), []);
  } finally {
    h.cleanup();
  }
});

// ── lookup ──────────────────────────────────────────────────────────────────────

test('A LOOKUP RETURNS STRUCTURE, NOT A FLATTENED TEXT BLOB', async () => {
  /*
   * Every field is something a consumer needs separately: the confidence monitor shows the reference,
   * the cue builder needs verse numbers to split a long passage, and the licence has to be available
   * for attribution.
   */
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    unwrap(await h.call('bible:import'));

    const result = unwrap<ScriptureLookup>(
      await h.call('bible:lookup', { translationId: 'sample', reference: 'John 3:16-18' }),
    );

    assert.equal(result.found, true);
    assert.ok(result.found);
    assert.equal(result.passage.reference, 'John 3:16-18');
    assert.equal(result.passage.translationAbbreviation, 'SMP');
    assert.equal(result.passage.bookNumber, 43);
    assert.equal(result.passage.bookName, 'John');
    assert.equal(result.passage.chapter, 3);
    assert.equal(result.passage.startVerse, 16);
    assert.equal(result.passage.endVerse, 18);
    assert.deepEqual(result.passage.verses.map((verse) => verse.verse), [16, 17, 18]);
    assert.equal(result.passage.copyrightNotice, 'Public domain', 'attribution travels with the passage');
    assert.deepEqual(result.passage.missingVerses, []);
  } finally {
    h.cleanup();
  }
});

test('a whole chapter resolves to every verse present', async () => {
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    unwrap(await h.call('bible:import'));

    const result = unwrap<ScriptureLookup>(
      await h.call('bible:lookup', { translationId: 'sample', reference: 'John 3' }),
    );
    assert.ok(result.found);
    assert.equal(result.passage.verses.length, 21);
    assert.equal(result.passage.reference, 'John 3');
  } finally {
    h.cleanup();
  }
});

test('A BAD REFERENCE AND ABSENT TEXT ARE DIFFERENT ANSWERS', async () => {
  /*
   * The distinction this whole layer exists to preserve. "Jud 3" is ambiguous input; "Romans 8:28" is
   * perfectly well formed but absent from this translation. Collapsing both into one error would leave
   * the operator with no idea which they were facing.
   */
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    unwrap(await h.call('bible:import'));

    const ambiguous = unwrap<ScriptureLookup>(
      await h.call('bible:lookup', { translationId: 'sample', reference: 'Jud 3' }),
    );
    assert.equal(ambiguous.found, false);
    assert.ok(!ambiguous.found);
    assert.equal(ambiguous.code, 'bad-reference');
    assert.deepEqual(ambiguous.candidates, ['Judges', 'Jude'], 'the candidates survive to the UI');

    const absent = unwrap<ScriptureLookup>(
      await h.call('bible:lookup', { translationId: 'sample', reference: 'Romans 8:28' }),
    );
    assert.ok(!absent.found);
    assert.equal(absent.code, 'book-missing');
    assert.match(absent.message, /SMP does not include Romans/);

    const chapterGone = unwrap<ScriptureLookup>(
      await h.call('bible:lookup', { translationId: 'sample', reference: 'John 9:1' }),
    );
    assert.ok(!chapterGone.found);
    assert.equal(chapterGone.code, 'chapter-missing');

    const noTranslation = unwrap<ScriptureLookup>(
      await h.call('bible:lookup', { translationId: 'absent', reference: 'John 3:16' }),
    );
    assert.ok(!noTranslation.found);
    assert.equal(noTranslation.code, 'no-translation');
  } finally {
    h.cleanup();
  }
});

test('a lookup failure is a RESULT, never a thrown failure', async () => {
  // Otherwise every mistyped reference becomes a red banner and the specific remedy is lost.
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    unwrap(await h.call('bible:import'));
    const raw = await h.call('bible:lookup', { translationId: 'sample', reference: 'Xyzzy 1:1' });
    assert.equal(raw.ok, true, 'the channel succeeded; the lookup did not find anything');
  } finally {
    h.cleanup();
  }
});

// ── books, chapters, search ─────────────────────────────────────────────────────

test('books and verse counts come from the installed text', async () => {
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    unwrap(await h.call('bible:import'));

    const books = unwrap<{ bookNumber: number; chapterCount: number }[]>(
      await h.call('bible:books', { translationId: 'sample' }),
    );
    assert.deepEqual(books.map((book) => book.bookNumber), [43]);
    assert.equal(books[0]?.chapterCount, 3);

    const counts = unwrap<number[]>(await h.call('bible:chapters', { translationId: 'sample', bookNumber: 43 }));
    assert.deepEqual(counts, [3, 1, 21]);
  } finally {
    h.cleanup();
  }
});

test('search returns hits with usable references', async () => {
  const h = harness();
  try {
    h.setFile(writePackage(h.dir));
    unwrap(await h.call('bible:import'));

    const hits = unwrap<{ reference: string; text: string }[]>(
      await h.call('bible:search', { translationId: 'sample', query: 'john one' }),
    );
    assert.ok(hits.length > 0);
    assert.match(hits[0]?.reference ?? '', /^John \d+:\d+$/);
  } finally {
    h.cleanup();
  }
});

// ── validation and roles ────────────────────────────────────────────────────────

test('MALFORMED PAYLOADS ARE REJECTED BEFORE REACHING THE SERVICE', async () => {
  const h = harness();
  try {
    expectFailure(await h.call('bible:lookup', { translationId: 'sample', reference: '' }), 'ipc/invalid-payload');
    expectFailure(await h.call('bible:lookup', { translationId: '../etc', reference: 'John 3' }), 'ipc/invalid-payload');
    expectFailure(await h.call('bible:lookup', { translationId: 'sample' }), 'ipc/invalid-payload');
    expectFailure(await h.call('bible:lookup', { translationId: 'sample', reference: 'x'.repeat(500) }), 'ipc/invalid-payload');

    // Outside the canon: a programming error, not a typo.
    expectFailure(await h.call('bible:chapters', { translationId: 'sample', bookNumber: 0 }), 'ipc/invalid-payload');
    expectFailure(await h.call('bible:chapters', { translationId: 'sample', bookNumber: 67 }), 'ipc/invalid-payload');

    expectFailure(await h.call('bible:search', { translationId: 'sample', query: '' }), 'ipc/invalid-payload');
    expectFailure(await h.call('bible:search', { translationId: 'sample', query: 'a', limit: 0 }), 'ipc/invalid-payload');
    expectFailure(await h.call('bible:search', { translationId: 'sample', query: 'a', limit: 5000 }), 'ipc/invalid-payload');
  } finally {
    h.cleanup();
  }
});

test('THE AUDIENCE OUTPUT AND CONFIDENCE MONITOR CANNOT READ THE BIBLE DIRECTLY', () => {
  /*
   * Scripture reaches the audience the same way lyrics do: inside a cue that already carries its text.
   * The output window is not permitted to query the library, and adding scripture must not have quietly
   * created an exception to that.
   */
  for (const channel of [
    'bible:translations',
    'bible:lookup',
    'bible:books',
    'bible:chapters',
    'bible:search',
    'bible:import',
    'bible:removeTranslation',
  ] as const) {
    assert.equal(isChannelAllowedForRole(channel, 'output'), false, `${channel} must not reach the output`);
    assert.equal(isChannelAllowedForRole(channel, 'confidence'), false, `${channel} must not reach the monitor`);
  }
});

test('IMPORT AND REMOVAL ARE OPERATOR-ONLY', () => {
  // Installing or deleting a translation is a library-changing act; a display must not be able to do it.
  assert.equal(isChannelAllowedForRole('bible:import', 'operator'), true);
  assert.equal(isChannelAllowedForRole('bible:removeTranslation', 'operator'), true);
});

test('the bible channels fail cleanly when the service is absent', async () => {
  // Mirrors the wireless camera: a channel whose service never started must say so specifically rather
  // than looking like an unknown-channel crash.
  const db = openDatabase({ path: ':memory:' });
  try {
    const handlers = createHandlers({
      db,
      live: createLiveStateService(),
      appInfo: () => APP_INFO,
      quit: () => undefined,
      // No bible service.
    });

    const result = await dispatch('bible:translations', undefined, 'operator', { handlers });

    expectFailure(result, 'feature/not-implemented');
  } finally {
    db.close();
  }
});
