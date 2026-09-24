/**
 * HELP — keyboard reference and an honest account of what this build does.
 */

import { BRAND } from '@shared/brand.ts';
import { useQuery } from '@ui/hooks.ts';
import { LogoMark } from '@ui/Logo.tsx';
import { Panel } from '@ui/primitives.tsx';
import { SECTIONS } from '../navigation.ts';

export function HelpSection(): JSX.Element {
  const shortcuts = useQuery('shortcuts:list');
  const info = useQuery('app:info');

  const working = SECTIONS.filter((section) => section.available);
  const pending = SECTIONS.filter((section) => !section.available);

  return (
    <div className="h-full overflow-auto p-5">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-4">
          <LogoMark size={40} />
          <div>
            <h1 className="text-lg font-semibold text-silver-100">{BRAND.name}</h1>
            <p className="text-[13px] text-silver-600">{BRAND.tagline}</p>
          </div>
        </div>

        <Panel title="Keyboard shortcuts">
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5">
            {(shortcuts.data ?? []).map((binding) => (
              <div key={binding.action} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="text-silver-500 truncate">{binding.action}</span>
                <kbd className="px-1.5 py-0.5 rounded bg-ink-950 border border-ink-700 font-mono text-[11px] text-silver-400 shrink-0">
                  {binding.accelerator}
                </kbd>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={`What works in this build (${working.length} of ${SECTIONS.length} sections)`}>
          <div className="p-4 text-[13px] space-y-3">
            <div>
              <p className="field-label">Working now</p>
              <p className="text-silver-400">{working.map((section) => section.label).join(' · ')}</p>
            </div>
            <div>
              <p className="field-label">Not implemented yet</p>
              <ul className="space-y-1">
                {pending.map((section) => (
                  <li key={section.id} className="text-silver-600">
                    <span className="text-silver-400">{section.label}</span> — {section.phase}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Panel>

        <Panel title="Black and Clear are different">
          <div className="p-4 text-[13px] text-silver-500 space-y-2">
            <p>
              <kbd className="px-1.5 rounded bg-ink-950 border border-ink-700 font-mono text-[11px]">B</kbd>{' '}
              <span className="text-silver-300">Black</span> — the audience screen goes completely
              black. Pressing it again returns to the exact slide you left.
            </p>
            <p>
              <kbd className="px-1.5 rounded bg-ink-950 border border-ink-700 font-mono text-[11px]">C</kbd>{' '}
              <span className="text-silver-300">Clear</span> — hides only the text. A camera feed or
              background video keeps playing. Use this to take lyrics off a live shot without cutting
              to black.
            </p>
          </div>
        </Panel>

        {info.data && (
          <Panel title="About this build">
            <div className="p-4 text-[12px] text-silver-600 space-y-2">
              <p>
                Version {info.data.version}, schema {info.data.schemaVersion},{' '}
                {info.data.isPackaged ? 'packaged' : 'development build'}.
              </p>
              <p>
                Your library lives at{' '}
                <span className="selectable text-silver-400 break-all">{info.data.userDataPath}</span>.
              </p>
              <p>
                No Bible translations are bundled with this application. Scripture text must be
                installed from a properly licensed or public-domain source, and the licence terms are
                recorded alongside it.
              </p>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
