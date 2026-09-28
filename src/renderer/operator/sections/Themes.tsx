/**
 * THEMES — the theme gallery, with a working BACKGROUND editor (Sections 16, 13).
 *
 * Previews render the actual ThemeSpec through `SlideCanvas`, so what is shown here is genuinely what
 * the audience screen will produce and not an illustration.
 *
 * WHY THIS SCREEN GAINED AN EDITOR IN PHASE 5. Media import, the `app-media:` protocol and the media
 * layer in `SlideCanvas` are all real now, but `background.mediaAssetId` was reachable from no
 * interface at all — so "put a picture behind the lyrics" was implemented and impossible. This project
 * has already shipped that exact mistake once: the service theme picker existed, the field was saved,
 * and precedence made it inert, so a control the operator could set did nothing. A capability with no
 * way to invoke it is not a feature.
 *
 * SCOPE, STATED PLAINLY. This edits the BACKGROUND and nothing else. Typography, padding, the scrim and
 * transitions are still read-only and still arrive with the full theme designer in Phase 9. Built-in
 * themes remain immutable — the repository refuses to modify them, deliberately, because they are the
 * thing an operator falls back to when a custom theme goes wrong. "Customise" creates a CHILD theme
 * that inherits everything and overrides only what it is given, which is the mechanism themes were
 * built around.
 */

import { useCallback, useMemo, useState } from 'react';
import type { Theme, ThemeSpec } from '@shared/domain/entities.ts';
import { describeBackground, resolveThemeSpecOrBase } from '@shared/domain/theme.ts';
import { describeBytes } from '@shared/domain/media.ts';
import type { MediaAssetView } from '@shared/ipc-contract.ts';
import { useMutation, useQuery } from '@ui/hooks.ts';
import { EmptyState, FailureNotice, Panel, Spinner } from '@ui/primitives.tsx';
import { SlideCanvas } from '@ui/SlideCanvas.tsx';

const SAMPLE: Record<string, string[]> = {
  'theme-scripture': ['For God so loved the world,', 'that he gave his only Son…'],
  'theme-sermon': ['Three marks of a', 'generous heart'],
  'theme-announcement': ['YOUTH NIGHT', 'Friday at 7:00 PM'],
  default: ['Way maker', 'Miracle worker'],
};

type BackgroundKind = ThemeSpec['background']['kind'];

const KIND_LABELS: Record<BackgroundKind, string> = {
  solid: 'Solid colour',
  gradient: 'Gradient',
  image: 'Image',
  video: 'Video (silent, looping)',
  camera: 'Live camera',
};

