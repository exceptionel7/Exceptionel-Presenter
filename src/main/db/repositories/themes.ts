/**
 * EXCEPTIONEL PRESENTER — themes (Section 16), with inheritance resolution.
 */

import type { Theme, ThemeSpec } from '../../../shared/domain/entities.ts';
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

/**
 * The fallback every theme resolves against, so the presentation renderer always receives
 * a complete spec and never has to guard a missing field mid-service.
 */
export const BASE_THEME_SPEC: ThemeSpec = {
  background: { kind: 'solid', value: '#000000' },
  text: {
    fontFamily: 'Inter',
    fontSize: 72,
    fontWeight: 600,
    color: '#FFFFFF',
    align: 'center',
    lineHeight: 1.3,
    letterSpacing: 0,
    shadow: { enabled: true, color: 'rgba(0,0,0,0.7)', blur: 24, offsetY: 4 },
    outline: { enabled: false, color: '#000000', width: 0 },
  },
  padding: { top: 0.1, right: 0.08, bottom: 0.1, left: 0.08 },
  textBox: { enabled: false, color: '#000000', opacity: 0, cornerRadius: 0 },
  transition: { kind: 'fade', durationMs: 250 },
};

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

  return {
    list() {
      return db
        .prepare(
          `SELECT id, name, parent_theme_id, is_builtin, spec_json FROM themes
           WHERE deleted_at IS NULL
           ORDER BY is_builtin DESC, name COLLATE NOCASE`,
        )
        .all()
        .map(toTheme);
    },

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

    resolve(id) {
      const chain: Theme[] = [];
      const seen = new Set<string>();
      let cursor = get(id);
      if (!cursor) return null;

      while (cursor) {
        // Defensive: save() prevents cycles, but a hand-edited database should degrade
        // rather than hang the main process.
        if (seen.has(cursor.id)) break;
        seen.add(cursor.id);
        chain.push(cursor);
        cursor = cursor.parentThemeId ? get(cursor.parentThemeId) : null;
      }

      // Apply from the most distant ancestor down to the requested theme, so nearer
      // definitions win.
      return chain
        .reverse()
        .reduce<ThemeSpec>((spec, theme) => mergeSpec(spec, theme.spec), BASE_THEME_SPEC);
    },
  };
}

/**
 * Field-level merge, one level into each group. Themes override individual properties
 * (say, just `text.color`) without having to restate the whole group — a blind spread
 * would wipe the sibling fields.
 */
export function mergeSpec(base: ThemeSpec, override: Partial<ThemeSpec>): ThemeSpec {
  return {
    background: { ...base.background, ...(override.background ?? {}) },
    text: {
      ...base.text,
      ...(override.text ?? {}),
      shadow: { ...base.text.shadow, ...(override.text?.shadow ?? {}) },
      outline: { ...base.text.outline, ...(override.text?.outline ?? {}) },
    },
    padding: { ...base.padding, ...(override.padding ?? {}) },
    textBox: { ...base.textBox, ...(override.textBox ?? {}) },
    transition: { ...base.transition, ...(override.transition ?? {}) },
  };
}
