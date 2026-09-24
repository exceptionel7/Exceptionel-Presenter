import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareStamps,
  isSyncedEntity,
  nextRevision,
  resolveConflict,
  settingScope,
  shortDeviceId,
  shouldApplyRemote,
  type SyncMeta,
  type SyncStamp,
} from '../src/shared/domain/sync.ts';

const stamp = (revision: number, originDeviceId: string | null = 'dev-a'): SyncStamp => ({
  revision,
  originDeviceId,
});

const meta = (
  revision: number,
  originDeviceId: string | null = 'dev-a',
  deletedAt: string | null = null,
): SyncMeta => ({ revision, originDeviceId, deletedAt });

// ── Lamport counter ─────────────────────────────────────────────────────────────

test('a local write always advances past everything observed', () => {
  assert.equal(nextRevision(1), 2);
  assert.equal(nextRevision(5, 3), 6, 'our counter is ahead');
  assert.equal(nextRevision(3, 9), 10, 'the other device ran ahead — we must jump past it');
});

test('the counter never goes backwards, even from corrupt input', () => {
  assert.equal(nextRevision(0), 1);
  assert.equal(nextRevision(-5), 1, 'a negative counter must not produce a negative revision');
  assert.equal(nextRevision(-5, -9), 1);
});

test('revisions are strictly increasing across repeated writes', () => {
  let counter = 0;
  const seen: number[] = [];
  for (let i = 0; i < 50; i++) {
    counter = nextRevision(counter);
    seen.push(counter);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]! > seen[i - 1]!, 'each revision must exceed the last');
  }
});

// ── stamp ordering ──────────────────────────────────────────────────────────────

test('a higher revision is newer', () => {
  assert.ok(compareStamps(stamp(5), stamp(3)) > 0);
  assert.ok(compareStamps(stamp(3), stamp(5)) < 0);
});

test('ordering does NOT depend on wall-clock time', () => {
  // The whole point: a booth computer with a clock two years slow must still lose to a
  // genuinely later edit. There is no timestamp in a stamp at all.
  const older = stamp(1, 'booth-with-wrong-clock');
  const newer = stamp(2, 'laptop');
  assert.ok(compareStamps(newer, older) > 0);
  assert.equal(Object.keys(older).includes('updatedAt'), false);
});

test('concurrent edits break ties on device id, identically on every replica', () => {
  const a = stamp(7, 'dev-a');
  const b = stamp(7, 'dev-b');
  assert.ok(compareStamps(b, a) > 0);
  assert.ok(compareStamps(a, b) < 0);
  // Antisymmetry is what stops two replicas reaching opposite conclusions.
  assert.equal(Math.sign(compareStamps(a, b)), -Math.sign(compareStamps(b, a)));
});

test('identical stamps compare equal', () => {
  assert.equal(compareStamps(stamp(4, 'dev-a'), stamp(4, 'dev-a')), 0);
  assert.equal(compareStamps(stamp(4, null), stamp(4, null)), 0);
});

test('a pre-sync row (no origin) loses to any stamped row at the same revision', () => {
  assert.ok(compareStamps(stamp(1, 'dev-a'), stamp(1, null)) > 0);
  assert.ok(compareStamps(stamp(1, null), stamp(1, 'dev-a')) < 0);
});

test('ordering is transitive', () => {
  const low = stamp(1, 'dev-a');
  const mid = stamp(1, 'dev-b');
  const high = stamp(2, 'dev-a');
  assert.ok(compareStamps(mid, low) > 0);
  assert.ok(compareStamps(high, mid) > 0);
  assert.ok(compareStamps(high, low) > 0);
});

// ── conflict resolution ─────────────────────────────────────────────────────────

test('the later edit wins', () => {
  assert.equal(resolveConflict(meta(5), meta(3)), 'local');
  assert.equal(resolveConflict(meta(3), meta(5)), 'remote');
  assert.equal(shouldApplyRemote(meta(3), meta(5)), true);
  assert.equal(shouldApplyRemote(meta(5), meta(3)), false);
});

test('A LATER DELETE WINS — deleting is a real edit', () => {
  const edit = meta(3, 'dev-a');
  const laterDelete = meta(7, 'dev-b', '2026-09-24T10:00:00.000Z');
  assert.equal(resolveConflict(edit, laterDelete), 'remote');
});

test('AN EDIT LATER THAN A DELETE resurrects the row, as it should', () => {
  const deleted = meta(3, 'dev-a', '2026-09-24T10:00:00.000Z');
  const laterEdit = meta(7, 'dev-b');
  assert.equal(resolveConflict(deleted, laterEdit), 'remote');
});

