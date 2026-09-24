import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openNodeSqlite } from '../src/main/db/node-sqlite-driver.ts';
import {
  MigrationFailure,
  checksum,
  currentVersion,
  migrate,
  verifyIntegrity,
} from '../src/main/db/migrator.ts';
import { APP_SCHEMA_VERSION, MIGRATIONS } from '../src/main/db/migrations/index.ts';
import type { SqliteDriver } from '../src/main/db/driver.ts';

const fresh = (): SqliteDriver => openNodeSqlite({ path: ':memory:' });

const migrated = (): SqliteDriver => {
  const db = fresh();
  migrate(db, MIGRATIONS);
  return db;
};

const tableNames = (db: SqliteDriver): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => String(r['name']));

test('migrations apply cleanly to an empty database', () => {
  const db = fresh();
  assert.equal(currentVersion(db), 0);

  const outcome = migrate(db, MIGRATIONS);

  assert.equal(outcome.fromVersion, 0);
  assert.equal(outcome.toVersion, APP_SCHEMA_VERSION);
  assert.deepEqual(outcome.applied, [1, 2]);
  assert.equal(currentVersion(db), APP_SCHEMA_VERSION);
  db.close();
});

test('every table from Section 28 exists', () => {
  const db = migrated();
  const names = tableNames(db);
  for (const expected of [
    'announcements',
    'bible_books',
    'bible_translations',
    'bible_verses',
    'camera_profiles',
    'church_profile',
    'display_profiles',
    'media_assets',
    'playlist_items',
    'playlists',
    'presentation_slides',
    'presentations',
    'schema_migrations',
    'service_items',
    'services',
    'session_recovery',
    'settings',
    'shortcuts',
    'song_sections',
    'songs',
    'sync_oplog',
    'themes',
  ]) {
    assert.ok(names.includes(expected), `missing table: ${expected}`);
  }
  db.close();
});

test('re-running migrations is a no-op — idempotent', () => {
  const db = migrated();
  const second = migrate(db, MIGRATIONS);
  assert.deepEqual(second.applied, [], 'nothing should re-apply');
  assert.equal(currentVersion(db), APP_SCHEMA_VERSION);
  db.close();
});

test('a database newer than the app is REFUSED, not opened', () => {
  const db = migrated();
  // Simulate a library written by a future build.
  db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  ).run(999, 'from-the-future', 'deadbeef', new Date().toISOString());

  assert.throws(
    () => migrate(db, MIGRATIONS),
    (e: unknown) =>
      e instanceof MigrationFailure &&
      e.failure.code === 'database/schema-newer-than-app' &&
      e.failure.severity === 'fatal',
  );
  db.close();
});

test('editing an already-applied migration is detected', () => {
  const db = migrated();
  const tampered = MIGRATIONS.map((m) =>
    m.version === 1 ? { ...m, sql: `${m.sql}\n-- sneaky edit` } : m,
  );

  assert.throws(
    () => migrate(db, tampered),
    (e: unknown) =>
      e instanceof MigrationFailure && /has changed since it was applied/.test(e.failure.detail ?? ''),
  );
  db.close();
});

test('duplicate migration versions are rejected before anything runs', () => {
  const db = fresh();
  assert.throws(
    () => migrate(db, [...MIGRATIONS, { version: 1, name: 'clash', sql: 'SELECT 1' }]),
    (e: unknown) => e instanceof MigrationFailure && /duplicate migration version/.test(e.failure.detail ?? ''),
  );
  db.close();
});

test('a failing migration rolls back — the database is NOT left half-migrated', () => {
  const db = fresh();
  migrate(db, MIGRATIONS);
  const before = currentVersion(db);

  const broken = [
    ...MIGRATIONS,
    {
      version: 3,
      name: 'broken',
      // First statement is valid, second is not: proves the whole migration reverts.
      sql: 'CREATE TABLE should_not_survive (id TEXT); INSERT INTO nonexistent_table VALUES (1);',
    },
  ];

  assert.throws(
    () => migrate(db, broken),
    (e: unknown) => e instanceof MigrationFailure && e.failure.code === 'database/migration-failed',
  );

  assert.equal(currentVersion(db), before, 'version must not advance');
  assert.ok(
    !tableNames(db).includes('should_not_survive'),
    'the partially-created table must have been rolled back',
  );
  db.close();
});

test('checksum is stable and sensitive', () => {
  assert.equal(checksum('abc'), checksum('abc'));
  assert.notEqual(checksum('abc'), checksum('abd'));
  assert.match(checksum('abc'), /^[0-9a-f]{8}$/);
});

