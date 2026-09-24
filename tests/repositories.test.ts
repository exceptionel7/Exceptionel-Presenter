import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { BASE_THEME_SPEC, mergeSpec } from '../src/main/db/repositories/themes.ts';
import { escapeLike, ftsQuery, newId } from '../src/main/db/repositories/support.ts';

const open = (): AppDatabase => openDatabase({ path: ':memory:' });

const wayMaker = {
  title: 'Way Maker',
  artist: 'Sinach',
  ccliNumber: '7115744',
  songKey: 'E',
  sections: [
    {
      kind: 'verse',
      label: 'Verse 1',
      sortOrder: 0,
      lyrics: 'You are here\nMoving in our midst',
      slideBreakMode: 'blank-line',
    },
    {
      kind: 'chorus',
      label: 'Chorus',
      sortOrder: 1,
      lyrics: 'Way maker\nMiracle worker\nPromise keeper\nLight in the darkness',
      slideBreakMode: 'blank-line',
    },
  ],
};

// ── facade ──────────────────────────────────────────────────────────────────────

test('openDatabase migrates, seeds and reports a clean integrity check', () => {
  const db = open();
  assert.equal(db.schemaVersion, 2);
  assert.deepEqual(db.migration.applied, [1, 2]);
  assert.deepEqual(db.integrityProblems, []);
  assert.equal(db.themes.list().length, 6);
  db.close();
});

test('newId produces prefixed, vId-safe identifiers', () => {
  const id = newId('song');
  assert.match(id, /^song_[0-9a-f]{32}$/);
  assert.notEqual(newId('song'), newId('song'));
});

// ── settings ────────────────────────────────────────────────────────────────────

test('settings round-trip every JSON type', () => {
  const db = open();
  const cases: [string, unknown][] = [
    ['a.string', 'hello'],
    ['a.number', 42],
    ['a.zero', 0],
    ['a.true', true],
    ['a.false', false],
    ['a.null', null],
    ['a.object', { nested: { deep: [1, 2, 3] } }],
    ['a.array', ['x', 'y']],
  ];
  for (const [key, value] of cases) {
    db.settings.set(key, value);
    assert.deepEqual(db.settings.get(key, 'MISSING'), value, `${key} should round-trip`);
  }
  db.close();
});

test('false and 0 survive — they must not be mistaken for a missing value', () => {
  const db = open();
  db.settings.set('x.flag', false);
  assert.equal(db.settings.get('x.flag', true), false, 'stored false must beat the fallback');
  db.settings.set('x.count', 0);
  assert.equal(db.settings.get('x.count', 99), 0);
  db.close();
});

test('settings.set upserts rather than duplicating', () => {
  const db = open();
  db.settings.set('app.theme', 'light');
  db.settings.set('app.theme', 'dark');
  assert.equal(db.settings.get('app.theme', ''), 'dark');
  db.close();
});

test('seeded defaults are readable through the repository', () => {
  const db = open();
  const all = db.settings.getAll();
  assert.equal(all['presentation.defaultThemeId'], 'theme-modern-worship');
  assert.equal(all['presentation.blackOnStartup'], true);
  assert.equal(all['bible.defaultTranslationId'], null);
  db.close();
});

test('a corrupt settings value degrades to the fallback instead of throwing', () => {
  const db = open();
  // Simulate disk corruption or a hand-edited database.
  db.driver
    .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
    .run('broken.key', '{not valid json', new Date().toISOString());
  assert.equal(db.settings.get('broken.key', 'fallback'), 'fallback');
  assert.doesNotThrow(() => db.settings.getAll());
  db.close();
});

// ── church profile ──────────────────────────────────────────────────────────────

test('church profile is created, updated and completes onboarding', () => {
  const db = open();
  assert.equal(db.profile.get(), null, 'no profile before first run');

  const created = db.profile.save({ name: 'Grace Chapel', timezone: 'America/New_York' });
  assert.equal(created.name, 'Grace Chapel');
  assert.equal(created.onboardingCompleted, false);

  const renamed = db.profile.save({ name: 'Grace Community Chapel', timezone: 'America/Chicago' });
  assert.equal(renamed.name, 'Grace Community Chapel');
  assert.equal(renamed.timezone, 'America/Chicago');

  const done = db.profile.completeOnboarding();
  assert.equal(done.onboardingCompleted, true);

  const count = db.driver.prepare('SELECT COUNT(*) AS n FROM church_profile').get();
  assert.equal(count?.['n'], 1, 'saving twice must not create a second profile');
  db.close();
});

