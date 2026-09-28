/**
 * EXCEPTIONEL PRESENTER — the media channels, end to end through the dispatcher.
 *
 * Real SQLite, a real temporary media root, real files on disk. Only the file dialog is stubbed,
 * because it is the one thing that needs a human.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE is `no response ever carries a filesystem path`. Everything
 * else here is behaviour; that one is the security boundary. A renderer that learns `abs_path` learns
 * the operator's account name, and the whole reason for the `app-media:` protocol disappears.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type AppDatabase } from '../src/main/db/database.ts';
import { createLiveStateService } from '../src/main/services/live-state-service.ts';
import { createHandlers } from '../src/main/ipc/handlers.ts';
import { dispatch, isChannelAllowedForRole } from '../src/main/ipc/dispatcher.ts';
import { createMediaService, type MediaService } from '../src/main/services/media-service.ts';
import { mediaRoots } from '../src/main/services/media-import.ts';
import { IPC_CHANNELS, type AppInfo, type IpcResult } from '../src/shared/ipc-contract.ts';
import type { MediaAssetView, MediaImportReport } from '../src/shared/ipc-contract.ts';

const APP_INFO: AppInfo = {
  name: 'Exceptionel Presenter',
  version: '0.2.0',
  electronVersion: 'test',
  chromeVersion: 'test',
  nodeVersion: process.versions['node'] ?? 'test',
  platform: 'linux',
  schemaVersion: 2,
  sqliteEngine: 'node:sqlite',
  userDataPath: '/tmp/exceptionel-test',
  isPackaged: false,
};

interface Harness {
  db: AppDatabase;
  media: MediaService;
  dir: string;
  roots: ReturnType<typeof mediaRoots>;
  /** Files the stubbed dialog will return on the next import. */
  chosen: string[];
  call: (channel: string, payload?: unknown, role?: 'operator' | 'output' | 'confidence') => Promise<IpcResult<unknown>>;
  /** Writes a source file the operator might pick, returning its path. */
  source: (filename: string, content?: Uint8Array) => string;
  close: () => void;
}

