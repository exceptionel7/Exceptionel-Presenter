/**
 * EXCEPTIONEL PRESENTER — the media library index, against real SQLite.
 *
 * Real migrations, the real partial UNIQUE index on the content hash, the real tombstone columns.
 * Nothing is mocked: the de-duplication guarantee IS the index, so a fake driver would prove nothing
 * about it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import type { MediaAssetInput } from '../src/main/db/repositories/media.ts';

const withDb = (fn: (db: AppDatabase) => void): void => {
  const db = openDatabase({ path: ':memory:' });
  try {
    fn(db);
  } finally {
    db.close();
  }
};

const input = (overrides: Partial<MediaAssetInput> = {}): MediaAssetInput => ({
  kind: 'image',
  filename: 'sunrise.jpg',
  absPath: '/userData/media/aaaaaaaaaaaa_sunrise.jpg',
  mime: 'image/jpeg',
  bytes: 2048,
  hash: 'a'.repeat(64),
  ...overrides,
});

// ── adding ──────────────────────────────────────────────────────────────────────

test('an imported file becomes a row with everything import knew about it', () => {
  withDb((db) => {
    const added = db.media.add(
      input({ width: 1920, height: 1080, category: 'Backgrounds', durationMs: null }),
    );

    assert.equal(added.created, true);
    assert.match(added.asset.id, /^media_/);
    assert.equal(added.asset.kind, 'image');
    assert.equal(added.asset.filename, 'sunrise.jpg');
    assert.equal(added.asset.bytes, 2048);
    assert.equal(added.asset.width, 1920);
    assert.equal(added.asset.height, 1080);
    assert.equal(added.asset.durationMs, null);
    assert.equal(added.asset.category, 'Backgrounds');
    assert.equal(added.asset.isFavorite, false);
    assert.equal(added.asset.hash, 'a'.repeat(64));
    // Both timestamps are set at insert, so ordering by either works from the first import.
    assert.ok(added.asset.createdAt !== '');
    assert.equal(added.asset.updatedAt, added.asset.createdAt);
  });
});

test('the same bytes imported twice produce ONE row', () => {
  withDb((db) => {
    const first = db.media.add(input({ filename: 'background.jpg' }));
    // Same hash, different name — the memory-stick-twice case.
    const second = db.media.add(input({ filename: 'background (1).jpg' }));

    assert.equal(first.created, true);
    assert.equal(second.created, false, 'a duplicate must be recognised, not inserted');
    assert.equal(second.asset.id, first.asset.id);
    // The existing row is returned UNCHANGED: the operator's own name and category survive a
    // re-import. Overwriting them would silently undo their filing.
    assert.equal(second.asset.filename, 'background.jpg');
    assert.equal(db.media.count(), 1);
  });
});

test('different bytes with the same name are two separate assets', () => {
  withDb((db) => {
    const a = db.media.add(input({ hash: 'a'.repeat(64), absPath: '/userData/media/a_bg.jpg' }));
    const b = db.media.add(input({ hash: 'b'.repeat(64), absPath: '/userData/media/b_bg.jpg' }));

    assert.notEqual(a.asset.id, b.asset.id);
    assert.equal(db.media.count(), 2);
  });
});

test('every kind the schema allows can actually be stored', () => {
  withDb((db) => {
    // The CHECK constraint and the MediaKind union have to agree; if one drifts, this fails.
    for (const [index, kind] of (['image', 'video', 'audio', 'background', 'logo'] as const).entries()) {
      const added = db.media.add(
        input({ kind, hash: String(index).repeat(64).slice(0, 64), absPath: `/userData/media/${kind}` }),
      );
      assert.equal(added.asset.kind, kind);
    }
    assert.equal(db.media.count(), 5);
  });
});

test('an insert is recorded in the sync log, so it can propagate', () => {
  withDb((db) => {
    const added = db.media.add(input());
    const ops = db.driver
      .prepare("SELECT entity, entity_id, op, revision FROM sync_oplog WHERE entity = 'media_assets'")
      .all();

    assert.equal(ops.length, 1);
    assert.equal(ops[0]?.['entity_id'], added.asset.id);
    assert.equal(ops[0]?.['op'], 'insert');
    // Without a revision the entry cannot be ordered against changes from another machine.
    assert.ok(Number(ops[0]?.['revision'] ?? 0) > 0, 'a logged change needs a Lamport revision');
  });
});

test('a recognised duplicate adds nothing to the sync log', () => {
  withDb((db) => {
    db.media.add(input());
    db.media.add(input({ filename: 'copy.jpg' }));

    const ops = db.driver
      .prepare("SELECT COUNT(*) AS n FROM sync_oplog WHERE entity = 'media_assets'")
      .get();
    // A no-op must not travel to other machines as a change.
    assert.equal(Number(ops?.['n'] ?? 0), 1);
  });
});

// ── reading ─────────────────────────────────────────────────────────────────────

test('lookup by hash finds live rows only', () => {
  withDb((db) => {
    const added = db.media.add(input());
    assert.equal(db.media.findByHash('a'.repeat(64))?.id, added.asset.id);
    assert.equal(db.media.findByHash('f'.repeat(64)), null);
    // An empty hash must not match every row with a NULL hash.
    assert.equal(db.media.findByHash(''), null);

    db.media.delete(added.asset.id);
    assert.equal(db.media.findByHash('a'.repeat(64)), null, 'a tombstone is not a hit');
  });
});

test('listing filters by kind, category and favourites, and searches the name', () => {
  withDb((db) => {
    const still = db.media.add(
      input({ kind: 'image', filename: 'Mountain Sunrise.jpg', hash: '1'.repeat(64), absPath: '/m/1', category: 'Nature' }),
    ).asset;
    const clip = db.media.add(
      input({ kind: 'video', filename: 'worship-loop.mp4', hash: '2'.repeat(64), absPath: '/m/2', category: 'Loops' }),
    ).asset;
    db.media.add(
      input({ kind: 'audio', filename: 'prelude.mp3', hash: '3'.repeat(64), absPath: '/m/3' }),
    );

    assert.deepEqual(
      db.media.list({ kind: 'video' }).map((asset) => asset.id),
      [clip.id],
    );
    assert.deepEqual(
      db.media.list({ category: 'Nature' }).map((asset) => asset.id),
      [still.id],
    );
    // Case-insensitive substring, mid-word: an operator types what they remember, not a prefix.
    assert.deepEqual(
      db.media.list({ search: 'sunrise' }).map((asset) => asset.id),
      [still.id],
    );
    assert.deepEqual(
      db.media.list({ search: 'LOOP' }).map((asset) => asset.id),
      [clip.id],
    );
    // The category is searched too, so "Loops" finds the clip filed under it.
    assert.equal(db.media.list({ search: 'Loops' }).length, 1);

    db.media.setFavorite(clip.id, true);
    assert.deepEqual(
      db.media.list({ favoritesOnly: true }).map((asset) => asset.id),
      [clip.id],
    );
    assert.equal(db.media.list({}).length, 3);
  });
});

test('LIKE wildcards typed by the operator are literal, not a pattern', () => {
  withDb((db) => {
    db.media.add(input({ filename: '100% Live.jpg', hash: '1'.repeat(64), absPath: '/m/1' }));
    db.media.add(input({ filename: 'anything.jpg', hash: '2'.repeat(64), absPath: '/m/2' }));

    // Unescaped, `%` would match every row and the operator would think search is broken.
    assert.equal(db.media.list({ search: '%' }).length, 1);
    assert.equal(db.media.list({ search: '100%' }).length, 1);
    // `_` is LIKE's single-character wildcard.
    assert.equal(db.media.list({ search: '_' }).length, 0);
  });
});

test('favourites sort first, then newest, so the operator sees what they use', () => {
  withDb((db) => {
    const first = db.media.add(input({ hash: '1'.repeat(64), absPath: '/m/1' })).asset;
    const second = db.media.add(input({ hash: '2'.repeat(64), absPath: '/m/2' })).asset;
    const third = db.media.add(input({ hash: '3'.repeat(64), absPath: '/m/3' })).asset;

    db.media.setFavorite(first.id, true);

    const ids = db.media.list({}).map((asset) => asset.id);
    assert.equal(ids[0], first.id, 'a favourite comes first even though it is the oldest');
    assert.deepEqual(new Set(ids.slice(1)), new Set([second.id, third.id]));
  });
});

test('paging is bounded, so a bad limit cannot try to load the whole library', () => {
  withDb((db) => {
    for (let index = 0; index < 5; index += 1) {
      db.media.add(input({ hash: String(index).repeat(64).slice(0, 64), absPath: `/m/${String(index)}` }));
    }

    assert.equal(db.media.list({ limit: 2 }).length, 2);
    assert.equal(db.media.list({ limit: 2, offset: 4 }).length, 1);
    assert.equal(db.media.list({ limit: 0 }).length, 1, 'a zero limit is clamped to at least one');
    assert.equal(db.media.list({ limit: -5 }).length, 1);
  });
});

// ── mutating ────────────────────────────────────────────────────────────────────

test('favouriting and categorising bump the revision so the change can sync', () => {
  withDb((db) => {
    const asset = db.media.add(input()).asset;
    const revisionAt = (id: string): number =>
      Number(
        db.driver.prepare('SELECT revision FROM media_assets WHERE id = ?').get(id)?.['revision'] ?? 0,
      );
    const before = revisionAt(asset.id);

    db.media.setFavorite(asset.id, true);
    assert.equal(db.media.get(asset.id)?.isFavorite, true);
    assert.ok(revisionAt(asset.id) > before, 'a change nobody can order is a change nobody receives');

    db.media.setFavorite(asset.id, false);
    assert.equal(db.media.get(asset.id)?.isFavorite, false);

    db.media.setCategory(asset.id, 'Christmas');
    assert.equal(db.media.get(asset.id)?.category, 'Christmas');
  });
});

test('a blank category is stored as none, not as an empty category', () => {
  withDb((db) => {
    const asset = db.media.add(input({ category: 'Nature' })).asset;

    db.media.setCategory(asset.id, '   ');
    assert.equal(db.media.get(asset.id)?.category, null);
    // Otherwise the filter dropdown would offer a nameless entry.
    assert.deepEqual(db.media.categories(), []);

    db.media.setCategory(asset.id, '  Advent  ');
    assert.equal(db.media.get(asset.id)?.category, 'Advent', 'stored trimmed');
  });
});

test('categories are the distinct ones actually in use, sorted', () => {
  withDb((db) => {
    db.media.add(input({ hash: '1'.repeat(64), absPath: '/m/1', category: 'Nature' }));
    db.media.add(input({ hash: '2'.repeat(64), absPath: '/m/2', category: 'advent' }));
    db.media.add(input({ hash: '3'.repeat(64), absPath: '/m/3', category: 'Nature' }));
    db.media.add(input({ hash: '4'.repeat(64), absPath: '/m/4' }));

    assert.deepEqual(db.media.categories(), ['advent', 'Nature']);
  });
});

test('a deleted asset stops contributing its category to the filter list', () => {
  withDb((db) => {
    const asset = db.media.add(input({ category: 'Easter' })).asset;
    db.media.delete(asset.id);
    assert.deepEqual(db.media.categories(), []);
  });
});

test('probe results fill in one field at a time without wiping the others', () => {
  withDb((db) => {
    const asset = db.media.add(input({ kind: 'video', durationMs: null })).asset;

    db.media.setProbe(asset.id, { width: 1280, height: 720 });
    db.media.setProbe(asset.id, { durationMs: 45_000 });
    // A thumbnail arrives last, generated asynchronously — it must not clear the dimensions.
    db.media.setProbe(asset.id, { thumbnailPath: '/userData/thumbnails/x.png' });

    const probed = db.media.get(asset.id);
    assert.equal(probed?.width, 1280);
    assert.equal(probed?.height, 720);
    assert.equal(probed?.durationMs, 45_000);
    assert.equal(probed?.thumbnailPath, '/userData/thumbnails/x.png');
  });
});

test('an empty probe is a no-op rather than an UPDATE with no columns', () => {
  withDb((db) => {
    const asset = db.media.add(input({ width: 800 })).asset;
    // `UPDATE media_assets SET WHERE id = ?` is a syntax error, so this must not reach SQLite.
    db.media.setProbe(asset.id, {});
    assert.equal(db.media.get(asset.id)?.width, 800);
  });
});

// ── deleting ────────────────────────────────────────────────────────────────────

test('delete tombstones the row and reports the file as free to remove', () => {
  withDb((db) => {
    const asset = db.media.add(input()).asset;

    const deleted = db.media.delete(asset.id);
    assert.ok(deleted);
    assert.equal(deleted.asset.id, asset.id);
    assert.equal(deleted.asset.absPath, asset.absPath, 'the caller needs the path to unlink it');
    assert.equal(deleted.fileStillReferenced, false);

    assert.equal(db.media.get(asset.id), null);
    assert.equal(db.media.list({}).length, 0);
    // The row survives, so the deletion can reach other machines.
    const row = db.driver
      .prepare('SELECT deleted_at FROM media_assets WHERE id = ?')
      .get(asset.id);
    assert.ok(row?.['deleted_at']);
  });
});

test('deleting something already gone returns null instead of throwing', () => {
  withDb((db) => {
    const asset = db.media.add(input()).asset;
    assert.ok(db.media.delete(asset.id));
    // Double-click on Delete, or two windows racing.
    assert.equal(db.media.delete(asset.id), null);
    assert.equal(db.media.delete('media_nonexistent'), null);
  });
});

test('the identical file can be re-imported after being deleted', () => {
  withDb((db) => {
    const first = db.media.add(input()).asset;
    db.media.delete(first.id);

    // The UNIQUE hash index covers live rows only, so this must succeed. If it did not, deleting a
    // background would permanently block ever importing it again.
    const again = db.media.add(input());
    assert.equal(again.created, true);
    assert.notEqual(again.asset.id, first.id);
    assert.equal(db.media.count(), 1);
  });
});

test('re-importing a deleted file protects the new copy from the old tombstone', () => {
  withDb((db) => {
    // Both rows share abs_path, because the stored name is derived from the content hash.
    const first = db.media.add(input()).asset;
    db.media.delete(first.id);
    const second = db.media.add(input()).asset;
    assert.equal(second.absPath, first.absPath);

    // Deleting the LIVE row again: now nothing else references the file, so it may go.
    const deleted = db.media.delete(second.id);
    assert.ok(deleted);
    assert.equal(deleted.fileStillReferenced, false);
  });
});

test('a path still used by a live row is never reported as free', () => {
  withDb((db) => {
    /*
     * Two live rows on one path. Reachable if a future migration or a repair tool re-points a row, and
     * cheap to defend against. Unlinking here would empty a slide that is still in a service.
     */
    const shared = '/userData/media/shared_bg.jpg';
    const a = db.media.add(input({ hash: 'a'.repeat(64), absPath: shared })).asset;
    db.media.add(input({ hash: 'b'.repeat(64), absPath: shared }));

    const deleted = db.media.delete(a.id);
    assert.ok(deleted);
    assert.equal(deleted.fileStillReferenced, true, 'the other row still needs this file');
  });
});

test('a delete is recorded in the sync log as a delete', () => {
  withDb((db) => {
    const asset = db.media.add(input()).asset;
    db.media.delete(asset.id);

    const ops = db.driver
      .prepare("SELECT op FROM sync_oplog WHERE entity = 'media_assets' ORDER BY id")
      .all()
      .map((row) => row['op']);
    assert.deepEqual(ops, ['insert', 'delete']);
  });
});

test('purging removes only tombstones older than the cutoff', () => {
  withDb((db) => {
    const asset = db.media.add(input()).asset;
    const live = db.media.add(input({ hash: 'b'.repeat(64), absPath: '/m/b' })).asset;
    db.media.delete(asset.id);

    assert.equal(db.media.purgeTombstones('2000-01-01T00:00:00.000Z'), 0, 'too old a cutoff');

    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(db.media.purgeTombstones(future), 1);
    assert.equal(
      Number(db.driver.prepare('SELECT COUNT(*) AS n FROM media_assets').get()?.['n'] ?? -1),
      1,
      'the live row must survive a purge',
    );
    assert.equal(db.media.get(live.id)?.id, live.id);
  });
});
