import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';

const open = (): AppDatabase => openDatabase({ path: ':memory:' });

const wayMaker = {
  title: 'Way Maker',
  artist: 'Sinach',
  sections: [
    { kind: 'chorus', label: 'Chorus', sortOrder: 0, lyrics: 'Way maker\nMiracle worker', slideBreakMode: 'blank-line' },
  ],
};

// ── device identity ─────────────────────────────────────────────────────────────

test('a device identity is created on first access and is stable', () => {
  const db = open();
  const first = db.identity.get();
  assert.match(first.deviceId, /^[0-9a-f]{32}$/);
  assert.equal(first.lamportCounter, 0);
  assert.equal(first.upstreamUri, null);
  assert.equal(db.identity.get().deviceId, first.deviceId, 'must not regenerate');
  db.close();
});

test('two separate libraries get DIFFERENT device ids', () => {
  // The id is generated on first access rather than in the migration. If the migration
  // generated it, a restored backup would carry the SAME id as the machine it came from,
  // and two devices sharing an id breaks tie-breaking.
  const a = open();
  const b = open();
  assert.notEqual(a.identity.get().deviceId, b.identity.get().deviceId);
  a.close();
  b.close();
});

test('a fresh library is authoritative until an upstream is set', () => {
  const db = open();
  assert.equal(db.identity.isAuthoritative(), true);

  db.identity.setUpstream('file:///Volumes/Share/library.db');
  assert.equal(db.identity.isAuthoritative(), false);
  assert.equal(db.identity.get().upstreamUri, 'file:///Volumes/Share/library.db');

  db.identity.setUpstream(null);
  assert.equal(db.identity.isAuthoritative(), true, 'a replica can be promoted back');
  db.close();
});

test('a device can be labelled for display', () => {
  const db = open();
  assert.equal(db.identity.setLabel('Booth PC').deviceLabel, 'Booth PC');
  db.close();
});

// ── the Lamport clock ───────────────────────────────────────────────────────────

test('every write advances the revision, and revisions never repeat', () => {
  const db = open();
  const seen: number[] = [];

  const song = db.songs.save(wayMaker);
  seen.push(revisionOf(db, song.id));

  db.songs.setFavorite(song.id, true);
  seen.push(revisionOf(db, song.id));

  db.songs.save({ id: song.id, title: 'Way Maker (Live)', sections: [] });
  seen.push(revisionOf(db, song.id));

  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]! > seen[i - 1]!, `revision must increase: ${seen.join(' -> ')}`);
  }
  db.close();
});

test('the counter is shared across entity types, giving one library-wide order', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  const service = db.services.save({ name: 'Sunday', items: [] });
  const theme = db.themes.save({ name: 'Custom', spec: {} });

  const songRev = revisionOf(db, song.id);
  const serviceRev = Number(
    db.driver.prepare('SELECT revision FROM services WHERE id = ?').get(service.id)?.['revision'],
  );
  const themeRev = Number(
    db.driver.prepare('SELECT revision FROM themes WHERE id = ?').get(theme.id)?.['revision'],
  );

  assert.ok(serviceRev > songRev, 'a later write to another table still sorts after');
  assert.ok(themeRev > serviceRev);
  db.close();
});

test('observing a remote revision jumps our counter past it', () => {
  const db = open();
  db.songs.save(wayMaker);
  const before = db.identity.get().lamportCounter;

  db.identity.observe(before + 500);
  const song = db.songs.save({ title: 'Later', sections: [] });

  assert.ok(
    revisionOf(db, song.id) > before + 500,
    'a local edit after a pull must sort after the pulled change',
  );
  db.close();
});

test('observing an older or invalid revision never moves the counter backwards', () => {
  const db = open();
  db.identity.observe(100);
  const counter = db.identity.get().lamportCounter;

  for (const bad of [50, 0, -1, 1.5, Number.NaN]) db.identity.observe(bad);
  assert.equal(db.identity.get().lamportCounter, counter);
  db.close();
});

test('a rolled-back write rolls back the counter too — no revision gaps', () => {
  const db = open();
  const before = db.identity.get().lamportCounter;

  assert.throws(() => {
    db.transaction(() => {
      db.songs.save({ title: 'Doomed', sections: [] });
      throw new Error('rolled back');
    });
  }, /rolled back/);

  assert.equal(
    db.identity.get().lamportCounter,
    before,
    'a gap in revisions would look like a lost change during a pull',
  );
  db.close();
});

// ── tombstones: the resurrection bug this exists to prevent ─────────────────────

test('THE WHOLE POINT — a delete leaves a durable record, not an absence', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.delete(song.id);

  // With a hard delete, the only evidence would be an oplog row. Prune that, or have a
  // replica miss it, and the song silently comes back on the next pull. A tombstone is
  // evidence that survives independently of the change log.
  const row = db.driver
    .prepare('SELECT deleted_at, revision, origin_device_id FROM songs WHERE id = ?')
    .get(song.id);

  assert.ok(row, 'the tombstone must exist');
  assert.notEqual(row?.['deleted_at'], null);
  assert.equal(row?.['origin_device_id'], db.identity.get().deviceId, 'we know which machine deleted it');
  db.close();
});

