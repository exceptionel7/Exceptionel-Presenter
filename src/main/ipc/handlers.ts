/**
 * EXCEPTIONEL PRESENTER — IPC handler registry.
 *
 * Maps channels to implementations. Payloads arriving here are already validated by the
 * dispatcher, so handlers may trust their shape (but not their meaning — referential
 * integrity is still the repositories' job).
 *
 * Channels belonging to later phases are registered as explicit NOT IMPLEMENTED failures
 * rather than being omitted. An omitted channel reports "this action is not available",
 * which looks like a bug; a deliberate stub tells the operator which phase delivers it.
 * Section 42.
 */

import { failure } from '../../shared/domain/errors.ts';
import type { AppInfo, ChurchProfileDraft, ServiceDraft, SongDraft, ThemeDraft } from '../../shared/ipc-contract.ts';
import type { ShortcutBinding, SongQuery } from '../../shared/domain/entities.ts';
import type { Cue, LiveIntent } from '../../shared/domain/live-state.ts';
import type { AppDatabase } from '../db/database.ts';
import type { HandlerRegistry } from './dispatcher.ts';
import { cuesFromServiceItems, type LiveStateService } from '../services/live-state-service.ts';

export interface HandlerContext {
  db: AppDatabase;
  live: LiveStateService;
  appInfo: () => AppInfo;
  quit: () => void;
}

/** Thrown by not-yet-built channels so the UI can say exactly what is missing and why. */
function notImplemented(feature: string, phase: string, requirement: string): never {
  const appFailure = failure({
    domain: 'internal',
    code: 'feature/not-implemented',
    message: `${feature} is NOT IMPLEMENTED in this build.`,
    remedies: [`Planned for ${phase}.`, requirement],
    severity: 'info',
  });
  throw Object.assign(new Error(appFailure.message), { failure: appFailure });
}

