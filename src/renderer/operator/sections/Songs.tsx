/**
 * SONGS — the worship song library (Section 7).
 *
 * A real, working library: create, edit, duplicate, delete, favourite and search across
 * titles and lyrics. Every action goes through validated IPC to SQLite.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Song, SongSectionKind, SlideBreakMode } from '@shared/domain/entities.ts';
import { SLIDE_BREAK_MODES, SONG_SECTION_KINDS } from '@shared/domain/entities.ts';
import type { SongDraft, SongSectionDraft } from '@shared/ipc-contract.ts';
import { countSectionSlides, nextSectionLabel } from '@shared/domain/song.ts';
import type { ErrorNotice } from '@shared/domain/errors.ts';
import { client } from '@ui/client.ts';
import { useMutation, useQuery } from '@ui/hooks.ts';
import { EmptyState, FailureNotice, Panel, Spinner } from '@ui/primitives.tsx';

/** A brand-new song starts with the sections almost every worship song has. */
const STARTER_SECTIONS: SongSectionDraft[] = [
  { kind: 'verse', label: 'Verse 1', sortOrder: 0, lyrics: '', slideBreakMode: 'blank-line' },
  { kind: 'chorus', label: 'Chorus', sortOrder: 1, lyrics: '', slideBreakMode: 'blank-line' },
];

