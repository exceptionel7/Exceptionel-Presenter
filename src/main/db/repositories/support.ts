/**
 * EXCEPTIONEL PRESENTER — repository support utilities.
 *
 * Shared plumbing: id generation, timestamps, JSON columns, and the sync oplog writer.
 */

import { randomUUID } from 'node:crypto';
import type { SqlRow, SqlValue, SqliteDriver } from '../driver.ts';

/**
 * Ids are prefixed UUIDs with the hyphens stripped: `song_4f9c1a...`.
 *
 * The prefix makes a stray id in a log or a service_items.ref_id immediately
 * identifiable, which matters because ref_id is polymorphic and cannot be a foreign key.
 * Hyphens are removed to satisfy vId's `[A-Za-z0-9_-]` alphabet without ambiguity
 * between the prefix separator and UUID separators.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export const nowIso = (): string => new Date().toISOString();

// ── column coercion ─────────────────────────────────────────────────────────────
// SQLite is dynamically typed, so every read goes through an explicit coercion. These
// helpers exist so a NULL or an unexpected type produces a predictable value instead of
// leaking `undefined` into the UI.

export const asText = (value: SqlValue): string => (typeof value === 'string' ? value : String(value ?? ''));

export const asTextOrNull = (value: SqlValue): string | null =>
  value === null || value === undefined ? null : String(value);

export const asInt = (value: SqlValue, fallback = 0): number => {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return fallback;
};

export const asIntOrNull = (value: SqlValue): number | null => {
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return null;
};

export const asReal = (value: SqlValue, fallback = 0): number =>
  typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : fallback;

export const asBool = (value: SqlValue): boolean => value === 1 || value === 1n;

export const boolToSql = (value: boolean): number => (value ? 1 : 0);

export function asJson<T>(value: SqlValue, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed === null ? fallback : (parsed as T);
  } catch {
    // A corrupt JSON column must not take the whole library down: a single unreadable
    // theme override should degrade to the default, not crash startup.
    return fallback;
  }
}

/**
 * Like asJson, but distinguishes a stored `null` from a missing/corrupt value.
 *
 * Needed by the settings store, where `null` is a legitimate value: the seeded
 * `bible.defaultTranslationId` is null, meaning "no translation chosen yet". Collapsing
 * that into the caller's fallback would silently invent a default translation.
 */
export function tryJson<T>(value: SqlValue): { ok: true; value: T } | { ok: false } {
  if (typeof value !== 'string' || value === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) as T };
  } catch {
    return { ok: false };
  }
}

export const jsonToSql = (value: unknown): string => JSON.stringify(value ?? null);

// ── sync oplog (Section 29) ─────────────────────────────────────────────────────

export type SyncOp = 'insert' | 'update' | 'delete';

/**
 * Records a change for the future cloud sync engine. Called inside the same transaction
 * as the write itself, so the log can never disagree with the data.
 */
export function recordOp(
  db: SqliteDriver,
  entity: string,
  entityId: string,
  op: SyncOp,
  payload?: unknown,
): void {
  db.prepare(
    'INSERT INTO sync_oplog (entity, entity_id, op, payload_json, local_ts) VALUES (?, ?, ?, ?, ?)',
  ).run(entity, entityId, op, payload === undefined ? null : jsonToSql(payload), nowIso());
}

// ── query helpers ───────────────────────────────────────────────────────────────

/**
 * Escapes a user search string for a LIKE clause, given `ESCAPE '\'`.
 * Without this, typing `%` in the search box matches everything and `_` matches any
 * character — surprising, and slow on a large library.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Quotes a user query for an FTS5 MATCH so operator-typed text is treated as literal
 * terms. Unescaped input lets FTS5 syntax (`NEAR`, `*`, `:`, `"`) either error out or
 * silently change the query's meaning.
 */
export function ftsQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter((term) => term.length > 0);
  if (terms.length === 0) return '';
  // Prefix-match the final term so results narrow as the operator types.
  return terms.map((term, index) => (index === terms.length - 1 ? `"${term}"*` : `"${term}"`)).join(' ');
}

/** Applies LIMIT/OFFSET with sane caps so a bad query cannot try to load everything. */
export function pagination(limit: number | undefined, offset: number | undefined): {
  limit: number;
  offset: number;
} {
  return {
    limit: Math.min(Math.max(limit ?? 200, 1), 1_000),
    offset: Math.max(offset ?? 0, 0),
  };
}

export const firstRow = (rows: SqlRow[]): SqlRow | undefined => rows[0];
