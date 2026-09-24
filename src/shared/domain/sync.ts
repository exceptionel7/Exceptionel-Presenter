/**
 * EXCEPTIONEL PRESENTER — synchronisation primitives.
 *
 * The model (see docs/SYNC.md): ONE library is authoritative; other machines are replicas
 * that pull from it. Edits travel prep → booth, which is how churches actually work, and
 * it means we never have to answer "two people edited this song differently, which wins?"
 *
 * Even so, concurrent edits are possible (someone edits on the replica before pulling), so
 * every syncable row carries a stamp and conflicts resolve deterministically.
 *
 * WHY NOT WALL-CLOCK TIME: last-write-wins on `updated_at` assumes clocks are correct.
 * Church booth computers are frequently months or years off — they are rarely-rebooted
 * machines nobody administers. A wrong clock makes LWW silently discard the NEWER edit,
 * with no error anywhere. So ordering uses a Lamport counter, which needs no clock at all.
 *
 * Dependency-free and unit-tested.
 */

/** Identifies one installation. Stable for the life of the library file. */
export type DeviceId = string;

/**
 * Ordering stamp on every syncable row.
 *
 * `revision` is a Lamport counter, not a timestamp: it only ever increases, and it
 * increases past anything this device has seen. `originDeviceId` breaks ties so that two
 * devices independently resolving the same conflict always reach the SAME answer — without
 * that, replicas would silently diverge.
 */
export interface SyncStamp {
  revision: number;
  /** Null for rows written before sync columns existed. Treated as lowest priority. */
  originDeviceId: DeviceId | null;
}

/** A row's sync metadata, including whether it is a tombstone. */
export interface SyncMeta extends SyncStamp {
  /** ISO-8601 when this row was soft-deleted, or null if live. */
  deletedAt: string | null;
}

/**
 * Advances a Lamport counter for a local write.
 *
 * Takes the max of our counter and anything we have observed, then adds one — so a local
 * edit always sorts after every change we know about, including changes pulled from
 * another device whose counter had run ahead of ours.
 */
export function nextRevision(localCounter: number, observedMax = 0): number {
  return Math.max(localCounter, observedMax, 0) + 1;
}

/**
 * Total order over stamps. Returns <0 if `a` is older, >0 if newer, 0 if identical.
 *
 * Deterministic and antisymmetric: every replica computes the same result for the same
 * pair, which is what keeps them from diverging.
 */
export function compareStamps(a: SyncStamp, b: SyncStamp): number {
  if (a.revision !== b.revision) return a.revision < b.revision ? -1 : 1;

  // Same revision means the edits were concurrent. Fall back to device id, which is
  // arbitrary but consistent everywhere.
  const left = a.originDeviceId;
  const right = b.originDeviceId;

  // A row with no origin predates sync, so it loses to anything stamped.
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

export type Resolution = 'local' | 'remote';

/**
 * Decides which version of a row survives a merge.
 *
 * THE DELIBERATE ASYMMETRY: when a delete and an edit are concurrent (identical
 * revisions), the EDIT wins and the row survives.
 *
 * The two failure modes are not equally bad. If delete won, someone's edit would disappear
 * with no trace and no way to recover it. If the edit wins, a song someone deleted comes
 * back — which is visible, obviously wrong, and fixed by deleting it again. Recoverable
 * beats silent.
 *
 * A delete that is genuinely LATER (higher revision) still wins normally; this rule only
 * governs true ties.
 */
export function resolveConflict(local: SyncMeta, remote: SyncMeta): Resolution {
  const order = compareStamps(local, remote);
  if (order > 0) return 'local';
  if (order < 0) return 'remote';

  // Exact tie on both revision and origin: same logical write, or the same device wrote
  // twice at one revision. Prefer whichever is NOT a tombstone.
  const localDeleted = local.deletedAt !== null;
  const remoteDeleted = remote.deletedAt !== null;
  if (localDeleted !== remoteDeleted) return localDeleted ? 'remote' : 'local';

  // Genuinely identical. Keep local to avoid a pointless write.
  return 'local';
}

/** True when a remote version should overwrite what we hold. */
export const shouldApplyRemote = (local: SyncMeta, remote: SyncMeta): boolean =>
  resolveConflict(local, remote) === 'remote';

/**
 * Which entities participate in sync, and which are tied to one machine.
 *
 * `camera_profiles` and `display_profiles` are DEVICE-scoped on purpose: they hold
 * OS-assigned device ids, monitor ids and bounds, which are meaningless on another
 * computer. Syncing them would point the booth machine's projector output at a display id
 * that only exists on someone's laptop.
 */
export const SYNCED_ENTITIES = Object.freeze([
  'songs',
  'services',
  'themes',
  'playlists',
  'presentations',
  'announcements',
  'media_assets',
] as const);

export const DEVICE_LOCAL_ENTITIES = Object.freeze([
  'camera_profiles',
  'display_profiles',
  'session_recovery',
] as const);

export type SyncedEntity = (typeof SYNCED_ENTITIES)[number];

export const isSyncedEntity = (entity: string): entity is SyncedEntity =>
  (SYNCED_ENTITIES as readonly string[]).includes(entity);

/**
 * Settings are mixed: some describe the library, some describe this computer.
 *
 * Anything hardware- or preference-bound must stay local, or pulling a service would
 * reassign the booth's projector and reset the operator's own UI.
 */
export const DEVICE_SCOPED_SETTING_PREFIXES = Object.freeze([
  'app.',
  'display.',
  'camera.',
  'confidence.',
  'autosave.',
  'cloud.',
  'presentation.aspectRatio',
] as const);

export type SettingScope = 'library' | 'device';

export function settingScope(key: string): SettingScope {
  return DEVICE_SCOPED_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix)) ? 'device' : 'library';
}

/**
 * Formats a device id for display, e.g. in "Last edited on Booth PC".
 * Short form is enough to distinguish machines without showing a raw UUID.
 */
export const shortDeviceId = (id: DeviceId | null): string => (id === null ? 'unknown' : id.slice(0, 8));
