/**
 * EXCEPTIONEL PRESENTER — operator application shell.
 *
 * Production-software layout, not a SaaS dashboard: a dense navigation rail, a large work
 * area, and a persistent status bar that always answers "what is the audience seeing?"
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInfo } from '@shared/ipc-contract.ts';
import type { ErrorNotice } from '@shared/domain/errors.ts';
import type { LiveState } from '@shared/domain/live-state.ts';
import { BRAND } from '@shared/brand.ts';
import { client } from '@ui/client.ts';
import { useIpcEvent, useQuery } from '@ui/hooks.ts';
import { Wordmark } from '@ui/Logo.tsx';
import { FailureNotice, NotImplemented, Spinner, StatusDot } from '@ui/primitives.tsx';
import { SECTIONS, sectionById, type SectionId } from './navigation.ts';
import { DashboardSection } from './sections/Dashboard.tsx';
import { SongsSection } from './sections/Songs.tsx';
import { ThemesSection } from './sections/Themes.tsx';
import { SettingsSection } from './sections/Settings.tsx';
import { HelpSection } from './sections/Help.tsx';

const GROUP_LABEL: Record<string, string> = {
  produce: 'Produce',
  library: 'Library',
  system: 'System',
};

export function App(): JSX.Element {
  const [activeId, setActiveId] = useState<SectionId>('dashboard');
  const [notices, setNotices] = useState<ErrorNotice[]>([]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const info = useQuery('app:info');

  // Main is authoritative; the UI mirrors what it broadcasts (§1).
  useIpcEvent('live:state', setLive);
  useIpcEvent('error:notice', (notice) => {
    // Cap the stack: a repeating failure must not push the UI off screen.
    setNotices((current) => [notice, ...current].slice(0, 4));
  });
  useIpcEvent('autosave:committed', ({ at }) => setSavedAt(at));

  useEffect(() => {
    void client.invoke('live:getState').then((result) => {
      if (result.ok) setLive(result.data);
    });
  }, []);

  useEffect(() => {
    document.title = `${sectionById(activeId).label} — ${BRAND.name}`;
  }, [activeId]);

  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<string, typeof SECTIONS> = {};
    for (const section of SECTIONS) {
      groups[section.group] = [...(groups[section.group] ?? []), section];
    }
    return groups;
  }, []);

  if (!client.available) {
    // The preload bridge failed to load. Without it nothing works, so say so plainly
    // rather than rendering an app that silently does nothing.
    return (
      <div className="h-full grid place-items-center p-8">
        <div className="max-w-md">
          <FailureNotice
            notice={{
              domain: 'internal',
              code: 'bridge/unavailable',
              message: 'Exceptionel Presenter could not reach its application core.',
              detail: 'window.exceptionel is undefined — the preload script did not load.',
              remedies: ['Restart the application.', 'If this persists, reinstall Exceptionel Presenter.'],
              severity: 'fatal',
              retryable: false,
              id: 'bridge',
              occurredAt: new Date().toISOString(),
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-ink-900">
      {/* ── title bar ─────────────────────────────────────────────────────────── */}
      <header className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-ink-700 bg-ink-850">
        <Wordmark />
        <LiveIndicator live={live} />
      </header>

      <div className="flex-1 flex min-h-0">
        {/* ── navigation rail ─────────────────────────────────────────────────── */}
        <nav className="w-52 shrink-0 border-r border-ink-700 bg-ink-850 overflow-y-auto py-3 px-2">
          {(['produce', 'library', 'system'] as const).map((group) => (
            <div key={group} className="mb-4">
              <p className="px-3 mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700">
                {GROUP_LABEL[group]}
              </p>
              <ul className="space-y-0.5">
                {(grouped[group] ?? []).map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(section.id)}
                      className={`nav-item w-full text-left ${activeId === section.id ? 'nav-item-active' : ''}`}
                      aria-current={activeId === section.id ? 'page' : undefined}
                    >
                      <span className="w-4 text-center text-silver-600 text-[13px]">{section.glyph}</span>
                      <span className="flex-1 truncate">{section.label}</span>
                      {!section.available && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-ink-600"
                          title={`Not implemented — ${section.phase}`}
                          aria-label="Not implemented"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {/* ── work area ───────────────────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 flex flex-col">
          {notices.length > 0 && (
            <div className="shrink-0 p-3 space-y-2 border-b border-ink-700 bg-ink-900">
              {notices.map((notice) => (
                <FailureNotice key={notice.id} notice={notice} onDismiss={() => dismiss(notice.id)} />
              ))}
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
            <SectionView id={activeId} />
          </div>
        </main>
      </div>

      {/* ── status bar ──────────────────────────────────────────────────────────── */}
      <footer className="h-7 shrink-0 flex items-center justify-between px-4 border-t border-ink-700 bg-ink-850 text-[11px] text-silver-600">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <StatusDot tone={live && live.status !== 'idle' ? 'live' : 'idle'} />
            {describeStatus(live)}
          </span>
          {savedAt !== null && <span>Saved {new Date(savedAt).toLocaleTimeString()}</span>}
        </div>
        <div className="flex items-center gap-4">
          {info.data && <BuildInfo info={info.data} />}
        </div>
      </footer>
    </div>
  );
}

function SectionView({ id }: { id: SectionId }): JSX.Element {
  const section = sectionById(id);

  if (!section.available) {
    return (
      <NotImplemented
        feature={section.label}
        phase={section.phase}
        requirement={section.requirement}
        {...(section.capabilities ? { capabilities: section.capabilities } : {})}
      />
    );
  }

  switch (id) {
    case 'dashboard':
      return <DashboardSection />;
    case 'songs':
      return <SongsSection />;
    case 'themes':
      return <ThemesSection />;
    case 'settings':
      return <SettingsSection />;
    case 'help':
      return <HelpSection />;
    default:
      return <Spinner />;
  }
}

/**
 * The single most important indicator in the app: is anything reaching the audience right
 * now? Red and pulsing when live, so it registers peripherally.
 */
function LiveIndicator({ live }: { live: LiveState | null }): JSX.Element {
  const isBroadcasting = live !== null && live.status !== 'idle';
  const isBlack = live?.status === 'black';

  return (
    <div className="flex items-center gap-3">
      <div
        className={`flex items-center gap-2 px-3 h-7 rounded-md border text-[11px] font-bold uppercase tracking-[0.14em] ${
          isBroadcasting
            ? isBlack
              ? 'border-ink-600 bg-ink-950 text-silver-500'
              : 'border-status-live bg-status-live/10 text-status-live shadow-live'
            : 'border-ink-700 bg-ink-800 text-silver-600'
        }`}
      >
        <StatusDot
          tone={isBroadcasting ? (isBlack ? 'idle' : 'live') : 'idle'}
          pulse={isBroadcasting && !isBlack}
        />
        {isBroadcasting ? (isBlack ? 'Black' : 'On Air') : 'Off Air'}
      </div>
    </div>
  );
}

function describeStatus(live: LiveState | null): string {
  if (!live) return 'Connecting…';
  switch (live.status) {
    case 'idle':
      return 'Audience screen is black — nothing is live';
    case 'live':
      return `Live — slide ${live.cueIndex + 1}`;
    case 'black':
      return 'Audience screen blacked out';
    case 'clear':
      return 'Text cleared — background and camera still live';
    case 'paused':
      return 'Paused';
  }
}

function BuildInfo({ info }: { info: AppInfo }): JSX.Element {
  return (
    <span className="flex items-center gap-3">
      <span>v{info.version}</span>
      <span className="text-silver-700">schema {info.schemaVersion}</span>
      {!info.isPackaged && (
        <span className="px-1.5 rounded bg-ink-750 text-silver-500 text-[10px] uppercase tracking-wider">dev</span>
      )}
    </span>
  );
}
