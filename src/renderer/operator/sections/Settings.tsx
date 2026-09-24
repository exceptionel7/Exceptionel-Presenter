/**
 * SETTINGS (Section 37).
 *
 * Panes for features that do not exist yet are shown but clearly marked, so the operator can
 * see the intended shape of the application without encountering controls that do nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ShortcutBinding } from '@shared/domain/entities.ts';
import { client } from '@ui/client.ts';
import { useMutation, useQuery } from '@ui/hooks.ts';
import { FailureNotice, Panel, Spinner, StatusDot } from '@ui/primitives.tsx';

type PaneId =
  | 'general'
  | 'appearance'
  | 'shortcuts'
  | 'displays'
  | 'cameras'
  | 'bible'
  | 'cloud'
  | 'advanced';

const PANES: { id: PaneId; label: string; available: boolean; phase?: string }[] = [
  { id: 'general', label: 'General', available: true },
  { id: 'appearance', label: 'Appearance', available: true },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', available: true },
  { id: 'advanced', label: 'Advanced', available: true },
  { id: 'displays', label: 'Displays', available: false, phase: 'Phase 7' },
  { id: 'cameras', label: 'Cameras', available: false, phase: 'Phase 6' },
  { id: 'bible', label: 'Bible', available: false, phase: 'Phase 4' },
  { id: 'cloud', label: 'Cloud', available: false, phase: 'Phase 9' },
];

export function SettingsSection(): JSX.Element {
  const [pane, setPane] = useState<PaneId>('general');

  return (
    <div className="h-full flex min-h-0">
      <nav className="w-48 shrink-0 border-r border-ink-700 py-3 px-2 overflow-y-auto">
        <ul className="space-y-0.5">
          {PANES.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setPane(item.id)}
                className={`nav-item w-full text-left ${pane === item.id ? 'nav-item-active' : ''}`}
              >
                <span className="flex-1 truncate">{item.label}</span>
                {!item.available && <span className="w-1.5 h-1.5 rounded-full bg-ink-600" title={item.phase} />}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex-1 min-w-0 overflow-auto p-5">
        <div className="max-w-2xl space-y-4">
          {pane === 'general' && <GeneralPane />}
          {pane === 'appearance' && <AppearancePane />}
          {pane === 'shortcuts' && <ShortcutsPane />}
          {pane === 'advanced' && <AdvancedPane />}
          {!PANES.find((item) => item.id === pane)?.available && (
            <PendingPane label={PANES.find((item) => item.id === pane)!.label} pane={pane} />
          )}
        </div>
      </div>
    </div>
  );
}

function GeneralPane(): JSX.Element {
  const profile = useQuery('profile:get');
  const save = useMutation('profile:save');

  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!profile.data) {
      // Sensible defaults for a first run: the OS already knows the timezone.
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
      return;
    }
    setName(profile.data.name);
    setTimezone(profile.data.timezone);
  }, [profile.data]);

  const commit = async (): Promise<void> => {
    const saved = await save.run({ name, timezone });
    if (saved) {
      setDirty(false);
      profile.reload();
    }
  };

  if (profile.loading) return <Spinner />;

  return (
    <Panel title="Church profile">
      <div className="p-4 space-y-3">
        <label className="block">
          <span className="field-label">Church name</span>
          <input
            className="field"
            value={name}
            placeholder="Grace Chapel"
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
          />
        </label>

        <label className="block">
          <span className="field-label">Timezone</span>
          <input
            className="field"
            value={timezone}
            placeholder="America/New_York"
            onChange={(event) => {
              setTimezone(event.target.value);
              setDirty(true);
            }}
          />
          <span className="mt-1 block text-[11px] text-silver-700">
            Used for service dates and timers. Detected from your system on first run.
          </span>
        </label>

        {save.failure && <FailureNotice notice={save.failure} />}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || name.trim() === '' || save.pending}
            onClick={() => void commit()}
          >
            {save.pending ? 'Saving…' : 'Save profile'}
          </button>
          {profile.data?.onboardingCompleted === false && (
            <span className="text-[11px] text-silver-600">
              Setup wizard arrives in Phase 9 — this is all that is needed for now.
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}

function AppearancePane(): JSX.Element {
  const settings = useQuery('settings:getAll');
  const set = useMutation('settings:set');

  const update = async (key: string, value: unknown): Promise<void> => {
    await set.run({ key, value });
    settings.reload();
  };

  if (settings.loading) return <Spinner />;
  const values = settings.data ?? {};

  return (
    <>
      <Panel title="Interface">
        <div className="p-4 space-y-4">
          <div>
            <p className="field-label">Theme</p>
            <p className="text-[13px] text-silver-400">
              Dark interface only. A light theme is not planned: production software is used in
              darkened rooms, where a bright operator screen spills onto the stage and ruins the
              operator's own night vision.
            </p>
          </div>

          <Toggle
            label="Black the audience screen on startup"
            description="Recommended. Prevents a stale slide appearing before the service begins."
            checked={values['presentation.blackOnStartup'] === true}
            onChange={(next) => void update('presentation.blackOnStartup', next)}
          />
        </div>
      </Panel>

      <Panel title="Autosave">
        <div className="p-4">
          <label className="block">
            <span className="field-label">Debounce (milliseconds)</span>
            <input
              type="number"
              className="field w-40"
              min={100}
              max={5000}
              step={100}
              value={String(values['autosave.debounceMs'] ?? 400)}
              onChange={(event) => void update('autosave.debounceMs', Number(event.target.value))}
            />
            <span className="mt-1 block text-[11px] text-silver-700">
              How long to wait after you stop typing before writing to disk. A crash costs at most
              this much work.
            </span>
          </label>
        </div>
      </Panel>
    </>
  );
}

function ShortcutsPane(): JSX.Element {
  const shortcuts = useQuery('shortcuts:list');
  const reset = useMutation('shortcuts:resetDefaults');

  if (shortcuts.loading) return <Spinner />;

  return (
    <Panel
      title="Keyboard shortcuts"
      actions={
        <button
          type="button"
          className="btn-ghost h-7 text-[12px]"
          onClick={async () => {
            await reset.run();
            shortcuts.reload();
          }}
        >
          Restore defaults
        </button>
      }
    >
      <div className="p-4">
        <p className="text-[12px] text-silver-600 mb-3">
          Shortcuts are stored in the database, so rebinding needs no code change. The editor for
          custom bindings arrives in Phase 9; the defaults below are active now.
        </p>
        <ul className="divide-y divide-ink-700">
          {(shortcuts.data ?? []).map((binding: ShortcutBinding) => (
            <li key={binding.action} className="flex items-center justify-between py-2">
              <span className="flex items-center gap-2 text-[13px]">
                <StatusDot tone={binding.enabled ? 'ok' : 'idle'} />
                <span className={binding.enabled ? 'text-silver-300' : 'text-silver-700 line-through'}>
                  {describeAction(binding.action)}
                </span>
              </span>
              <kbd className="px-2 py-0.5 rounded bg-ink-950 border border-ink-700 text-[11px] font-mono text-silver-400">
                {binding.accelerator}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function AdvancedPane(): JSX.Element {
  const info = useQuery('app:info');
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!info.data) return;
    await navigator.clipboard.writeText(JSON.stringify(info.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [info.data]);

  if (info.loading) return <Spinner />;
  if (!info.data) return <FailureNotice notice={info.failure!} onRetry={info.reload} />;

  const rows: [string, string][] = [
    ['Version', info.data.version],
    ['Schema version', String(info.data.schemaVersion)],
    ['SQLite engine', info.data.sqliteEngine],
    ['Electron', info.data.electronVersion],
    ['Chromium', info.data.chromeVersion],
    ['Node', info.data.nodeVersion],
    ['Platform', info.data.platform],
    ['Packaged', info.data.isPackaged ? 'yes' : 'no (development)'],
    ['Library location', info.data.userDataPath],
  ];

  return (
    <>
      <Panel
        title="Diagnostics"
        actions={
          <button type="button" className="btn-ghost h-7 text-[12px]" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy for support'}
          </button>
        }
      >
        <dl className="p-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[12px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-silver-600">{label}</dt>
              <dd className="text-silver-300 selectable break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <Panel title="Data">
        <div className="p-4 space-y-2 text-[12px] text-silver-500">
          <p>
            Your library is a single SQLite file in the location above. It contains every song,
            service, theme and setting. Copy that file to back everything up.
          </p>
          <p>
            Write-ahead logging is enabled, so the file is checkpointed when the application closes
            cleanly. Copy it while the app is closed to be certain the backup is complete.
          </p>
          <p className="text-silver-700">Backup and restore tooling arrives in Phase 9.</p>
        </div>
      </Panel>
    </>
  );
}

function PendingPane({ label, pane }: { label: string; pane: PaneId }): JSX.Element {
  const notes: Partial<Record<PaneId, string>> = {
    displays:
      "Monitor and projector assignment, with per-display roles. Electron's screen API does not report refresh rate, so that value will be shown as unavailable rather than guessed.",
    cameras:
      'Camera selection, resolution and framerate, plus named profiles. Streams are opened locally and never uploaded.',
    bible:
      'Translation installation and the default translation. No scripture text is bundled — translations must come from properly licensed or public-domain packages.',
    cloud:
      'Optional account sign-in and synchronisation. Camera video will never be routed through the cloud, and the application will keep working fully offline.',
  };

  return (
    <Panel title={label}>
      <div className="p-4">
        <span className="inline-block mb-2 px-2 py-0.5 rounded text-[10px] font-bold tracking-widest uppercase bg-ink-750 text-silver-500 border border-ink-700">
          Not implemented
        </span>
        <p className="text-[13px] text-silver-500">{notes[pane]}</p>
      </div>
    </Panel>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        className="mt-0.5 accent-signal-500"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-[13px] text-silver-300">{label}</span>
        {description !== undefined && (
          <span className="block text-[11px] text-silver-600 mt-0.5">{description}</span>
        )}
      </span>
    </label>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'live.previous': 'Previous slide',
  'live.next': 'Next slide',
  'live.nextAlt': 'Next slide (alternate)',
  'live.black': 'Black the audience screen',
  'live.clear': 'Clear text (keep background)',
  'live.fullscreen': 'Fullscreen output',
  'live.exitFullscreen': 'Exit fullscreen',
  'live.stop': 'Stop presenting',
  'camera.select1': 'Switch to camera 1',
  'camera.select2': 'Switch to camera 2',
  'camera.select3': 'Switch to camera 3',
  'service.save': 'Save service',
  'service.new': 'New service',
  'search.focus': 'Focus search',
  'output.toggle': 'Toggle presentation output',
};

const describeAction = (action: string): string => ACTION_LABELS[action] ?? action;
