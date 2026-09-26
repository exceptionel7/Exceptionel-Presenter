import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCues, countItemCues, NO_THEMES, type CueThemes } from '../src/shared/domain/cues.ts';
import type { Service, ServiceItem, ServiceItemKind, Song, SongSection } from '../src/shared/domain/entities.ts';

/**
 * EXCEPTIONEL PRESENTER — cue expansion (Phase 3).
 *
 * `buildCues` decides what a congregation will actually see when the operator presses Next. Every
 * test here is about one of two things: that real content becomes the right slides, and that content
 * we cannot present yet produces NOTHING rather than something misleading.
 */

const section = (over: Partial<SongSection> & { label: string; lyrics: string }): SongSection => ({
  id: `sec_${over.label.replace(/\W+/g, '')}`,
  songId: 'song_1',
  kind: 'verse',
  sortOrder: 0,
  slideBreakMode: 'whole-section',
  ...over,
});

const song = (over: Partial<Song> = {}): Song => ({
  id: 'song_1',
  title: 'Way Maker',
  artist: null,
  author: null,
  copyright: null,
  ccliNumber: null,
  songKey: null,
  notes: null,
  category: null,
  isFavorite: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sections: [],
  ...over,
});

const item = (over: Partial<ServiceItem> & { kind: ServiceItemKind; label: string }): ServiceItem => ({
  id: `item_${over.label.replace(/\W+/g, '')}`,
  serviceId: 'svc_1',
  sortOrder: 0,
  refId: null,
  config: {},
  ...over,
});

const service = (items: ServiceItem[], themeId: string | null = null): Pick<Service, 'themeId' | 'items'> => ({
  themeId,
  items,
});

// ── songs become lyric slides ───────────────────────────────────────────────────

test('A SONG BECOMES ONE CUE PER LYRIC SLIDE, NOT ONE PER ITEM', () => {
  // The whole point of Phase 3. Through Phase 2 a song produced a single cue, so pressing Next
  // jumped past the entire song.
  const target = song({
    sections: [
      section({ label: 'Verse 1', lyrics: 'You are here\nmoving in our midst', sortOrder: 0 }),
      section({ label: 'Chorus', kind: 'chorus', lyrics: 'Way maker\nmiracle worker', sortOrder: 1 }),
    ],
  });

  const built = buildCues({
    service: service([item({ kind: 'song', label: 'Way Maker', refId: 'song_1' })]),
    songs: [target],
  });

  assert.equal(built.cues.length, 2);
  assert.deepEqual(built.cues.map((cue) => cue.label), ['Way Maker — Verse 1', 'Way Maker — Chorus']);
  assert.deepEqual(built.cues[0]?.lines, ['You are here', 'moving in our midst']);
  assert.deepEqual(built.cues[1]?.lines, ['Way maker', 'miracle worker']);
  assert.equal(built.skipped.length, 0);
});

test('the slide break mode is respected, so one section can be several slides', () => {
  const target = song({
    sections: [
      section({
        label: 'Verse 1',
        slideBreakMode: 'blank-line',
        lyrics: 'line one\nline two\n\nline three\nline four',
      }),
    ],
  });

  const built = buildCues({
    service: service([item({ kind: 'song', label: 'Way Maker', refId: 'song_1' })]),
    songs: [target],
  });

  assert.equal(built.cues.length, 2, 'a blank line is a slide break');
  assert.deepEqual(built.cues[0]?.lines, ['line one', 'line two']);
  assert.deepEqual(built.cues[1]?.lines, ['line three', 'line four']);
});

test('every cue from a song carries the song title, however deep the running order', () => {
  // An operator scrolled to slide 40 must still be able to see which song they are in.
  const target = song({
    title: 'Great Is Thy Faithfulness',
    sections: [section({ label: 'Verse 2', lyrics: 'Summer and winter', sortOrder: 0 })],
  });

  const built = buildCues({
    service: service([item({ kind: 'song', label: 'anything at all', refId: 'song_1' })]),
    songs: [target],
  });

  assert.equal(built.cues[0]?.label, 'Great Is Thy Faithfulness — Verse 2');
});

test('cue ids are stable across reopening, so an edit does not lose the operator\'s place', () => {
  // LiveStateService re-points the live cue by id. Random ids would throw the operator back to
  // black every time the running order was touched mid-service.
  const target = song({ sections: [section({ label: 'Verse 1', lyrics: 'a' })] });
  const svc = service([item({ kind: 'song', label: 'Way Maker', refId: 'song_1' })]);

  const first = buildCues({ service: svc, songs: [target] });
  const second = buildCues({ service: svc, songs: [target] });
  assert.deepEqual(first.cues.map((cue) => cue.id), second.cues.map((cue) => cue.id));
});

