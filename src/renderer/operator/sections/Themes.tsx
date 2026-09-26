/**
 * THEMES — the six built-in themes (Section 16), with live previews.
 *
 * Previews render the actual ThemeSpec against a scaled 1920×1080 canvas, so what is shown
 * here is genuinely what the audience screen will produce, not an illustration.
 */

import type { Theme } from '@shared/domain/entities.ts';
import { BASE_THEME_SPEC, describeBackground, mergeSpec } from '@shared/domain/theme.ts';
import { useQuery } from '@ui/hooks.ts';
import { EmptyState, FailureNotice, Panel, Spinner } from '@ui/primitives.tsx';
import { SlideCanvas } from '@ui/SlideCanvas.tsx';

const SAMPLE: Record<string, string[]> = {
  'theme-scripture': ['For God so loved the world,', 'that he gave his only Son…'],
  'theme-sermon': ['Three marks of a', 'generous heart'],
  'theme-announcement': ['YOUTH NIGHT', 'Friday at 7:00 PM'],
  default: ['Way maker', 'Miracle worker'],
};

export function ThemesSection(): JSX.Element {
  const themes = useQuery('themes:list');

  if (themes.loading) return <Spinner label="Loading themes" />;
  if (themes.failure) {
    return (
      <div className="p-5 max-w-2xl">
        <FailureNotice notice={themes.failure} onRetry={themes.reload} />
      </div>
    );
  }
  if ((themes.data?.length ?? 0) === 0) {
    return <EmptyState title="No themes" description="The built-in themes should have been seeded on first run." />;
  }

  return (
    <div className="h-full overflow-auto p-5">
      <div className="max-w-6xl mx-auto">
        <p className="text-[13px] text-silver-600 mb-4 max-w-2xl">
          Each preview renders the theme's real specification on a scaled 1920×1080 canvas, so it
          matches what the audience display will show. Built-in themes are read-only; custom themes
          inherit from them and override only the fields they change — the theme editor arrives in
          Phase 9.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {themes.data?.map((theme) => (
            <ThemeCard key={theme.id} theme={theme} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ThemeCard({ theme }: { theme: Theme }): JSX.Element {
  const spec = mergeSpec(BASE_THEME_SPEC, theme.spec);
  const lines = SAMPLE[theme.id] ?? SAMPLE['default']!;

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
          <Row label="Font size" value={`${spec.text.fontSize}pt`} />
          <Row label="Weight" value={String(spec.text.fontWeight)} />
          <Row label="Align" value={spec.text.align} />
          <Row label="Transition" value={`${spec.transition.kind} ${spec.transition.durationMs}ms`} />
          <Row
            label="Legibility"
            value={[
              spec.text.shadow.enabled ? 'shadow' : null,
              spec.text.outline.enabled ? 'outline' : null,
              spec.textBox.enabled ? 'scrim' : null,
            ]
              .filter(Boolean)
              .join(', ') || 'none'}
          />
        </dl>
      </div>
    </Panel>
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