test('a delete raises the revision, so it beats an earlier edit elsewhere', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  const editRevision = revisionOf(db, song.id);

  db.songs.delete(song.id);
  assert.ok(revisionOf(db, song.id) > editRevision, 'deleting is an edit and must sort later');
  db.close();
});

test('deleting twice is idempotent and does not double-log', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.delete(song.id);
  const afterFirst = revisionOf(db, song.id);

  db.songs.delete(song.id);
  assert.equal(revisionOf(db, song.id), afterFirst, 'a replayed delete must be a no-op');

  const deleteOps = db.driver
    .prepare("SELECT COUNT(*) AS n FROM sync_oplog WHERE entity='songs' AND op='delete'")
    .get();
  assert.equal(deleteOps?.['n'], 1);
  db.close();
});

test('deleting something that never existed is not an error', () => {
  const db = open();
  assert.doesNotThrow(() => db.songs.delete('song_nope'));
  assert.doesNotThrow(() => db.services.delete('svc_nope'));
  db.close();
});

// ── restore ─────────────────────────────────────────────────────────────────────

test('a deleted song can be restored intact, because nothing was destroyed', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.delete(song.id);

  const restored = db.songs.restore(song.id);
  assert.ok(restored, 'restore must succeed');
  assert.equal(restored?.title, 'Way Maker');
  assert.equal(restored?.sections.length, 1);
  assert.equal(restored?.sections[0]?.lyrics, 'Way maker\nMiracle worker');

  assert.equal(db.songs.list({}).length, 1, 'back in the library');
  assert.equal(db.songs.list({ search: 'miracle' }).length, 1, 'and back in the search index');
  db.close();
});

test('restoring something that is not deleted returns null', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  assert.equal(db.songs.restore(song.id), null);
  assert.equal(db.songs.restore('song_nope'), null);
  db.close();
});

test('deleted items are listable for a recovery view', () => {
  const db = open();
  const keep = db.songs.save({ title: 'Keep', sections: [] });
  const drop = db.songs.save({ title: 'Drop', sections: [] });
  db.songs.delete(drop.id);

  const deleted = db.songs.listDeleted();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]?.id, drop.id);
  assert.equal(db.songs.list({}).map((s) => s.id).includes(keep.id), true);
  db.close();
});

// ── a tombstone must not block reuse ───────────────────────────────────────────

test('a THEME NAME becomes reusable after deletion', () => {
  const db = open();
  const first = db.themes.save({ name: 'Christmas', spec: {} });
  db.themes.delete(first.id);

  // Without the partial UNIQUE index (WHERE deleted_at IS NULL), the tombstone would
  // permanently occupy the name and this would fail.
  const second = db.themes.save({ name: 'Christmas', spec: {} });
  assert.notEqual(second.id, first.id);
  assert.equal(db.themes.list().filter((t) => t.name === 'Christmas').length, 1);
  db.close();
});

test('a MEDIA HASH becomes reusable after deletion, so a file can be re-imported', () => {
  const db = open();
  const now = new Date().toISOString();
  const insert = db.driver.prepare(
    `INSERT INTO media_assets (id, kind, filename, abs_path, mime, bytes, hash, is_favorite, created_at, updated_at, revision)
     VALUES (?, 'image', 'bg.jpg', '/media/bg.jpg', 'image/jpeg', 100, 'abc123', 0, ?, ?, 1)`,
  );
  insert.run('media_1', now, now);

  // Duplicate hash while live is still rejected.
  assert.throws(() => insert.run('media_2', now, now), /UNIQUE/i);

  db.driver.prepare('UPDATE media_assets SET deleted_at = ? WHERE id = ?').run(now, 'media_1');

  // Re-importing the identical file after deleting it must work.
  assert.doesNotThrow(() => insert.run('media_3', now, now));
  db.close();
});

test('a deleted song frees nothing else but disappears from categories', () => {
  const db = open();
  const song = db.songs.save({ title: 'Hymn', category: 'Hymns', sections: [] });
  assert.deepEqual(db.songs.categories(), ['Hymns']);

  db.songs.delete(song.id);
  assert.deepEqual(db.songs.categories(), [], 'a tombstoned song must not keep its category alive');
  db.close();
});

// ── editing a tombstone is refused ──────────────────────────────────────────────

test('a deleted song cannot be edited — it must be restored first', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.delete(song.id);

  // Silently undeleting on save would let one machine's edit quietly override another
  // machine's deliberate delete.
  assert.throws(
    () => db.songs.save({ id: song.id, title: 'Sneaky', sections: [] }),
    /has been deleted — restore it first/,
  );
  db.close();
});

test('a deleted service cannot be edited or reordered', () => {
  const db = open();
  const service = db.services.save({
    name: 'Sunday',
    items: [{ kind: 'header', label: 'A', sortOrder: 0 }],
  });
  const itemId = service.items[0]!.id;
  db.services.delete(service.id);

  assert.throws(() => db.services.save({ id: service.id, name: 'X', items: [] }), /restore it first/);
  assert.throws(() => db.services.reorder(service.id, [itemId]), /does not exist/);
  db.close();
});

