/**
 * BIBLE — scripture lookup and staging (Section 8, Phase 4).
 *
 * Three columns: the translation and its books, then the passage selectors, then a preview of the real
 * slides with the actions that put them into a service.
 *
 * THE PREVIEW IS NOT AN APPROXIMATION. It renders through `SlideCanvas` using `packPassageIntoSlides` —
 * the same component and the same splitting function the presentation engine uses — so the slides shown
 * here are the slides the congregation will see, including where a long passage breaks. A preview built
 * any other way would eventually disagree with the projector.
 *
 * NO SCRIPTURE SHIPS WITH THIS APPLICATION. With nothing installed this screen explains why and offers
 * to import a package, rather than showing an empty list that looks broken.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BibleTranslation, Theme } from '@shared/domain/entities.ts';
import { BIBLE_BOOKS } from '@shared/domain/bible.ts';
import { packPassageIntoSlides, slideReference } from '@shared/domain/scripture.ts';
import { DEFAULT_THEME_ID, resolveThemeSpecOrBase } from '@shared/domain/theme.ts';
import type {
  BibleBookSummary,
  BibleSearchHit,
  ScriptureLookup,
  ScripturePassage,
  ServiceSummary,
  TranslationImportReport,
} from '@shared/ipc-contract.ts';
import { client } from '@ui/client.ts';
import { useQuery } from '@ui/hooks.ts';
import { SlideCanvas } from '@ui/SlideCanvas.tsx';
import { EmptyState, FailureNotice, Panel, Spinner } from '@ui/primitives.tsx';

export function BibleSection(): JSX.Element {
  const translations = useQuery('bible:translations');
  const themesQuery = useQuery('themes:list');
  const settings = useQuery('settings:getAll');
  const services = useQuery('services:list');

  const [translationId, setTranslationId] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [lookup, setLookup] = useState<ScriptureLookup | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<TranslationImportReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const installed: readonly BibleTranslation[] = translations.data ?? [];
  const themes: readonly Theme[] = themesQuery.data ?? [];

  // Settle on a translation as soon as one exists, so the operator never has to pick before looking up.
  useEffect(() => {
    if (translationId === null && installed.length > 0) setTranslationId(installed[0]!.id);
    if (translationId !== null && !installed.some((entry) => entry.id === translationId)) {
      setTranslationId(installed[0]?.id ?? null);
    }
  }, [installed, translationId]);

  const scriptureThemeId =
    typeof settings.data?.['presentation.scriptureThemeId'] === 'string'
      ? (settings.data['presentation.scriptureThemeId'] as string)
      : DEFAULT_THEME_ID;
  const spec = resolveThemeSpecOrBase(themes, scriptureThemeId);

  /*
   * Looked up in MAIN, never assembled here.
   *
   * The renderer could have queried verses and built a passage itself; doing it over one channel means
   * the operator's preview and the cue the engine later builds come from exactly the same resolution.
   */
  const runLookup = useCallback(
    async (text: string) => {
      if (translationId === null || text.trim() === '') {
        setLookup(null);
        return;
      }
      const result = await client.invoke('bible:lookup', { translationId, reference: text.trim() });
      if (result.ok) {
        setLookup(result.data);
        setSlideIndex(0);
      }
    },
    [translationId],
  );

  // Debounced, so typing "John 3:16" does not fire five lookups.
  useEffect(() => {
    const handle = setTimeout(() => void runLookup(reference), 180);
    return () => clearTimeout(handle);
  }, [reference, runLookup]);

  const passage: ScripturePassage | null = lookup?.found === true ? lookup.passage : null;

  /*
   * THE SAME splitting the engine will do. Not an estimate of it.
   */
  const slides = useMemo(
    () => (passage === null ? [] : packPassageIntoSlides(passage, spec)),
    [passage, spec],
  );
  const slide = slides[Math.min(slideIndex, Math.max(slides.length - 1, 0))] ?? null;

  const runImport = async (): Promise<void> => {
    setImporting(true);
    setImportReport(null);
    const result = await client.invoke('bible:import');
    setImporting(false);

    if (!result.ok) {
      setNotice(result.failure.message);
      return;
    }
    setImportReport(result.data);
    if (result.data.outcome === 'installed') {
      translations.reload();
      setTranslationId(result.data.translation.id);
    }
  };

  const removeTranslation = async (id: string, name: string): Promise<void> => {
    const result = await client.invoke('bible:removeTranslation', { id });
    if (!result.ok) {
      setNotice(result.failure.message);
      return;
    }
    setNotice(`Removed ${name}. Services using it will report their readings as unavailable.`);
    setLookup(null);
    translations.reload();
  };

  /**
   * Appends the passage to a service as a scripture item, then reopens it so cues rebuild.
   *
   * Existing item ids are passed back deliberately: `services:save` replaces the item rows, and cue ids
   * derive from item ids — so omitting them would regenerate every cue and `setCues` would find the
   * live one gone, blacking the projector mid-service.
   */
  const addToService = async (serviceId: string, goLive: boolean): Promise<void> => {
    if (passage === null || translationId === null) return;

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
          kind: 'scripture',
          label: `${passage.reference} (${passage.translationAbbreviation})`,
          sortOrder: service.items.length,
          // The reference and translation, so the engine resolves the passage fresh each time the
          // service is opened rather than storing a copy of the text that could go stale.
          config: { reference: passage.reference, translationId },
        },
      ],
    });

    if (!saved.ok) {
      setNotice(saved.failure.message);
      return;
    }

    const opened = await client.invoke('services:open', { serviceId });
    if (!opened.ok || opened.data === null) {
      setNotice('The passage was added, but the service could not be reopened.');
      return;
    }

    const addedItem = saved.data.items[saved.data.items.length - 1];
    const firstCue = opened.data.cues.find((cue) => cue.itemId === addedItem?.id);

    if (goLive && firstCue) {
      const live = await client.invoke('live:intent', { type: 'goLive', cueId: firstCue.id });
      if (!live.ok) {
        setNotice(live.failure.message);
        return;
      }
      setNotice(`${passage.reference} is now on air in "${service.name}".`);
      return;
    }

    setNotice(
      firstCue
        ? `Added ${passage.reference} to "${service.name}". Open it in Service to present it.`
        : `Added ${passage.reference} to "${service.name}", but it produced no slides.`,
    );
  };

  // ── nothing installed ─────────────────────────────────────────────────────────

  if (translations.loading) return <Spinner label="Loading translations" />;

  if (translations.failure) {
    return (
      <div className="p-5 max-w-2xl">
        <FailureNotice notice={translations.failure} onRetry={translations.reload} />
      </div>
    );
  }

  if (installed.length === 0) {
    return (
      <NoTranslations
        importing={importing}
        report={importReport}
        notice={notice}
        onImport={() => void runImport()}
      />
    );
  }

  // ── the workspace ─────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex min-h-0">
      <div className="w-72 shrink-0 border-r border-ink-700 flex flex-col min-h-0">
        <TranslationPicker
          installed={installed}
          selectedId={translationId}
          importing={importing}
          onSelect={setTranslationId}
          onImport={() => void runImport()}
          onRemove={(id, name) => void removeTranslation(id, name)}
        />
        {translationId !== null && (
          <BookList
            translationId={translationId}
            onPick={(ref) => setReference(ref)}
          />
        )}
      </div>

      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-auto">
        <div className="p-4 space-y-4">
          <Panel title="Passage">
            <div className="p-4 space-y-3">
              <div>
                <label className="field-label" htmlFor="bible-reference">
                  Reference
                </label>
                <input
                  id="bible-reference"
                  className="field"
                  value={reference}
                  placeholder="John 3:16, Psalm 23:1-6, Romans 8"
                  onChange={(event) => setReference(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <LookupStatus
                  lookup={lookup}
                  reference={reference}
                  slideCount={slides.length}
                  onPickCandidate={(book) => setReference(`${book} ${stripBook(reference)}`.trim())}
                />
              </div>

              {translationId !== null && (
                <KeywordSearch translationId={translationId} onPick={(ref) => setReference(ref)} />
              )}
            </div>
          </Panel>

          <Panel
            title="Preview"
            actions={
              slides.length > 1 ? (
                <span className="flex items-center gap-2 text-[11px] text-silver-500">
                  <button
                    type="button"
                    className="btn-ghost h-6 px-2"
                    disabled={slideIndex === 0}
                    title={slideIndex === 0 ? 'This is the first slide' : 'Previous slide'}
                    onClick={() => setSlideIndex((value) => Math.max(value - 1, 0))}
                  >
                    ‹
                  </button>
                  <span className="timecode">
                    {slideIndex + 1} / {slides.length}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost h-6 px-2"
                    disabled={slideIndex >= slides.length - 1}
                    title={slideIndex >= slides.length - 1 ? 'This is the last slide' : 'Next slide'}
                    onClick={() => setSlideIndex((value) => Math.min(value + 1, slides.length - 1))}
                  >
                    ›
                  </button>
                </span>
              ) : null
            }
          >
            <div className="p-3">
              {/*
                The SAME component the audience output uses, with the SAME packing. What is shown here is
                what the congregation will see.
              */}
              {passage !== null && slide !== null ? (
                <SlideCanvas
                  spec={spec}
                  lines={slide.lines}
                  caption={`${slideReference(passage, slide)} (${passage.translationAbbreviation})`}
                  annotate
                  className="w-full aspect-video rounded-lg border border-ink-700"
                />
              ) : (
                <div className="w-full aspect-video rounded-lg border border-ink-700 bg-black grid place-items-center">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-silver-700">
                    Type a reference to preview it
                  </p>
                </div>
              )}

              {passage !== null && passage.missingVerses.length > 0 && (
                <p className="mt-3 text-[12px] text-status-ready">
                  {passage.translationAbbreviation} does not contain{' '}
                  {passage.missingVerses.length === 1 ? 'verse' : 'verses'}{' '}
                  {passage.missingVerses.join(', ')} of this range. Only the verses shown will be
                  presented.
                </p>
              )}

              {passage?.copyrightNotice !== null && passage !== null && (
                <p className="mt-3 text-[11px] text-silver-700">
                  {passage.translationAbbreviation}: {passage.copyrightNotice}
                </p>
              )}
            </div>
          </Panel>

          <AddToService
            services={services.data ?? []}
            enabled={passage !== null}
            onAdd={(serviceId, goLive) => void addToService(serviceId, goLive)}
          />

          {notice !== null && (
            <p className="p-2.5 rounded-md bg-ink-800 border border-ink-700 text-[12px] text-silver-400">
              {notice}
            </p>
          )}

          {importReport !== null && <ImportOutcome report={importReport} />}
        </div>
      </div>
    </div>
  );
}

