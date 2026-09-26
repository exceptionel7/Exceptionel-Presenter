/**
 * EXCEPTIONEL PRESENTER — themes (Section 16), with inheritance resolution.
 */

import type { Theme, ThemeSpec } from '../../../shared/domain/entities.ts';
import { BASE_THEME_SPEC, mergeSpec, resolveThemeSpec } from '../../../shared/domain/theme.ts';
import type { ThemeDraft } from '../../../shared/ipc-contract.ts';
import type { SqliteDriver } from '../driver.ts';
import type { IdentityRepository } from './identity.ts';
import { asBool, asJson, asText, asTextOrNull, boolToSql, jsonToSql, newId, nowIso, recordOp } from './support.ts';

export interface ThemeRepository {
  list(): Theme[];
  get(id: string): Theme | null;
  save(draft: ThemeDraft): Theme;
  delete(id: string): void;
  /** Flattens a theme and its ancestors into one complete spec. */
  resolve(id: string): ThemeSpec | null;
}

/*
 * BASE_THEME_SPEC and mergeSpec now live in shared/domain/theme.ts and are re-exported here so
 * existing importers keep working.
 *
 * They moved because a renderer cannot import from main, so `Themes.tsx` had been keeping its own
 * copy. Two definitions of what a theme defaults to is a guarantee that the operator's preview and
 * the audience screen eventually disagree — and the operator would have no way to tell which was
 * lying. One definition, used by both.
 */
export { BASE_THEME_SPEC, mergeSpec };

export function createThemeRepository(db: SqliteDriver, identity: IdentityRepository): ThemeRepository {
  const toTheme = (row: Record<string, unknown>): Theme => ({
    id: asText((row['id'] ?? null) as never),
    name: asText((row['name'] ?? null) as never),
    parentThemeId: asTextOrNull((row['parent_theme_id'] ?? null) as never),
    isBuiltin: asBool((row['is_builtin'] ?? null) as never),
    spec: asJson<Partial<ThemeSpec>>((row['spec_json'] ?? null) as never, {}),
  });

  const get = (id: string): Theme | null => {
    const row = db
      .prepare(
        'SELECT id, name, parent_theme_id, is_builtin, spec_json FROM themes WHERE id = ? AND deleted_at IS NULL',
      )
      .get(id);
    return row ? toTheme(row) : null;
  };

  /*
   * A plain local function, deliberately not a method on the returned object.
   *
   * `resolve` needs the full list, and reaching it as `this.list()` would silently lose its binding
   * the moment anything destructured the repository — `const { resolve } = themes` is an entirely
   * reasonable thing to write, and it would throw at the worst possible moment. This project has
   * already lost a launch cycle to exactly that mistake elsewhere.
   */
  const list = (): Theme[] =>
    db
      .prepare(
        `SELECT id, name, parent_theme_id, is_builtin, spec_json FROM themes
         WHERE deleted_at IS NULL
         ORDER BY is_builtin DESC, name COLLATE NOCASE`,
      )
      .all()
      .map(toTheme);

  return {
    list,

    get,

    save(draft) {
      return db.transaction(() => {
        const timestamp = nowIso();
        const stamp = identity.nextStamp();
        const isNew = !draft.id;
        const themeId = draft.id ?? newId('theme');

        if (draft.parentThemeId) {
          if (draft.parentThemeId === themeId) {
            throw new Error('a theme cannot inherit from itself');
          }
          if (!get(draft.parentThemeId)) {
            throw new Error(`parent theme ${draft.parentThemeId} does not exist`);
          }
          // Walk up from the proposed parent: if we reach this theme, the link would
          // create a cycle and resolve() would spin forever.
          let cursor = get(draft.parentThemeId);
          const seen = new Set<string>([themeId]);
          while (cursor) {
            if (seen.has(cursor.id)) throw new Error('theme inheritance would form a cycle');
            seen.add(cursor.id);
            cursor = cursor.parentThemeId ? get(cursor.parentThemeId) : null;
          }
        }

        if (isNew) {
          db.prepare(
            `INSERT INTO themes (id, name, parent_theme_id, is_builtin, spec_json, created_at, updated_at,
                                 revision, origin_device_id, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          ).run(
            themeId,
            draft.name,
            draft.parentThemeId ?? null,
            boolToSql(false),
            jsonToSql(draft.spec),
            timestamp,
            timestamp,
            stamp.revision,
            stamp.originDeviceId,
          );
        } else {
          const existing = get(themeId);
          if (!existing) throw new Error(`cannot update theme ${themeId}: it does not exist`);
          // Built-ins are the safety net users fall back to when a custom theme goes
          // wrong, so they stay pristine. The UI offers "Duplicate" instead.
          if (existing.isBuiltin) {
            throw new Error(
              `"${existing.name}" is a built-in theme and cannot be modified — duplicate it first`,
            );
          }
          db.prepare(
            `UPDATE themes SET name = ?, parent_theme_id = ?, spec_json = ?, updated_at = ?,
                               revision = ?, origin_device_id = ?
             WHERE id = ?`,
          ).run(
            draft.name,
            draft.parentThemeId ?? null,
            jsonToSql(draft.spec),
            timestamp,
            stamp.revision,
            stamp.originDeviceId,
            themeId,
          );
        }

        recordOp(db, 'themes', themeId, isNew ? 'insert' : 'update', undefined, stamp);
        const saved = get(themeId);
        if (!saved) throw new Error(`theme ${themeId} vanished immediately after write`);
        return saved;
      });
    },

    delete(id) {
      db.transaction(() => {
        const existing = get(id);
        if (!existing) return;
        if (existing.isBuiltin) {
          throw new Error(`"${existing.name}" is a built-in theme and cannot be deleted`);
        }
        // Checked explicitly rather than relying on the schema's ON DELETE RESTRICT, which
        // would raise a raw constraint error. Only LIVE children block a delete.
        const children = db
          .prepare('SELECT COUNT(*) AS n FROM themes WHERE parent_theme_id = ? AND deleted_at IS NULL')
          .get(id);
        const childCount = Number(children?.['n'] ?? 0);
        if (childCount > 0) {
          throw new Error(
            `"${existing.name}" is inherited by ${childCount} other theme(s) — reassign them first`,
          );
        }

        // Tombstone, not removal. The partial UNIQUE index on themes(name) excludes deleted
        // rows, so the name becomes reusable immediately.
        const stamp = identity.nextStamp();
        db.prepare(
          `UPDATE themes SET deleted_at = ?, updated_at = ?, revision = ?, origin_device_id = ?
           WHERE id = ? AND deleted_at IS NULL`,
        ).run(nowIso(), nowIso(), stamp.revision, stamp.originDeviceId, id);
        recordOp(db, 'themes', id, 'delete', undefined, stamp);
      });
    },

    /*
     * Delegates to the shared resolver rather than walking the chain itself.
     *
     * `list()` already returns every live theme, and resolution is a pure function of that list, so
     * the renderers and the main process run literally the same code. The previous implementation
     * issued one SELECT per ancestor, which also meant the operator preview (resolving client-side
     * from `themes:list`) and the audience output could diverge if the two walks ever drifted.
     */
    resolve: (id) => resolveThemeSpec(list(), id),
  };
}
