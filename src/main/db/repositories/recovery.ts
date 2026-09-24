/**
 * EXCEPTIONEL PRESENTER — crash recovery (Sections 32, 33).
 *
 * A heartbeat row carries the open service and live state. Clean exit sets
 * clean_shutdown = 1; finding a row with 0 on launch means the app died, and the operator
 * is offered "Recover Previous Session?".
 */

import type { RecoverySnapshot } from '../../../shared/domain/entities.ts';
import type { SqliteDriver } from '../driver.ts';
import { asBool, asJson, asText, asTextOrNull, jsonToSql, newId, nowIso } from './support.ts';

export interface RecoveryRepository {
  /** Opens a session row for this run. Returns its id, used for later heartbeats. */
  beginSession(serviceId: string | null, serviceName: string | null): string;
  heartbeat(sessionId: string, snapshot: Record<string, unknown>, serviceId: string | null, serviceName: string | null): void;
  markCleanShutdown(sessionId: string): void;
  /** The most recent unclean session, if any — i.e. evidence of a crash. */
  findRecoverable(): RecoverySnapshot | null;
  discard(id: string): void;
  /** Trims old sessions so the table cannot grow without bound. */
  prune(keep?: number): void;
}

export function createRecoveryRepository(db: SqliteDriver): RecoveryRepository {
  const toSnapshot = (row: Record<string, unknown>): RecoverySnapshot => ({
    id: asText((row['id'] ?? null) as never),
    serviceId: asTextOrNull((row['service_id'] ?? null) as never),
    serviceName: asTextOrNull((row['service_name'] ?? null) as never),
    snapshot: asJson<Record<string, unknown>>((row['snapshot_json'] ?? null) as never, {}),
    heartbeatAt: asText((row['heartbeat_at'] ?? null) as never),
    cleanShutdown: asBool((row['clean_shutdown'] ?? null) as never),
  });

  return {
    beginSession(serviceId, serviceName) {
      const id = newId('sess');
      db.prepare(
        `INSERT INTO session_recovery (id, service_id, service_name, snapshot_json, heartbeat_at, clean_shutdown)
         VALUES (?, ?, ?, '{}', ?, 0)`,
      ).run(id, serviceId, serviceName, nowIso());
      return id;
    },

    heartbeat(sessionId, snapshot, serviceId, serviceName) {
      db.prepare(
        `UPDATE session_recovery
         SET snapshot_json = ?, service_id = ?, service_name = ?, heartbeat_at = ?
         WHERE id = ?`,
      ).run(jsonToSql(snapshot), serviceId, serviceName, nowIso(), sessionId);
    },

    markCleanShutdown(sessionId) {
      db.prepare('UPDATE session_recovery SET clean_shutdown = 1, heartbeat_at = ? WHERE id = ?').run(
        nowIso(),
        sessionId,
      );
    },

    findRecoverable() {
      // Only sessions that actually got somewhere are worth offering. An empty snapshot
      // means the crash happened before any work existed, so prompting would just be
      // noise the operator has to dismiss.
      // rowid DESC breaks ties: two sessions started in the same millisecond have equal
      // heartbeat_at, and without a tiebreaker SQLite may return either, so the operator
      // could be offered the older crash. Insertion order is the correct tiebreak.
      const row = db
        .prepare(
          `SELECT id, service_id, service_name, snapshot_json, heartbeat_at, clean_shutdown
           FROM session_recovery
           WHERE clean_shutdown = 0 AND snapshot_json <> '{}'
           ORDER BY heartbeat_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get();
      return row ? toSnapshot(row) : null;
    },

    discard(id) {
      // Marked clean rather than deleted, so declining recovery once does not destroy the
      // snapshot — Section 33 keeps it available for one more launch.
      db.prepare('UPDATE session_recovery SET clean_shutdown = 1 WHERE id = ?').run(id);
    },

    prune(keep = 20) {
      db.prepare(
        `DELETE FROM session_recovery
         WHERE id NOT IN (
           SELECT id FROM session_recovery ORDER BY heartbeat_at DESC, rowid DESC LIMIT ?
         )`,
      ).run(keep);
    },
  };
}