test('ON A TRUE TIE, THE EDIT BEATS THE DELETE — silent data loss is worse than resurrection', () => {
  // Same revision AND same origin: genuinely concurrent, no ordering available.
  // Losing someone's edit leaves no trace; a resurrected song is visible and can be
  // deleted again. So the surviving version is the one with data in it.
  const tombstone = meta(4, 'dev-a', '2026-09-24T10:00:00.000Z');
  const edit = meta(4, 'dev-a', null);

  assert.equal(resolveConflict(edit, tombstone), 'local', 'local edit survives a tied tombstone');
  assert.equal(resolveConflict(tombstone, edit), 'remote', 'remote edit survives a tied tombstone');

  // And the decision is symmetric — both replicas keep the edit, so they agree.
  assert.equal(shouldApplyRemote(tombstone, edit), true);
  assert.equal(shouldApplyRemote(edit, tombstone), false);
});

test('two tombstones at the same stamp settle without a pointless write', () => {
  const a = meta(4, 'dev-a', '2026-09-24T10:00:00.000Z');
  const b = meta(4, 'dev-a', '2026-09-24T11:00:00.000Z');
  assert.equal(resolveConflict(a, b), 'local', 'identical stamps: keep what we have');
});

test('two concurrent deletes on different devices resolve deterministically', () => {
  const a = meta(4, 'dev-a', '2026-09-24T10:00:00.000Z');
  const b = meta(4, 'dev-b', '2026-09-24T10:00:00.000Z');
  assert.equal(resolveConflict(a, b), 'remote', 'dev-b sorts higher');
  assert.equal(resolveConflict(b, a), 'local');
});

test('resolution never leaves two replicas disagreeing', () => {
  // Exhaustive over a small space: for every pair, the version each side keeps must be
  // the same version. This is the property that prevents silent divergence.
  const candidates: SyncMeta[] = [];
  for (const revision of [1, 2]) {
    for (const origin of ['dev-a', 'dev-b', null]) {
      for (const deleted of [null, '2026-09-24T10:00:00.000Z']) {
        candidates.push(meta(revision, origin, deleted));
      }
    }
  }

  for (const local of candidates) {
    for (const remote of candidates) {
      // Device X holds `local` and receives `remote`; device Y holds `remote` and
      // receives `local`. They must end up with the same row.
      const keptByX = resolveConflict(local, remote) === 'local' ? local : remote;
      const keptByY = resolveConflict(remote, local) === 'local' ? remote : local;
      assert.deepEqual(
        keptByX,
        keptByY,
        `divergence: ${JSON.stringify(local)} vs ${JSON.stringify(remote)}`,
      );
    }
  }
});

// ── entity scoping ──────────────────────────────────────────────────────────────

test('library content syncs', () => {
  for (const entity of ['songs', 'services', 'themes', 'playlists', 'media_assets']) {
    assert.equal(isSyncedEntity(entity), true, `${entity} should sync`);
  }
});

test('HARDWARE CONFIG NEVER SYNCS — device ids are meaningless on another computer', () => {
  // Syncing display_profiles would point the booth's projector output at a monitor id
  // that only exists on someone's laptop.
  for (const entity of ['camera_profiles', 'display_profiles', 'session_recovery']) {
    assert.equal(isSyncedEntity(entity), false, `${entity} must stay local`);
  }
});

test('unknown entities are not synced by default — fail closed', () => {
  assert.equal(isSyncedEntity('some_future_table'), false);
  assert.equal(isSyncedEntity('__proto__'), false);
});

// ── settings scope ──────────────────────────────────────────────────────────────

test('library-level settings sync', () => {
  assert.equal(settingScope('presentation.defaultThemeId'), 'library');
  assert.equal(settingScope('presentation.lyricsThemeId'), 'library');
  assert.equal(settingScope('bible.defaultTranslationId'), 'library');
});

test('MACHINE-BOUND SETTINGS STAY LOCAL', () => {
  // Pulling a service must not reassign the booth's projector or reset the operator's UI.
  for (const key of [
    'app.theme',
    'app.firstRunCompleted',
    'display.presentationId',
    'camera.defaultProfileId',
    'confidence.showTimer',
    'autosave.debounceMs',
    'cloud.syncEnabled',
    'presentation.aspectRatio',
  ]) {
    assert.equal(settingScope(key), 'device', `${key} must not sync`);
  }
});

test('aspect ratio is device-scoped but other presentation.* keys are not', () => {
  // The projector's shape is a property of the room, not the library.
  assert.equal(settingScope('presentation.aspectRatio'), 'device');
  assert.equal(settingScope('presentation.blackOnStartup'), 'library');
});

// ── display helper ──────────────────────────────────────────────────────────────

test('device ids shorten for display without becoming ambiguous', () => {
  assert.equal(shortDeviceId('4f9c1a2b3c4d5e6f7a8b9c0d1e2f3a4b'), '4f9c1a2b');
  assert.equal(shortDeviceId(null), 'unknown');
});
