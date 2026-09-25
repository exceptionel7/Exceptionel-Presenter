/**
 * EXCEPTIONEL PRESENTER — renderer bootstrap with a visible failure path.
 *
 * A blank window is the worst failure mode this application has: the operator cannot tell a
 * crashed renderer from a working-but-empty one, and during a service they have no way to
 * know whether to restart. So if React cannot mount, the error is PAINTED INTO THE PAGE
 * using plain DOM — no React, no Tailwind, no imports that could themselves be broken.
 *
 * `audienceSafe` suppresses that for the audience output window: showing a stack trace on
 * the projector would be far worse than showing black.
 */

import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export interface BootstrapOptions {
  /** Which window this is, for log prefixes. */
  role: string;
  /**
   * True for the audience output. Failures stay black and silent on screen; they are still
   * reported to the console, which main forwards to the terminal.
   */
  audienceSafe?: boolean;
  /**
   * React StrictMode double-invokes effects, which would open camera streams and restart
   * video playback twice. Safe for the operator UI, not for output windows.
   */
  strict?: boolean;
}

export function bootstrap(node: ReactNode, options: BootstrapOptions): void {
  const { role, audienceSafe = false, strict = false } = options;

  const container = document.getElementById('root');
  if (!container) {
    reportFatal(new Error('#root is missing from index.html'), role, audienceSafe, null);
    return;
  }

  // Catches module-evaluation and async errors that an error boundary cannot see.
  window.addEventListener('error', (event) => {
    console.error(`[${role}] uncaught error:`, event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error(`[${role}] unhandled rejection:`, event.reason);
  });

  try {
    const tree = (
      <RootErrorBoundary role={role} audienceSafe={audienceSafe}>
        {node}
      </RootErrorBoundary>
    );
    createRoot(container).render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  } catch (error) {
    reportFatal(error, role, audienceSafe, container);
  }
}

interface BoundaryProps {
  role: string;
  audienceSafe: boolean;
  children: ReactNode;
}

class RootErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.role}] render failed:`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    // The audience screen stays black. A stack trace on the projector is worse than nothing.
    if (this.props.audienceSafe) {
      return <div style={{ position: 'fixed', inset: 0, background: '#000' }} />;
    }

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          overflow: 'auto',
          padding: 32,
          background: '#0A1421',
          color: '#D8E1EC',
          font: "13px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ maxWidth: 760 }}>
          <p style={{ color: '#FF2D46', fontWeight: 700, letterSpacing: '0.14em', fontSize: 11 }}>
            INTERFACE ERROR
          </p>
          <h1 style={{ fontSize: 20, margin: '8px 0 4px', color: '#FFF' }}>
            The operator interface could not be displayed.
          </h1>
          <p style={{ color: '#6E8299', margin: '0 0 20px' }}>
            Your library is unaffected — nothing has been saved or changed by this error.
          </p>
          <pre
            style={{
              userSelect: 'text',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#060D16',
              border: '1px solid #1F3348',
              borderRadius: 6,
              padding: 12,
              fontSize: 12,
              color: '#94A5BA',
            }}
          >
            {error.name}: {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </pre>
          <p style={{ color: '#6E8299', marginTop: 20 }}>
            Restart Exceptionel Presenter. If this repeats, copy the text above into a report.
          </p>
        </div>
      </div>
    );
  }
}

/**
 * Last resort: React itself could not start, so the message is built with raw DOM.
 * Uses textContent rather than innerHTML so an error message can never inject markup.
 */
function reportFatal(
  error: unknown,
  role: string,
  audienceSafe: boolean,
  container: HTMLElement | null,
): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  console.error(`[${role}] failed to start:`, error);

  const target = container ?? document.body;
  target.textContent = '';

  if (audienceSafe) {
    target.setAttribute('style', 'position:fixed;inset:0;background:#000');
    return;
  }

  const wrap = document.createElement('div');
  wrap.setAttribute(
    'style',
    "position:fixed;inset:0;padding:32px;overflow:auto;background:#0A1421;color:#D8E1EC;font:13px/1.6 system-ui,sans-serif",
  );

  const heading = document.createElement('h1');
  heading.setAttribute('style', 'font-size:20px;color:#fff;margin:0 0 8px');
  heading.textContent = 'Exceptionel Presenter could not start its interface.';

  const detail = document.createElement('pre');
  detail.setAttribute(
    'style',
    'user-select:text;white-space:pre-wrap;word-break:break-word;background:#060D16;border:1px solid #1F3348;border-radius:6px;padding:12px;font-size:12px;color:#94A5BA',
  );
  detail.textContent = stack ? `${message}\n\n${stack}` : message;

  wrap.append(heading, detail);
  target.append(wrap);
}
