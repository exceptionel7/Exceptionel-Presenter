/**
 * EXCEPTIONEL PRESENTER — SqliteDriver over the built-in `node:sqlite` module.
 *
 * Verified against Node 22.23 and Node 24 (see docs/ENVIRONMENT.md). Available unflagged
 * from Node 22.16, so Electron 37+ needs no special launch arguments.
 */

import { DatabaseSync } from 'node:sqlite';
import { DatabaseFailures } from '../../shared/domain/errors.ts';
import type { SqliteDriver, SqliteStatement, SqlRow, SqlValue } from './driver.ts';

export interface OpenOptions {
  /** Absolute file path, or ':memory:' for tests. */
  path: string;
  /**
   * WAL keeps readers from blocking the writer, so an autosave never stalls the
   * operator UI mid-service. Disabled for :memory: where WAL is meaningless.
   */
  wal?: boolean;
}

export function openNodeSqlite(options: OpenOptions): SqliteDriver {
  const { path, wal = path !== ':memory:' } = options;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw new Error(
      JSON.stringify(DatabaseFailures.sqliteUnavailable(String(cause))),
      { cause },
    );
  }

  // Pragmas, in a deliberate order.
  db.exec('PRAGMA foreign_keys = ON');
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  // NORMAL rather than FULL: with WAL this is durable across app crashes (only an OS
  // crash can lose the last commits) and avoids an fsync on every autosave.
  db.exec('PRAGMA synchronous = NORMAL');
  // Wait rather than immediately failing with SQLITE_BUSY if another connection writes.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');

  /** Depth of nested transaction() calls, so inner calls use SAVEPOINTs. */
  let depth = 0;

  const wrap = (sql: string): SqliteStatement => {
    const stmt = db.prepare(sql);
    return {
      all: (...params) => stmt.all(...params) as SqlRow[],
      get: (...params) => stmt.get(...params) as SqlRow | undefined,
      run: (...params) => {
        const r = stmt.run(...params);
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
      },
      iterate: (...params) => stmt.iterate(...params) as IterableIterator<SqlRow>,
    };
  };

  return {
    engine: `node:sqlite (Node ${process.versions.node})`,

    exec(sql) {
      db.exec(sql);
    },

    prepare: wrap,

    transaction<T>(fn: () => T): T {
      // Nested transactions join the outer one. Without this, a repository method that
      // internally uses a transaction could not be called from inside a larger unit of
      // work — e.g. saving a service that also saves its songs.
      const isOuter = depth === 0;
      const savepoint = `sp_${depth}`;
      db.exec(isOuter ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      depth++;
      try {
        const result = fn();
        depth--;
        db.exec(isOuter ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth--;
        try {
          db.exec(isOuter ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        } catch {
          // A rollback failure must not mask the original error, which is the one that
          // actually explains what went wrong.
        }
        throw error;
      }
    },

    pragma(statement) {
      return db.prepare(`PRAGMA ${statement}`).all() as SqlRow[];
    },

    close() {
      // Checkpoint so the -wal file is folded back into the main database on clean exit.
      // Without this a copied/backed-up .db file can be missing recent commits.
      if (wal) {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
          // Non-fatal: WAL will be replayed on next open.
        }
      }
      db.close();
    },
  };
}

/** Convenience for repositories: JSON columns, with a safe fallback on corrupt text. */
export function parseJsonColumn<T>(value: SqlValue, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** SQLite has no boolean type; we store 0/1 INTEGER. */
export const toSqlBool = (value: boolean): number => (value ? 1 : 0);
export const fromSqlBool = (value: SqlValue): boolean => value === 1 || value === 1n;
