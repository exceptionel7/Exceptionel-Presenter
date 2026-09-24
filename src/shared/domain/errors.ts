/**
 * EXCEPTIONEL PRESENTER — structured failures.
 *
 * Section 39 of the brief: never silently fail, and never show a bare "Camera
 * unavailable." A failure carries a machine-readable `reason` so the UI can render the
 * specific troubleshooting steps for *that* cause, and `detail` for the log.
 */

export type ErrorDomain =
  | 'database'
  | 'camera'
  | 'display'
  | 'media'
  | 'bible'
  | 'filesystem'
  | 'validation'
  | 'cloud'
  | 'internal';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface AppFailure {
  domain: ErrorDomain;
  /** Stable machine code, e.g. 'camera/permission-denied'. Drives the UI copy. */
  code: string;
  /** One-line human summary. Shown as the headline. */
  message: string;
  /** Ordered, actionable troubleshooting steps. Shown as a list beneath the headline. */
  remedies: string[];
  severity: ErrorSeverity;
  /** Technical context for logs and bug reports. Never shown by default. */
  detail?: string;
  /** True when retrying the identical operation could plausibly succeed. */
  retryable: boolean;
}

export interface ErrorNotice extends AppFailure {
  id: string;
  occurredAt: string;
}

export function failure(
  init: Omit<AppFailure, 'severity' | 'retryable' | 'remedies'> &
    Partial<Pick<AppFailure, 'severity' | 'retryable' | 'remedies'>>,
): AppFailure {
  return {
    severity: 'error',
    retryable: false,
    remedies: [],
    ...init,
  };
}

/**
 * Camera failures, Section 39. Each cause gets its own remedies because the fixes are
 * genuinely different — "grant permission" is useless advice when the real problem is
 * that OBS already holds the device.
 */
export const CameraFailures = {
  permissionDenied: (detail?: string): AppFailure =>
    failure({
      domain: 'camera',
      code: 'camera/permission-denied',
      message: 'Camera unavailable — permission denied.',
      remedies: [
        'On macOS: System Settings → Privacy & Security → Camera, enable Exceptionel Presenter.',
        'On Windows: Settings → Privacy & security → Camera, allow desktop apps to access your camera.',
        'Restart Exceptionel Presenter after changing the permission.',
      ],
      retryable: true,
      ...(detail === undefined ? {} : { detail }),
    }),

  inUse: (deviceLabel?: string): AppFailure =>
    failure({
      domain: 'camera',
      code: 'camera/in-use',
      message: `Camera unavailable — ${deviceLabel ?? 'the device'} is already in use.`,
      remedies: [
        'Close other software using the camera (OBS, Zoom, Teams, Skype, browser tabs).',
        'Some capture cards allow only one application at a time.',
        'Unplug and reconnect the device if no other application appears to hold it.',
      ],
      retryable: true,
    }),

  disconnected: (deviceLabel?: string): AppFailure =>
    failure({
      domain: 'camera',
      code: 'camera/disconnected',
      message: `Camera unavailable — ${deviceLabel ?? 'the device'} is disconnected.`,
      remedies: [
        'Check the USB or HDMI cable at both ends.',
        'Try a different USB port — prefer a port directly on the computer over a hub.',
        'Confirm the camera is powered on.',
      ],
      retryable: true,
    }),

  noDevices: (): AppFailure =>
    failure({
      domain: 'camera',
      code: 'camera/no-devices',
      message: 'No cameras detected on this computer.',
      remedies: [
        'Connect a USB camera or capture device.',
        'Confirm the device appears in your operating system settings.',
        'Install the manufacturer driver for capture cards.',
      ],
      retryable: true,
      severity: 'warning',
    }),

  providerNotImplemented: (provider: string, requirement: string): AppFailure =>
    failure({
      domain: 'camera',
      code: 'camera/provider-not-implemented',
      message: `${provider} support is NOT IMPLEMENTED in this version.`,
      remedies: [requirement],
      severity: 'info',
    }),
} as const;

/** Display failures, Section 39 + Section 22. */
export const DisplayFailures = {
  outputDisplayLost: (label: string): AppFailure =>
    failure({
      domain: 'display',
      code: 'display/output-lost',
      message: `The presentation display "${label}" was disconnected.`,
      remedies: [
        'Presentation output has been parked — it was NOT moved onto your operator screen.',
        'Reconnect the display or projector, then reassign it in Outputs.',
        'Check the HDMI/DisplayPort cable and that the projector is powered on.',
      ],
      severity: 'warning',
      retryable: true,
    }),

  noSecondaryDisplay: (): AppFailure =>
    failure({
      domain: 'display',
      code: 'display/no-secondary',
      message: 'Only one display detected — there is nowhere to send the audience output.',
      remedies: [
        'Connect a second monitor or projector.',
        'If a display is connected, set it to Extend rather than Mirror in your OS display settings.',
        'You can still rehearse using Test Mode in a window.',
      ],
      severity: 'warning',
      retryable: true,
    }),
} as const;

/** Database failures — these are the ones that can cost a church its library. */
export const DatabaseFailures = {
  schemaNewerThanApp: (dbVersion: number, appVersion: number): AppFailure =>
    failure({
      domain: 'database',
      code: 'database/schema-newer-than-app',
      message: 'This library was created by a newer version of Exceptionel Presenter.',
      remedies: [
        `The library is at schema version ${dbVersion}; this app understands up to ${appVersion}.`,
        'Update Exceptionel Presenter to open this library.',
        'Your data has NOT been modified.',
      ],
      severity: 'fatal',
      detail: `db=${dbVersion} app=${appVersion}`,
    }),

  migrationFailed: (version: number, detail: string): AppFailure =>
    failure({
      domain: 'database',
      code: 'database/migration-failed',
      message: `Database migration ${version} failed. Your data was rolled back and is unchanged.`,
      remedies: [
        'The migration ran inside a transaction, so the library is still at its previous version.',
        'Restore from Settings → Backup if the problem persists.',
        'Send the technical detail below to support.',
      ],
      severity: 'fatal',
      detail,
    }),

  sqliteUnavailable: (detail: string): AppFailure =>
    failure({
      domain: 'database',
      code: 'database/sqlite-unavailable',
      message: 'No SQLite engine is available in this runtime.',
      remedies: [
        'Exceptionel Presenter requires Electron 37 or newer, which bundles node:sqlite.',
        'Reinstall the application, or run `npm install` and rebuild if running from source.',
      ],
      severity: 'fatal',
      detail,
    }),
} as const;
