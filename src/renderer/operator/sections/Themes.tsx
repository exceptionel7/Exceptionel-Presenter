/**
 * THEMES — the six built-in themes (Section 16), with live previews.
 *
 * Previews render the actual ThemeSpec against a scaled 1920×1080 canvas, so what is shown
 * here is genuinely what the audience screen will produce, not an illustration.
 */

import type { Theme, ThemeSpec } from '@shared/domain/entities.ts';
import { useQuery } from '@ui/hooks.ts';
import { EmptyState, FailureNotice, Panel, Spinner } from '@ui/primitives.tsx';

/** Same defaults as BASE_THEME_SPEC in the main process, for fields a theme omits. */
const FALLBACK: ThemeSpec = {
  background: { kind: 'solid', value: '#000000' },
  text: {
    fontFamily: 'Inter',
    fontSize: 72,
    fontWeight: 600,
    color: '#FFFFFF',
    align: 'center',
    lineHeight: 1.3,
    letterSpacing: 0,
    shadow: { enabled: true, color: 'rgba(0,0,0,0.7)', blur: 24, offsetY: 4 },
    outline: { enabled: false, color: '#000000', width: 0 },
  },
  padding: { top: 0.1, right: 0.08, bottom: 0.1, left: 0.08 },
  textBox: { enabled: false, color: '#000000', opacity: 0, cornerRadius: 0 },
  transition: { kind: 'fade', durationMs: 250 },
};

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
  const spec = mergePreview(FALLBACK, theme.spec);
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
        <ThemePreview spec={spec} lines={lines} />
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

/**
 * Renders the theme on a 16:9 surface. Font size is expressed as a percentage of the
 * preview height rather than in px, so the preview scales proportionally exactly as the
 * real output does on a different-resolution display.
 */
function ThemePreview({ spec, lines }: { spec: ThemeSpec; lines: string[] }): JSX.Element {
  const CANVAS_HEIGHT = 1080;

  const justify =
    spec.text.align === 'left' ? 'flex-start' : spec.text.align === 'right' ? 'flex-end' : 'center';

  const textShadow = spec.text.shadow.enabled
    ? `0 ${(spec.text.shadow.offsetY / CANVAS_HEIGHT) * 100}cqh ${(spec.text.shadow.blur / CANVAS_HEIGHT) * 100}cqh ${spec.text.shadow.color}`
    : undefined;

  return (
    <div
      className="relative w-full aspect-video rounded overflow-hidden border border-ink-700"
      style={{ containerType: 'size', background: backgroundCss(spec) }}
    >
      {/* Camera-backed themes have no image here; a hatch makes that explicit rather than
          showing a misleading solid colour. */}
      {spec.background.kind === 'camera' && (
        <div className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,#0d1a28_0px,#0d1a28_8px,#0a1421_8px,#0a1421_16px)]">
          <span className="text-[9px] uppercase tracking-[0.2em] text-silver-700">Live camera feed</span>
        </div>
      )}

      <div
        className="absolute inset-0 flex flex-col"
        style={{
          paddingTop: `${spec.padding.top * 100}%`,
          paddingBottom: `${spec.padding.bottom * 100}%`,
          paddingLeft: `${spec.padding.left * 100}%`,
          paddingRight: `${spec.padding.right * 100}%`,
          justifyContent: 'center',
          alignItems: justify,
        }}
      >
        <div
          style={{
            ...(spec.textBox.enabled
              ? {
                  backgroundColor: withOpacity(spec.textBox.color, spec.textBox.opacity),
                  borderRadius: `${(spec.textBox.cornerRadius / CANVAS_HEIGHT) * 100}cqh`,
                  padding: '2cqh 3cqh',
                }
              : {}),
          }}
        >
          {lines.map((line, index) => (
            <div
              key={index}
              style={{
                // cqh = 1% of the container's height, so type scales with the preview.
                fontSize: `${(spec.text.fontSize / CANVAS_HEIGHT) * 100}cqh`,
                fontWeight: spec.text.fontWeight,
                color: spec.text.color,
                textAlign: spec.text.align,
                lineHeight: spec.text.lineHeight,
                letterSpacing: `${spec.text.letterSpacing}em`,
                fontFamily: spec.text.fontFamily,
                ...(textShadow ? { textShadow } : {}),
                ...(spec.text.outline.enabled
                  ? { WebkitTextStroke: `${(spec.text.outline.width / CANVAS_HEIGHT) * 100}cqh ${spec.text.outline.color}` }
                  : {}),
              }}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
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

function backgroundCss(spec: ThemeSpec): string {
  switch (spec.background.kind) {
    case 'gradient':
      return spec.background.value;
    case 'solid':
      return spec.background.value;
    case 'camera':
      return '#0A1421';
    case 'image':
    case 'video':
      return '#050B14';
  }
}

function describeBackground(spec: ThemeSpec): string {
  return spec.background.kind === 'solid' ? spec.background.value : spec.background.kind;
}

/** Applies an opacity to a hex colour for the scrim box. */
function withOpacity(hex: string, opacity: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const value = parseInt(match[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** Field-level merge, matching mergeSpec in the main process. */
function mergePreview(base: ThemeSpec, override: Partial<ThemeSpec>): ThemeSpec {
  return {
    background: { ...base.background, ...(override.background ?? {}) },
    text: {
      ...base.text,
      ...(override.text ?? {}),
      shadow: { ...base.text.shadow, ...(override.text?.shadow ?? {}) },
      outline: { ...base.text.outline, ...(override.text?.outline ?? {}) },
    },
    padding: { ...base.padding, ...(override.padding ?? {}) },
    textBox: { ...base.textBox, ...(override.textBox ?? {}) },
    transition: { ...base.transition, ...(override.transition ?? {}) },
  };
}
