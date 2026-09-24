/**
 * EXCEPTIONEL PRESENTER — forward-only migration runner.
 *
 * Guarantees that matter for a church's library:
 *   1. Each migration runs inside a transaction. A failure rolls back; the database
 *      stays at its previous version rather than half-migrated.
 *   2. Applied versions are recorded, so migrating twice is a no-op.
 *   3. A database newer than the app is REFUSED, not opened. Silently running an old
 *      build against a new schema is how data gets destroyed.
 *   4. Migrations are immutable once shipped — a checksum detects edited history.
 *
 * See docs/ARCHITECTURE.md §3.
 */

import { DatabaseFailures } from '../../shared/domain/errors.ts';
import type { AppFailure } from '../../shared/domain/errors.ts';
import type { SqliteDriver } from './driver.ts';

export interface Migration {
  version: number;
  name: string;
  /** Plain DDL/DML. Executed via exec(), so it may contain multiple statements. */
  sql: string;
}

export interface MigrationOutcome {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

export class MigrationFailure extends Error {
  readonly failure: AppFailure;

  constructor(failure: AppFailure) {
    super(failure.message);
    this.name = 'MigrationFailure';
    this.failure = failure;
  }
}

const SCHEMA_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/**
 * Cheap deterministic checksum (FNV-1a, hex). Not cryptographic — its only job is to
 * notice that a shipped migration's text changed, which means someone edited history
 * instead of adding a new migration.
 */
export function checksum(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function currentVersion(db: SqliteDriver): number {
  db.exec(SCHEMA_TABLE);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  const value = row?.['v'];
  return typeof value === 'number' ? value : 0;
}

export function migrate(db: SqliteDriver, migrations: readonly Migration[]): MigrationOutcome {
  if (migrations.length === 0) return { fromVersion: 0, toVersion: 0, applied: [] };

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  assertWellFormed(ordered);

  db.exec(SCHEMA_TABLE);

  const appliedRows = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all();

  const appliedByVersion = new Map<number, { name: string; checksum: string }>();
  for (const row of appliedRows) {
    appliedByVersion.set(Number(row['version']), {
      name: String(row['name']),
      checksum: String(row['checksum']),
    });
  }

  const fromVersion = appliedRows.length
    ? Math.max(...[...appliedByVersion.keys()])
    : 0;
  const latest = ordered[ordered.length - 1]!.version;

  // Guarantee 3: refuse to open a library from a newer build.
  if (fromVersion > latest) {
    throw new MigrationFailure(DatabaseFailures.schemaNewerThanApp(fromVersion, latest));
  }

  // Guarantee 4: shipped migrations are immutable.
  for (const migration of ordered) {
    const previous = appliedByVersion.get(migration.version);
    if (previous && previous.checksum !== checksum(migration.sql)) {
      throw new MigrationFailure(
        DatabaseFailures.migrationFailed(
          migration.version,
          `Migration ${migration.version} ("${migration.name}") has changed since it was ` +
            `applied (recorded ${previous.checksum}, now ${checksum(migration.sql)}). ` +
            `Shipped migrations must never be edited — add a new one instead.`,
        ),
      );
    }
  }

  const applied: number[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  for (const migration of ordered) {
    if (appliedByVersion.has(migration.version)) continue; // Guarantee 2: idempotent.

    try {
      // Guarantee 1: DDL and its bookkeeping commit together or not at all.
      db.transaction(() => {
        db.exec(migration.sql);
        insert.run(
          migration.version,
          migration.name,
          checksum(migration.sql),
          new Date().toISOString(),
        );
      });
      applied.push(migration.version);
    } catch (error) {
      if (error instanceof MigrationFailure) throw error;
      throw new MigrationFailure(
        DatabaseFailures.migrationFailed(
          migration.version,
          `${migration.name}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  return { fromVersion, toVersion: latest, applied };
}

function assertWellFormed(ordered: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of ordered) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new MigrationFailure(
        DatabaseFailures.migrationFailed(
          migration.version,
          'migration versions must be integers >= 1',
        ),
      );
    }
    if (seen.has(migration.version)) {
      throw new MigrationFailure(
        DatabaseFailures.migrationFailed(
          migration.version,
          `duplicate migration version ${migration.version} ` +
            `— two developers probably numbered a migration the same`,
        ),
      );
    }
    seen.add(migration.version);
  }
}

/**
 * Integrity probe run at startup. `foreign_key_check` catches orphaned rows that a
 * historical bug (or a hand-edited database) may have left behind.
 */
export function verifyIntegrity(db: SqliteDriver): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  const integrity = db.pragma('quick_check');
  for (const row of integrity) {
    const value = Object.values(row)[0];
    if (typeof value === 'string' && value !== 'ok') problems.push(`integrity: ${value}`);
  }

  const orphans = db.pragma('foreign_key_check');
  for (const row of orphans) {
    problems.push(
      `orphaned row in ${String(row['table'] ?? '?')} referencing ${String(row['parent'] ?? '?')}`,
    );
  }

  return { ok: problems.length === 0, problems };
}
