/**
 * EXCEPTIONEL PRESENTER — the database facade.
 *
 * One place that opens SQLite, migrates it, checks its integrity and exposes the
 * repositories. Everything above this layer (IPC handlers, services) receives an
 * `AppDatabase` and never touches the driver directly.
 */

import { openNodeSqlite } from './node-sqlite-driver.ts';
import { MIGRATIONS, APP_SCHEMA_VERSION } from './migrations/index.ts';
import { migrate, verifyIntegrity, type MigrationOutcome } from './migrator.ts';
import type { SqliteDriver } from './driver.ts';
import {
  createProfileRepository,
  createSettingsRepository,
  createShortcutsRepository,
  type ProfileRepository,
  type SettingsRepository,
  type ShortcutsRepository,
} from './repositories/settings.ts';
import { createSongRepository, type SongRepository } from './repositories/songs.ts';
import { createServiceRepository, type ServiceRepository } from './repositories/services.ts';
import { createThemeRepository, type ThemeRepository } from './repositories/themes.ts';
import { createRecoveryRepository, type RecoveryRepository } from './repositories/recovery.ts';

export interface AppDatabase {
  readonly driver: SqliteDriver;
  readonly schemaVersion: number;
  readonly migration: MigrationOutcome;
  /** Non-fatal integrity warnings found at startup, surfaced in Settings → Advanced. */
  readonly integrityProblems: readonly string[];

  readonly settings: SettingsRepository;
  readonly profile: ProfileRepository;
  readonly shortcuts: ShortcutsRepository;
  readonly songs: SongRepository;
  readonly services: ServiceRepository;
  readonly themes: ThemeRepository;
  readonly recovery: RecoveryRepository;

  /** Runs a unit of work across repositories atomically. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Absolute path to the library file, or ':memory:' in tests. */
  path: string;
}

export function openDatabase(options: OpenDatabaseOptions): AppDatabase {
  const driver = openNodeSqlite({ path: options.path });

  // Migrate before anything reads. A MigrationFailure propagates to the caller, which
  // shows the operator a real explanation rather than letting the app half-start.
  const migration = migrate(driver, MIGRATIONS);

  // Integrity is reported, not thrown: an orphaned row should not stop a church from
  // running Sunday's service, but it must be visible somewhere.
  const integrity = verifyIntegrity(driver);

  return {
    driver,
    schemaVersion: APP_SCHEMA_VERSION,
    migration,
    integrityProblems: Object.freeze([...integrity.problems]),

    settings: createSettingsRepository(driver),
    profile: createProfileRepository(driver),
    shortcuts: createShortcutsRepository(driver),
    songs: createSongRepository(driver),
    services: createServiceRepository(driver),
    themes: createThemeRepository(driver),
    recovery: createRecoveryRepository(driver),

    transaction: (fn) => driver.transaction(fn),
    close: () => driver.close(),
  };
}