export function ThemesSection(): JSX.Element {
  const themes = useQuery('themes:list');
  /*
   * Only what the media layer can paint. Audio is in the library but cannot be a background, and
   * offering it here would be a choice that silently does nothing.
   */
  const images = useQuery('media:list', { kind: 'image' });
  const videos = useQuery('media:list', { kind: 'video' });

  const [editingId, setEditingId] = useState<string | null>(null);

  const save = useMutation('themes:save');
  const remove = useMutation('themes:delete');

  const reload = themes.reload;

  const customise = useCallback(
    async (parent: Theme) => {
      /*
       * A CHILD theme, not a copy of the parent's fields.
       *
       * Inheritance is the point: the child overrides only its background, so a later correction to
       * the built-in — a legibility fix, say — still reaches it. Flattening the parent's spec into the
       * child would freeze today's defaults forever.
       */
      const created = await save.run({
        name: `${parent.name} — custom`,
        parentThemeId: parent.id,
        spec: {},
      });
      if (created) {
        reload();
        setEditingId(created.id);
      }
    },
    [save, reload],
  );

  const applyBackground = useCallback(
    async (theme: Theme, background: ThemeSpec['background']) => {
      const saved = await save.run({
        id: theme.id,
        name: theme.name,
        parentThemeId: theme.parentThemeId,
        // Only the background is written. Every other field keeps inheriting.
        spec: { ...theme.spec, background },
      });
      if (saved) {
        reload();
        setEditingId(null);
      }
    },
    [save, reload],
  );

  const deleteTheme = useCallback(
    async (theme: Theme) => {
      await remove.run({ id: theme.id });
      setEditingId(null);
      reload();
    },
    [remove, reload],
  );

  if (themes.loading) return <Spinner label="Loading themes" />;
  if (themes.failure) {
    return (
      <div className="p-5 max-w-2xl">
        <FailureNotice notice={themes.failure} onRetry={themes.reload} />
      </div>
    );
  }
  if ((themes.data?.length ?? 0) === 0) {
    return (
      <EmptyState title="No themes" description="The built-in themes should have been seeded on first run." />
    );
  }

  return (
    <div className="h-full overflow-auto p-5">
      <div className="max-w-6xl mx-auto">
        <p className="text-[13px] text-silver-600 mb-4 max-w-3xl">
          Each preview renders the theme&apos;s real specification on a scaled 1920×1080 canvas, so it
          matches what the audience display will show. Built-in themes are read-only: use{' '}
          <strong className="text-silver-400">Customise</strong> to make a version that inherits from
          one and overrides only what you change. Backgrounds can be edited here; typography, spacing
          and transitions arrive with the full theme designer in Phase&nbsp;9.
        </p>

        {save.failure !== null && (
          <div className="mb-4">
            <FailureNotice notice={save.failure} onDismiss={save.clearFailure} />
          </div>
        )}
        {remove.failure !== null && (
          <div className="mb-4">
            <FailureNotice notice={remove.failure} onDismiss={remove.clearFailure} />
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {themes.data?.map((theme) => (
            <ThemeCard
              key={theme.id}
              theme={theme}
              themes={themes.data ?? []}
              images={images.data ?? []}
              videos={videos.data ?? []}
              editing={editingId === theme.id}
              busy={save.pending || remove.pending}
              onCustomise={() => void customise(theme)}
              onEdit={() => setEditingId(theme.id)}
              onCancel={() => setEditingId(null)}
              onApply={(background) => void applyBackground(theme, background)}
              onDelete={() => void deleteTheme(theme)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  theme,
  themes,
  images,
  videos,
  editing,
  busy,
  onCustomise,
  onEdit,
  onCancel,
  onApply,
  onDelete,
}: {
  theme: Theme;
  themes: readonly Theme[];
  images: readonly MediaAssetView[];
  videos: readonly MediaAssetView[];
  editing: boolean;
  busy: boolean;
  onCustomise: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onApply: (background: ThemeSpec['background']) => void;
  onDelete: () => void;
}): JSX.Element {
  /*
   * Resolved through the INHERITANCE CHAIN by the SHARED resolver — the same function the main process
   * uses, not a copy of it.
   *
   * Both halves of that matter. A child theme's own spec holds only its overrides, so merging it
   * straight onto the base spec would preview it with the base typography instead of its parent's:
   * a card that does not match what the projector will do. And re-implementing the walk here is the
   * mistake this file already made once, when it kept its own `FALLBACK` and `mergePreview` because a
   * renderer cannot import from main. Two definitions of what a theme resolves to is a guarantee that
   * the preview and the audience screen eventually disagree.
   */
  const spec = useMemo(() => resolveThemeSpecOrBase(themes, theme.id), [themes, theme.id]);
  const lines = SAMPLE[theme.id] ?? SAMPLE['default']!;
  const parentName = theme.parentThemeId
    ? (themes.find((entry) => entry.id === theme.parentThemeId)?.name ?? null)
    : null;

  return (
    <Panel
      title={theme.name}
      actions={
        theme.isBuiltin ? (
          <span className="px-1.5 py-0.5 rounded bg-ink-750 text-[9px] font-bold uppercase tracking-widest text-silver-600">
            Built-in
          </span>
        ) : null
      }
    >
      <div className="p-3">
        {/*
          The SAME component the audience output uses. A separate preview implementation would
          eventually disagree with the real renderer, and the operator would find out on the
          projector.
        */}
        <SlideCanvas spec={spec} lines={lines} annotate className="w-full aspect-video rounded border border-ink-700" />

        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <Row label="Background" value={describeBackground(spec)} />
          {parentName !== null && <Row label="Inherits" value={parentName} />}
          <Row label="Font size" value={`${String(spec.text.fontSize)}pt`} />
          <Row label="Weight" value={String(spec.text.fontWeight)} />
          <Row label="Align" value={spec.text.align} />
          <Row label="Transition" value={`${spec.transition.kind} ${String(spec.transition.durationMs)}ms`} />
          <Row
            label="Legibility"
            value={
              [
                spec.text.shadow.enabled ? 'shadow' : null,
                spec.text.outline.enabled ? 'outline' : null,
                spec.textBox.enabled ? 'scrim' : null,
              ]
                .filter(Boolean)
                .join(', ') || 'none'
            }
          />
        </dl>

        {editing ? (
          <BackgroundEditor
            spec={spec}
            images={images}
            videos={videos}
            busy={busy}
            onCancel={onCancel}
            onApply={onApply}
          />
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {theme.isBuiltin ? (
              <button
                type="button"
                className="h-7 px-2.5 rounded-md text-[11px] font-semibold bg-ink-750 text-silver-200 hover:bg-ink-700 transition-colors disabled:opacity-40"
                onClick={onCustomise}
                disabled={busy}
                title={
                  busy
                    ? 'Finishing the last action first'
                    : 'Create a theme that inherits from this one, so you can change its background'
                }
              >
                Customise…
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="h-7 px-2.5 rounded-md text-[11px] font-semibold bg-ink-750 text-silver-200 hover:bg-ink-700 transition-colors disabled:opacity-40"
                  onClick={onEdit}
                  disabled={busy}
                  title={busy ? 'Finishing the last action first' : 'Change this theme’s background'}
                >
                  Edit background…
                </button>
                <button
                  type="button"
                  className="h-7 px-2.5 rounded-md text-[11px] font-semibold bg-ink-750 text-status-error hover:bg-ink-700 transition-colors disabled:opacity-40"
                  onClick={onDelete}
                  disabled={busy}
                  title={busy ? 'Finishing the last action first' : 'Delete this custom theme'}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Edits one theme's background.
 *
 * Deliberately narrow. It shows only the controls the chosen kind actually uses, so there is never a
 * colour field sitting inert beside an image picker — an operator cannot tell an ignored control from
 * a broken one.
 */
function BackgroundEditor({
  spec,
  images,
  videos,
  busy,
  onCancel,
  onApply,
}: {
  spec: ThemeSpec;
  images: readonly MediaAssetView[];
  videos: readonly MediaAssetView[];
  busy: boolean;
  onCancel: () => void;
  onApply: (background: ThemeSpec['background']) => void;
}): JSX.Element {
  const [kind, setKind] = useState<BackgroundKind>(spec.background.kind);
  const [value, setValue] = useState(spec.background.value);
  const [assetId, setAssetId] = useState<string | null>(spec.background.mediaAssetId ?? null);
  const [fit, setFit] = useState<'cover' | 'contain'>(spec.background.fit ?? 'cover');

  const assets = kind === 'video' ? videos : images;
  const needsAsset = kind === 'image' || kind === 'video';
  const chosen = needsAsset ? assets.find((asset) => asset.id === assetId) ?? null : null;
  const incomplete = needsAsset && chosen === null;

  return (
    <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850 p-3 flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-silver-600">Background</span>
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as BackgroundKind)}
          className="h-8 px-2 rounded-md bg-ink-900 border border-ink-700 text-[13px] text-silver-100 focus:border-brand-500 focus:outline-none"
        >
          {(Object.keys(KIND_LABELS) as BackgroundKind[]).map((entry) => (
            <option key={entry} value={entry}>
              {KIND_LABELS[entry]}
            </option>
          ))}
        </select>
      </label>

      {(kind === 'solid' || kind === 'gradient') && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-silver-600">
            {kind === 'solid' ? 'Colour' : 'CSS gradient'}
          </span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={kind === 'solid' ? '#000000' : 'linear-gradient(...)'}
            className="h-8 px-2 rounded-md bg-ink-900 border border-ink-700 text-[12px] font-mono text-silver-100 placeholder:text-silver-600 focus:border-brand-500 focus:outline-none"
          />
        </label>
      )}

      {kind === 'camera' && (
        <p className="text-[12px] text-silver-500">
          The live camera fills the screen behind the text. Assign a camera in the Camera section and
          put it on air; until then this theme shows black, which is the correct thing to show when
          there is no picture.
        </p>
      )}

      {needsAsset && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-silver-600">
              {kind === 'image' ? 'Image' : 'Video'}
            </span>
            {assets.length === 0 ? (
              <p className="text-[12px] text-status-ready">
                {/* Named as the actual next step rather than shown as an empty list, which reads as
                    broken. */}
                No {kind === 'image' ? 'images' : 'videos'} in your media library yet. Import some in
                the Media section first.
              </p>
            ) : (
              <ul className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] max-h-44 overflow-auto p-0.5">
                {assets.map((asset) => (
                  <li key={asset.id}>
                    <button
                      type="button"
                      onClick={() => setAssetId(asset.id)}
                      className={`block w-full rounded-md overflow-hidden border transition-colors ${
                        asset.id === assetId
                          ? 'border-brand-500'
                          : 'border-ink-700 hover:border-ink-600'
                      }`}
                      aria-pressed={asset.id === assetId}
                      title={`${asset.filename} · ${describeBytes(asset.bytes)}`}
                    >
                      {asset.thumbnailUrl === null ? (
                        <span className="block aspect-video bg-ink-900 grid place-items-center px-1 text-[8px] uppercase tracking-widest text-silver-600 text-center">
                          {/* Honest: a video has no preview frame, because nothing here can decode one. */}
                          {asset.kind === 'video' ? 'No preview frame' : 'No preview'}
                        </span>
                      ) : (
                        <img
                          src={asset.thumbnailUrl}
                          alt=""
                          className="block w-full aspect-video object-cover"
                          loading="lazy"
                        />
                      )}
                      <span className="block px-1 py-0.5 truncate text-[10px] text-silver-400">
                        {asset.filename}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-silver-600">Fit</span>
            <select
              value={fit}
              onChange={(event) => setFit(event.target.value as 'cover' | 'contain')}
              className="h-8 px-2 rounded-md bg-ink-900 border border-ink-700 text-[13px] text-silver-100 focus:border-brand-500 focus:outline-none"
            >
              <option value="cover">Fill the screen (crops the edges)</option>
              <option value="contain">Fit the whole picture (adds bars)</option>
            </select>
          </label>
        </>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="h-8 px-3 rounded-md text-[12px] font-semibold bg-brand-600 text-white hover:bg-brand-500 transition-colors disabled:opacity-50"
          onClick={() =>
            onApply({
              kind,
              value,
              ...(needsAsset ? { mediaAssetId: assetId, fit } : {}),
            })
          }
          disabled={busy || incomplete}
          title={
            busy
              ? 'Finishing the last action first'
              : incomplete
                ? `Choose ${kind === 'image' ? 'an image' : 'a video'} first`
                : 'Apply this background'
          }
        >
          Apply
        </button>
        <button
          type="button"
          className="h-8 px-3 rounded-md text-[12px] font-semibold bg-ink-750 text-silver-200 hover:bg-ink-700 transition-colors"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="text-silver-700">{label}</dt>
      <dd className="text-silver-400 truncate">{value}</dd>
    </>
  );
}