// ── no translations ──────────────────────────────────────────────────────────────

/**
 * The first thing most operators will see here.
 *
 * States the licensing position plainly instead of showing an empty list that looks like a fault. Being
 * honest about WHY there is no scripture is the difference between "this app is broken" and "I need to
 * install a translation".
 */
function NoTranslations({
  importing,
  report,
  notice,
  onImport,
}: {
  importing: boolean;
  report: TranslationImportReport | null;
  notice: string | null;
  onImport: () => void;
}): JSX.Element {
  return (
    <div className="h-full overflow-auto p-5">
      <div className="max-w-2xl mx-auto">
        <EmptyState
          title="No Bible translation installed"
          description="Exceptionel Presenter does not include any Bible text. Most translations are under copyright, so bundling one would mean distributing it without permission — or restricting which churches may use this software."
          action={
            <button
              type="button"
              className="btn-primary"
              onClick={onImport}
              disabled={importing}
              title={importing ? 'Reading the package…' : 'Choose a translation package to install'}
            >
              {importing ? 'Installing…' : 'Install a translation…'}
            </button>
          }
        />

        <div className="mt-5 p-4 rounded-lg border border-ink-700 bg-ink-900 text-[12px] text-silver-500 space-y-2">
          <p className="font-semibold text-silver-300">What a translation package looks like</p>
          <p>
            A single <code className="text-silver-400">.json</code> file naming the translation, its
            licence, and its books as arrays of verses. The licence field is required — a package that
            does not state its terms is refused.
          </p>
          <pre className="mt-2 p-2.5 rounded bg-ink-950 border border-ink-750 text-[11px] text-silver-500 overflow-auto">
{`{
  "translation": {
    "id": "example", "abbreviation": "EX",
    "name": "Example Version", "language": "en",
    "license": "Public domain"
  },
  "books": [
    { "number": 43, "chapters": [["verse one", "verse two"]] }
  ]
}`}
          </pre>
          <p>
            Public-domain and openly licensed translations are available from several open Bible projects.
            Check the terms for your country: some editions are public domain in one jurisdiction and
            still under copyright in another.
          </p>
          <p className="text-silver-600">See docs/BIBLE.md for the full format.</p>
        </div>

        {notice !== null && <p className="mt-4 text-[12px] text-status-live">{notice}</p>}
        {report !== null && (
          <div className="mt-4">
            <ImportOutcome report={report} />
          </div>
        )}
      </div>
    </div>
  );
}