test('onboarding cannot complete before a profile exists', () => {
  const db = open();
  assert.throws(() => db.profile.completeOnboarding(), /before a profile exists/);
  db.close();
});

// ── shortcuts ───────────────────────────────────────────────────────────────────

test('shortcuts seed with the Section 20 defaults', () => {
  const db = open();
  const bindings = db.shortcuts.list();
  const byAction = new Map(bindings.map((b) => [b.action, b.accelerator]));
  assert.equal(byAction.get('live.black'), 'B');
  assert.equal(byAction.get('live.next'), 'ArrowRight');
  assert.equal(bindings.length, 15);
  db.close();
});

test('rebinding a key in use disables the previous holder instead of erroring', () => {
  const db = open();
  // 'B' currently belongs to live.black. Give it to live.clear.
  const after = db.shortcuts.set({ action: 'live.clear', accelerator: 'B', enabled: true });
  const byAction = new Map(after.map((b) => [b.action, b]));
  assert.equal(byAction.get('live.clear')?.accelerator, 'B');
  assert.equal(byAction.get('live.clear')?.enabled, true);
  assert.equal(byAction.get('live.black')?.enabled, false, 'the old owner must be disabled');
  db.close();
});

test('resetDefaults restores the seeded set and drops custom actions', () => {
  const db = open();
  db.shortcuts.set({ action: 'custom.thing', accelerator: 'CommandOrControl+J', enabled: true });
  db.shortcuts.set({ action: 'live.black', accelerator: 'K', enabled: true });

  const reset = db.shortcuts.resetDefaults();
  const byAction = new Map(reset.map((b) => [b.action, b.accelerator]));
  assert.equal(byAction.get('live.black'), 'B', 'default restored');
  assert.equal(byAction.has('custom.thing'), false, 'custom action removed');
  assert.equal(reset.length, 15);
  db.close();
});

// ── songs ───────────────────────────────────────────────────────────────────────

test('a song saves with its sections and reads back in order', () => {
  const db = open();
  const saved = db.songs.save(wayMaker);

  assert.match(saved.id, /^song_/);
  assert.equal(saved.title, 'Way Maker');
  assert.equal(saved.artist, 'Sinach');
  assert.equal(saved.ccliNumber, '7115744');
  assert.equal(saved.sections.length, 2);
  assert.equal(saved.sections[0]?.label, 'Verse 1');
  assert.equal(saved.sections[1]?.label, 'Chorus');
  assert.equal(saved.sections[1]?.lyrics.split('\n').length, 4, 'line breaks preserved');

  const reloaded = db.songs.get(saved.id);
  assert.deepEqual(reloaded, saved);
  db.close();
});

test('sortOrder is derived from array position, not trusted from the client', () => {
  const db = open();
  const saved = db.songs.save({
    title: 'Reordered',
    // Deliberately gappy and out of order, as drag-and-drop tends to produce.
    sections: [
      { kind: 'chorus', label: 'Chorus', sortOrder: 99, lyrics: 'c', slideBreakMode: 'blank-line' },
      { kind: 'verse', label: 'Verse 1', sortOrder: 5, lyrics: 'v', slideBreakMode: 'blank-line' },
    ],
  });
  assert.deepEqual(saved.sections.map((s) => s.sortOrder), [0, 1]);
  assert.deepEqual(saved.sections.map((s) => s.label), ['Chorus', 'Verse 1']);
  db.close();
});

test('updating a song replaces its sections wholesale', () => {
  const db = open();
  const saved = db.songs.save(wayMaker);
  const updated = db.songs.save({
    id: saved.id,
    title: 'Way Maker',
    sections: [{ kind: 'bridge', label: 'Bridge', sortOrder: 0, lyrics: 'b', slideBreakMode: 'whole-section' }],
  });
  assert.equal(updated.sections.length, 1);
  assert.equal(updated.sections[0]?.kind, 'bridge');
  const orphans = db.driver.prepare('SELECT COUNT(*) AS n FROM song_sections').get();
  assert.equal(orphans?.['n'], 1, 'old sections must be gone, not orphaned');
  db.close();
});