function harness(options: { withThumbnails?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ep-media-ipc-'));
  const db = openDatabase({ path: ':memory:' });
  const roots = mediaRoots(join(dir, 'userData'));
  const state: { chosen: string[] } = { chosen: [] };

  const media = createMediaService({
    db,
    roots,
    chooseFiles: () => Promise.resolve(state.chosen),
    ...(options.withThumbnails
      ? {
          // Stands in for Electron's nativeImage, which cannot run here.
          generateThumbnail: async (asset) => {
            const path = join(roots.thumbnails, `${asset.id}.png`);
            writeFileSync(path, Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
            return { path, width: 640, height: 360 };
          },
        }
      : {}),
  });

  const handlers = createHandlers({
    db,
    live: createLiveStateService(),
    appInfo: () => APP_INFO,
    quit: () => undefined,
    media,
  });

  let counter = 0;

  return {
    db,
    media,
    dir,
    roots,
    get chosen() {
      return state.chosen;
    },
    set chosen(paths: string[]) {
      state.chosen = paths;
    },
    call: (channel, payload, role = 'operator') => dispatch(channel, payload, role, { handlers }),
    source: (filename, content) => {
      counter += 1;
      const path = join(dir, `${String(counter)}-${filename}`);
      // A distinct byte per file, so every source has its own hash unless asked otherwise.
      writeFileSync(path, content ?? Uint8Array.from({ length: 64 }, () => counter));
      return path;
    },
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const unwrap = <T,>(result: IpcResult<unknown>): T => {
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result.data as T;
};

const expectFailure = (result: IpcResult<unknown>, code: string): void => {
  assert.ok(!result.ok, 'expected a failure');
  assert.equal(result.failure.code, code);
};

// ── the boundary ────────────────────────────────────────────────────────────────

test('no response ever carries a filesystem path', async () => {
  const h = harness({ withThumbnails: true });
  try {
    // A name and a directory that would be unmistakable in any leaked payload.
    h.chosen = [h.source('sunrise.jpg')];
    const report = unwrap<MediaImportReport>(await h.call('media:import'));
    assert.ok(report.outcome === 'completed');

    const listed = unwrap<MediaAssetView[]>(await h.call('media:list', {}));
    const serialised = JSON.stringify({ report, listed });

    // The temp directory is the operator's private path in miniature.
    assert.ok(!serialised.includes(h.dir), 'a source path must not reach the renderer');
    assert.ok(!serialised.includes(h.roots.media), 'nor the media root');
    assert.ok(!serialised.includes(h.roots.thumbnails), 'nor the thumbnail root');
    assert.ok(!serialised.includes('absPath'), 'nor the field itself, even if empty');
    assert.ok(!serialised.includes('thumbnailPath'));
    // Nor the content hash, which the renderer has no use for.
    assert.ok(!serialised.includes('hash'));

    // What it DOES get: an id-addressed URL.
    const asset = listed[0];
    assert.ok(asset);
    assert.equal(asset.url, `app-media://${asset.id}`);
    assert.equal(asset.thumbnailUrl, `app-media://${asset.id}/thumbnail`);
  } finally {
    h.close();
  }
});

test('no media channel is reachable from the audience or confidence windows', () => {
  for (const channel of IPC_CHANNELS) {
    if (!channel.startsWith('media:') || channel === 'media:relay') continue;
    for (const role of ['output', 'confidence'] as const) {
      /*
       * The audience window needs no media channel at all: a background reaches it as an
       * `app-media://` URL inside the cue's theme, which the protocol serves without IPC. Giving it
       * `media:list` would hand a window that renders whatever it is told the ability to enumerate
       * the library.
       */
      assert.equal(isChannelAllowedForRole(channel, role), false, `${channel} from ${role}`);
    }
  }
});

test('the media channels report honestly when the service did not start', async () => {
  const db = openDatabase({ path: ':memory:' });
  try {
    // No `media` in the context: what a build looks like if construction failed.
    const handlers = createHandlers({
      db,
      live: createLiveStateService(),
      appInfo: () => APP_INFO,
      quit: () => undefined,
    });
    const result = await dispatch('media:list', {}, 'operator', { handlers });
    expectFailure(result, 'feature/not-implemented');
    assert.ok(!result.ok);
    assert.match(result.failure.message, /NOT IMPLEMENTED/);
    assert.ok(result.failure.remedies.some((remedy) => /Phase 5/.test(remedy)));
  } finally {
    db.close();
  }
});

// ── import ──────────────────────────────────────────────────────────────────────

test('importing copies the files in and lists them', async () => {
  const h = harness();
  try {
    h.chosen = [h.source('bg.png'), h.source('loop.mp4'), h.source('organ.mp3')];
    const report = unwrap<MediaImportReport>(await h.call('media:import'));

    assert.ok(report.outcome === 'completed');
    assert.equal(report.added.length, 3);
    assert.equal(report.refused.length, 0);
    assert.equal(report.duplicates.length, 0);
    assert.deepEqual(
      report.added.map((asset) => asset.kind).sort(),
      ['audio', 'image', 'video'],
    );

    // The bytes are really in the app's own root.
    assert.equal(h.db.media.count(), 3);
    for (const asset of h.db.media.list({})) {
      assert.ok(asset.absPath.startsWith(h.roots.media));
      assert.ok(existsSync(asset.absPath), `${asset.filename} must exist on disk`);
    }

    assert.equal(unwrap<MediaAssetView[]>(await h.call('media:list', {})).length, 3);
  } finally {
    h.close();
  }
});

test('closing the dialog is a cancellation, not an error', async () => {
  const h = harness();
  try {
    h.chosen = [];
    const report = unwrap<MediaImportReport>(await h.call('media:import'));
    // Must not be a failure: a red banner for "I changed my mind" trains operators to ignore banners.
    assert.equal(report.outcome, 'cancelled');
    assert.equal(h.db.media.count(), 0);
  } finally {
    h.close();
  }
});

test('one unusable file does not lose the rest of the batch', async () => {
  const h = harness();
  try {
    h.chosen = [
      h.source('good.jpg'),
      h.source('testimony.mov'),
      h.source('slides.pptx'),
      h.source('also-good.webm'),
    ];
    const report = unwrap<MediaImportReport>(await h.call('media:import'));
    assert.ok(report.outcome === 'completed');

    assert.equal(report.added.length, 2, 'the usable files still import');
    assert.equal(report.refused.length, 2);

    const mov = report.refused.find((entry) => entry.filename.endsWith('.mov'));
    assert.ok(mov);
    // Named and actionable: the operator needs to know to convert it, not that "something failed".
    assert.match(mov.reason, /QuickTime/);
    assert.match(mov.reason, /MP4/);

    const pptx = report.refused.find((entry) => entry.filename.endsWith('.pptx'));
    assert.ok(pptx);
    assert.match(pptx.reason, /not supported/);
    assert.match(pptx.reason, /\.jpg/, 'and what IS accepted');
  } finally {
    h.close();
  }
});

test('re-importing the same file reports it as already present, not as added', async () => {
  const h = harness();
  try {
    const identical = Uint8Array.from({ length: 128 }, (_, index) => index % 251);
    const first = h.source('background.jpg', identical);
    const second = h.source('background copy.jpg', identical);

    h.chosen = [first];
    unwrap<MediaImportReport>(await h.call('media:import'));

    // Both the same file again AND a differently-named copy of it.
    h.chosen = [first, second];
    const report = unwrap<MediaImportReport>(await h.call('media:import'));
    assert.ok(report.outcome === 'completed');
    assert.equal(report.added.length, 0);
    assert.equal(report.duplicates.length, 2);
    assert.equal(h.db.media.count(), 1, 'the library holds it once');
  } finally {
    h.close();
  }
});

test('a re-import repairs a file that went missing from the library folder', async () => {
  const h = harness();
  try {
    const path = h.source('bg.png');
    h.chosen = [path];
    unwrap<MediaImportReport>(await h.call('media:import'));

    // A failed backup restore, or a volunteer "tidying up" the app folder.
    const asset = h.db.media.list({})[0];
    assert.ok(asset);
    rmSync(asset.absPath);
    assert.ok(!existsSync(asset.absPath));

    h.chosen = [path];
    const report = unwrap<MediaImportReport>(await h.call('media:import'));

    // Recognised as a duplicate (the row is still there), but the FILE is restored — otherwise the
    // library would keep a row whose slide renders blank, with no way for the operator to fix it.
    assert.ok(report.outcome === 'completed');
    assert.equal(report.duplicates.length, 1);
    assert.ok(existsSync(asset.absPath), 'the missing file must be replaced');
  } finally {
    h.close();
  }
});

// ── favourites, categories, delete ──────────────────────────────────────────────

test('favouriting and categorising travel over the bridge', async () => {
  const h = harness();
  try {
    h.chosen = [h.source('bg.png')];
    const report = unwrap<MediaImportReport>(await h.call('media:import'));
    const asset = report.outcome === 'completed' ? report.added[0] : undefined;
    assert.ok(asset);

    unwrap(await h.call('media:setFavorite', { id: asset.id, isFavorite: true }));
    unwrap(await h.call('media:setCategory', { id: asset.id, category: 'Advent' }));

    const listed = unwrap<MediaAssetView[]>(await h.call('media:list', { favoritesOnly: true }));
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.isFavorite, true);
    assert.equal(listed[0]?.category, 'Advent');

    assert.deepEqual(unwrap<string[]>(await h.call('media:categories')), ['Advent']);

    // Null clears it, which is how the operator removes a category.
    unwrap(await h.call('media:setCategory', { id: asset.id, category: null }));
    assert.deepEqual(unwrap<string[]>(await h.call('media:categories')), []);
  } finally {
    h.close();
  }
});

test('deleting removes the row and the file', async () => {
  const h = harness({ withThumbnails: true });
  try {
    h.chosen = [h.source('bg.png')];
    unwrap<MediaImportReport>(await h.call('media:import'));

    const asset = h.db.media.list({})[0];
    assert.ok(asset);
    assert.ok(existsSync(asset.absPath));
    assert.ok(asset.thumbnailPath !== null && existsSync(asset.thumbnailPath));

    unwrap(await h.call('media:delete', { id: asset.id }));

    assert.equal(unwrap<MediaAssetView[]>(await h.call('media:list', {})).length, 0);
    assert.ok(!existsSync(asset.absPath), 'delete must actually free the space');
    assert.ok(asset.thumbnailPath !== null && !existsSync(asset.thumbnailPath));
  } finally {
    h.close();
  }
});

test('deleting something already deleted is quietly fine', async () => {
  const h = harness();
  try {
    h.chosen = [h.source('bg.png')];
    unwrap<MediaImportReport>(await h.call('media:import'));
    const asset = h.db.media.list({})[0];
    assert.ok(asset);

    unwrap(await h.call('media:delete', { id: asset.id }));
    // A double-click on Delete must not raise an error the operator has to dismiss.
    unwrap(await h.call('media:delete', { id: asset.id }));
    unwrap(await h.call('media:delete', { id: 'media_neverexisted' }));
  } finally {
    h.close();
  }
});

// ── serving ─────────────────────────────────────────────────────────────────────

test('the protocol resolves an id to the real file, with the right type', async () => {
  const h = harness({ withThumbnails: true });
  try {
    h.chosen = [h.source('loop.mp4')];
    unwrap<MediaImportReport>(await h.call('media:import'));
    const asset = h.db.media.list({})[0];
    assert.ok(asset);

    const original = h.media.resolveFile(asset.id, 'original');
    assert.equal(original?.path, asset.absPath);
    // Chromium picks a decoder from this, so it has to be the real container type.
    assert.equal(original?.mime, 'video/mp4');

    const thumbnail = h.media.resolveFile(asset.id, 'thumbnail');
    assert.equal(thumbnail?.path, asset.thumbnailPath);
    assert.equal(thumbnail?.mime, 'image/png');
  } finally {
    h.close();
  }
});

test('a URL held after a delete resolves to nothing, not to whatever is there now', async () => {
  const h = harness();
  try {
    h.chosen = [h.source('bg.png')];
    unwrap<MediaImportReport>(await h.call('media:import'));
    const asset = h.db.media.list({})[0];
    assert.ok(asset);

    unwrap(await h.call('media:delete', { id: asset.id }));

    /*
     * The stored name is derived from the content hash, so a later import of the same bytes occupies
     * the same path. Resolving a stale id by path rather than by row would serve the NEW file to a
     * window still holding the old URL.
     */
    assert.equal(h.media.resolveFile(asset.id, 'original'), null);
    assert.equal(h.media.resolveFile('media_nonexistent', 'original'), null);
  } finally {
    h.close();
  }
});

test('a thumbnail that was never generated resolves to null, not to the original', async () => {
  const h = harness();
  try {
    h.chosen = [h.source('bg.png')];
    unwrap<MediaImportReport>(await h.call('media:import'));
    const asset = h.db.media.list({})[0];
    assert.ok(asset);

    // Serving the full-size file where a thumbnail was asked for would make a grid of forty
    // backgrounds decode forty full images.
    assert.equal(h.media.resolveFile(asset.id, 'thumbnail'), null);
    assert.equal(
      unwrap<MediaAssetView[]>(await h.call('media:list', {}))[0]?.thumbnailUrl,
      null,
      'and the view says so, so the UI can show a placeholder',
    );
  } finally {
    h.close();
  }
});

test('a failing thumbnail generator does not fail the import', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ep-media-thumb-'));
  const db = openDatabase({ path: ':memory:' });
  try {
    const roots = mediaRoots(join(dir, 'userData'));
    const path = join(dir, 'bg.png');
    writeFileSync(path, Uint8Array.of(1, 2, 3, 4));

    const media = createMediaService({
      db,
      roots,
      chooseFiles: () => Promise.resolve([path]),
      // A real possibility: a corrupt or unusual file Chromium cannot decode.
      generateThumbnail: () => Promise.reject(new Error('decode failed')),
    });

    const report = await media.import();
    assert.ok(report.outcome === 'completed');
    assert.equal(report.added.length, 1, 'the asset is still imported');
    assert.equal(report.added[0]?.thumbnailUrl, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── payload validation ──────────────────────────────────────────────────────────

test('a renderer cannot smuggle a path into an import', async () => {
  const h = harness();
  try {
    // media:import takes no payload at all, so anything is refused before a handler runs.
    expectFailure(await h.call('media:import', { absPath: '/etc/shadow' }), 'ipc/invalid-payload');
    expectFailure(await h.call('media:import', { paths: ['/etc/shadow'] }), 'ipc/invalid-payload');
    expectFailure(await h.call('media:delete', { id: '../../etc/shadow' }), 'ipc/invalid-payload');
    expectFailure(await h.call('media:list', { kind: 'executable' }), 'ipc/invalid-payload');
  } finally {
    h.close();
  }
});