export function createHandlers(context: HandlerContext): HandlerRegistry {
  const { db, live } = context;

  return {
    // ── app ──────────────────────────────────────────────────────────────────────
    'app:info': () => context.appInfo(),
    'app:quit': () => {
      context.quit();
    },

    // ── church profile & onboarding (Section 36) ──────────────────────────────────
    'profile:get': () => db.profile.get(),
    'profile:save': (payload) => db.profile.save(payload as ChurchProfileDraft),
    'onboarding:complete': () => db.profile.completeOnboarding(),

    // ── settings (Section 37) ────────────────────────────────────────────────────
    'settings:getAll': () => db.settings.getAll(),
    'settings:get': (payload) => {
      const { key } = payload as { key: string };
      return db.settings.get<unknown>(key, null);
    },
    'settings:set': (payload) => {
      const { key, value } = payload as { key: string; value: unknown };
      db.settings.set(key, value);
    },
    'settings:reset': (payload) => {
      const { key } = payload as { key: string };
      db.settings.remove(key);
    },

    // ── shortcuts (Section 20) ───────────────────────────────────────────────────
    'shortcuts:list': () => db.shortcuts.list(),
    'shortcuts:set': (payload) => db.shortcuts.set(payload as ShortcutBinding),
    'shortcuts:resetDefaults': () => db.shortcuts.resetDefaults(),

    // ── songs (Section 7) ────────────────────────────────────────────────────────
    'songs:list': (payload) => db.songs.list(payload as SongQuery),
    'songs:get': (payload) => db.songs.get((payload as { id: string }).id),
    'songs:save': (payload) => db.songs.save(payload as SongDraft),
    'songs:delete': (payload) => {
      db.songs.delete((payload as { id: string }).id);
    },
    'songs:duplicate': (payload) => db.songs.duplicate((payload as { id: string }).id),
    'songs:setFavorite': (payload) => {
      const { id, isFavorite } = payload as { id: string; isFavorite: boolean };
      db.songs.setFavorite(id, isFavorite);
    },

    // ── services (Section 17) ────────────────────────────────────────────────────
    'services:list': () => db.services.list(),
    'services:get': (payload) => db.services.get((payload as { id: string }).id),
    'services:save': (payload) => db.services.save(payload as ServiceDraft),
    'services:delete': (payload) => {
      db.services.delete((payload as { id: string }).id);
    },
    'services:reorder': (payload) => {
      const { serviceId, itemIds } = payload as { serviceId: string; itemIds: string[] };
      return db.services.reorder(serviceId, itemIds);
    },

    // ── themes (Section 16) ──────────────────────────────────────────────────────
    'themes:list': () => db.themes.list(),
    'themes:save': (payload) => db.themes.save(payload as ThemeDraft),
    'themes:delete': (payload) => {
      db.themes.delete((payload as { id: string }).id);
    },

    // ── live control (Sections 19-21) ────────────────────────────────────────────
    'live:getState': () => live.getState(),
    'live:intent': (payload) => live.apply(payload as LiveIntent),
    'live:setCues': (payload) => live.setCues((payload as { cues: Cue[] }).cues),

    // ── crash recovery (Section 33) ──────────────────────────────────────────────
    'recovery:check': () => db.recovery.findRecoverable(),
    'recovery:restore': (payload) => {
      const snapshot = db.recovery.findRecoverable();
      const { id } = payload as { id: string };
      if (!snapshot || snapshot.id !== id) return null;
      const service = snapshot.serviceId ? db.services.get(snapshot.serviceId) : null;
      if (service) live.setCues(cuesFromServiceItems(service.items));
      db.recovery.discard(id);
      return service;
    },
    'recovery:discard': (payload) => {
      db.recovery.discard((payload as { id: string }).id);
    },

    // ── NOT IMPLEMENTED — later phases ───────────────────────────────────────────
    // These exist so the UI receives an honest, specific explanation instead of a
    // generic "unknown channel" that looks like a crash.

    'media:list': () =>
      notImplemented('The media library', 'Phase 5', 'Requires the media import pipeline and thumbnail generation.'),
    'media:import': () =>
      notImplemented('Media import', 'Phase 5', 'Requires the main-process file dialog and content hashing.'),
    'media:delete': () => notImplemented('Media deletion', 'Phase 5', 'Requires the media library.'),

    'bible:translations': () =>
      notImplemented(
        'Bible translations',
        'Phase 4',
        'Requires the translation package importer. No scripture text is bundled — translations must be installed from a properly licensed or public-domain source.',
      ),
    'bible:lookup': () =>
      notImplemented('Scripture lookup', 'Phase 4', 'Requires at least one installed Bible translation.'),

    'announcements:list': () =>
      notImplemented('Announcements', 'Phase 5', 'Requires the announcement editor and media library.'),
    'announcements:save': () => notImplemented('Announcements', 'Phase 5', 'Requires the announcement editor.'),
    'announcements:delete': () => notImplemented('Announcements', 'Phase 5', 'Requires the announcement editor.'),

    'display:list': () =>
      notImplemented(
        'Display detection',
        'Phase 7',
        "Requires the display service over Electron's screen API. Note that refresh rate is not exposed by Electron and will show as unavailable.",
      ),
    'display:assign': () => notImplemented('Output assignment', 'Phase 7', 'Requires the display service.'),
    'display:status': () => notImplemented('Output status', 'Phase 7', 'Requires the display service.'),
    'display:identify': () => notImplemented('Display identification', 'Phase 7', 'Requires the display service.'),
    'output:open': () =>
      notImplemented('The presentation output window', 'Phase 7', 'Requires multi-display output management.'),
    'output:close': () => notImplemented('The presentation output window', 'Phase 7', 'Requires output management.'),

    'camera:list': () =>
      notImplemented(
        'Camera detection',
        'Phase 6',
        'Requires the camera provider registry. Camera streams are opened in the renderer via getUserMedia and never leave this computer.',
      ),
    'camera:profiles': () => notImplemented('Camera profiles', 'Phase 6', 'Requires the camera provider registry.'),
    'camera:saveProfile': () => notImplemented('Camera profiles', 'Phase 6', 'Requires the camera provider registry.'),
    'camera:deleteProfile': () => notImplemented('Camera profiles', 'Phase 6', 'Requires the camera provider registry.'),
  };
}