test('updating a nonexistent song is refused rather than silently inserting', () => {
  const db = open();
  assert.throws(
    () => db.songs.save({ id: 'song_doesnotexist', title: 'Ghost', sections: [] }),
    /does not exist/,
  );
  db.close();
});

test('search finds a song by lyric phrase, title and artist', () => {
  const db = open();
  db.songs.save(wayMaker);
  db.songs.save({
    title: 'Great Are You Lord',
    artist: 'All Sons & Daughters',
    sections: [{ kind: 'chorus', label: 'Chorus', sortOrder: 0, lyrics: 'You give life, You are love', slideBreakMode: 'blank-line' }],
  });

  assert.equal(db.songs.list({ search: 'miracle worker' })[0]?.title, 'Way Maker');
  assert.equal(db.songs.list({ search: 'Sinach' })[0]?.title, 'Way Maker');
  assert.equal(db.songs.list({ search: 'great' })[0]?.title, 'Great Are You Lord');
  assert.equal(db.songs.list({ search: 'zzzznothing' }).length, 0);
  db.close();
});

test('search matches mid-word, which FTS prefix matching alone would miss', () => {
  const db = open();
  db.songs.save(wayMaker);
  // 'aker' is not a token prefix, so only the LIKE arm can find it.
  assert.equal(db.songs.list({ search: 'aker' })[0]?.title, 'Way Maker');
  db.close();
});

test('the search index follows an edit — stale lyrics stop matching', () => {
  const db = open();
  const saved = db.songs.save(wayMaker);
  assert.equal(db.songs.list({ search: 'miracle' }).length, 1);

  db.songs.save({
    id: saved.id,
    title: 'Way Maker',
    sections: [{ kind: 'verse', label: 'Verse 1', sortOrder: 0, lyrics: 'Completely different words', slideBreakMode: 'blank-line' }],
  });

  assert.equal(db.songs.list({ search: 'miracle' }).length, 0, 'removed lyrics must leave the index');
  assert.equal(db.songs.list({ search: 'different' }).length, 1, 'new lyrics must enter the index');
  db.close();
});

test('a renamed song is findable by its new title only', () => {
  const db = open();
  const saved = db.songs.save({ title: 'Old Title', sections: [] });
  db.songs.save({ id: saved.id, title: 'Brand New Title', sections: [] });
  assert.equal(db.songs.list({ search: 'Brand New' }).length, 1);
  assert.equal(db.songs.list({ search: 'Old Title' }).length, 0);
  db.close();
});

test('search input containing FTS and LIKE metacharacters is handled literally', () => {
  const db = open();
  db.songs.save(wayMaker);
  // None of these should throw or match everything.
  for (const query of ['%', '_', 'way OR maker', 'NEAR(a b)', '"', 'a*', 'col:val', '\\']) {
    assert.doesNotThrow(() => db.songs.list({ search: query }), `query ${JSON.stringify(query)} threw`);
  }
  assert.equal(db.songs.list({ search: '%' }).length, 0, 'a bare % must not match every song');
  db.close();
});

test('deleting a song removes its sections and its search index entry', () => {
  const db = open();
  const saved = db.songs.save(wayMaker);
  db.songs.delete(saved.id);

  assert.equal(db.songs.get(saved.id), null);
  assert.equal(db.driver.prepare('SELECT COUNT(*) AS n FROM song_sections').get()?.['n'], 0);
  assert.equal(db.driver.prepare('SELECT COUNT(*) AS n FROM songs_fts').get()?.['n'], 0);
  assert.equal(db.songs.list({ search: 'miracle' }).length, 0);
  db.close();
});

test('deleting a missing song is a no-op, not an error', () => {
  const db = open();
  assert.doesNotThrow(() => db.songs.delete('song_nope'));
  db.close();
});