test('a new service item cannot reference a DELETED song', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.delete(song.id);

  assert.throws(
    () =>
      db.services.save({
        name: 'Broken',
        items: [{ kind: 'song', label: 'Way Maker', sortOrder: 0, refId: song.id }],
      }),
    /does not exist/,
    'adding a song to a service after someone deleted it would create a broken item',
  );
  db.close();
});

test('an EXISTING service keeps its reference when a song is deleted', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  const service = db.services.save({
    name: 'Sunday',
    items: [{ kind: 'song', label: 'Way Maker', sortOrder: 0, refId: song.id }],
  });

  db.songs.delete(song.id);

  // Losing Sunday's running order because a song was deleted would be far worse than one
  // item needing to be re-picked. And since the song is only tombstoned, restoring it
  // repairs the service completely.
  const reloaded = db.services.get(service.id);
  assert.equal(reloaded?.items.length, 1);
  assert.equal(reloaded?.items[0]?.refId, song.id);

  db.songs.restore(song.id);
  assert.ok(db.songs.get(song.id), 'restoring the song repairs the reference');
  db.close();
});

// ── compaction ──────────────────────────────────────────────────────────────────

test('purging old tombstones hard-deletes them and cascades children', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.delete(song.id);

  // Nothing purged while the tombstone is newer than the cutoff.
  assert.equal(db.songs.purgeTombstones('2000-01-01T00:00:00.000Z'), 0);
  assert.equal(db.songs.listDeleted().length, 1);

  const purged = db.songs.purgeTombstones('2100-01-01T00:00:00.000Z');
  assert.equal(purged, 1);
  assert.equal(db.songs.listDeleted().length, 0);
  assert.equal(
    db.driver.prepare('SELECT COUNT(*) AS n FROM song_sections').get()?.['n'],
    0,
    'the hard delete must cascade sections',
  );
  db.close();
});

test('purging never touches live rows', () => {
  const db = open();
  db.songs.save({ title: 'Live One', sections: [] });
  const doomed = db.songs.save({ title: 'Doomed', sections: [] });
  db.songs.delete(doomed.id);

  db.songs.purgeTombstones('2100-01-01T00:00:00.000Z');
  assert.equal(db.songs.list({}).length, 1);
  assert.equal(db.songs.list({})[0]?.title, 'Live One');
  db.close();
});

// ── settings scope ──────────────────────────────────────────────────────────────

test('settings are scoped automatically from their key', () => {
  const db = open();
  db.settings.set('presentation.defaultThemeId', 'theme-scripture');
  db.settings.set('display.presentationId', '12345');

  const scopes = new Map(
    db.driver
      .prepare('SELECT key, scope FROM settings WHERE key IN (?, ?)')
      .all('presentation.defaultThemeId', 'display.presentationId')
      .map((r) => [String(r['key']), String(r['scope'])]),
  );
  assert.equal(scopes.get('presentation.defaultThemeId'), 'library');
  assert.equal(scopes.get('display.presentationId'), 'device');
  db.close();
});

test('librarySettings EXCLUDES machine-bound settings', () => {
  const db = open();
  db.settings.set('display.presentationId', '12345');
  db.settings.set('app.theme', 'dark');
  db.settings.set('presentation.defaultThemeId', 'theme-scripture');

  const library = db.settings.librarySettings();
  assert.equal(library['presentation.defaultThemeId'], 'theme-scripture');
  assert.equal('display.presentationId' in library, false, 'pulling must not reassign the projector');
  assert.equal('app.theme' in library, false);
  assert.equal('autosave.debounceMs' in library, false);
  assert.equal('confidence.showTimer' in library, false);
  db.close();
});

test('re-setting a key keeps its scope correct', () => {
  const db = open();
  db.settings.set('presentation.aspectRatio', '4:3');
  assert.equal(db.settings.scopeOf('presentation.aspectRatio'), 'device');
  const row = db.driver.prepare('SELECT scope FROM settings WHERE key = ?').get('presentation.aspectRatio');
  assert.equal(row?.['scope'], 'device', 'the projector shape belongs to the room, not the library');
  db.close();
});

// ── the oplog now carries ordering ──────────────────────────────────────────────

test('every oplog entry carries the revision and origin device', () => {
  const db = open();
  const song = db.songs.save(wayMaker);
  db.songs.delete(song.id);

  const ops = db.driver
    .prepare("SELECT op, revision, origin_device_id FROM sync_oplog WHERE entity='songs' ORDER BY id")
    .all();

  assert.equal(ops.length, 2);
  const deviceId = db.identity.get().deviceId;
  for (const op of ops) {
    assert.ok(Number(op['revision']) > 0, 'a pull must be able to order this without a clock');
    assert.equal(op['origin_device_id'], deviceId);
  }
  assert.ok(Number(ops[1]!['revision']) > Number(ops[0]!['revision']));
  db.close();
});

function revisionOf(db: AppDatabase, songId: string): number {
  return Number(db.driver.prepare('SELECT revision FROM songs WHERE id = ?').get(songId)?.['revision']);
}