test('integrity check passes on a freshly migrated database', () => {
  const db = migrated();
  const result = verifyIntegrity(db);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  db.close();
});

// ── schema behaviour: the constraints must actually bite ────────────────────────

test('foreign keys are enforced — song_sections cannot orphan', () => {
  const db = migrated();
  assert.throws(
    () =>
      db
        .prepare(
          'INSERT INTO song_sections (id, song_id, kind, label, sort_order, lyrics, slide_break_mode) VALUES (?,?,?,?,?,?,?)',
        )
        .run('sec1', 'no-such-song', 'verse', 'Verse 1', 0, 'x', 'blank-line'),
    /FOREIGN KEY/i,
  );
  db.close();
});

test('deleting a song cascades to its sections and clears the search index', () => {
  const db = migrated();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO songs (id,title,is_favorite,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    'song1',
    'Way Maker',
    0,
    now,
    now,
  );
  db.prepare(
    'INSERT INTO song_sections (id,song_id,kind,label,sort_order,lyrics,slide_break_mode) VALUES (?,?,?,?,?,?,?)',
  ).run('sec1', 'song1', 'chorus', 'Chorus', 0, 'Way maker\nMiracle worker', 'blank-line');
  db.prepare('INSERT INTO songs_fts (song_id,title,lyrics) VALUES (?,?,?)').run(
    'song1',
    'Way Maker',
    'Way maker miracle worker',
  );

  db.prepare('DELETE FROM songs WHERE id = ?').run('song1');

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM song_sections WHERE song_id = ?').get('song1')?.['n'],
    0,
    'sections must cascade',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM songs_fts WHERE song_id = ?').get('song1')?.['n'],
    0,
    'the FTS delete trigger must have fired',
  );
  db.close();
});

test('CHECK constraints reject invalid enum values', () => {
  const db = migrated();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO songs (id,title,is_favorite,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    's1',
    'T',
    0,
    now,
    now,
  );
  assert.throws(
    () =>
      db
        .prepare(
          'INSERT INTO song_sections (id,song_id,kind,label,sort_order,lyrics,slide_break_mode) VALUES (?,?,?,?,?,?,?)',
        )
        .run('x', 's1', 'chorus-ish', 'Bad', 0, '', 'blank-line'),
    /CHECK/i,
  );
  db.close();
});

test('only one display may hold the presentation role', () => {
  const db = migrated();
  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO display_profiles (id,os_display_id,label,role,scale_factor,is_primary,last_seen_at) VALUES (?,?,?,?,?,?,?)',
  );
  insert.run('d1', '100', 'Projector', 'presentation', 1, 0, now);

  assert.throws(
    () => insert.run('d2', '200', 'TV', 'presentation', 1, 0, now),
    /UNIQUE/i,
    'a second presentation display would make the audience screen ambiguous',
  );

  // 'unused' is exempt, since many displays can be unassigned.
  insert.run('d3', '300', 'Laptop', 'unused', 1, 1, now);
  insert.run('d4', '400', 'Spare', 'unused', 1, 0, now);
  db.close();
});

test('two enabled shortcuts cannot share an accelerator', () => {
  const db = migrated();
  assert.throws(
    () => db.prepare('INSERT INTO shortcuts (action,accelerator,enabled) VALUES (?,?,?)').run('live.chaos', 'B', 1),
    /UNIQUE/i,
  );
  // Disabled bindings may collide — they are inert.
  db.prepare('INSERT INTO shortcuts (action,accelerator,enabled) VALUES (?,?,?)').run('live.spare', 'B', 0);
  db.close();
});