test('generated cue ids stay inside the length the IPC validator allows', () => {
  const target = song({ sections: [section({ label: 'Verse 1', lyrics: 'a' })] });
  const built = buildCues({
    service: service([item({ id: `item_${'x'.repeat(200)}`, kind: 'song', label: 'Long', refId: 'song_1' })]),
    songs: [target],
  });

  const id = built.cues[0]?.id ?? '';
  assert.ok(id.length <= 64, `cue id must fit vId(): got ${String(id.length)}`);
  assert.match(id, /^[A-Za-z0-9_-]+$/, 'and must match the validator pattern');
});

// ── what must NOT reach the audience ────────────────────────────────────────────

test('A HEADER PRODUCES NO CUE AND IS NOT REPORTED AS A PROBLEM', () => {
  const built = buildCues({
    service: service([item({ kind: 'header', label: 'Welcome' })]),
    songs: [],
  });
  assert.equal(built.cues.length, 0, 'a header is an operator divider');
  assert.equal(built.skipped.length, 0, 'and was never meant to reach a screen, so it is not a fault');
});

test('UNBUILT FEATURES PRODUCE NO CUE AND NAME THEIR PHASE', () => {
  /*
   * The rule that matters most in this file. An unimplemented item must not produce a slide reading
   * "not implemented" — the congregation must never be shown the state of our backlog. It must also
   * not vanish silently, or the operator finds out by pressing Next and watching nothing happen.
   */
  const built = buildCues({
    service: service([
      item({ kind: 'scripture', label: 'John 3:16', sortOrder: 0 }),
      item({ kind: 'image', label: 'Sermon Slide', sortOrder: 1 }),
      item({ kind: 'video', label: 'Bumper', sortOrder: 2 }),
      item({ kind: 'announcement', label: 'Youth Night', sortOrder: 3 }),
      item({ kind: 'slide', label: 'Custom', sortOrder: 4 }),
    ]),
    songs: [],
  });

  assert.equal(built.cues.length, 0, 'nothing presentable');
  assert.equal(built.skipped.length, 5, 'but every one is accounted for');

  for (const entry of built.skipped) {
    assert.equal(entry.reason.code, 'not-implemented');
    assert.match(entry.reason.phase ?? '', /^Phase \d+$/, `${entry.kind} must name its phase`);
    assert.ok(entry.reason.detail.length > 20, 'and explain what is missing');
    assert.ok(entry.label.length > 0, 'and be identifiable in the running order');
  }

  const byKind = new Map(built.skipped.map((entry) => [entry.kind, entry.reason.phase]));
  assert.equal(byKind.get('scripture'), 'Phase 4');
  assert.equal(byKind.get('image'), 'Phase 5');
  assert.equal(byKind.get('video'), 'Phase 5');
});

test('a song deleted after the service was built is reported, not guessed at', () => {
  const built = buildCues({
    service: service([item({ kind: 'song', label: 'Way Maker', refId: 'song_gone' })]),
    songs: [],
  });

  assert.equal(built.cues.length, 0);
  assert.equal(built.skipped[0]?.reason.code, 'missing-song');
  assert.match(built.skipped[0]?.reason.detail ?? '', /no longer in the library/);
});

test('a song item with no link to the library is reported', () => {
  const built = buildCues({
    service: service([item({ kind: 'song', label: 'Untitled', refId: null })]),
    songs: [],
  });
  assert.equal(built.skipped[0]?.reason.code, 'missing-song');
});

test('a song with no lyrics yet is reported rather than presenting a blank slide', () => {
  const built = buildCues({
    service: service([item({ kind: 'song', label: 'New Song', refId: 'song_1' })]),
    songs: [song({ title: 'New Song', sections: [section({ label: 'Verse 1', lyrics: '   \n\n  ' })] })],
  });

  assert.equal(built.cues.length, 0, 'whitespace is not a slide');
  assert.equal(built.skipped[0]?.reason.code, 'empty-song');
  assert.match(built.skipped[0]?.reason.detail ?? '', /New Song/, 'the reason names the song');
});

// ── camera scenes are presentable now ───────────────────────────────────────────

test('A CAMERA SCENE IS PRESENTABLE, WITH NO TEXT', () => {
  // The wireless camera layer is real and verified on hardware, so this is not a stub.
  const built = buildCues({
    service: service([item({ kind: 'camera_scene', label: 'Pastor Camera' })]),
    songs: [],
  });

  assert.equal(built.cues.length, 1);
  assert.equal(built.cues[0]?.kind, 'camera');
  assert.deepEqual(built.cues[0]?.lines, [], 'empty is honest — there is nothing to read');
  assert.equal(built.skipped.length, 0);
});

// ── themes ──────────────────────────────────────────────────────────────────────

const THEMES: CueThemes = {
  default: 'theme-default',
  lyrics: 'theme-lyrics',
  scripture: 'theme-scripture',
  camera: 'theme-camera',
};