function ImportOutcome({ report }: { report: TranslationImportReport }): JSX.Element | null {
  if (report.outcome === 'cancelled') return null;

  if (report.outcome === 'rejected') {
    return (
      <div className="p-3 rounded-md bg-status-live/10 border border-status-live/40">
        <p className="text-[12px] font-semibold text-status-live">
          That package was not installed ({report.problems.length}{' '}
          {report.problems.length === 1 ? 'problem' : 'problems'})
        </p>
        <ul className="mt-2 space-y-1">
          {report.problems.slice(0, 12).map((problem, index) => (
            <li key={`${problem.path}:${String(index)}`} className="text-[11px] text-silver-400">
              {problem.path !== '' && <code className="text-silver-600">{problem.path}</code>}{' '}
              {problem.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="p-3 rounded-md bg-status-ok/10 border border-status-ok/40">
      <p className="text-[12px] font-semibold text-status-ok">
        Installed {report.translation.name} — {report.translation.verseCount.toLocaleString()} verses
      </p>
      <p className="mt-1 text-[11px] text-silver-500">Licence: {report.translation.license}</p>
      {report.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {report.warnings.slice(0, 8).map((warning, index) => (
            <li key={index} className="text-[11px] text-status-ready">
              {warning.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── translations ─────────────────────────────────────────────────────────────────

function TranslationPicker({
  installed,
  selectedId,
  importing,
  onSelect,
  onImport,
  onRemove,
}: {
  installed: readonly BibleTranslation[];
  selectedId: string | null;
  importing: boolean;
  onSelect: (id: string) => void;
  onImport: () => void;
  onRemove: (id: string, name: string) => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null);
  const selected = installed.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="p-3 border-b border-ink-700">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700">Translation</p>
        <button
          type="button"
          className="btn-ghost h-6 px-2 text-[11px]"
          onClick={onImport}
          disabled={importing}
          title={importing ? 'Reading the package…' : 'Install another translation'}
        >
          {importing ? '…' : '+ Install'}
        </button>
      </div>

      <select
        className="field"
        value={selectedId ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        title="Which translation to look up"
      >
        {installed.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.abbreviation} — {entry.name}
          </option>
        ))}
      </select>

      {selected !== null && (
        <div className="mt-2 space-y-1">
          <p className="text-[11px] text-silver-700">
            {selected.verseCount.toLocaleString()} verses · {selected.language}
          </p>
          {/* Attribution, verbatim as the package declared it. */}
          <p className="text-[11px] text-silver-600 leading-snug">{selected.license}</p>

          {confirming === selected.id ? (
            <div className="flex items-center gap-1.5 pt-1">
              <button
                type="button"
                className="btn-ghost h-6 px-2 text-[11px] text-status-error"
                onClick={() => {
                  onRemove(selected.id, selected.name);
                  setConfirming(null);
                }}
                title="Delete this translation and all of its verses"
              >
                Really remove
              </button>
              <button
                type="button"
                className="btn-ghost h-6 px-2 text-[11px]"
                onClick={() => setConfirming(null)}
                title="Keep it"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn-ghost h-6 px-0 text-[11px] text-silver-700"
              onClick={() => setConfirming(selected.id)}
              title="Remove this translation from this computer"
            >
              Remove…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── books and chapters ───────────────────────────────────────────────────────────

function BookList({
  translationId,
  onPick,
}: {
  translationId: string;
  onPick: (reference: string) => void;
}): JSX.Element {
  const books = useQuery('bible:books', { translationId });
  const [filter, setFilter] = useState('');
  const [openBook, setOpenBook] = useState<number | null>(null);

  const available: readonly BibleBookSummary[] = books.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? available : available.filter((book) => book.name.toLowerCase().includes(needle));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="p-3 pb-2">
        <input
          className="field h-8 text-[12px]"
          placeholder="Filter books…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-3 pb-3">
        {books.loading ? (
          <Spinner label="Loading books" />
        ) : shown.length === 0 ? (
          <p className="text-[11px] text-silver-700 py-2">
            {available.length === 0
              ? 'This translation contains no books.'
              : `No book matches "${filter}".`}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {shown.map((book) => (
              <li key={book.bookNumber}>
                <button
                  type="button"
                  className={`w-full flex items-center justify-between text-left px-2 py-1.5 rounded text-[12px] transition-colors ${
                    openBook === book.bookNumber
                      ? 'bg-ink-750 text-silver-100'
                      : 'text-silver-400 hover:bg-ink-800 hover:text-silver-200'
                  }`}
                  onClick={() => setOpenBook(openBook === book.bookNumber ? null : book.bookNumber)}
                  title={`${book.name} — ${String(book.chapterCount)} chapters`}
                >
                  <span className="truncate">{book.name}</span>
                  <span className="text-[10px] text-silver-700">{book.chapterCount}</span>
                </button>

                {openBook === book.bookNumber && (
                  <ChapterGrid
                    translationId={translationId}
                    book={book}
                    onPick={(chapter) => onPick(`${canonicalName(book.bookNumber)} ${String(chapter)}`)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Chapter buttons, each labelled with how many verses it actually has.
 *
 * The counts come from the installed text rather than a versification table, so the operator is never
 * offered a chapter or verse that comes back empty.
 */
function ChapterGrid({
  translationId,
  book,
  onPick,
}: {
  translationId: string;
  book: BibleBookSummary;
  onPick: (chapter: number) => void;
}): JSX.Element {
  const counts = useQuery('bible:chapters', { translationId, bookNumber: book.bookNumber });
  const verseCounts: readonly number[] = counts.data ?? [];

  return (
    <div className="mt-1 mb-2 ml-2 grid grid-cols-6 gap-1">
      {Array.from({ length: book.chapterCount }, (_, index) => index + 1).map((chapter) => {
        const verses = verseCounts[chapter - 1] ?? 0;
        return (
          <button
            key={chapter}
            type="button"
            className="h-6 rounded text-[11px] text-silver-500 bg-ink-850 hover:bg-ink-750 hover:text-silver-200 transition-colors disabled:opacity-40"
            onClick={() => onPick(chapter)}
            disabled={verses === 0}
            title={
              verses === 0
                ? `Chapter ${String(chapter)} is not in this translation`
                : `Chapter ${String(chapter)} — ${String(verses)} verses`
            }
          >
            {chapter}
          </button>
        );
      })}
    </div>
  );
}

// ── lookup feedback ──────────────────────────────────────────────────────────────

/**
 * What the reference box says beneath itself.
 *
 * Each failure has its own message and its own remedy, which is the whole reason `ScriptureLookup` is a
 * discriminated result rather than a thrown error. An ambiguous book offers its candidates as buttons,
 * so "Jud 3" is one click from being resolved.
 */
function LookupStatus({
  lookup,
  reference,
  slideCount,
  onPickCandidate,
}: {
  lookup: ScriptureLookup | null;
  reference: string;
  slideCount: number;
  onPickCandidate: (book: string) => void;
}): JSX.Element | null {
  if (reference.trim() === '') {
    return (
      <p className="mt-1 text-[11px] text-silver-700">
        Book, chapter and optional verses. Ranges and abbreviations are understood.
      </p>
    );
  }

  if (lookup === null) return null;

  if (lookup.found) {
    const verses = lookup.passage.verses.length;
    return (
      <p className="mt-1 text-[11px] text-status-ok">
        {lookup.passage.reference} · {verses} {verses === 1 ? 'verse' : 'verses'} ·{' '}
        {slideCount} {slideCount === 1 ? 'slide' : 'slides'}
      </p>
    );
  }

  return (
    <div className="mt-1">
      <p className="text-[11px] text-status-ready">{lookup.message}</p>
      {lookup.candidates !== undefined && lookup.candidates.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {lookup.candidates.map((book) => (
            <button
              key={book}
              type="button"
              className="px-2 h-6 rounded bg-ink-800 border border-ink-700 text-[11px] text-silver-300 hover:bg-ink-750"
              onClick={() => onPickCandidate(book)}
              title={`Use ${book}`}
            >
              {book}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── keyword search ───────────────────────────────────────────────────────────────

function KeywordSearch({
  translationId,
  onPick,
}: {
  translationId: string;
  onPick: (reference: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [hits, setHits] = useState<readonly BibleSearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (debounced === '') {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void client.invoke('bible:search', { translationId, query: debounced, limit: 40 }).then((result) => {
      if (cancelled) return;
      setSearching(false);
      if (result.ok) setHits(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [debounced, translationId]);

  return (
    <div>
      <label className="field-label" htmlFor="bible-search">
        Or search the text
      </label>
      <input
        id="bible-search"
        className="field"
        placeholder="shepherd, everlasting, born again…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
      />

      {searching && <p className="mt-1 text-[11px] text-silver-700">Searching…</p>}

      {!searching && debounced !== '' && hits.length === 0 && (
        <p className="mt-1 text-[11px] text-silver-700">Nothing in this translation matches "{debounced}".</p>
      )}

      {hits.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-auto space-y-0.5">
          {hits.map((hit) => (
            <li key={`${String(hit.bookNumber)}_${String(hit.chapter)}_${String(hit.verse)}`}>
              <button
                type="button"
                className="w-full text-left px-2 py-1.5 rounded text-[12px] text-silver-500 hover:bg-ink-800 hover:text-silver-200 transition-colors"
                onClick={() => onPick(hit.reference)}
                title={`Use ${hit.reference}`}
              >
                <span className="block text-[11px] font-semibold text-silver-400">{hit.reference}</span>
                <span className="block truncate text-silver-600">{hit.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── staging into a service ───────────────────────────────────────────────────────

function AddToService({
  services,
  enabled,
  onAdd,
}: {
  services: readonly ServiceSummary[];
  enabled: boolean;
  onAdd: (serviceId: string, goLive: boolean) => void;
}): JSX.Element {
  const [serviceId, setServiceId] = useState('');

  useEffect(() => {
    if (serviceId === '' && services.length > 0) setServiceId(services[0]!.id);
  }, [services, serviceId]);

  if (services.length === 0) {
    return (
      <Panel title="Add to a service">
        <p className="p-4 text-[12px] text-silver-600">
          There are no services yet. Create one in the Service section, then this passage can be added to
          it.
        </p>
      </Panel>
    );
  }

  const chosen = services.find((entry) => entry.id === serviceId) ?? null;

  return (
    <Panel title="Add to a service">
      <div className="p-4 space-y-3">
        <select
          className="field"
          value={serviceId}
          onChange={(event) => setServiceId(event.target.value)}
          title="Which service to add this reading to"
        >
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name} ({service.itemCount} {service.itemCount === 1 ? 'item' : 'items'})
            </option>
          ))}
        </select>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={!enabled || chosen === null}
            onClick={() => chosen && onAdd(chosen.id, false)}
            title={enabled ? 'Append this reading to the running order' : 'Look up a passage first'}
          >
            Add to service
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!enabled || chosen === null}
            onClick={() => chosen && onAdd(chosen.id, true)}
            title={
              enabled
                ? 'Append it and send its first slide to the audience now'
                : 'Look up a passage first'
            }
          >
            Add and go live
          </button>
        </div>

        <p className="text-[11px] text-silver-700">
          {/* The stored item holds the reference, not a copy of the text — so re-opening the service
              always reads the current translation rather than a stale snapshot. */}
          The reading is stored as its reference and translation, so it always presents the installed
          text.
        </p>
      </div>
    </Panel>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────────

/** The canonical English name, which the parser always understands. */
const canonicalName = (bookNumber: number): string =>
  BIBLE_BOOKS.find((book) => book.number === bookNumber)?.name ?? '';

/** Everything after the book name in a typed reference, so a candidate can replace just the book. */
function stripBook(reference: string): string {
  const match = /([0-9]+(?:\s*[:.]\s*[0-9]+(?:\s*[-–—]\s*[0-9]+)?)?)\s*$/.exec(reference.trim());
  return match?.[1] ?? '';
}
