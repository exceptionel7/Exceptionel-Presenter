/**
 * EXCEPTIONEL PRESENTER — SQLite driver abstraction.
 *
 * We target `node:sqlite`, built into Node 22.16+ and therefore into Electron 37+.
 * The alternative, `better-sqlite3`, is a native module requiring node-gyp, an
 * ABI-matched rebuild on every Electron major, and Visual Studio build tools on Windows.
 * Avoiding that removes a whole class of "the app won't install" support tickets.
 *
 * The interface exists so that choice stays reversible: implement `SqliteDriver` over
 * better-sqlite3 and nothing above this file changes.
 *
 * See docs/ARCHITECTURE.md §3.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqliteStatement {
  all(...params: SqlValue[]): SqlRow[];
  get(...params: SqlValue[]): SqlRow | undefined;
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  iterate(...params: SqlValue[]): IterableIterator<SqlRow>;
}

export interface SqliteDriver {
  /** Multi-statement DDL. Not parameterised — never build this from user input. */
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on throw.
   * Nested calls join the outer transaction via SAVEPOINT rather than failing.
   */
  transaction<T>(fn: () => T): T;
  pragma(statement: string): SqlRow[];
  close(): void;
  /** Reported in Settings → Advanced so support can tell which engine is live. */
  readonly engine: string;
}