test('duplicate copies sections, renames, and is independently searchable', () => {
  const db = open();
  const original = db.songs.save({ ...wayMaker, isFavorite: true });
  const copy = db.songs.duplicate(original.id);

  assert.notEqual(copy.id, original.id);
  assert.equal(copy.title, 'Way Maker (Copy)');
  assert.equal(copy.isFavorite, false, 'a copy should not inherit favourite status');
  assert.equal(copy.sections.length, 2);
  assert.notEqual(copy.sections[0]?.id, original.sections[0]?.id, 'sections need fresh ids');

  assert.equal(db.songs.list({ search: 'miracle worker' }).length, 2, 'both copies searchable');

  // Editing the copy must not touch the original.
  db.songs.save({ id: copy.id, title: 'Copy Edited', sections: [] });
  assert.equal(db.songs.get(original.id)?.sections.length, 2);
  db.close();
});

test('favourites sort first and can be filtered', () => {
  const db = open();
  db.songs.save({ title: 'Aaa Not Favourite', sections: [] });
  const fav = db.songs.save({ title: 'Zzz Favourite', sections: [] });
  db.songs.setFavorite(fav.id, true);

  const all = db.songs.list({});
  assert.equal(all[0]?.title, 'Zzz Favourite', 'favourites lead the list despite alphabetical order');

  const onlyFavs = db.songs.list({ favoritesOnly: true });
  assert.equal(onlyFavs.length, 1);
  assert.equal(onlyFavs[0]?.id, fav.id);

  db.songs.setFavorite(fav.id, false);
  assert.equal(db.songs.list({ favoritesOnly: true }).length, 0);
  db.close();
});

test('category filter and category listing work', () => {
  const db = open();
  db.songs.save({ title: 'Hymn A', category: 'Hymns', sections: [] });
  db.songs.save({ title: 'Modern B', category: 'Contemporary', sections: [] });
  db.songs.save({ title: 'Uncategorised', sections: [] });

  assert.equal(db.songs.list({ category: 'Hymns' }).length, 1);
  assert.deepEqual(db.songs.categories(), ['Contemporary', 'Hymns']);
  db.close();
});

test('summaries count sections without loading lyrics', () => {
  const db = open();
  db.songs.save(wayMaker);
  const summary = db.songs.list({})[0];
  assert.equal(summary?.sectionCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(summary ?? {}, 'sections'), false);
  db.close();
});

test('pagination caps limit and applies offset', () => {
  const db = open();
  for (let i = 0; i < 5; i++) db.songs.save({ title: `Song ${i}`, sections: [] });
  assert.equal(db.songs.list({ limit: 2 }).length, 2);
  assert.equal(db.songs.list({ limit: 2, offset: 4 }).length, 1);
  assert.equal(db.songs.list({ limit: 99_999 }).length, 5, 'an absurd limit must be clamped, not fail');
  db.close();
});

// ── services ────────────────────────────────────────────────────────────────────

test('a service saves with ordered items and reads back', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  const service = db.services.save({
    name: 'Sunday Service',
    serviceDate: '2026-09-27',
    items: [
      { kind: 'header', label: 'Welcome', sortOrder: 0 },
      { kind: 'song', label: 'Way Maker', sortOrder: 1, refId: song.id },
      { kind: 'scripture', label: 'John 3:16', sortOrder: 2, config: { reference: 'John 3:16' } },
    ],
  });

  assert.equal(service.items.length, 3);
  assert.deepEqual(service.items.map((i) => i.sortOrder), [0, 1, 2]);
  assert.equal(service.items[1]?.refId, song.id);
  assert.deepEqual(service.items[2]?.config, { reference: 'John 3:16' });
  db.close();
});

test('a service item referencing a nonexistent song is REFUSED before any write', () => {
  const db = open();
  assert.throws(
    () =>
      db.services.save({
        name: 'Broken',
        items: [{ kind: 'song', label: 'Ghost', sortOrder: 0, refId: 'song_missing' }],
      }),
    /references songs row "song_missing", which does not exist/,
  );
  assert.equal(db.services.list().length, 0, 'nothing may be persisted when validation fails');
  db.close();
});

