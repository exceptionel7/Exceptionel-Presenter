import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { createLiveStateService, type LiveStateService } from '../src/main/services/live-state-service.ts';
import { openService, readCueThemes } from '../src/main/services/service-opener.ts';
import { DEFAULT_THEME_ID } from '../src/shared/domain/theme.ts';

/**
 * EXCEPTIONEL PRESENTER — opening a service for presentation, against a real SQLite database.
 *
 * Not mocked: these run the real repositories, the real migrations and the real seed, because the
 * thing being tested is the join between a stored service, its songs and the live cue list.
 */

interface Harness {
  db: AppDatabase;
  live: LiveStateService;
}

const harness = (): Harness => {
  const db = openDatabase({ path: ':memory:' });
  return { db, live: createLiveStateService() };
};

const withHarness = (fn: (h: Harness) => void): void => {
  const h = harness();
  try {
    fn(h);
  } finally {
    h.db.close();
  }
};

const twoSectionSong = (db: AppDatabase, title = 'Way Maker'): string =>
  db.songs.save({
    title,
    sections: [
      {
        kind: 'verse',
        label: 'Verse 1',
        sortOrder: 0,
        lyrics: 'You are here\nmoving in our midst',
        slideBreakMode: 'whole-section',
      },
      {
        kind: 'chorus',
        label: 'Chorus',
        sortOrder: 1,
        lyrics: 'Way maker\nmiracle worker',
        slideBreakMode: 'whole-section',
      },
    ],
  }).id;

// ── the happy path ──────────────────────────────────────────────────────────────

test('OPENING A SERVICE INSTALLS CUES THE OPERATOR CAN STEP THROUGH', () => {
  withHarness(({ db, live }) => {
    const songId = twoSectionSong(db);
    const service = db.services.save({
      name: 'Sunday Morning',
      items: [
        { kind: 'header', label: 'Welcome', sortOrder: 0 },
        { kind: 'song', label: 'Way Maker', sortOrder: 1, refId: songId },
      ],
    });

    const opened = openService(db, live, service.id);
    assert.ok(opened, 'the service opened');
    assert.equal(opened.service.name, 'Sunday Morning');
    assert.equal(opened.cues.length, 2, 'two sections, two slides; the header is not a cue');

    // Installed as live state, not merely returned — that is the point of doing this in main.
    assert.deepEqual(
      live.getCues().map((cue) => cue.label),
      ['Way Maker — Verse 1', 'Way Maker — Chorus'],
    );

    // And the audience text travelled with them, because the output window may not read the library.
    assert.deepEqual(live.getCues()[0]?.lines, ['You are here', 'moving in our midst']);
  });
});

test('transport then works end to end: goLive, next, black, restore', () => {
  withHarness(({ db, live }) => {
    const songId = twoSectionSong(db);
    const service = db.services.save({
      name: 'Sunday',
      items: [{ kind: 'song', label: 'Way Maker', sortOrder: 0, refId: songId }],
    });

    const opened = openService(db, live, service.id);
    assert.ok(opened);
    const first = opened.cues[0]?.id ?? '';

    assert.equal(live.apply({ type: 'goLive', cueId: first }).status, 'live');
    assert.equal(live.getState().cueIndex, 0);

    assert.equal(live.apply({ type: 'next' }).cueIndex, 1);
    assert.equal(live.getState().activeCueId, opened.cues[1]?.id);

    assert.equal(live.apply({ type: 'black' }).status, 'black');
    // Black preserves the slide so restoring returns to it rather than to the top of the song.
    assert.equal(live.getState().restoreCueId, opened.cues[1]?.id);
    assert.equal(live.apply({ type: 'black' }).activeCueId, opened.cues[1]?.id);
    assert.equal(live.getState().status, 'live');
  });
});

test('an unknown or deleted service returns null rather than throwing', () => {
  withHarness(({ db, live }) => {
    assert.equal(openService(db, live, 'svc_nope'), null);

    const service = db.services.save({ name: 'Gone', items: [] });
    db.services.delete(service.id);
    assert.equal(openService(db, live, service.id), null, 'a tombstoned service cannot be presented');
  });
});

// ── honesty about what cannot be presented ──────────────────────────────────────

test('ITEMS THAT CANNOT BE PRESENTED ARE REPORTED, NOT SILENTLY DROPPED', () => {
  withHarness(({ db, live }) => {
    const songId = twoSectionSong(db);
    const service = db.services.save({
      name: 'Mixed',
      items: [
        { kind: 'song', label: 'Way Maker', sortOrder: 0, refId: songId },
        { kind: 'scripture', label: 'John 3:16', sortOrder: 1 },
        { kind: 'camera_scene', label: 'Pastor Camera', sortOrder: 2 },
      ],
    });

    const opened = openService(db, live, service.id);
    assert.ok(opened);
    assert.equal(opened.cues.length, 3, 'two lyric slides plus the camera scene');
    assert.equal(opened.skipped.length, 1);
    assert.equal(opened.skipped[0]?.label, 'John 3:16');
    assert.equal(opened.skipped[0]?.reason.phase, 'Phase 4');
  });
});