export function SongsSection(): JSX.Element {
  const [search, setSearch] = useState('');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SongDraft | null>(null);

  // Debounced so each keystroke does not fire an IPC round trip.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 180);
    return () => clearTimeout(handle);
  }, [search]);

  const list = useQuery('songs:list', {
    ...(debounced ? { search: debounced } : {}),
    ...(favouritesOnly ? { favoritesOnly: true } : {}),
  });

  const save = useMutation('songs:save');
  const remove = useMutation('songs:delete');
  const duplicate = useMutation('songs:duplicate');
  const favourite = useMutation('songs:setFavorite');

  const refresh = list.reload;

  const openSong = useCallback(async (id: string) => {
    setSelectedId(id);
    const result = await client.invoke('songs:get', { id });
    if (result.ok && result.data) setDraft(toDraft(result.data));
  }, []);

  const startNew = useCallback(() => {
    setSelectedId(null);
    setDraft({ title: '', sections: STARTER_SECTIONS.map((section) => ({ ...section })) });
  }, []);

  const commit = useCallback(async () => {
    if (!draft || draft.title.trim() === '') return;
    const saved = await save.run(draft);
    if (saved) {
      setSelectedId(saved.id);
      setDraft(toDraft(saved));
      refresh();
    }
  }, [draft, save, refresh]);

  return (
    <div className="h-full flex min-h-0">
      {/* ── library list ────────────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-ink-700 flex flex-col min-h-0">
        <div className="p-3 space-y-2 border-b border-ink-700">
          <input
            type="search"
            className="field"
            placeholder="Search titles and lyrics…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-[12px] text-silver-500 cursor-pointer">
              <input
                type="checkbox"
                className="accent-signal-500"
                checked={favouritesOnly}
                onChange={(event) => setFavouritesOnly(event.target.checked)}
              />
              Favourites only
            </label>
            <button type="button" className="btn-primary h-7 text-[12px] px-2.5" onClick={startNew}>
              New song
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {list.loading ? (
            <Spinner />
          ) : list.failure ? (
            <div className="p-3">
              <FailureNotice notice={list.failure} onRetry={refresh} />
            </div>
          ) : (list.data?.length ?? 0) === 0 ? (
            <EmptyState
              title={debounced ? 'No matches' : 'No songs yet'}
              description={
                debounced
                  ? `Nothing in the library matches "${debounced}". Search covers titles, artists and lyrics.`
                  : 'Create your first song. Its lyrics become searchable the moment you save.'
              }
            />
          ) : (
            <ul className="divide-y divide-ink-700">
              {list.data?.map((song) => (
                <li key={song.id}>
                  <button
                    type="button"
                    onClick={() => void openSong(song.id)}
                    className={`w-full text-left px-3 py-2.5 hover:bg-ink-800 transition-colors duration-snap ${
                      selectedId === song.id ? 'bg-ink-750' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] text-silver-200 truncate">{song.title}</span>
                        {song.artist !== null && (
                          <span className="block text-[11px] text-silver-600 truncate">{song.artist}</span>
                        )}
                      </span>
                      {song.isFavorite && <span className="text-status-ready text-xs shrink-0">★</span>}
                      {song.songKey !== null && (
                        <span className="px-1.5 py-0.5 rounded bg-ink-800 text-[10px] text-silver-500 shrink-0">
                          {song.songKey}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── editor ──────────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-auto">
        {!draft ? (
          <EmptyState
            title="Select a song"
            description="Choose a song from the library, or create a new one. Sections become presentation slides in Phase 3."
          />
        ) : (
          <SongEditor
            draft={draft}
            onChange={setDraft}
            onSave={() => void commit()}
            saving={save.pending}
            failure={save.failure ?? remove.failure ?? duplicate.failure}
            canDelete={selectedId !== null}
            onDelete={async () => {
              if (selectedId === null) return;
              await remove.run({ id: selectedId });
              setSelectedId(null);
              setDraft(null);
              refresh();
            }}
            onDuplicate={async () => {
              if (selectedId === null) return;
              const copy = await duplicate.run({ id: selectedId });
              if (copy) {
                setSelectedId(copy.id);
                setDraft(toDraft(copy));
                refresh();
              }
            }}
            onToggleFavourite={async () => {
              if (selectedId === null) return;
              await favourite.run({ id: selectedId, isFavorite: !(draft.isFavorite ?? false) });
              setDraft({ ...draft, isFavorite: !(draft.isFavorite ?? false) });
              refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}

function SongEditor({
  draft,
  onChange,
  onSave,
  saving,
  failure,
  canDelete,
  onDelete,
  onDuplicate,
  onToggleFavourite,
}: {
  draft: SongDraft;
  onChange: (draft: SongDraft) => void;
  onSave: () => void;
  saving: boolean;
  failure: ErrorNotice | null;
  canDelete: boolean;
  onDelete: () => Promise<void>;
  onDuplicate: () => Promise<void>;
  onToggleFavourite: () => Promise<void>;
}): JSX.Element {
  const set = <K extends keyof SongDraft>(key: K, value: SongDraft[K]): void =>
    onChange({ ...draft, [key]: value });

  const setSection = (index: number, patch: Partial<SongSectionDraft>): void => {
    const sections = draft.sections.map((section, i) => (i === index ? { ...section, ...patch } : section));
    onChange({ ...draft, sections });
  };

  const addSection = (): void => {
    onChange({
      ...draft,
      sections: [
        ...draft.sections,
        {
          kind: 'verse',
          // nextSectionLabel numbers from the highest existing number, so deleting
          // Verse 2 and adding one gives Verse 3 rather than a duplicate.
          label: nextSectionLabel('verse', draft.sections as never),
          sortOrder: draft.sections.length,
          lyrics: '',
          slideBreakMode: 'blank-line',
        },
      ],
    });
  };

  const moveSection = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= draft.sections.length) return;
    const sections = [...draft.sections];
    const [moved] = sections.splice(index, 1);
    sections.splice(target, 0, moved!);
    onChange({ ...draft, sections });
  };

  const slideCount = useMemo(
    () => draft.sections.reduce((total, section) => total + countSlides(section), 0),
    [draft.sections],
  );

  return (
    <div className="p-5 space-y-4 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <input
            className="w-full bg-transparent text-xl font-semibold text-silver-100 placeholder:text-silver-700 focus:outline-none"
            placeholder="Song title"
            value={draft.title}
            onChange={(event) => set('title', event.target.value)}
          />
          <p className="mt-1 text-[11px] text-silver-600">
            {draft.sections.length} section{draft.sections.length === 1 ? '' : 's'} · {slideCount} slide
            {slideCount === 1 ? '' : 's'} when presented
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canDelete && (
            <>
              <button type="button" className="btn-ghost" onClick={() => void onToggleFavourite()}>
                {draft.isFavorite ? '★ Favourited' : '☆ Favourite'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => void onDuplicate()}>
                Duplicate
              </button>
              <button type="button" className="btn-ghost text-status-error" onClick={() => void onDelete()}>
                Delete
              </button>
            </>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={onSave}
            disabled={saving || draft.title.trim() === ''}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {failure && <FailureNotice notice={failure} />}

      {/* ── metadata ────────────────────────────────────────────────────────────── */}
      <Panel title="Details">
        <div className="p-4 grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field label="Artist" value={draft.artist ?? ''} onChange={(v) => set('artist', v || null)} />
          <Field label="Author" value={draft.author ?? ''} onChange={(v) => set('author', v || null)} />
          <Field label="Key" value={draft.songKey ?? ''} onChange={(v) => set('songKey', v || null)} placeholder="E" />
          <Field
            label="CCLI number"
            value={draft.ccliNumber ?? ''}
            onChange={(v) => set('ccliNumber', v.replace(/\D/g, '') || null)}
            placeholder="7115744"
          />
          <Field label="Category" value={draft.category ?? ''} onChange={(v) => set('category', v || null)} />
          <Field
            label="Copyright"
            value={draft.copyright ?? ''}
            onChange={(v) => set('copyright', v || null)}
            className="col-span-2 md:col-span-1"
          />
        </div>
      </Panel>

      {/* ── sections ────────────────────────────────────────────────────────────── */}
      <Panel
        title="Sections"
        actions={
          <button type="button" className="btn-ghost h-7 text-[12px]" onClick={addSection}>
            + Add section
          </button>
        }
      >
        <div className="p-3 space-y-3">
          {draft.sections.length === 0 && (
            <p className="text-[13px] text-silver-600 px-1 py-4 text-center">
              No sections yet. Add a verse or chorus to begin.
            </p>
          )}

          {draft.sections.map((section, index) => (
            <div key={index} className="rounded-md border border-ink-700 bg-ink-850">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-700">
                <select
                  className="field h-7 w-32 text-[12px]"
                  value={section.kind}
                  onChange={(event) => setSection(index, { kind: event.target.value as SongSectionKind })}
                >
                  {SONG_SECTION_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {titleCase(kind)}
                    </option>
                  ))}
                </select>

                <input
                  className="field h-7 flex-1 text-[12px]"
                  value={section.label}
                  placeholder="Label shown to the operator"
                  onChange={(event) => setSection(index, { label: event.target.value })}
                />

                <select
                  className="field h-7 w-36 text-[12px]"
                  value={section.slideBreakMode}
                  onChange={(event) =>
                    setSection(index, { slideBreakMode: event.target.value as SlideBreakMode })
                  }
                  title="How these lyrics split into slides"
                >
                  {SLIDE_BREAK_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {describeBreakMode(mode)}
                    </option>
                  ))}
                </select>

                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    type="button"
                    className="btn-ghost h-7 w-7 px-0"
                    onClick={() => moveSection(index, -1)}
                    disabled={index === 0}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn-ghost h-7 w-7 px-0"
                    onClick={() => moveSection(index, 1)}
                    disabled={index === draft.sections.length - 1}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn-ghost h-7 w-7 px-0 text-status-error"
                    onClick={() =>
                      onChange({ ...draft, sections: draft.sections.filter((_, i) => i !== index) })
                    }
                    title="Remove section"
                  >
                    ×
                  </button>
                </div>
              </div>

              <textarea
                className="w-full bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-silver-200 placeholder:text-silver-700 resize-y min-h-[90px] focus:outline-none selectable"
                placeholder={'You are here\nMoving in our midst\n\n(a blank line starts a new slide)'}
                value={section.lyrics}
                onChange={(event) => setSection(index, { lyrics: event.target.value })}
                spellCheck={false}
              />

              <div className="px-3 pb-2 text-[11px] text-silver-700">
                {countSlides(section)} slide{countSlides(section) === 1 ? '' : 's'}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}): JSX.Element {
  return (
    <label className={`block ${className}`}>
      <span className="field-label">{label}</span>
      <input
        className="field"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/**
 * Slide count preview, delegated to the tested shared splitter rather than reimplemented
 * here. The editor and the presentation engine must never disagree about how many slides a
 * section produces — that would surprise the operator live.
 */
const countSlides = (section: SongSectionDraft): number =>
  countSectionSlides({
    kind: section.kind as never,
    label: section.label,
    lyrics: section.lyrics,
    slideBreakMode: section.slideBreakMode as never,
  });

const titleCase = (value: string): string =>
  value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');

function describeBreakMode(mode: SlideBreakMode): string {
  switch (mode) {
    case 'blank-line':
      return 'Split on blank line';
    case 'every-2-lines':
      return 'Every 2 lines';
    case 'every-4-lines':
      return 'Every 4 lines';
    case 'whole-section':
      return 'One slide';
  }
}

function toDraft(song: Song): SongDraft {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    author: song.author,
    copyright: song.copyright,
    ccliNumber: song.ccliNumber,
    songKey: song.songKey,
    notes: song.notes,
    category: song.category,
    isFavorite: song.isFavorite,
    sections: song.sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      label: section.label,
      sortOrder: section.sortOrder,
      lyrics: section.lyrics,
      slideBreakMode: section.slideBreakMode,
    })),
  };
}