test('validation happens before writing, so a late bad item leaves no partial service', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  assert.throws(() =>
    db.services.save({
      name: 'Partial',
      items: [
        { kind: 'song', label: 'Good', sortOrder: 0, refId: song.id },
        { kind: 'image', label: 'Bad', sortOrder: 1, refId: 'media_missing' },
      ],
    }),
  );
  assert.equal(db.driver.prepare('SELECT COUNT(*) AS n FROM service_items').get()?.['n'], 0);
  db.close();
});

test('kinds without a reference need no ref_id', () => {
  const db = open();
  const service = db.services.save({
    name: 'No Refs',
    items: [
      { kind: 'header', label: 'Divider', sortOrder: 0 },
      { kind: 'scripture', label: 'Psalm 23', sortOrder: 1, config: { reference: 'Psalm 23:1-6' } },
    ],
  });
  assert.equal(service.items.every((i) => i.refId === null), true);
  db.close();
});

test('reorder rewrites positions', () => {
  const db = open();
  const service = db.services.save({
    name: 'Order Me',
    items: [
      { kind: 'header', label: 'A', sortOrder: 0 },
      { kind: 'header', label: 'B', sortOrder: 1 },
      { kind: 'header', label: 'C', sortOrder: 2 },
    ],
  });
  const [a, b, c] = service.items.map((i) => i.id) as [string, string, string];

  const reordered = db.services.reorder(service.id, [c, a, b]);
  assert.deepEqual(reordered.items.map((i) => i.label), ['C', 'A', 'B']);
  assert.deepEqual(reordered.items.map((i) => i.sortOrder), [0, 1, 2]);
  db.close();
});

test('a partial reorder list is refused — it would scramble the running order', () => {
  const db = open();
  const service = db.services.save({
    name: 'Order Me',
    items: [
      { kind: 'header', label: 'A', sortOrder: 0 },
      { kind: 'header', label: 'B', sortOrder: 1 },
    ],
  });
  const first = service.items[0]!.id;

  assert.throws(() => db.services.reorder(service.id, [first]), /every item exactly once/);
  assert.throws(() => db.services.reorder(service.id, [first, first]), /every item exactly once/);
  assert.deepEqual(
    db.services.get(service.id)?.items.map((i) => i.label),
    ['A', 'B'],
    'order must be untouched after a refused reorder',
  );
  db.close();
});

test('deleting a service cascades its items', () => {
  const db = open();
  const service = db.services.save({
    name: 'Temp',
    items: [{ kind: 'header', label: 'A', sortOrder: 0 }],
  });
  db.services.delete(service.id);
  assert.equal(db.services.get(service.id), null);
  assert.equal(db.driver.prepare('SELECT COUNT(*) AS n FROM service_items').get()?.['n'], 0);
  db.close();
});

test('deleting a song used by a service does not delete the service', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  const service = db.services.save({
    name: 'Sunday',
    items: [{ kind: 'song', label: 'Way Maker', sortOrder: 0, refId: song.id }],
  });

  db.songs.delete(song.id);

  // ref_id is not a foreign key, so the item survives as a dangling reference. The
  // service must still open — losing Sunday's order of service because a song was
  // deleted would be far worse than one item that needs re-picking.
  const reloaded = db.services.get(service.id);
  assert.ok(reloaded, 'the service must still exist');
  assert.equal(reloaded?.items.length, 1);
  assert.equal(reloaded?.items[0]?.refId, song.id, 'the dangling ref is preserved for repair');
  db.close();
});

test('services list newest-first with item counts', () => {
  const db = open();
  db.services.save({ name: 'Older', serviceDate: '2026-01-04', items: [] });
  db.services.save({
    name: 'Newer',
    serviceDate: '2026-09-27',
    items: [{ kind: 'header', label: 'A', sortOrder: 0 }],
  });
  const list = db.services.list();
  assert.equal(list[0]?.name, 'Newer');
  assert.equal(list[0]?.itemCount, 1);
  assert.equal(list[1]?.itemCount, 0);
  db.close();
});

// ── themes ──────────────────────────────────────────────────────────────────────

