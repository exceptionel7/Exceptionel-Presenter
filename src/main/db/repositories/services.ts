/**
 * EXCEPTIONEL PRESENTER — service builder persistence (Section 17).
 *
 * `service_items.ref_id` is polymorphic (it points into songs, media_assets, announcements
 * or presentations depending on `kind`), so SQLite cannot enforce it with a foreign key.
 * This repository is therefore the integrity boundary.
 *
 * Deletes are tombstones (migration 0003).
 */

import type {
  Service,
  ServiceItem,
  ServiceItemKind,
  ServiceSummary,
} from '../../../shared/domain/entities.ts';
import type { ServiceDraft } from '../../../shared/ipc-contract.ts';
import type { SqliteDriver } from '../driver.ts';
import type { IdentityRepository } from './identity.ts';
import { asInt, asJson, asText, asTextOrNull, jsonToSql, newId, nowIso, recordOp } from './support.ts';

export interface ServiceRepository {
  list(): ServiceSummary[];
  get(id: string): Service | null;
  save(draft: ServiceDraft): Service;
  delete(id: string): void;
  restore(id: string): Service | null;
  reorder(serviceId: string, itemIds: string[]): Service;
  listDeleted(limit?: number): ServiceSummary[];
  purgeTombstones(olderThanIso: string): number;
}

/**
 * Which table each item kind's ref_id points into. `null` = no row reference expected.
 * Tables carrying tombstones are checked for live rows only.
 */
const REF_TABLE: Readonly<Record<ServiceItemKind, { table: string; softDeleted: boolean } | null>> = {
  song: { table: 'songs', softDeleted: true },
  scripture: null, // the reference lives in config_json, not as a row id
  slide: { table: 'presentations', softDeleted: true },
  image: { table: 'media_assets', softDeleted: true },
  video: { table: 'media_assets', softDeleted: true },
  camera_scene: { table: 'camera_profiles', softDeleted: false }, // device-local, no tombstones
  announcement: { table: 'announcements', softDeleted: true },
  header: null, // a divider/label, purely presentational
};