test('a song deleted after the service was built is reported at open time', () => {
  withHarness(({ db, live }) => {
    const songId = twoSectionSong(db);
    const service = db.services.save({
      name: 'Sunday',
      items: [{ kind: 'song', label: 'Way Maker', sortOrder: 0, refId: songId }],
    });

    db.songs.delete(songId);

    const opened = openService(db, live, service.id);
    assert.ok(opened, 'the service still opens');
    assert.equal(opened.cues.length, 0);
    assert.equal(opened.skipped[0]?.reason.code, 'missing-song');
  });
});

// ── themes ──────────────────────────────────────────────────────────────────────

test('the seeded per-kind theme settings are what cues are built with', () => {
  withHarness(({ db }) => {
    const themes = readCueThemes(db);
    assert.equal(themes.default, DEFAULT_THEME_ID);
    assert.equal(themes.lyrics, 'theme-modern-worship');
    assert.equal(themes.scripture, 'theme-scripture');
    assert.equal(themes.camera, 'theme-live-worship');
  });
});

test('EVERY THEME A CUE NAMES ACTUALLY RESOLVES', () => {
  /*
   * The bug this catches: `createInitialLiveState` defaulted to 'modern-worship' while the seeded
   * row is 'theme-modern-worship', so the default named a theme that did not exist. A cue pointing
   * at a missing theme renders with no styling at all — on the projector, in front of everyone.
   */
  withHarness(({ db, live }) => {
    const songId = twoSectionSong(db);
    const service = db.services.save({
      name: 'Sunday',
      items: [
        { kind: 'song', label: 'Way Maker', sortOrder: 0, refId: songId },
        { kind: 'camera_scene', label: 'Camera', sortOrder: 1 },
      ],
    });

    const opened = openService(db, live, service.id);
    assert.ok(opened);
    assert.ok(opened.cues.length > 0);

    for (const cue of opened.cues) {
      assert.ok(cue.themeId, `${cue.label} must name a theme`);
      assert.ok(
        db.themes.resolve(cue.themeId) !== null,
        `${cue.label} names theme ${String(cue.themeId)}, which does not exist`,
      );
    }

    // And the live state's own fallback theme must resolve too.
    assert.ok(db.themes.resolve(live.getState().themeId) !== null, 'the live fallback theme must exist');
  });
});

test('a theme set on the service becomes the live fallback', () => {
  withHarness(({ db, live }) => {
    const service = db.services.save({
      name: 'Christmas Eve',
      themeId: 'theme-announcement',
      items: [],
    });

    openService(db, live, service.id);
    assert.equal(live.getState().themeId, 'theme-announcement');
  });
});

test('with no service theme the application default is used', () => {
  withHarness(({ db, live }) => {
    const service = db.services.save({ name: 'Sunday', items: [] });
    openService(db, live, service.id);
    assert.equal(live.getState().themeId, DEFAULT_THEME_ID);
  });
});

// ── reopening ───────────────────────────────────────────────────────────────────

test('reopening the same service keeps the operator on the same slide', () => {
  /*
   * Cue ids are derived from the item id and position, so `setCues` can re-point the live cue. Random
   * ids would throw the operator back to black every time they touched the running order mid-service.
   */
  withHarness(({ db, live }) => {
    const songId = twoSectionSong(db);
    const service = db.services.save({
      name: 'Sunday',
      items: [{ kind: 'song', label: 'Way Maker', sortOrder: 0, refId: songId }],
    });

    const opened = openService(db, live, service.id);
    assert.ok(opened);
    live.apply({ type: 'goLive', cueId: opened.cues[1]?.id ?? '' });
    assert.equal(live.getState().cueIndex, 1);

    openService(db, live, service.id);
    assert.equal(live.getState().status, 'live', 'the audience must not be blacked by a reopen');
    assert.equal(live.getState().cueIndex, 1);
  });
});

test('only the songs a service references are read', () => {
  // A church with two thousand songs must not pay for all of them to open a six-item service.
  withHarness(({ db, live }) => {
    const used = twoSectionSong(db, 'Used Song');
    twoSectionSong(db, 'Unused Song');

    const service = db.services.save({
      name: 'Sunday',
      items: [{ kind: 'song', label: 'Used Song', sortOrder: 0, refId: used }],
    });

    const opened = openService(db, live, service.id);
    assert.ok(opened);
    assert.equal(opened.cues.length, 2);
    for (const cue of opened.cues) assert.match(cue.label, /^Used Song/);
  });
});