test('built-in themes cannot be modified or deleted', () => {
  const db = open();
  assert.throws(
    () => db.themes.save({ id: 'theme-scripture', name: 'Hacked', spec: {} }),
    /built-in theme and cannot be modified/,
  );
  assert.throws(() => db.themes.delete('theme-scripture'), /cannot be deleted/);
  db.close();
});

test('a custom theme inherits from a built-in and overrides one field', () => {
  const db = open();
  const custom = db.themes.save({
    name: 'Our Scripture',
    parentThemeId: 'theme-scripture',
    spec: { text: { color: '#FFD700' } as never },
  });
  assert.equal(custom.isBuiltin, false);

  const resolved = db.themes.resolve(custom.id);
  assert.equal(resolved?.text.color, '#FFD700', 'the override wins');
  assert.equal(resolved?.text.align, 'left', 'unspecified fields come from the Scripture parent');
  assert.equal(resolved?.text.fontSize, 64, 'parent font size survives');
  assert.equal(resolved?.text.shadow.enabled, true, 'nested groups merge rather than being wiped');
  db.close();
});

test('resolve always returns a complete spec, even for a theme with an empty spec', () => {
  const db = open();
  const bare = db.themes.save({ name: 'Bare', spec: {} });
  const resolved = db.themes.resolve(bare.id);
  assert.ok(resolved);
  assert.equal(typeof resolved?.text.fontSize, 'number');
  assert.ok(resolved?.background.kind);
  assert.ok(resolved?.transition.kind);
  db.close();
});

test('self-inheritance and cycles are rejected', () => {
  const db = open();
  const a = db.themes.save({ name: 'A', spec: {} });
  const b = db.themes.save({ name: 'B', parentThemeId: a.id, spec: {} });

  assert.throws(() => db.themes.save({ id: a.id, name: 'A', parentThemeId: a.id, spec: {} }), /cannot inherit from itself/);
  assert.throws(
    () => db.themes.save({ id: a.id, name: 'A', parentThemeId: b.id, spec: {} }),
    /cycle/,
    'A inheriting from B, which already inherits from A, must be refused',
  );
  db.close();
});

test('a theme still inherited by others cannot be deleted', () => {
  const db = open();
  const parent = db.themes.save({ name: 'Parent', spec: {} });
  db.themes.save({ name: 'Child', parentThemeId: parent.id, spec: {} });
  assert.throws(() => db.themes.delete(parent.id), /inherited by 1 other theme/);
  db.close();
});

test('a three-level chain resolves nearest-wins', () => {
  const db = open();
  const level1 = db.themes.save({ name: 'L1', spec: { text: { fontSize: 100, color: '#111111' } as never } });
  const level2 = db.themes.save({ name: 'L2', parentThemeId: level1.id, spec: { text: { color: '#222222' } as never } });
  const level3 = db.themes.save({ name: 'L3', parentThemeId: level2.id, spec: { text: { fontWeight: 900 } as never } });

  const resolved = db.themes.resolve(level3.id);
  assert.equal(resolved?.text.fontSize, 100, 'from L1');
  assert.equal(resolved?.text.color, '#222222', 'L2 overrides L1');
  assert.equal(resolved?.text.fontWeight, 900, 'from L3');
  db.close();
});

test('mergeSpec preserves sibling fields inside nested groups', () => {
  const merged = mergeSpec(BASE_THEME_SPEC, { text: { shadow: { blur: 99 } } as never });
  assert.equal(merged.text.shadow.blur, 99);
  assert.equal(merged.text.shadow.enabled, BASE_THEME_SPEC.text.shadow.enabled);
  assert.equal(merged.text.shadow.color, BASE_THEME_SPEC.text.shadow.color);
  assert.equal(merged.text.fontSize, BASE_THEME_SPEC.text.fontSize);
});

test('resolve returns null for an unknown theme', () => {
  const db = open();
  assert.equal(db.themes.resolve('theme-nope'), null);
  db.close();
});

// ── crash recovery ──────────────────────────────────────────────────────────────

test('a clean shutdown offers nothing to recover', () => {
  const db = open();
  const session = db.recovery.beginSession(null, 'Sunday Service');
  db.recovery.heartbeat(session, { cueIndex: 3 }, null, 'Sunday Service');
  db.recovery.markCleanShutdown(session);
  assert.equal(db.recovery.findRecoverable(), null);
  db.close();
});