export function createServiceRepository(
  db: SqliteDriver,
  identity: IdentityRepository,
): ServiceRepository {
  const readItems = (serviceId: string): ServiceItem[] =>
    db
      .prepare(
        `SELECT id, service_id, sort_order, kind, label, ref_id, config_json
         FROM service_items WHERE service_id = ? ORDER BY sort_order, id`,
      )
      .all(serviceId)
      .map((row) => ({
        id: asText(row['id'] ?? null),
        serviceId: asText(row['service_id'] ?? null),
        sortOrder: asInt(row['sort_order'] ?? null),
        kind: asText(row['kind'] ?? null) as ServiceItemKind,
        label: asText(row['label'] ?? null),
        refId: asTextOrNull(row['ref_id'] ?? null),
        config: asJson<Record<string, unknown>>(row['config_json'] ?? null, {}),
      }));

  const read = (id: string): Service | null => {
    const row = db
      .prepare(
        `SELECT id, name, service_date, theme_id, notes, created_at, updated_at
         FROM services WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id);
    if (!row) return null;
    return {
      id: asText(row['id'] ?? null),
      name: asText(row['name'] ?? null),
      serviceDate: asTextOrNull(row['service_date'] ?? null),
      themeId: asTextOrNull(row['theme_id'] ?? null),
      notes: asTextOrNull(row['notes'] ?? null),
      createdAt: asText(row['created_at'] ?? null),
      updatedAt: asText(row['updated_at'] ?? null),
      items: readItems(id),
    };
  };

  /** Enforces the polymorphic reference SQLite cannot. */
  const assertRefExists = (kind: ServiceItemKind, refId: string | null | undefined): void => {
    const target = REF_TABLE[kind];
    if (!target || !refId) return;

    // A deleted row must not be newly referenced: adding a song to a service after someone
    // deleted it would quietly create a broken item.
    const sql = target.softDeleted
      ? `SELECT 1 AS present FROM ${target.table} WHERE id = ? AND deleted_at IS NULL`
      : `SELECT 1 AS present FROM ${target.table} WHERE id = ?`;

    if (!db.prepare(sql).get(refId)) {
      throw new Error(
        `service item of kind "${kind}" references ${target.table} row "${refId}", which does not exist`,
      );
    }
  };

  const toSummary = (row: Record<string, unknown>): ServiceSummary => ({
    id: asText((row['id'] ?? null) as never),
    name: asText((row['name'] ?? null) as never),
    serviceDate: asTextOrNull((row['service_date'] ?? null) as never),
    itemCount: asInt((row['item_count'] ?? null) as never),
    updatedAt: asText((row['updated_at'] ?? null) as never),
  });

  return {
    list() {
      return db
        .prepare(
          `SELECT s.id, s.name, s.service_date, s.updated_at,
                  (SELECT COUNT(*) FROM service_items i WHERE i.service_id = s.id) AS item_count
           FROM services s
           WHERE s.deleted_at IS NULL
           ORDER BY COALESCE(s.service_date, s.updated_at) DESC, s.name`,
        )
        .all()
        .map(toSummary);
    },

    get: read,

    save(draft) {
      return db.transaction(() => {
        const timestamp = nowIso();
        const stamp = identity.nextStamp();
        const isNew = !draft.id;
        const serviceId = draft.id ?? newId('svc');

        // Validate every reference BEFORE writing anything, so a bad item at position 9
        // does not leave positions 0-8 persisted.
        for (const item of draft.items) {
          assertRefExists(item.kind as ServiceItemKind, item.refId);
        }

        if (isNew) {
          db.prepare(
            `INSERT INTO services (id, name, service_date, theme_id, notes, created_at, updated_at,
                                   revision, origin_device_id, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          ).run(
            serviceId,
            draft.name,
            draft.serviceDate ?? null,
            draft.themeId ?? null,
            draft.notes ?? null,
            timestamp,
            timestamp,
            stamp.revision,
            stamp.originDeviceId,
          );
        } else {
          const existing = db.prepare('SELECT deleted_at FROM services WHERE id = ?').get(serviceId);
          if (!existing) throw new Error(`cannot update service ${serviceId}: it does not exist`);
          if (existing['deleted_at'] !== null) {
            throw new Error(
              `cannot update service ${serviceId}: it has been deleted — restore it first`,
            );
          }

          db.prepare(
            `UPDATE services SET name = ?, service_date = ?, theme_id = ?, notes = ?,
                                 updated_at = ?, revision = ?, origin_device_id = ?
             WHERE id = ?`,
          ).run(
            draft.name,
            draft.serviceDate ?? null,
            draft.themeId ?? null,
            draft.notes ?? null,
            timestamp,
            stamp.revision,
            stamp.originDeviceId,
            serviceId,
          );
        }

        db.prepare('DELETE FROM service_items WHERE service_id = ?').run(serviceId);
        const insertItem = db.prepare(
          `INSERT INTO service_items (id, service_id, sort_order, kind, label, ref_id, config_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        draft.items.forEach((item, index) => {
          insertItem.run(
            item.id ?? newId('item'),
            serviceId,
            index, // array position wins over client sortOrder, which drag-drop leaves gappy
            item.kind,
            item.label,
            item.refId ?? null,
            jsonToSql(item.config ?? {}),
          );
        });

        recordOp(db, 'services', serviceId, isNew ? 'insert' : 'update', undefined, stamp);

        const saved = read(serviceId);
        if (!saved) throw new Error(`service ${serviceId} vanished immediately after write`);
        return saved;
      });
    },

    delete(id) {
      db.transaction(() => {
        const stamp = identity.nextStamp();
        const result = db
          .prepare(
            `UPDATE services SET deleted_at = ?, updated_at = ?, revision = ?, origin_device_id = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(nowIso(), nowIso(), stamp.revision, stamp.originDeviceId, id);
        if (result.changes === 0) return;
        recordOp(db, 'services', id, 'delete', undefined, stamp);
      });
    },

    restore(id) {
      return db.transaction(() => {
        const stamp = identity.nextStamp();
        const result = db
          .prepare(
            `UPDATE services SET deleted_at = NULL, updated_at = ?, revision = ?, origin_device_id = ?
             WHERE id = ? AND deleted_at IS NOT NULL`,
          )
          .run(nowIso(), stamp.revision, stamp.originDeviceId, id);
        if (result.changes === 0) return null;
        recordOp(db, 'services', id, 'update', { restored: true }, stamp);
        return read(id);
      });
    },

    reorder(serviceId, itemIds) {
      return db.transaction(() => {
        const live = db.prepare('SELECT 1 AS ok FROM services WHERE id = ? AND deleted_at IS NULL').get(serviceId);
        if (!live) throw new Error(`cannot reorder service ${serviceId}: it does not exist`);

        const current = readItems(serviceId);
        if (current.length === 0 && itemIds.length > 0) {
          throw new Error(`cannot reorder service ${serviceId}: it has no items`);
        }

        // Refuse anything but a complete permutation. A partial list would leave omitted
        // items at stale positions, and a list with duplicates ([a,a] for two items) would
        // pass a naive length check while collapsing the running order.
        const currentIds = new Set(current.map((item) => item.id));
        const requestedIds = new Set(itemIds);
        if (
          requestedIds.size !== itemIds.length ||
          itemIds.length !== currentIds.size ||
          !itemIds.every((id) => currentIds.has(id))
        ) {
          throw new Error(
            `reorder must list every item exactly once ` +
              `(expected ${currentIds.size} distinct ids, received ${itemIds.length} ` +
              `with ${requestedIds.size} distinct)`,
          );
        }

        const stamp = identity.nextStamp();
        const update = db.prepare('UPDATE service_items SET sort_order = ? WHERE id = ? AND service_id = ?');
        itemIds.forEach((itemId, index) => update.run(index, itemId, serviceId));

        db.prepare(
          'UPDATE services SET updated_at = ?, revision = ?, origin_device_id = ? WHERE id = ?',
        ).run(nowIso(), stamp.revision, stamp.originDeviceId, serviceId);
        recordOp(db, 'services', serviceId, 'update', { reordered: true }, stamp);

        const saved = read(serviceId);
        if (!saved) throw new Error(`service ${serviceId} vanished during reorder`);
        return saved;
      });
    },

    listDeleted(limit = 50) {
      return db
        .prepare(
          `SELECT s.id, s.name, s.service_date, s.updated_at,
                  (SELECT COUNT(*) FROM service_items i WHERE i.service_id = s.id) AS item_count
           FROM services s
           WHERE s.deleted_at IS NOT NULL
           ORDER BY s.deleted_at DESC
           LIMIT ?`,
        )
        .all(Math.min(Math.max(limit, 1), 500))
        .map(toSummary);
    },

    purgeTombstones(olderThanIso) {
      return db.transaction(
        () =>
          db
            .prepare('DELETE FROM services WHERE deleted_at IS NOT NULL AND deleted_at < ?')
            .run(olderThanIso).changes,
      );
    },
  };
}
