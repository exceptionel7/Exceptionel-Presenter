/**
 * SERVICE — the live production workspace (Sections 3, 13, 19, 20, 21).
 *
 * Three columns, in the order an operator's attention moves during a service:
 *   1. the running order, and the slides each item expands into
 *   2. PREVIEW — the slide they are considering
 *   3. LIVE — what the congregation is seeing at this instant
 *
 * PREVIEW AND LIVE ARE THE SAME COMPONENT AS THE AUDIENCE OUTPUT. `SlideCanvas`, three times, with
 * different props. A preview that was a separate implementation would eventually disagree with the
 * projector, and the operator would find out in front of everyone.
 *
 * Main owns live state. Every control here sends an intent and then renders whatever main broadcasts
 * back — nothing is applied optimistically, so the interface can never claim something reached the
 * audience when it did not.
 *
 * NOT IN THIS PHASE: drag-and-drop reordering and service editing (Phase 8). The running order is
 * read-only here, and says so.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Service, ServiceItem, ServiceSummary, Theme } from '@shared/domain/entities.ts';
import type { Cue, LiveIntent, LiveState } from '@shared/domain/live-state.ts';
import { resolveAudienceVisibility, serviceProgress } from '@shared/domain/live-state.ts';
import type { SkippedItem } from '@shared/domain/cues.ts';
import { fitSlideText, resolveThemeSpec, resolveThemeSpecOrBase } from '@shared/domain/theme.ts';
import type { OpenedService } from '@shared/ipc-contract.ts';
import { client } from '@ui/client.ts';
import { useIpcEvent, useQuery } from '@ui/hooks.ts';
import { createLoopbackSubscriber } from '@ui/loopback.ts';
import { SlideCanvas } from '@ui/SlideCanvas.tsx';
import { EmptyState, FailureNotice, Panel, Spinner, StatusDot } from '@ui/primitives.tsx';

export function ServiceSection(): JSX.Element {
  const services = useQuery('services:list');
  const themesQuery = useQuery('themes:list');

  const [opened, setOpened] = useState<OpenedService | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [cues, setCues] = useState<readonly Cue[]>([]);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFailure, setOpenFailure] = useState<string | null>(null);

  const themes: readonly Theme[] = themesQuery.data ?? [];

  // Main is authoritative (docs/ARCHITECTURE.md §1); this view mirrors its broadcasts.
  useIpcEvent('live:state', setLive);
  useIpcEvent('live:cues', ({ cues: next }) => setCues(next));

  useEffect(() => {
    void client.invoke('live:getState').then((result) => {
      if (result.ok) setLive(result.data);
    });
  }, []);

  /*
   * The phone camera preview, over the loopback connection the output window publishes.
   *
   * Without it the operator's PREVIEW and LIVE panes would show lyrics over black while the
   * congregation saw lyrics over a camera feed — a preview that is wrong in exactly the way that
   * matters most.
   */
  const subscriber = useMemo(() => createLoopbackSubscriber(), []);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  useIpcEvent('media:relay', ({ message }) => subscriber.handleRelay(message));

  useEffect(() => {
    const unsubscribe = subscriber.onStream((_id, stream) => setCameraStream(stream));
    return () => {
      unsubscribe();
      subscriber.closeAll();
    };
  }, [subscriber]);

  const openService = useCallback(async (serviceId: string) => {
    setBusy(true);
    setOpenFailure(null);
    const result = await client.invoke('services:open', { serviceId });
    setBusy(false);

    if (!result.ok) {
      setOpenFailure(result.failure.message);
      return;
    }
    if (result.data === null) {
      setOpenFailure('That service could no longer be found. It may have been deleted.');
      return;
    }

    setOpened(result.data);
    setSelectedCueId(result.data.cues[0]?.id ?? null);
  }, []);

  const send = useCallback(async (intent: LiveIntent) => {
    setBusy(true);
    await client.invoke('live:intent', intent);
    setBusy(false);
  }, []);

  // ── derived state ─────────────────────────────────────────────────────────────

  const progress = live ? serviceProgress(live, cues) : null;
  const liveCue = progress?.current ?? null;
  const selectedCue = cues.find((cue) => cue.id === selectedCueId) ?? null;

  const liveSpec = resolveThemeSpecOrBase(themes, liveCue?.themeId ?? live?.themeId ?? null);
  const previewSpec = resolveThemeSpecOrBase(themes, selectedCue?.themeId ?? live?.themeId ?? null);

  /*
   * Themes a cue names that do not resolve.
   *
   * The audience output falls back to an unstyled base spec rather than showing nothing, which is
   * the right behaviour there and exactly why the problem has to surface HERE instead — otherwise a
   * service renders in the wrong design all morning and nobody can say why.
   */
  const missingThemes = useMemo(() => {
    if (themesQuery.loading) return [];
    const missing = new Set<string>();
    for (const cue of cues) {
      if (cue.themeId !== null && resolveThemeSpec(themes, cue.themeId) === null) missing.add(cue.themeId);
    }
    return [...missing];
  }, [cues, themes, themesQuery.loading]);

  if (services.loading) return <Spinner label="Loading services" />;

  if (services.failure) {
    return (
      <div className="p-5 max-w-2xl">
        <FailureNotice notice={services.failure} onRetry={services.reload} />
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* ── column 1: services and running order ─────────────────────────────── */}
      <div className="w-[22rem] shrink-0 border-r border-ink-700 flex flex-col min-h-0">
        <ServicePicker
          services={services.data ?? []}
          openedId={opened?.service.id ?? null}
          busy={busy}
          onOpen={(id) => void openService(id)}
          onCreated={(id) => {
            // Reload the list, then open the new service so the operator lands somewhere useful
            // rather than having to find what they just made.
            services.reload();
            void openService(id);
          }}
        />

        {openFailure !== null && (
          <p className="mx-3 mb-3 p-2.5 rounded-md bg-status-live/10 border border-status-live/40 text-[12px] text-status-live">
            {openFailure}
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-auto">
          {opened === null ? (
            <p className="p-4 text-[12px] text-silver-600">
              Open a service to build its slides.
            </p>
          ) : (
            <RunningOrder
              service={opened.service}
              cues={cues}
              skipped={opened.skipped}
              liveCueId={live?.activeCueId ?? null}
              selectedCueId={selectedCueId}
              onSelect={setSelectedCueId}
            />
          )}
        </div>
      </div>

      {/* ── columns 2 & 3: preview, live, transport ───────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-2 gap-4 p-4 overflow-auto">
          <Stage
            title="Preview"
            subtitle={selectedCue?.label ?? 'Nothing selected'}
            tone="idle"
            empty="Select a slide to preview it"
            cue={selectedCue}
          >
            {selectedCue && (
              <SlideCanvas
                spec={previewSpec}
                lines={selectedCue.lines}
                cameraStream={cameraStream}
                transitionKey={selectedCue.id}
                // Operator surface, so honest annotations are welcome here.
                annotate
                className="w-full h-full"
              />
            )}
          </Stage>

          <Stage
            title="Live"
            subtitle={liveCue?.label ?? describeIdle(live)}
            tone={live && live.status !== 'idle' ? 'live' : 'idle'}
            empty="Nothing is reaching the audience"
            cue={liveCue}
          >
            {live && (
              <SlideCanvas
                spec={liveSpec}
                lines={liveCue?.lines ?? []}
                // The REAL visibility rules, so Black and Clear look here exactly as they look on
                // the projector rather than being approximated.
                visibility={resolveAudienceVisibility(live)}
                cameraStream={cameraStream}
                {...(liveCue ? { transitionKey: liveCue.id } : {})}
                annotate
                className="w-full h-full"
              />
            )}
          </Stage>
        </div>

        {missingThemes.length > 0 && (
          <p className="mx-4 mb-2 p-2.5 rounded-md bg-status-ready/10 border border-status-ready/40 text-[12px] text-status-ready">
            {missingThemes.length === 1 ? 'A theme this service uses' : 'Themes this service uses'} no
            longer {missingThemes.length === 1 ? 'exists' : 'exist'} ({missingThemes.join(', ')}). Those
            slides will present with default styling until the service is given a theme that does.
          </p>
        )}

        <Transport
          live={live}
          selectedCue={selectedCue}
          previewFits={previewFitStatus(selectedCue, previewSpec)}
          hasCues={cues.length > 0}
          busy={busy}
          position={progress?.position ?? '0 / 0'}
          onIntent={(intent) => void send(intent)}
        />
      </div>
    </div>
  );
}

// ── services list ────────────────────────────────────────────────────────────────

function ServicePicker({
  services,
  openedId,
  busy,
  onOpen,
  onCreated,
}: {
  services: readonly ServiceSummary[];
  openedId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const [building, setBuilding] = useState(false);

  return (
    <div className="p-3 border-b border-ink-700">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700">Services</p>
        <button
          type="button"
          className="btn-ghost h-6 px-2 text-[11px]"
          onClick={() => setBuilding((value) => !value)}
        >
          {building ? 'Cancel' : '+ New'}
        </button>
      </div>

      {building && (
        <NewService
          onDone={(id) => {
            setBuilding(false);
            onCreated(id);
          }}
        />
      )}

      {services.length === 0 && !building ? (
        <EmptyState
          title="No services yet"
          description="Create one from your songs to start presenting."
        />
      ) : (
        <ul className="space-y-1 max-h-48 overflow-auto">
          {services.map((service) => (
            <li key={service.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onOpen(service.id)}
                className={`w-full text-left px-2.5 py-2 rounded-md text-[13px] transition-colors ${
                  openedId === service.id
                    ? 'bg-ink-750 text-silver-100'
                    : 'text-silver-400 hover:bg-ink-800 hover:text-silver-200'
                }`}
              >
                <span className="block truncate font-medium">{service.name}</span>
                <span className="block text-[11px] text-silver-700">
                  {service.serviceDate ?? 'No date'} · {service.itemCount}{' '}
                  {service.itemCount === 1 ? 'item' : 'items'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A minimal service builder: a name and a set of songs, in the order they were picked.
 *
 * DELIBERATELY SMALL, and included in Phase 3 for one reason: a presentation engine that cannot be
 * fed is not a deliverable. Nothing else in the application creates a service, so without this the
 * whole phase would be unusable and unverifiable — the operator would open this screen, see an empty
 * list, and have no route forward.
 *
 * It writes through `services:save`, which already exists and is already tested, and it claims
 * nothing more than it does. The real builder — drag-and-drop ordering, scripture and media items,
 * headers, templates, per-item overrides — is Phase 8.
 */
function NewService({ onDone }: { onDone: (serviceId: string) => void }): JSX.Element {
  const songs = useQuery('songs:list', { limit: 200 });
  const [name, setName] = useState('Sunday Service');
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string): void => {
    setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const create = async (): Promise<void> => {
    setSaving(true);
    setError(null);

    const byId = new Map((songs.data ?? []).map((song) => [song.id, song]));
    const result = await client.invoke('services:save', {
      name: name.trim() === '' ? 'Untitled Service' : name.trim(),
      // Selection order becomes the running order.
      items: picked.map((songId, index) => ({
        kind: 'song',
        label: byId.get(songId)?.title ?? 'Song',
        sortOrder: index,
        refId: songId,
      })),
    });

    setSaving(false);
    if (!result.ok) {
      setError(result.failure.message);
      return;
    }
    onDone(result.data.id);
  };

  return (
    <div className="mb-3 p-2.5 rounded-md border border-ink-700 bg-ink-900">
      <label className="field-label" htmlFor="new-service-name">
        Service name
      </label>
      <input
        id="new-service-name"
        className="field mb-2"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <p className="field-label">Songs, in order</p>
      {songs.loading ? (
        <Spinner label="Loading songs" />
      ) : (songs.data?.length ?? 0) === 0 ? (
        <p className="text-[11px] text-silver-700 py-2">
          There are no songs in the library yet. Add one in the Songs section first — a service needs
          something to present.
        </p>
      ) : (
        <ul className="max-h-40 overflow-auto space-y-0.5 mb-2">
          {songs.data?.map((song) => {
            const position = picked.indexOf(song.id);
            return (
              <li key={song.id}>
                <button
                  type="button"
                  onClick={() => toggle(song.id)}
                  className={`w-full flex items-center gap-2 text-left px-2 py-1.5 rounded text-[12px] transition-colors ${
                    position >= 0
                      ? 'bg-signal-500/15 text-silver-100'
                      : 'text-silver-500 hover:bg-ink-800 hover:text-silver-300'
                  }`}
                >
                  <span className="w-4 text-center text-[10px] text-silver-600">
                    {position >= 0 ? position + 1 : ''}
                  </span>
                  <span className="flex-1 truncate">{song.title}</span>
                  <span className="text-[10px] text-silver-700">
                    {song.sectionCount} {song.sectionCount === 1 ? 'section' : 'sections'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error !== null && <p className="mb-2 text-[11px] text-status-live">{error}</p>}

      <button
        type="button"
        className="btn-primary w-full h-8 text-[12px]"
        disabled={saving || picked.length === 0}
        onClick={() => void create()}
      >
        {saving ? 'Creating…' : `Create service${picked.length > 0 ? ` (${String(picked.length)})` : ''}`}
      </button>
    </div>
  );
}

// ── running order ────────────────────────────────────────────────────────────────

function RunningOrder({
  service,
  cues,
  skipped,
  liveCueId,
  selectedCueId,
  onSelect,
}: {
  service: Service;
  cues: readonly Cue[];
  skipped: readonly SkippedItem[];
  liveCueId: string | null;
  selectedCueId: string | null;
  onSelect: (cueId: string) => void;
}): JSX.Element {
  const skippedByItem = new Map(skipped.map((entry) => [entry.itemId, entry]));

  // Cues grouped by the item that produced them, so a song's slides sit under the song.
  const cuesByItem = new Map<string, Cue[]>();
  for (const cue of cues) {
    cuesByItem.set(cue.itemId, [...(cuesByItem.get(cue.itemId) ?? []), cue]);
  }

  return (
    <div className="p-3">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700">Running order</p>
        <span className="text-[10px] text-silver-700">
          {cues.length} {cues.length === 1 ? 'slide' : 'slides'}
        </span>
      </div>

      {/* Honest about the limits of this phase rather than implying editing works. */}
      <p className="mb-3 text-[11px] text-silver-700">
        Read-only. Reordering and editing arrive with the service builder in Phase 8.
      </p>

      <ol className="space-y-2">
        {service.items.map((item) => (
          <li key={item.id}>
            <ItemHeading item={item} count={cuesByItem.get(item.id)?.length ?? 0} />

            {item.kind === 'header' ? null : skippedByItem.has(item.id) ? (
              <SkippedNote entry={skippedByItem.get(item.id)!} />
            ) : (
              <ul className="mt-1 space-y-0.5">
                {(cuesByItem.get(item.id) ?? []).map((cue) => (
                  <li key={cue.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(cue.id)}
                      className={`w-full flex items-center gap-2 text-left pl-3 pr-2 py-1.5 rounded text-[12px] transition-colors ${
                        cue.id === selectedCueId
                          ? 'bg-signal-500/15 text-silver-100 ring-1 ring-signal-500/50'
                          : 'text-silver-500 hover:bg-ink-800 hover:text-silver-300'
                      }`}
                    >
                      {/* A live slide is unmistakable at a glance. */}
                      {cue.id === liveCueId ? (
                        <StatusDot tone="live" pulse />
                      ) : (
                        <span className="w-2 h-2 shrink-0" />
                      )}
                      <span className="truncate">
                        {cue.lines.length > 0 ? cue.lines[0] : <em className="text-silver-700">no text</em>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ItemHeading({ item, count }: { item: ServiceItem; count: number }): JSX.Element {
  if (item.kind === 'header') {
    return (
      <p className="pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700 border-b border-ink-750">
        {item.label}
      </p>
    );
  }

  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-4 text-center text-silver-700">{GLYPH[item.kind] ?? '·'}</span>
      <span className="flex-1 truncate font-medium text-silver-300">{item.label}</span>
      {count > 0 && <span className="text-[10px] text-silver-700">{count}</span>}
    </div>
  );
}

const GLYPH: Record<string, string> = {
  song: '♪',
  scripture: '✝',
  slide: '▤',
  image: '▣',
  video: '▶',
  camera_scene: '◉',
  announcement: '❖',
};

/**
 * Why an item will present nothing.
 *
 * Shown inline, next to the item, at the moment the service is opened. An operator preparing on
 * Thursday must find out then — not by pressing Next on Sunday and watching the screen stay black.
 */
function SkippedNote({ entry }: { entry: SkippedItem }): JSX.Element {
  return (
    <p className="mt-1 ml-3 mb-1 pl-2 border-l-2 border-ink-700 text-[11px] text-silver-700">
      <span className="font-semibold uppercase tracking-wider text-silver-600">
        {entry.reason.code === 'not-implemented' ? `Not implemented — ${entry.reason.phase}` : 'Cannot present'}
      </span>
      <br />
      {entry.reason.detail}
    </p>
  );
}

// ── preview / live panes ─────────────────────────────────────────────────────────

function Stage({
  title,
  subtitle,
  tone,
  empty,
  cue,
  children,
}: {
  title: string;
  subtitle: string;
  tone: 'live' | 'idle';
  empty: string;
  cue: Cue | null;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Panel
      title={title}
      actions={
        <span className="flex items-center gap-1.5 text-[11px] text-silver-500 max-w-[16rem]">
          <StatusDot tone={tone} pulse={tone === 'live'} />
          <span className="truncate">{subtitle}</span>
        </span>
      }
    >
      <div className="p-3">
        <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-black border border-ink-700">
          {cue === null && children === undefined ? null : children}
          {cue === null && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <p className="text-[11px] text-silver-700 uppercase tracking-[0.18em]">{empty}</p>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

// ── transport ────────────────────────────────────────────────────────────────────

function Transport({
  live,
  selectedCue,
  previewFits,
  hasCues,
  busy,
  position,
  onIntent,
}: {
  live: LiveState | null;
  selectedCue: Cue | null;
  previewFits: string | null;
  hasCues: boolean;
  busy: boolean;
  position: string;
  onIntent: (intent: LiveIntent) => void;
}): JSX.Element {
  const isLive = live !== null && live.status !== 'idle';

  return (
    <div className="shrink-0 border-t border-ink-700 bg-ink-850">
      {previewFits !== null && (
        <p className="px-4 pt-2 text-[11px] text-status-ready">{previewFits}</p>
      )}

      <div className="flex items-center gap-2 p-3 flex-wrap">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || selectedCue === null}
          onClick={() => selectedCue && onIntent({ type: 'goLive', cueId: selectedCue.id })}
          title="Send the previewed slide to the audience"
        >
          Go Live
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !hasCues}
            onClick={() => onIntent({ type: 'previous' })}
          >
            ‹ Previous
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !hasCues}
            onClick={() => onIntent({ type: 'next' })}
          >
            Next ›
          </button>
        </div>

        <span className="text-[11px] text-silver-600 timecode px-2">{position}</span>

        <div className="flex-1" />

        {/*
          Black and Clear are genuinely different and both are offered, because the distinction is
          what operators actually need: Black hides everything; Clear hides only the words, leaving a
          camera feed or background running.
        */}
        <button
          type="button"
          className={live?.status === 'black' ? 'btn-primary' : 'btn-secondary'}
          disabled={busy || !isLive}
          onClick={() => onIntent({ type: 'black' })}
          title="Hide everything (B)"
        >
          {live?.status === 'black' ? 'Restore' : 'Black'}
        </button>
        <button
          type="button"
          className={live?.status === 'clear' ? 'btn-primary' : 'btn-secondary'}
          disabled={busy || !isLive}
          onClick={() => onIntent({ type: 'clear' })}
          title="Hide the text only, keeping camera and background (C)"
        >
          {live?.status === 'clear' ? 'Restore' : 'Clear'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={busy || !isLive}
          onClick={() => onIntent({ type: 'stop' })}
          title="End the presentation and black the audience screen"
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────────

function describeIdle(live: LiveState | null): string {
  if (!live) return 'Connecting…';
  switch (live.status) {
    case 'idle':
      return 'Off air';
    case 'black':
      return 'Blacked out';
    case 'clear':
      return 'Text cleared';
    case 'paused':
      return 'Paused';
    case 'live':
      return 'Live';
  }
}

/**
 * Warns when the previewed slide cannot fit at a readable size.
 *
 * Calls the same pure, deterministic function the renderer uses, so the warning and the rendered
 * result can never disagree.
 */
function previewFitStatus(cue: Cue | null, spec: Parameters<typeof fitSlideText>[1]): string | null {
  if (cue === null || cue.lines.length === 0) return null;
  const fit = fitSlideText(cue.lines, spec);

  if (fit.limitedBy === 'minimum') {
    return 'This slide has too much text to fit. Split it into two, or the audience will see it at the smallest readable size.';
  }
  if (fit.limitedBy === 'disabled' && fit.estimatedLineCount * fit.fontSize * spec.text.lineHeight > 1080) {
    return 'This theme has auto-fit switched off and this slide overflows the screen.';
  }
  return null;
}
