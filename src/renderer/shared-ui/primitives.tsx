/**
 * EXCEPTIONEL PRESENTER — shared UI primitives.
 */

import type { ReactNode } from 'react';
import type { ErrorNotice } from '@shared/domain/errors.ts';

export type StatusTone = 'live' | 'ready' | 'ok' | 'idle' | 'error';

const TONE_CLASS: Record<StatusTone, string> = {
  live: 'bg-status-live',
  ready: 'bg-status-ready',
  ok: 'bg-status-ok',
  idle: 'bg-status-idle',
  error: 'bg-status-error',
};

/**
 * A status indicator. Colour alone is never the signal — every use pairs the dot with a
 * label, so it reads correctly for colour-blind operators and in a dim room.
 */
export function StatusDot({ tone, pulse = false }: { tone: StatusTone; pulse?: boolean }): JSX.Element {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${TONE_CLASS[tone]} ${pulse ? 'animate-live-pulse' : ''}`}
      aria-hidden="true"
    />
  );
}

export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): JSX.Element {
  return (
    <section className={`panel flex flex-col min-h-0 ${className}`}>
      {title !== undefined && (
        <header className="panel-header shrink-0">
          <span>{title}</span>
          {actions}
        </header>
      )}
      <div className={`flex-1 min-h-0 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/**
 * Renders a structured failure: headline plus the specific remedies for that cause
 * (Section 39). Technical detail is available but collapsed, because an operator
 * mid-service needs the fix, not a stack trace.
 */
export function FailureNotice({
  notice,
  onRetry,
  onDismiss,
}: {
  notice: ErrorNotice;
  onRetry?: () => void;
  onDismiss?: () => void;
}): JSX.Element {
  const isInfo = notice.severity === 'info';

  return (
    <div
      className={`rounded-lg border p-4 ${
        isInfo ? 'border-ink-700 bg-ink-800' : 'border-status-error/40 bg-status-error/[0.07]'
      }`}
      role={isInfo ? 'status' : 'alert'}
    >
      <div className="flex items-start gap-3">
        <span className="mt-1.5">
          <StatusDot tone={isInfo ? 'idle' : notice.severity === 'warning' ? 'ready' : 'error'} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-silver-100">{notice.message}</p>

          {notice.remedies.length > 0 && (
            <ul className="mt-2 space-y-1">
              {notice.remedies.map((remedy, index) => (
                <li key={index} className="text-[13px] text-silver-500 flex gap-2">
                  <span className="text-silver-600 shrink-0">•</span>
                  <span>{remedy}</span>
                </li>
              ))}
            </ul>
          )}

          {notice.detail !== undefined && (
            <details className="mt-3">
              <summary className="text-[11px] uppercase tracking-wider text-silver-600 cursor-pointer hover:text-silver-400">
                Technical detail
              </summary>
              <pre className="selectable mt-2 p-2 rounded bg-ink-950 border border-ink-700 text-[11px] text-silver-500 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                {notice.code}
                {'\n'}
                {notice.detail}
              </pre>
            </details>
          )}

          {(onRetry ?? onDismiss) && (
            <div className="mt-3 flex gap-2">
              {onRetry && notice.retryable && (
                <button type="button" className="btn-secondary h-8 text-[13px]" onClick={onRetry}>
                  Try again
                </button>
              )}
              {onDismiss && (
                <button type="button" className="btn-ghost h-8 text-[13px]" onClick={onDismiss}>
                  Dismiss
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-12">
      <p className="text-sm font-semibold text-silver-300">{title}</p>
      <p className="mt-1.5 text-[13px] text-silver-600 max-w-sm">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center gap-2 text-silver-600 text-[13px]">
      <span className="w-3 h-3 rounded-full border-2 border-ink-600 border-t-signal-500 animate-spin" />
      {label}
    </div>
  );
}

/**
 * Marks a feature that genuinely is not built yet, naming the phase that delivers it.
 * Section 42: no fake buttons. A phase label is more useful than a dead control.
 */
export function NotImplemented({
  feature,
  phase,
  requirement,
  capabilities,
}: {
  feature: string;
  phase: string;
  requirement: string;
  capabilities?: string[];
}): JSX.Element {
  return (
    <div className="h-full overflow-auto p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-3">
          <span className="px-2 py-0.5 rounded text-[10px] font-bold tracking-widest uppercase bg-ink-750 text-silver-500 border border-ink-700">
            Not implemented
          </span>
          <span className="text-[11px] uppercase tracking-wider text-signal-400">{phase}</span>
        </div>

        <h2 className="text-xl font-semibold text-silver-100">{feature}</h2>
        <p className="mt-2 text-sm text-silver-500">{requirement}</p>

        {capabilities && capabilities.length > 0 && (
          <div className="mt-6">
            <p className="field-label">Planned capabilities</p>
            <ul className="space-y-1.5">
              {capabilities.map((capability) => (
                <li key={capability} className="flex gap-2.5 text-[13px] text-silver-500">
                  <span className="text-silver-700 shrink-0">—</span>
                  <span>{capability}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-6 text-[12px] text-silver-700 leading-relaxed">
          This screen is deliberately empty rather than showing controls that do nothing. The
          underlying data model and IPC channels already exist; the feature is wired up in the
          phase named above.
        </p>
      </div>
    </div>
  );
}
