/**
 * EXCEPTIONEL PRESENTER — the migration list.
 *
 * Append-only. To change the schema, add a new numbered module and register it here;
 * never edit an applied migration (the migrator checksums them and will refuse to open
 * libraries whose history has been rewritten).
 */

import type { Migration } from '../migrator.ts';
import { SQL as init } from './0001-init.ts';
import { SQL as seed } from './0002-seed.ts';

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'init', sql: init },
  { version: 2, name: 'seed-themes-shortcuts-settings', sql: seed },
]);

/** The schema version this build understands. Surfaced in Settings → Advanced. */
export const APP_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