test('a playlist item must be exactly one of a service ref or an inline item', () => {
  const db = migrated();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO playlists (id,name,kind,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    'p1',
    'Sunday Morning',
    'template',
    now,
    now,
  );
  const insert = db.prepare(
    'INSERT INTO playlist_items (id,playlist_id,sort_order,service_id,item_json) VALUES (?,?,?,?,?)',
  );
  assert.throws(() => insert.run('i1', 'p1', 0, null, null), /CHECK/i, 'neither is invalid');
  db.prepare('INSERT INTO services (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('sv1', 'S', now, now);
  assert.throws(() => insert.run('i2', 'p1', 0, 'sv1', '{"a":1}'), /CHECK/i, 'both is invalid');
  insert.run('i3', 'p1', 0, 'sv1', null);
  insert.run('i4', 'p1', 1, null, '{"kind":"song"}');
  db.close();
});

test('only one church profile row can exist', () => {
  const db = migrated();
  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO church_profile (id,name,timezone,onboarding_completed,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  );
  insert.run('default', 'Grace Chapel', 'America/New_York', 0, now, now);
  assert.throws(() => insert.run('second', 'Other', 'UTC', 0, now, now), /CHECK/i);
  db.close();
});

test('the six built-in themes from Section 16 are seeded with valid JSON specs', () => {
  const db = migrated();
  const rows = db.prepare('SELECT id, name, spec_json FROM themes WHERE is_builtin = 1 ORDER BY name').all();
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((r) => String(r['name'])),
    ['Announcement', 'Live Worship', 'Minimal Worship', 'Modern Worship', 'Scripture', 'Sermon'],
  );
  for (const row of rows) {
    const spec = JSON.parse(String(row['spec_json'])) as Record<string, Record<string, unknown>>;
    assert.ok(spec['background'], `${String(row['id'])} needs a background`);
    assert.equal(typeof spec['text']!['fontSize'], 'number');
    assert.ok(spec['transition'], `${String(row['id'])} needs a transition`);
  }
  db.close();
});

test('the Live Worship theme is camera-backed and scrimmed for legibility over video', () => {
  const db = migrated();
  const row = db.prepare('SELECT spec_json FROM themes WHERE id = ?').get('theme-live-worship');
  const spec = JSON.parse(String(row?.['spec_json'])) as {
    background: { kind: string };
    textBox: { enabled: boolean; opacity: number };
    text: { outline: { enabled: boolean } };
  };
  assert.equal(spec.background.kind, 'camera');
  assert.equal(spec.textBox.enabled, true);
  assert.ok(spec.textBox.opacity > 0);
  assert.equal(spec.text.outline.enabled, true);
  db.close();
});

test('Section 20 default shortcuts are seeded', () => {
  const db = migrated();
  const rows = db.prepare('SELECT action, accelerator FROM shortcuts').all();
  const byAction = new Map(rows.map((r) => [String(r['action']), String(r['accelerator'])]));
  assert.equal(byAction.get('live.previous'), 'ArrowLeft');
  assert.equal(byAction.get('live.next'), 'ArrowRight');
  assert.equal(byAction.get('live.nextAlt'), 'Space');
  assert.equal(byAction.get('live.black'), 'B');
  assert.equal(byAction.get('live.clear'), 'C');
  assert.equal(byAction.get('live.fullscreen'), 'F');
  assert.equal(byAction.get('live.exitFullscreen'), 'Escape');
  assert.equal(byAction.get('camera.select1'), '1');
  db.close();
});

test('default settings parse as JSON and name real themes', () => {
  const db = migrated();
  const rows = db.prepare('SELECT key, value_json FROM settings').all();
  assert.ok(rows.length >= 10);
  const settings = new Map(rows.map((r) => [String(r['key']), JSON.parse(String(r['value_json']))]));
  assert.equal(settings.get('presentation.defaultThemeId'), 'theme-modern-worship');
  assert.equal(settings.get('presentation.cameraThemeId'), 'theme-live-worship');
  assert.equal(settings.get('presentation.blackOnStartup'), true);
  assert.equal(settings.get('bible.defaultTranslationId'), null);

  for (const key of ['presentation.defaultThemeId', 'presentation.scriptureThemeId', 'presentation.lyricsThemeId', 'presentation.cameraThemeId']) {
    const themeId = settings.get(key) as string;
    const found = db.prepare('SELECT 1 AS ok FROM themes WHERE id = ?').get(themeId);
    assert.ok(found, `${key} points at missing theme ${themeId}`);
  }
  db.close();
});

test('NO Bible translations are bundled — text must be installed under a known licence', () => {
  const db = migrated();
  const count = db.prepare('SELECT COUNT(*) AS n FROM bible_translations').get()?.['n'];
  assert.equal(count, 0, 'shipping copyrighted scripture would be a licensing violation');
  db.close();
});

test('bible_verses uses a composite key and rejects duplicate verses', () => {
  const db = migrated();
  db.prepare(
    'INSERT INTO bible_translations (id,abbreviation,name,language,license,install_state,verse_count) VALUES (?,?,?,?,?,?,?)',
  ).run('kjv', 'KJV', 'King James Version', 'en', 'Public Domain', 'installed', 1);
  const insert = db.prepare(
    'INSERT INTO bible_verses (translation_id,book_number,chapter,verse,text) VALUES (?,?,?,?,?)',
  );
  insert.run('kjv', 43, 3, 16, 'For God so loved the world...');
  assert.throws(() => insert.run('kjv', 43, 3, 16, 'duplicate'), /UNIQUE|PRIMARY KEY/i);
  db.close();
});