test('an unclean session with work is offered for recovery', () => {
  const db = open();
  const service = db.services.save({ name: 'Sunday Service', items: [] });
  const session = db.recovery.beginSession(service.id, service.name);
  db.recovery.heartbeat(session, { cueIndex: 4, status: 'live' }, service.id, service.name);

  const recoverable = db.recovery.findRecoverable();
  assert.ok(recoverable, 'a crash must be detected');
  assert.equal(recoverable?.serviceName, 'Sunday Service');
  assert.equal(recoverable?.snapshot['cueIndex'], 4);
  assert.equal(recoverable?.cleanShutdown, false);
  db.close();
});

test('a crash before any work is NOT offered — that prompt would be noise', () => {
  const db = open();
  db.recovery.beginSession(null, null);
  assert.equal(db.recovery.findRecoverable(), null, 'an empty snapshot is not worth recovering');
  db.close();
});

test('the most recent crashed session wins', () => {
  const db = open();
  const older = db.recovery.beginSession(null, 'Older');
  db.recovery.heartbeat(older, { n: 1 }, null, 'Older');
  const newer = db.recovery.beginSession(null, 'Newer');
  db.recovery.heartbeat(newer, { n: 2 }, null, 'Newer');
  assert.equal(db.recovery.findRecoverable()?.serviceName, 'Newer');
  db.close();
});

test('discarding keeps the snapshot row but stops offering it', () => {
  const db = open();
  const session = db.recovery.beginSession(null, 'Sunday');
  db.recovery.heartbeat(session, { n: 1 }, null, 'Sunday');
  const found = db.recovery.findRecoverable()!;

  db.recovery.discard(found.id);
  assert.equal(db.recovery.findRecoverable(), null, 'no longer offered');
  assert.equal(
    db.driver.prepare('SELECT COUNT(*) AS n FROM session_recovery WHERE id = ?').get(found.id)?.['n'],
    1,
    'declining once must not destroy the snapshot',
  );
  db.close();
});

test('prune bounds the recovery table', () => {
  const db = open();
  for (let i = 0; i < 30; i++) {
    const id = db.recovery.beginSession(null, `S${i}`);
    db.recovery.heartbeat(id, { i }, null, `S${i}`);
  }
  db.recovery.prune(5);
  assert.equal(db.driver.prepare('SELECT COUNT(*) AS n FROM session_recovery').get()?.['n'], 5);
  db.close();
});

// ── cross-repository behaviour ──────────────────────────────────────────────────

test('every write records a sync oplog entry inside the same transaction', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.setFavorite(song.id, true);
  db.songs.delete(song.id);

  const ops = db.driver
    .prepare('SELECT entity, op FROM sync_oplog WHERE entity = ? ORDER BY id')
    .all('songs')
    .map((r) => String(r['op']));
  assert.deepEqual(ops, ['insert', 'update', 'delete']);
  db.close();
});

test('a facade transaction rolls back across repositories together', () => {
  const db = open();
  assert.throws(() => {
    db.transaction(() => {
      db.songs.save({ title: 'Should Vanish', sections: [] });
      db.services.save({ name: 'Should Also Vanish', items: [] });
      throw new Error('service build failed halfway');
    });
  }, /halfway/);

  assert.equal(db.songs.list({}).length, 0);
  assert.equal(db.services.list().length, 0);
  assert.equal(db.driver.prepare('SELECT COUNT(*) AS n FROM sync_oplog').get()?.['n'], 0, 'the oplog must roll back too');
  db.close();
});

// ── helpers ─────────────────────────────────────────────────────────────────────

test('escapeLike neutralises wildcards', () => {
  assert.equal(escapeLike('100%'), '100\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('back\\slash'), 'back\\\\slash');
});

test('ftsQuery quotes terms and prefix-matches the last one', () => {
  assert.equal(ftsQuery('way maker'), '"way" "maker"*');
  assert.equal(ftsQuery('  '), '');
  assert.equal(ftsQuery('a"b'), '"ab"*', 'embedded quotes are stripped, not escaped into syntax');
});
