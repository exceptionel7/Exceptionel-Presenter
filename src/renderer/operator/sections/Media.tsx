/**
 * MEDIA — the imported media library (Section 13, Phase 5).
 *
 * A real, working library: import, search, filter, categorise, favourite, delete. Every action goes
 * through validated IPC to SQLite, and every file shown is one the application has copied into its own
 * folder.
 *
 * NO FILESYSTEM PATH EXISTS IN THIS FILE, and none can. `media:list` returns `MediaAssetView`, which
 * carries `app-media://` URLs instead of paths; import is driven by a dialog in the main process, so
 * this screen cannot name a file to import even if it wanted to.
 *
 * VIDEO THUMBNAILS ARE NOT IMPLEMENTED — `nativeImage` has no video decoder (see
 * src/main/services/thumbnails.ts). A video tile therefore shows a LABELLED placeholder saying so. Not
 * a blank square: an operator who sees an empty tile concludes the import failed and imports the file
 * again, which is precisely the confusion this screen exists to prevent.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MEDIA_KINDS, type MediaKind } from '@shared/domain/entities.ts';
import {
  acceptedExtensions,
  canBeBackground,
  describeBytes,
  describeMediaKind,
} from '@shared/domain/media.ts';
import type { MediaAssetView, MediaImportReport, ServiceSummary } from '@shared/ipc-contract.ts';
import { client } from '@ui/client.ts';
import { useMutation, useQuery } from '@ui/hooks.ts';
import { EmptyState, FailureNotice, Panel, Spinner } from '@ui/primitives.tsx';

type KindFilter = MediaKind | 'all';

export function MediaSection(): JSX.Element {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [category, setCategory] = useState<string>('all');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<MediaImportReport | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Debounced so each keystroke does not fire an IPC round trip against the whole library.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 180);
    return () => clearTimeout(handle);
  }, [search]);

  const list = useQuery('media:list', {
    ...(debounced === '' ? {} : { search: debounced }),
    ...(kind === 'all' ? {} : { kind }),
    ...(category === 'all' ? {} : { category }),
    ...(favouritesOnly ? { favoritesOnly: true } : {}),
  });
  const categories = useQuery('media:categories');
  const services = useQuery('services:list');

  const importMedia = useMutation('media:import');
  const remove = useMutation('media:delete');
  const favourite = useMutation('media:setFavorite');
  const categorise = useMutation('media:setCategory');

  const assets: readonly MediaAssetView[] = list.data ?? [];
  const selected = useMemo(
    () => assets.find((asset) => asset.id === selectedId) ?? null,
    [assets, selectedId],
  );

  const refresh = useCallback(() => {
    list.reload();
    // The category list changes with the assets, so it has to be re-read alongside them or the
    // filter bar offers a category nothing is filed under any more.
    categories.reload();
  }, [list, categories]);

  const runImport = useCallback(async () => {
    const result = await importMedia.run();
    if (result) {
      setReport(result);
      if (result.outcome === 'completed') refresh();
    }
  }, [importMedia, refresh]);

  const confirmDelete = useCallback(
    async (id: string) => {
      await remove.run({ id });
      setConfirmDeleteId(null);
      if (selectedId === id) setSelectedId(null);
      refresh();
    },
    [remove, selectedId, refresh],
  );

  /**
   * Appends this file to a service's running order as a slide of its own.
   *
   * WHY THIS BUTTON HAS TO EXIST. `buildCues` turns an `image` or `video` item into a real cue, and
   * `SlideCanvas` paints it — but nothing else in the application can create such an item. The minimal
   * service builder adds songs only, and the full builder is Phase 8. Without this, a working
   * capability would be reachable from no interface at all.
   *
   * EXISTING ITEM IDS ARE PASSED BACK, deliberately. `services:save` replaces the item rows and cue ids
   * derive from item ids, so omitting them would regenerate every cue — and `setCues` would find the
   * live one gone, blacking the projector mid-service.
   */
  const addToService = useCallback(
    async (asset: MediaAssetView, serviceId: string) => {
      setNotice(null);

      const current = await client.invoke('services:get', { id: serviceId });
      if (!current.ok || current.data === null) {
        setNotice('That service could not be opened.');
        return;
      }

      const service = current.data;
      const saved = await client.invoke('services:save', {
        id: service.id,
        name: service.name,
        serviceDate: service.serviceDate,
        themeId: service.themeId,
        notes: service.notes,
        items: [
          ...service.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            label: item.label,
            sortOrder: item.sortOrder,
            refId: item.refId,
            config: item.config,
          })),
          {
            // A video asset becomes a video item. The cue builder re-checks this against the asset
            // anyway, so a mismatch cannot reach the projector, but there is no reason to store one.
            kind: asset.kind === 'video' ? 'video' : 'image',
            label: asset.filename,
            sortOrder: service.items.length,
            // The asset ID, so the engine resolves it fresh every time the service opens rather than
            // storing a copy of anything that could go stale.
            refId: asset.id,
            config: {},
          },
        ],
      });

      if (!saved.ok) {
        setNotice(saved.failure.message);
        return;
      }

      setNotice(`Added ${asset.filename} to ${service.name}.`);
      services.reload();
    },
    [services],
  );

  const busy = importMedia.pending || remove.pending;
  const filtering = debounced !== '' || kind !== 'all' || category !== 'all' || favouritesOnly;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 p-4 overflow-hidden">
      <Panel
        title="Media library"
        actions={
          <button
            type="button"
            className="h-7 px-3 rounded-md text-[12px] font-semibold bg-brand-600 text-white hover:bg-brand-500 transition-colors disabled:opacity-50"
            onClick={() => void runImport()}
            disabled={busy}
            // A disabled control with no stated reason is indistinguishable from a broken one.
            title={busy ? 'Finishing the last action first' : 'Copy files into your media library'}
          >
            {importMedia.pending ? 'Importing…' : 'Import files…'}
          </button>
        }
        className="shrink-0"
        bodyClassName="p-3 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-silver-600">Search</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="File name or category"
              className="h-8 w-56 px-2 rounded-md bg-ink-850 border border-ink-700 text-[13px] text-silver-100 placeholder:text-silver-600 focus:border-brand-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-silver-600">Type</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as KindFilter)}
              className="h-8 px-2 rounded-md bg-ink-850 border border-ink-700 text-[13px] text-silver-100 focus:border-brand-500 focus:outline-none"
            >
              <option value="all">All types</option>
              {MEDIA_KINDS.map((entry) => (
                <option key={entry} value={entry}>
                  {describeMediaKind(entry)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-silver-600">Category</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="h-8 px-2 rounded-md bg-ink-850 border border-ink-700 text-[13px] text-silver-100 focus:border-brand-500 focus:outline-none"
            >
              <option value="all">All categories</option>
              {(categories.data ?? []).map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 h-8 text-[13px] text-silver-300">
            <input
              type="checkbox"
              checked={favouritesOnly}
              onChange={(event) => setFavouritesOnly(event.target.checked)}
              className="accent-brand-500"
            />
            Favourites only
          </label>

          <span className="ml-auto text-[12px] text-silver-600">
            {list.loading
              ? 'Loading…'
              : `${String(assets.length)} ${assets.length === 1 ? 'file' : 'files'}${
                  filtering ? ' matching' : ''
                }`}
          </span>
        </div>

        {report !== null && <ImportReport report={report} onDismiss={() => setReport(null)} />}

        {importMedia.failure !== null && (
          <FailureNotice notice={importMedia.failure} onDismiss={importMedia.clearFailure} />
        )}
        {remove.failure !== null && (
          <FailureNotice notice={remove.failure} onDismiss={remove.clearFailure} />
        )}
      </Panel>

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[1fr_20rem] gap-4">
        <Panel title="Files" bodyClassName="p-3 overflow-auto">
          {list.failure !== null ? (
            <FailureNotice notice={list.failure} onRetry={list.reload} />
          ) : list.loading && assets.length === 0 ? (
            <Spinner label="Reading your media library" />
          ) : assets.length === 0 ? (
            <EmptyState
              title={filtering ? 'Nothing matches those filters' : 'No media yet'}
              description={
                filtering
                  ? 'Clear the search or filters to see everything in your library.'
                  : `Import images, video or audio to use as backgrounds and slides. Accepted formats: ${acceptedExtensions().join(', ')}.`
              }
            />
          ) : (
            <ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <MediaTile
                    asset={asset}
                    selected={asset.id === selectedId}
                    onSelect={() => setSelectedId(asset.id)}
                    onToggleFavourite={() => {
                      void favourite.run({ id: asset.id, isFavorite: !asset.isFavorite }).then(refresh);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Details" bodyClassName="p-3 overflow-auto">
          {selected === null ? (
            <EmptyState title="Nothing selected" description="Choose a file to see its details." />
          ) : (
            <Details
              asset={selected}
              categories={categories.data ?? []}
              services={services.data ?? []}
              notice={notice}
              onAddToService={(serviceId) => void addToService(selected, serviceId)}
              busy={busy}
              confirming={confirmDeleteId === selected.id}
              onCategorise={(value) => {
                void categorise.run({ id: selected.id, category: value }).then(refresh);
              }}
              onToggleFavourite={() => {
                void favourite
                  .run({ id: selected.id, isFavorite: !selected.isFavorite })
                  .then(refresh);
              }}
              onAskDelete={() => setConfirmDeleteId(selected.id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onConfirmDelete={() => void confirmDelete(selected.id)}
            />
          )}
        </Panel>
      </div>
    </div>
  );
}

// ── one tile ────────────────────────────────────────────────────────────────────

function MediaTile({
  asset,
  selected,
  onSelect,
  onToggleFavourite,
}: {
  asset: MediaAssetView;
  selected: boolean;
  onSelect: () => void;
  onToggleFavourite: () => void;
}): JSX.Element {
  return (
    <div
      className={`group relative rounded-lg border overflow-hidden transition-colors ${
        selected ? 'border-brand-500 bg-ink-800' : 'border-ink-700 bg-ink-850 hover:border-ink-600'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="block w-full text-left"
        aria-pressed={selected}
      >
        <Preview asset={asset} />
        <span className="block px-2 py-1.5">
          <span className="block truncate text-[12px] text-silver-200" title={asset.filename}>
            {asset.filename}
          </span>
          <span className="block text-[11px] text-silver-600">
            {describeMediaKind(asset.kind)} · {describeBytes(asset.bytes)}
            {asset.width !== null && asset.height !== null
              ? ` · ${String(asset.width)}×${String(asset.height)}`
              : ''}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={onToggleFavourite}
        className={`absolute top-1.5 right-1.5 h-6 w-6 grid place-items-center rounded-md text-[13px] transition-colors ${
          asset.isFavorite
            ? 'bg-ink-900/80 text-status-ready'
            : 'bg-ink-900/60 text-silver-600 opacity-0 group-hover:opacity-100 focus:opacity-100'
        }`}
        // The glyph alone does not say what the control does, and a favourite toggle that only
        // appears on hover is invisible to anyone using a keyboard without it.
        aria-label={asset.isFavorite ? `Remove ${asset.filename} from favourites` : `Add ${asset.filename} to favourites`}
        title={asset.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
      >
        {asset.isFavorite ? '★' : '☆'}
      </button>
    </div>
  );
}

/**
 * The tile's picture.
 *
 * Three real cases, each shown honestly:
 *  - a thumbnail exists — show it;
 *  - the asset is a video — say that no preview frame can be generated, and why in one word;
 *  - it is audio, or an image whose thumbnail could not be generated — name the type.
 */
function Preview({ asset }: { asset: MediaAssetView }): JSX.Element {
  if (asset.thumbnailUrl !== null) {
    return (
      <span className="block aspect-video bg-ink-900">
        <img
          src={asset.thumbnailUrl}
          alt=""
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
        />
      </span>
    );
  }

  const label =
    asset.kind === 'video'
      ? 'Video — no preview frame'
      : asset.kind === 'audio'
        ? 'Audio'
        : 'No preview available';

  return (
    <span className="block aspect-video bg-[repeating-linear-gradient(45deg,#0d1a28_0px,#0d1a28_8px,#0a1421_8px,#0a1421_16px)] grid place-items-center">
      <span className="px-2 text-center text-[9px] uppercase tracking-[0.18em] text-silver-600">
        {label}
      </span>
    </span>
  );
}

// ── the details pane ────────────────────────────────────────────────────────────

function Details({
  asset,
  categories,
  services,
  notice,
  busy,
  confirming,
  onCategorise,
  onToggleFavourite,
  onAddToService,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  asset: MediaAssetView;
  categories: readonly string[];
  services: readonly ServiceSummary[];
  notice: string | null;
  busy: boolean;
  confirming: boolean;
  onCategorise: (category: string | null) => void;
  onToggleFavourite: () => void;
  onAddToService: (serviceId: string) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}): JSX.Element {
  const [draftCategory, setDraftCategory] = useState(asset.category ?? '');

  // Re-seeded when the selection changes, so the field always describes the file on screen.
  useEffect(() => setDraftCategory(asset.category ?? ''), [asset.id, asset.category]);

  const categoryChanged = draftCategory.trim() !== (asset.category ?? '');

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg overflow-hidden border border-ink-700">
        <Preview asset={asset} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        <Row label="Name">{asset.filename}</Row>
        <Row label="Type">{describeMediaKind(asset.kind)}</Row>
        <Row label="Format">{asset.mime}</Row>
        <Row label="Size">{describeBytes(asset.bytes)}</Row>
        {asset.width !== null && asset.height !== null && (
          <Row label="Dimensions">{`${String(asset.width)} × ${String(asset.height)}`}</Row>
        )}
        {asset.durationMs !== null && (
          <Row label="Duration">{`${(asset.durationMs / 1000).toFixed(1)}s`}</Row>
        )}
        <Row label="Imported">{new Date(asset.createdAt).toLocaleString()}</Row>
        <Row label="Usable as">
          {canBeBackground(asset.kind)
            ? asset.kind === 'video'
              ? 'A background (silent, looping) or a slide of its own'
              : 'A background or a slide of its own'
            : /*
               * Audio is imported and stored, but nothing plays it yet. Said plainly rather than
               * implied by its absence from a dropdown the operator has to go looking for.
               */
              'Stored only — audio playback is NOT IMPLEMENTED yet'}
        </Row>
      </dl>

      <div className="flex flex-col gap-2">
        <label htmlFor="media-category" className="text-[11px] uppercase tracking-wider text-silver-600">
          Category
        </label>
        <div className="flex gap-2">
          <input
            id="media-category"
            value={draftCategory}
            onChange={(event) => setDraftCategory(event.target.value)}
            list="media-category-suggestions"
            placeholder="None"
            className="h-8 flex-1 min-w-0 px-2 rounded-md bg-ink-850 border border-ink-700 text-[13px] text-silver-100 placeholder:text-silver-600 focus:border-brand-500 focus:outline-none"
          />
          <datalist id="media-category-suggestions">
            {categories.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
          <button
            type="button"
            className="h-8 px-3 rounded-md text-[12px] font-semibold bg-ink-750 text-silver-200 hover:bg-ink-700 transition-colors disabled:opacity-40"
            onClick={() => onCategorise(draftCategory.trim() === '' ? null : draftCategory.trim())}
            disabled={busy || !categoryChanged}
            title={
              busy
                ? 'Finishing the last action first'
                : categoryChanged
                  ? 'Save this category'
                  : 'The category has not been changed'
            }
          >
            Save
          </button>
        </div>
      </div>

      <AddToService
        asset={asset}
        services={services}
        busy={busy}
        onAdd={onAddToService}
      />

      {notice !== null && (
        <p className="text-[12px] text-silver-400 rounded-md bg-ink-850 border border-ink-700 p-2">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="h-8 px-3 rounded-md text-[12px] font-semibold bg-ink-750 text-silver-200 hover:bg-ink-700 transition-colors disabled:opacity-40"
          onClick={onToggleFavourite}
          disabled={busy}
          title={busy ? 'Finishing the last action first' : undefined}
        >
          {asset.isFavorite ? '★ Remove favourite' : '☆ Add favourite'}
        </button>

        {confirming ? (
          <>
            <button
              type="button"
              className="h-8 px-3 rounded-md text-[12px] font-semibold bg-status-error text-white hover:brightness-110 transition-all disabled:opacity-40"
              onClick={onConfirmDelete}
              disabled={busy}
              title={busy ? 'Finishing the last action first' : 'Delete this file permanently'}
            >
              Delete permanently
            </button>
            <button
              type="button"
              className="h-8 px-3 rounded-md text-[12px] font-semibold bg-ink-750 text-silver-200 hover:bg-ink-700 transition-colors"
              onClick={onCancelDelete}
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className="h-8 px-3 rounded-md text-[12px] font-semibold bg-ink-750 text-status-error hover:bg-ink-700 transition-colors disabled:opacity-40"
            onClick={onAskDelete}
            disabled={busy}
            title={busy ? 'Finishing the last action first' : 'Remove this file from your library'}
          >
            Delete…
          </button>
        )}
      </div>

      {confirming && (
        <p className="text-[12px] text-status-ready">
          {/*
            Stated before the fact, not discovered afterwards. Import copies files in, so deleting
            here removes the app's copy — but any service that still points at it will have a slide
            with nothing to show, and the operator needs to know that before they confirm.
          */}
          This deletes the copy in your library. Any service slide using it will have nothing to show
          until you import the file again.
        </p>
      )}
    </div>
  );
}

/**
 * Puts a file into a service's running order.
 *
 * Only for kinds the presentation engine can paint. Audio is stored but nothing plays it, so offering
 * to add it to a service would be a control that silently produces a slide showing nothing.
 */
function AddToService({
  asset,
  services,
  busy,
  onAdd,
}: {
  asset: MediaAssetView;
  services: readonly ServiceSummary[];
  busy: boolean;
  onAdd: (serviceId: string) => void;
}): JSX.Element | null {
  const [serviceId, setServiceId] = useState('');

  useEffect(() => {
    if (serviceId === '' && services.length > 0) setServiceId(services[0]?.id ?? '');
  }, [services, serviceId]);

  if (!canBeBackground(asset.kind)) return null;

  if (services.length === 0) {
    return (
      <p className="text-[12px] text-silver-600">
        {/* Named as the next step rather than shown as an empty dropdown, which reads as broken. */}
        There are no services yet. Create one in the Service section and this file can be added to it
        as a slide.
      </p>
    );
  }

  const chosen = services.find((entry) => entry.id === serviceId) ?? null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-wider text-silver-600">Add to a service</span>
      <select
        value={serviceId}
        onChange={(event) => setServiceId(event.target.value)}
        className="h-8 px-2 rounded-md bg-ink-850 border border-ink-700 text-[13px] text-silver-100 focus:border-brand-500 focus:outline-none"
        title="Which service to add this file to"
      >
        {services.map((service) => (
          <option key={service.id} value={service.id}>
            {service.name} ({String(service.itemCount)} {service.itemCount === 1 ? 'item' : 'items'})
          </option>
        ))}
      </select>
      <button
        type="button"
        className="h-8 px-3 rounded-md text-[12px] font-semibold bg-ink-750 text-silver-200 hover:bg-ink-700 transition-colors disabled:opacity-40"
        onClick={() => chosen && onAdd(chosen.id)}
        disabled={busy || chosen === null}
        title={
          busy
            ? 'Finishing the last action first'
            : chosen === null
              ? 'Choose a service first'
              : 'Append this file to the running order as a slide of its own'
        }
      >
        Add as a slide
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-silver-600">{label}</dt>
      <dd className="text-silver-200 break-words">{children}</dd>
    </>
  );
}

// ── what the last import did ────────────────────────────────────────────────────

/**
 * The outcome of an import, reported per file.
 *
 * Counts alone would be a lie of omission: telling an operator that forty files were imported when
 * eight were duplicates and two were refused is something they discover later, in the grid, while
 * looking for a file that is not there.
 */
function ImportReport({
  report,
  onDismiss,
}: {
  report: MediaImportReport;
  onDismiss: () => void;
}): JSX.Element | null {
  // Closing the dialog is not an event worth reporting.
  if (report.outcome === 'cancelled') return null;

  const { added, duplicates, refused } = report;
  if (added.length === 0 && duplicates.length === 0 && refused.length === 0) return null;

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-800 p-3" role="status">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-[13px] font-semibold text-silver-100">
            {added.length === 0
              ? 'Nothing new was added'
              : `Added ${String(added.length)} ${added.length === 1 ? 'file' : 'files'}`}
          </p>

          {duplicates.length > 0 && (
            <p className="text-[12px] text-silver-500">
              {duplicates.length === 1 ? 'One file was' : `${String(duplicates.length)} files were`}{' '}
              already in your library and{' '}
              {duplicates.length === 1 ? 'was' : 'were'} not added again:{' '}
              {duplicates.map((asset) => asset.filename).join(', ')}
            </p>
          )}

          {refused.length > 0 && (
            <ul className="space-y-1">
              {refused.map((entry) => (
                <li key={entry.filename} className="text-[12px] text-status-ready flex gap-2">
                  <span className="shrink-0">•</span>
                  {/* The name AND the reason, because the reason is what tells them what to do. */}
                  <span>
                    <strong className="font-semibold">{entry.filename}</strong> — {entry.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="h-6 w-6 shrink-0 grid place-items-center rounded text-silver-600 hover:text-silver-200 hover:bg-ink-750 transition-colors"
          aria-label="Dismiss this import summary"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