test('removing a translation cascades verses and clears its search index', () => {
  const db = migrated();
  db.prepare(
    'INSERT INTO bible_translations (id,abbreviation,name,language,license,install_state,verse_count) VALUES (?,?,?,?,?,?,?)',
  ).run('web', 'WEB', 'World English Bible', 'en', 'Public Domain', 'installed', 2);
  db.prepare('INSERT INTO bible_verses (translation_id,book_number,chapter,verse,text) VALUES (?,?,?,?,?)').run(
    'web',
    43,
    3,
    16,
    'For God so loved the world',
  );
  db.prepare(
    'INSERT INTO bible_verses_fts (translation_id,book_number,chapter,verse,text) VALUES (?,?,?,?,?)',
  ).run('web', 43, 3, 16, 'For God so loved the world');

  db.prepare('DELETE FROM bible_translations WHERE id = ?').run('web');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bible_verses').get()?.['n'], 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bible_verses_fts').get()?.['n'], 0);
  db.close();
});

test('full-text search works over lyrics', () => {
  const db = migrated();
  db.prepare('INSERT INTO songs_fts (song_id,title,lyrics) VALUES (?,?,?)').run(
    'song1',
    'Way Maker',
    'Way maker miracle worker promise keeper light in the darkness',
  );
  db.prepare('INSERT INTO songs_fts (song_id,title,lyrics) VALUES (?,?,?)').run(
    'song2',
    'Great Are You Lord',
    'You give life you are love you bring light to the darkness',
  );

  const hits = db
    .prepare("SELECT song_id FROM songs_fts WHERE songs_fts MATCH ? ORDER BY rank")
    .all('darkness');
  assert.equal(hits.length, 2, 'both songs mention darkness');

  const specific = db
    .prepare("SELECT song_id FROM songs_fts WHERE songs_fts MATCH ?")
    .all('"miracle worker"');
  assert.equal(specific.length, 1);
  assert.equal(specific[0]?.['song_id'], 'song1');
  db.close();
});

test('diacritics are folded, so "Jesús" matches "Jesus"', () => {
  const db = migrated();
  db.prepare('INSERT INTO songs_fts (song_id,title,lyrics) VALUES (?,?,?)').run('s1', 'Jesús Es Mi Rey', 'Alabaré');
  const hits = db.prepare('SELECT song_id FROM songs_fts WHERE songs_fts MATCH ?').all('jesus');
  assert.equal(hits.length, 1, 'unicode61 remove_diacritics 2 should fold the accent');
  db.close();
});

test('transactions roll back on throw, and nested ones use savepoints', () => {
  const db = migrated();
  const now = new Date().toISOString();

  assert.throws(() => {
    db.transaction(() => {
      db.prepare('INSERT INTO songs (id,title,is_favorite,created_at,updated_at) VALUES (?,?,?,?,?)').run(
        'outer',
        'Outer',
        0,
        now,
        now,
      );
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM songs').get()?.['n'], 0, 'outer must roll back');

  // Nested: inner failure is contained, outer still commits.
  db.transaction(() => {
    db.prepare('INSERT INTO songs (id,title,is_favorite,created_at,updated_at) VALUES (?,?,?,?,?)').run(
      'keep',
      'Keep',
      0,
      now,
      now,
    );
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO songs (id,title,is_favorite,created_at,updated_at) VALUES (?,?,?,?,?)').run(
          'drop',
          'Drop',
          0,
          now,
          now,
        );
        throw new Error('inner');
      });
    } catch {
      // swallowed on purpose
    }
  });

  const ids = db.prepare('SELECT id FROM songs ORDER BY id').all().map((r) => String(r['id']));
  assert.deepEqual(ids, ['keep'], 'savepoint should discard only the inner insert');
  db.close();
});

test('the sync oplog exists from day one, with a pending-only index', () => {
  const db = migrated();
  db.prepare(
    'INSERT INTO sync_oplog (entity,entity_id,op,payload_json,local_ts) VALUES (?,?,?,?,?)',
  ).run('songs', 'song1', 'insert', '{}', new Date().toISOString());
  const pending = db.prepare('SELECT COUNT(*) AS n FROM sync_oplog WHERE synced_at IS NULL').get();
  assert.equal(pending?.['n'], 1);
  db.close();
});
