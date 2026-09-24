/**
 * DASHBOARD — what an operator needs to know before a service starts.
 *
 * Deliberately not a metrics dashboard. It answers three questions: is the system ready,
 * what am I presenting, and what is still not built.
 */

import type { AppInfo } from '@shared/ipc-contract.ts';
import { BRAND } from '@shared/brand.ts';
import { useQuery } from '@ui/hooks.ts';
import { LogoMark } from '@ui/Logo.tsx';
import { EmptyState, Panel, Spinner, StatusDot, type StatusTone } from '@ui/primitives.tsx';
import { SECTIONS } from '../navigation.ts';

export function DashboardSection(): JSX.Element {
  const info = useQuery('app:info');
  const profile = useQuery('profile:get');
  const services = useQuery('services:list');
  const songs = useQuery('songs:list', { limit: 5 });
  const themes = useQuery('themes:list');

  const pending = SECTIONS.filter((section) => !section.available);

  return (
    <div className="h-full overflow-auto p-5">
      <div className="max-w-6xl mx-auto space-y-4">
        {/* ── welcome ─────────────────────────────────────────────────────────── */}
        <div className="panel p-5 flex items-start gap-4">
          <LogoMark size={44} className="shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-silver-100">
              {profile.data ? `Welcome back, ${profile.data.name}` : `Welcome to ${BRAND.name}`}
            </h1>
            <p className="mt-1 text-[13px] text-silver-500">{BRAND.tagline}</p>
            {profile.data === null && !profile.loading && (
              <p className="mt-3 text-[13px] text-silver-600">
                No church profile yet. The setup wizard arrives in Phase 9 — until then you can set
                your church name in <span className="text-silver-400">Settings → General</span>.
              </p>
            )}
          </div>
        </div>

        {/* ── readiness ───────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ReadinessCard
            label="Library"
            tone="ok"
            value={`${songs.data?.length ?? 0} song${songs.data?.length === 1 ? '' : 's'}`}
            detail={`${themes.data?.length ?? 0} themes installed`}
          />
          <ReadinessCard
            label="Presentation output"
            tone="idle"
            value="Not configured"
            detail="Display management arrives in Phase 7"
          />
          <ReadinessCard
            label="Cameras"
            tone="idle"
            value="Not configured"
            detail="Camera support arrives in Phase 6"
          />
        </div>

        {/* ── services and songs ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Recent services" className="min-h-[220px]">
            {services.loading ? (
              <Spinner />
            ) : (services.data?.length ?? 0) === 0 ? (
              <EmptyState
                title="No services yet"
                description="The service builder arrives in Phase 8. Songs and themes you create now will be ready for it."
              />
            ) : (
              <ul className="divide-y divide-ink-700">
                {services.data?.slice(0, 6).map((service) => (
                  <li key={service.id} className="flex items-center justify-between px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[13px] text-silver-200 truncate">{service.name}</p>
                      <p className="text-[11px] text-silver-600">
                        {service.itemCount} item{service.itemCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    {service.serviceDate !== null && (
                      <span className="text-[11px] text-silver-600 timecode shrink-0 ml-3">
                        {service.serviceDate}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Song library" className="min-h-[220px]">
            {songs.loading ? (
              <Spinner />
            ) : (songs.data?.length ?? 0) === 0 ? (
              <EmptyState
                title="No songs yet"
                description="Add your first worship song from the Songs section. Lyrics are searchable as soon as they are saved."
              />
            ) : (
              <ul className="divide-y divide-ink-700">
                {songs.data?.map((song) => (
                  <li key={song.id} className="flex items-center justify-between px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[13px] text-silver-200 truncate">{song.title}</p>
                      {song.artist !== null && (
                        <p className="text-[11px] text-silver-600 truncate">{song.artist}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      {song.songKey !== null && (
                        <span className="px-1.5 py-0.5 rounded bg-ink-750 text-[10px] text-silver-500">
                          {song.songKey}
                        </span>
                      )}
                      <span className="text-[11px] text-silver-700">{song.sectionCount} sections</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* ── honest build status ─────────────────────────────────────────────── */}
        <Panel title={`Build status — ${pending.length} sections not yet implemented`}>
          <div className="p-4">
            <p className="text-[12px] text-silver-600 mb-3">
              Listed so you always know what this build can and cannot do. Nothing here is a fake
              button — these sections show what is required instead of pretending to work.
            </p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {pending.map((section) => (
                <li key={section.id} className="flex items-center gap-2 text-[12px]">
                  <StatusDot tone="idle" />
                  <span className="text-silver-400">{section.label}</span>
                  <span className="text-silver-700">— {section.phase}</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        {info.data && <DiagnosticsStrip info={info.data} />}
      </div>
    </div>
  );
}

function ReadinessCard({
  label,
  tone,
  value,
  detail,
}: {
  label: string;
  tone: StatusTone;
  value: string;
  detail: string;
}): JSX.Element {
  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-2">
        <StatusDot tone={tone} />
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-silver-600">{label}</p>
      </div>
      <p className="text-sm font-semibold text-silver-100">{value}</p>
      <p className="mt-0.5 text-[11px] text-silver-600">{detail}</p>
    </div>
  );
}

function DiagnosticsStrip({ info }: { info: AppInfo }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3 rounded-lg bg-ink-850 border border-ink-700 text-[11px] text-silver-700">
      <span>
        Electron <span className="text-silver-500">{info.electronVersion}</span>
      </span>
      <span>
        Chromium <span className="text-silver-500">{info.chromeVersion}</span>
      </span>
      <span>
        Node <span className="text-silver-500">{info.nodeVersion}</span>
      </span>
      <span>
        SQLite <span className="text-silver-500">{info.sqliteEngine}</span>
      </span>
      <span>
        Platform <span className="text-silver-500">{info.platform}</span>
      </span>
    </div>
  );
}
