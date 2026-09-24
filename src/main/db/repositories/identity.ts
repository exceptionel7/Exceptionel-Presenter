/**
 * EXCEPTIONEL PRESENTER — device identity and the Lamport clock.
 *
 * Every syncable write stamps itself with this device's id and the next revision from this
 * counter. See src/shared/domain/sync.ts for why a counter is used rather than a timestamp.
 */

import { randomUUID } from 'node:crypto';
import { nextRevision, type DeviceId, type SyncStamp } from '../../../shared/domain/sync.ts';
import type { SqliteDriver } from '../driver.ts';
import { asInt, asText, asTextOrNull, nowIso } from './support.ts';

export interface DeviceIdentity {
  deviceId: DeviceId;
  deviceLabel: string | null;
  lamportCounter: number;
  /** Library this machine pulls from. Null means THIS machine is authoritative. */
  upstreamUri: string | null;
  createdAt: string;
}

export interface IdentityRepository {
  get(): DeviceIdentity;
  setLabel(label: string): DeviceIdentity;
  setUpstream(uri: string | null): DeviceIdentity;
  /** True when no upstream is configured, i.e. this library is the source of truth. */
  isAuthoritative(): boolean;

  /**
   * Allocates the next revision and persists the counter.
   *
   * MUST be called inside the same transaction as the write it stamps: if the write rolls
   * back, the counter must roll back with it, or revisions develop gaps that look like
   * lost changes during a pull.
   */
  nextStamp(): SyncStamp;

  /**
   * Records that a revision from elsewhere has been seen, so our next local write sorts
   * after it. Called when pulling from upstream.
   */
  observe(remoteRevision: number): void;
}

const IDENTITY_ID = 'local';

export function createIdentityRepository(db: SqliteDriver): IdentityRepository {
  const read = (): DeviceIdentity | null => {
    const row = db
      .prepare(
        'SELECT device_id, device_label, lamport_counter, upstream_uri, created_at FROM app_identity WHERE id = ?',
      )
      .get(IDENTITY_ID);
    if (!row) return null;
    return {
      deviceId: asText(row['device_id'] ?? null),
      deviceLabel: asTextOrNull(row['device_label'] ?? null),
      lamportCounter: asInt(row['lamport_counter'] ?? null),
      upstreamUri: asTextOrNull(row['upstream_uri'] ?? null),
      createdAt: asText(row['created_at'] ?? null),
    };
  };

  /**
   * Created on first access rather than in the migration: the migration runs identically on
   * every machine, so generating the id there would give a restored backup the SAME device
   * id as the machine it came from — and two devices sharing an id break tie-breaking.
   */
  const ensure = (): DeviceIdentity => {
    const existing = read();
    if (existing) return existing;

    return db.transaction(() => {
      // Re-check inside the transaction: two windows starting at once could both miss it.
      const raced = read();
      if (raced) return raced;

      db.prepare(
        'INSERT INTO app_identity (id, device_id, device_label, lamport_counter, upstream_uri, created_at) VALUES (?, ?, NULL, 0, NULL, ?)',
      ).run(IDENTITY_ID, randomUUID().replaceAll('-', ''), nowIso());

      const created = read();
      if (!created) throw new Error('app_identity row vanished immediately after insert');
      return created;
    });
  };

  return {
    get: ensure,

    setLabel(label) {
      ensure();
      db.prepare('UPDATE app_identity SET device_label = ? WHERE id = ?').run(label, IDENTITY_ID);
      return ensure();
    },

    setUpstream(uri) {
      ensure();
      db.prepare('UPDATE app_identity SET upstream_uri = ? WHERE id = ?').run(uri, IDENTITY_ID);
      return ensure();
    },

    isAuthoritative() {
      return ensure().upstreamUri === null;
    },

    nextStamp() {
      const identity = ensure();
      const revision = nextRevision(identity.lamportCounter);
      db.prepare('UPDATE app_identity SET lamport_counter = ? WHERE id = ?').run(revision, IDENTITY_ID);
      return { revision, originDeviceId: identity.deviceId };
    },

    observe(remoteRevision) {
      if (!Number.isInteger(remoteRevision) || remoteRevision < 0) return;
      const identity = ensure();
      if (remoteRevision <= identity.lamportCounter) return;
      // Jump the counter forward so our next write sorts after the remote change.
      db.prepare('UPDATE app_identity SET lamport_counter = ? WHERE id = ?').run(
        remoteRevision,
        IDENTITY_ID,
      );
    },
  };
}