test('each kind of cue gets its own theme', () => {
  const built = buildCues({
    service: service([
      item({ kind: 'song', label: 'Way Maker', refId: 'song_1', sortOrder: 0 }),
      item({ kind: 'camera_scene', label: 'Pastor Camera', sortOrder: 1 }),
    ]),
    songs: [song({ sections: [section({ label: 'Verse 1', lyrics: 'a' })] })],
    themes: THEMES,
  });

  assert.equal(built.cues[0]?.themeId, 'theme-lyrics');
  assert.equal(built.cues[1]?.themeId, 'theme-camera');
});

test('a kind-specific theme outranks a theme set on the service', () => {
  // Someone who has chosen a lyrics theme means it for every service. A per-service theme is the
  // fallback for kinds that have no choice of their own.
  const built = buildCues({
    service: service([item({ kind: 'song', label: 'Way Maker', refId: 'song_1' })], 'theme-christmas'),
    songs: [song({ sections: [section({ label: 'Verse 1', lyrics: 'a' })] })],
    themes: THEMES,
  });
  assert.equal(built.cues[0]?.themeId, 'theme-lyrics');
});

test('a service theme is used when no kind-specific theme is configured', () => {
  const built = buildCues({
    service: service([item({ kind: 'song', label: 'Way Maker', refId: 'song_1' })], 'theme-christmas'),
    songs: [song({ sections: [section({ label: 'Verse 1', lyrics: 'a' })] })],
    themes: { ...NO_THEMES, default: 'theme-app-default' },
  });
  assert.equal(built.cues[0]?.themeId, 'theme-christmas', 'the service wins over the app default');
});

test('with nothing configured at all the cue theme is null, not a guess', () => {
  const built = buildCues({
    service: service([item({ kind: 'song', label: 'Way Maker', refId: 'song_1' })]),
    songs: [song({ sections: [section({ label: 'Verse 1', lyrics: 'a' })] })],
  });
  assert.equal(built.cues[0]?.themeId, null);
});

// ── notes ───────────────────────────────────────────────────────────────────────

test('speaker notes travel to every cue the item produces', () => {
  // The confidence monitor shows them; the audience screen never does.
  const built = buildCues({
    service: service([
      item({
        kind: 'song',
        label: 'Way Maker',
        refId: 'song_1',
        config: { notes: 'Key change after the bridge' },
        sortOrder: 0,
      }),
      item({ kind: 'camera_scene', label: 'Pastor Camera', sortOrder: 1 }),
    ]),
    songs: [
      song({
        sections: [
          section({ label: 'Verse 1', lyrics: 'a', sortOrder: 0 }),
          section({ label: 'Chorus', kind: 'chorus', lyrics: 'b', sortOrder: 1 }),
        ],
      }),
    ],
  });

  assert.equal(built.cues[0]?.notes, 'Key change after the bridge');
  assert.equal(built.cues[1]?.notes, 'Key change after the bridge', 'every slide of the song');
  assert.equal(built.cues[2]?.notes, undefined, 'and nothing invented for items without notes');
});

test('blank notes are omitted rather than carried as empty strings', () => {
  const built = buildCues({
    service: service([item({ kind: 'camera_scene', label: 'Camera', config: { notes: '   ' } })]),
    songs: [],
  });
  assert.equal(built.cues[0]?.notes, undefined);
});

// ── ordering and counting ───────────────────────────────────────────────────────

test('cues follow the running order', () => {
  const built = buildCues({
    service: service([
      item({ id: 'item_a', kind: 'camera_scene', label: 'First', sortOrder: 0 }),
      item({ id: 'item_b', kind: 'camera_scene', label: 'Second', sortOrder: 1 }),
    ]),
    songs: [],
  });
  assert.deepEqual(built.cues.map((cue) => cue.label), ['First', 'Second']);
});

test('countItemCues agrees with what Next will actually step through', () => {
  /*
   * Derived from buildCues rather than reimplemented. Two counting rules would eventually disagree,
   * and the operator would be told a song has more slides than the engine will play.
   */
  const target = song({
    sections: [
      section({ label: 'Verse 1', slideBreakMode: 'blank-line', lyrics: 'a\n\nb\n\nc', sortOrder: 0 }),
      section({ label: 'Chorus', kind: 'chorus', lyrics: 'd', sortOrder: 1 }),
    ],
  });
  const songItem = item({ kind: 'song', label: 'Way Maker', refId: 'song_1' });

  const built = buildCues({ service: service([songItem]), songs: [target] });
  assert.equal(countItemCues(songItem, [target]), built.cues.length);
  assert.equal(countItemCues(songItem, [target]), 4);

  assert.equal(countItemCues(item({ kind: 'scripture', label: 'John 3:16' }), []), 0);
  assert.equal(countItemCues(item({ kind: 'header', label: 'Welcome' }), []), 0);
});

test('an empty service produces nothing and complains about nothing', () => {
  const built = buildCues({ service: service([]), songs: [] });
  assert.deepEqual(built.cues, []);
  assert.deepEqual(built.skipped, []);
});
