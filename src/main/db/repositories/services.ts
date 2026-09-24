/**
 * EXCEPTIONEL PRESENTER — service builder persistence (Section 17).
 *
 * `service_items.ref_id` is polymorphic (it points into songs, media_assets,
 * announcements or presentations depending on `kind`), so SQLite cannot enforce it with a
 * foreign key. This repository is therefore the integrity boundary: it validates that a
 * referenced row actually exists before writing.
 */

import type {
  Service,
  ServiceItem,
  ServiceItemKind,
  ServiceSummary,
} from '../../../shared/domain/entities.ts';
import type { ServiceDraft } from '../../../shared/ipc-contract.ts';
import type { SqliteDriver } from '../driver.ts';
import { asInt, asJson, asText, asTextOrNull, jsonToSql, newId, nowIso, recordOp } from './support.ts';

export interface ServiceRepository {
  list(): ServiceSummary[];
  get(id: string): Service | null;
  save(draft: ServiceDraft): Service;
  delete(id: string): void;
  reorder(serviceId: string, itemIds: string[]): Service;
}

/** Which table each item kind's ref_id points into. `null` = no reference expected. */
const REF_TABLE: Readonly<Record<ServiceItemKind, string | null>> = {
  song: 'songs',
  scripture: null, // the reference lives in config_json, not as a row id
  slide: 'presentations',
  image: 'media_assets',
  video: 'media_assets',
  camera_scene: 'camera_profiles',
  announcement: 'announcements',
  header: null, // a divider/label, purely presentational
};

export function createServiceRepository(db: SqliteDriver): ServiceRepository {
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
         FROM services WHERE id = ?`,
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
    const table = REF_TABLE[kind];
    if (!table || !refId) return;
    const found = db.prepare(`SELECT 1 AS present FROM ${table} WHERE id = ?`).get(refId);
    if (!found) {
      throw new Error(
        `service item of kind "${kind}" references ${table} row "${refId}", which does not exist`,
      );
    }
  };

  return {
    list() {
      return db
        .prepare(
          `SELECT s.id, s.name, s.service_date, s.updated_at,
                  (SELECT COUNT(*) FROM service_items i WHERE i.service_id = s.id) AS item_count
           FROM services s
           ORDER BY COALESCE(s.service_date, s.updated_at) DESC, s.name`,
        )
        .all()
        .map((row) => ({
          id: asText(row['id'] ?? null),
          name: asText(row['name'] ?? null),
          serviceDate: asTextOrNull(row['service_date'] ?? null),
          itemCount: asInt(row['item_count'] ?? null),
          updatedAt: asText(row['updated_at'] ?? null),
        }));
    },

    get: read,

    save(draft) {
      return db.transaction(() => {
        const timestamp = nowIso();
        const isNew = !draft.id;
        const serviceId = draft.id ?? newId('svc');

        // Validate every reference BEFORE writing anything, so a bad item at position 9
        // does not leave positions 0-8 persisted.
        for (const item of draft.items) {
          assertRefExists(item.kind as ServiceItemKind, item.refId);
        }

        if (isNew) {
          db.prepare(
            `INSERT INTO services (id, name, service_date, theme_id, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            serviceId,
            draft.name,
            draft.serviceDate ?? null,
            draft.themeId ?? null,
            draft.notes ?? null,
            timestamp,
            timestamp,
          );
        } else {
          const existing = db.prepare('SELECT 1 AS present FROM services WHERE id = ?').get(serviceId);
          if (!existing) throw new Error(`cannot update service ${serviceId}: it does not exist`);
          db.prepare(
            `UPDATE services SET name = ?, service_date = ?, theme_id = ?, notes = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            draft.name,
            draft.serviceDate ?? null,
            draft.themeId ?? null,
            draft.notes ?? null,
            timestamp,
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

        recordOp(db, 'services', serviceId, isNew ? 'insert' : 'update');

        const saved = read(serviceId);
        if (!saved) throw new Error(`service ${serviceId} vanished immediately after write`);
        return saved;
      });
    },

    delete(id) {
      db.transaction(() => {
        const result = db.prepare('DELETE FROM services WHERE id = ?').run(id);
        if (result.changes === 0) return;
        recordOp(db, 'services', id, 'delete');
      });
    },

    reorder(serviceId, itemIds) {
      return db.transaction(() => {
        const current = readItems(serviceId);
        if (current.length === 0 && itemIds.length > 0) {
          throw new Error(`cannot reorder service ${serviceId}: it has no items`);
        }

        // Refuse anything but a complete permutation. A partial list would leave the
        // omitted items at stale positions, and a list with duplicates (e.g. [a, a] for a
        // two-item service) would pass a naive length check while collapsing the running
        // order. Both scramble a service mid-build, so both are rejected.
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

        const update = db.prepare('UPDATE service_items SET sort_order = ? WHERE id = ? AND service_id = ?');
        itemIds.forEach((itemId, index) => update.run(index, itemId, serviceId));

        db.prepare('UPDATE services SET updated_at = ? WHERE id = ?').run(nowIso(), serviceId);
        recordOp(db, 'services', serviceId, 'update', { reordered: true });

        const saved = read(serviceId);
        if (!saved) throw new Error(`service ${serviceId} vanished during reorder`);
        return saved;
      });
    },
  };
}
