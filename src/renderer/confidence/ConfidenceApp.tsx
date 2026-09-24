/**
 * EXCEPTIONEL PRESENTER — CONFIDENCE MONITOR (Sections 23, 24).
 *
 * For the pastor or worship leader on stage. Shows the current slide large, what is coming
 * next, a clock and a service timer, plus speaker notes.
 *
 * Read-only by construction: its preload surface exposes no mutating channel, so nothing
 * here can alter the service. Notes shown on this screen never reach the audience display.
 */

import { useEffect, useState } from 'react';
import { serviceProgress, type Cue, type LiveState } from '@shared/domain/live-state.ts';
import { client } from '@ui/client.ts';
import { useIpcEvent } from '@ui/hooks.ts';
import { StatusDot } from '@ui/primitives.tsx';

export function ConfidenceApp(): JSX.Element {
  const [live, setLive] = useState<LiveState | null>(null);
  const [cues, setCues] = useState<readonly Cue[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [startedAt] = useState(() => Date.now());

  useIpcEvent('live:state', setLive);
  useIpcEvent('live:cues', ({ cues: next }) => setCues(next));

  useEffect(() => {
    void client.invoke('live:getState').then((result) => {
      if (result.ok) setLive(result.data);
    });
  }, []);

  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(handle);
  }, []);

  const progress = live ? serviceProgress(live, cues) : null;
  const blacked = live?.status === 'black' || live?.status === 'idle';

  return (
    <div className="fixed inset-0 flex flex-col bg-ink-950 text-silver-200 p-6 gap-5">
      {/* ── header: status, position, clock ─────────────────────────────────────── */}
      <header className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.14em]">
            <StatusDot tone={blacked ? 'idle' : 'live'} pulse={!blacked} />
            {live ? describeStatus(live.status) : 'Connecting'}
          </span>
          {progress && <span className="text-sm text-silver-600 timecode">{progress.position}</span>}
        </div>

        <div className="flex items-center gap-6">
          <Timer label="Elapsed" value={formatDuration(Date.now() - startedAt)} />
          <Timer label="Time" value={now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
        </div>
      </header>

      {/* ── current slide, large ────────────────────────────────────────────────── */}
      <main className="flex-1 min-h-0 flex flex-col justify-center rounded-lg border border-ink-700 bg-black px-10 py-8">
        {blacked ? (
          <p className="text-center text-xl text-silver-700 uppercase tracking-[0.2em]">
            Audience screen is black
          </p>
        ) : progress?.current ? (
          <p className="text-center text-5xl font-semibold leading-tight text-white">
            {progress.current.label}
          </p>
        ) : (
          <p className="text-center text-xl text-silver-700 uppercase tracking-[0.2em]">Nothing live</p>
        )}
      </main>

      {/* ── next slide and notes ────────────────────────────────────────────────── */}
      <footer className="shrink-0 grid grid-cols-2 gap-5">
        <section className="rounded-lg border border-ink-700 bg-ink-900 p-4 min-h-[96px]">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700 mb-2">Next</p>
          <p className="text-lg text-silver-300 leading-snug">
            {progress?.next?.label ?? <span className="text-silver-700">End of service</span>}
          </p>
        </section>

        <section className="rounded-lg border border-ink-700 bg-ink-900 p-4 min-h-[96px]">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700 mb-2">
            Speaker notes
          </p>
          <p className="text-sm text-silver-400 leading-relaxed whitespace-pre-wrap">
            {progress?.current?.notes ?? <span className="text-silver-700">No notes for this slide</span>}
          </p>
        </section>
      </footer>
    </div>
  );
}

function Timer({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="text-right">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-silver-700">{label}</p>
      {/* Tabular figures so the digits do not shift width as the timer counts. */}
      <p className="text-2xl font-semibold timecode text-silver-200">{value}</p>
    </div>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(Math.floor(ms / 1000), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function describeStatus(status: LiveState['status']): string {
  switch (status) {
    case 'live':
      return 'Live';
    case 'black':
      return 'Black';
    case 'clear':
      return 'Text cleared';
    case 'paused':
      return 'Paused';
    case 'idle':
      return 'Standby';
  }
}
