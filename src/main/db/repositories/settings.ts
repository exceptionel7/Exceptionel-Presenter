/**
 * EXCEPTIONEL PRESENTER — settings, church profile and shortcuts (Sections 36, 37, 20).
 */

import type { ChurchProfile, ShortcutBinding } from '../../../shared/domain/entities.ts';
import type { ChurchProfileDraft } from '../../../shared/ipc-contract.ts';
import { settingScope, type SettingScope } from '../../../shared/domain/sync.ts';
import type { SqliteDriver } from '../driver.ts';
import { asBool, asText, asTextOrNull, boolToSql, jsonToSql, nowIso, recordOp, tryJson } from './support.ts';

export interface SettingsRepository {
  getAll(): Record<string, unknown>;
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  /** Reverts to the seeded default by deleting the row; reads then fall back in code. */
  remove(key: string): void;
  /** Only the settings that describe the library, not this computer. */
  librarySettings(): Record<string, unknown>;
  scopeOf(key: string): SettingScope;
}

export function createSettingsRepository(db: SqliteDriver): SettingsRepository {
  return {
    getAll() {
      const rows = db.prepare('SELECT key, value_json FROM settings').all();
      const out: Record<string, unknown> = {};
      for (const row of rows) {
        const parsed = tryJson<unknown>(row['value_json'] ?? null);
        // Corrupt rows are skipped rather than surfaced as null, so a caller reading the
        // whole bag cannot mistake damage for a deliberate null.
        if (parsed.ok) out[asText(row['key'] ?? null)] = parsed.value;
      }
      return out;
    },

    get<T>(key: string, fallback: T): T {
      const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
      if (!row) return fallback;
      // tryJson, not asJson: a stored `null` is a real value here (e.g. "no Bible
      // translation selected yet") and must not collapse into the caller's fallback.
      const parsed = tryJson<T>(row['value_json'] ?? null);
      return parsed.ok ? parsed.value : fallback;
    },

    set(key, value) {
      // Scope is derived from the key, never supplied by the caller, so a setting cannot be
      // mis-scoped by a bug at the call site. Device-scoped settings (display assignment, UI
      // preferences) must never travel to another machine — see sync.ts.
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at, scope) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at,
                                        scope = excluded.scope`,
      ).run(key, jsonToSql(value), nowIso(), settingScope(key));
    },

    /** Library-scoped settings only — what a pull is allowed to carry. */
    librarySettings() {
      const rows = db.prepare("SELECT key, value_json FROM settings WHERE scope = 'library'").all();
      const out: Record<string, unknown> = {};
      for (const row of rows) {
        const parsed = tryJson<unknown>(row['value_json'] ?? null);
        if (parsed.ok) out[asText(row['key'] ?? null)] = parsed.value;
      }
      return out;
    },

    scopeOf(key) {
      return settingScope(key);
    },

    remove(key) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    },
  };
}

// ── church profile ──────────────────────────────────────────────────────────────

export interface ProfileRepository {
  get(): ChurchProfile | null;
  save(draft: ChurchProfileDraft): ChurchProfile;
  completeOnboarding(): ChurchProfile;
}

const PROFILE_ID = 'default';

export function createProfileRepository(db: SqliteDriver): ProfileRepository {
  const read = (): ChurchProfile | null => {
    const row = db
      .prepare(
        'SELECT id, name, timezone, logo_asset_id, onboarding_completed FROM church_profile WHERE id = ?',
      )
      .get(PROFILE_ID);
    if (!row) return null;
    return {
      id: asText(row['id'] ?? null),
      name: asText(row['name'] ?? null),
      timezone: asText(row['timezone'] ?? null),
      logoAssetId: asTextOrNull(row['logo_asset_id'] ?? null),
      onboardingCompleted: asBool(row['onboarding_completed'] ?? null),
    };
  };

  return {
    get: read,

    save(draft) {
      return db.transaction(() => {
        const timestamp = nowIso();
        // Upsert on the pinned id: the schema's CHECK (id = 'default') means there is
        // only ever one row, so this is the whole insert-or-update story.
        db.prepare(
          `INSERT INTO church_profile (id, name, timezone, logo_asset_id, onboarding_completed, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                         timezone = excluded.timezone,
                                         logo_asset_id = excluded.logo_asset_id,
                                         updated_at = excluded.updated_at`,
        ).run(PROFILE_ID, draft.name, draft.timezone, draft.logoAssetId ?? null, timestamp, timestamp);

        recordOp(db, 'church_profile', PROFILE_ID, 'update', draft);
        const saved = read();
        if (!saved) throw new Error('church_profile row vanished immediately after write');
        return saved;
      });
    },

    completeOnboarding() {
      return db.transaction(() => {
        db.prepare('UPDATE church_profile SET onboarding_completed = 1, updated_at = ? WHERE id = ?').run(
          nowIso(),
          PROFILE_ID,
        );
        const saved = read();
        if (!saved) throw new Error('cannot complete onboarding before a profile exists');
        return saved;
      });
    },
  };
}

// ── shortcuts ───────────────────────────────────────────────────────────────────

export interface ShortcutsRepository {
  list(): ShortcutBinding[];
  set(binding: ShortcutBinding): ShortcutBinding[];
  resetDefaults(): ShortcutBinding[];
}

export function createShortcutsRepository(db: SqliteDriver): ShortcutsRepository {
  const list = (): ShortcutBinding[] =>
    db
      .prepare('SELECT action, accelerator, enabled FROM shortcuts ORDER BY action')
      .all()
      .map((row) => ({
        action: asText(row['action'] ?? null),
        accelerator: asText(row['accelerator'] ?? null),
        enabled: asBool(row['enabled'] ?? null),
      }));

  return {
    list,

    set(binding) {
      return db.transaction(() => {
        // The schema has a unique index over enabled accelerators. Rather than letting
        // that surface as a raw SQLITE_CONSTRAINT, disable whoever currently holds the
        // key first — rebinding is the operator's clear intent, and refusing with an
        // error would make them hunt for the conflicting action themselves.
        if (binding.enabled) {
          db.prepare('UPDATE shortcuts SET enabled = 0 WHERE accelerator = ? AND action <> ?').run(
            binding.accelerator,
            binding.action,
          );
        }
        db.prepare(
          `INSERT INTO shortcuts (action, accelerator, enabled) VALUES (?, ?, ?)
           ON CONFLICT(action) DO UPDATE SET accelerator = excluded.accelerator,
                                             enabled = excluded.enabled`,
        ).run(binding.action, binding.accelerator, boolToSql(binding.enabled));
        return list();
      });
    },

    resetDefaults() {
      return db.transaction(() => {
        // Re-apply the seeded defaults from migration 0002 without re-running it.
        const defaults: ReadonlyArray<readonly [string, string]> = [
          ['live.previous', 'ArrowLeft'],
          ['live.next', 'ArrowRight'],
          ['live.nextAlt', 'Space'],
          ['live.black', 'B'],
          ['live.clear', 'C'],
          ['live.fullscreen', 'F'],
          ['live.exitFullscreen', 'Escape'],
          ['camera.select1', '1'],
          ['camera.select2', '2'],
          ['camera.select3', '3'],
          ['live.stop', 'Period'],
          ['service.save', 'CommandOrControl+S'],
          ['service.new', 'CommandOrControl+N'],
          ['search.focus', 'CommandOrControl+F'],
          ['output.toggle', 'CommandOrControl+Shift+O'],
        ];
        // Clear first: a custom binding on an action not in the default set must go too,
        // otherwise "reset" would leave surprises behind.
        db.exec('DELETE FROM shortcuts');
        const insert = db.prepare('INSERT INTO shortcuts (action, accelerator, enabled) VALUES (?, ?, 1)');
        for (const [action, accelerator] of defaults) insert.run(action, accelerator);
        return list();
      });
    },
  };
}
