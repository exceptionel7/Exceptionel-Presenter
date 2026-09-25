/**
 * EXCEPTIONEL PRESENTER — window role negotiation for the preload script.
 *
 * There is ONE preload bundle rather than three, because a sandboxed preload cannot
 * `require()` a local file. With three entry points Rollup code-splits their shared code
 * into `chunks/bridge-*.cjs`, each entry becomes a stub that requires that chunk, and the
 * require fails — leaving `window.exceptionel` undefined with no obvious cause.
 *
 * So main tells the single preload which role it is serving, via
 * `webPreferences.additionalArguments`. That value is set per-window by the main process and
 * is not reachable from page JavaScript.
 *
 * Dependency-free so the parser can be unit-tested without Electron.
 */

export const WINDOW_ROLES = ['operator', 'output', 'confidence'] as const;
export type PreloadRole = (typeof WINDOW_ROLES)[number];

export const ROLE_ARG_PREFIX = '--exceptionel-role=';

/**
 * The role assumed when the argument is missing, malformed, or unrecognised.
 *
 * FAIL CLOSED: 'output' is the most restricted surface (read-only, no mutating channel).
 * Defaulting to 'operator' would mean a bug in argument passing silently handed a window
 * the full IPC contract — exactly backwards.
 */
export const FALLBACK_ROLE: PreloadRole = 'output';

export const roleArgument = (role: PreloadRole): string => `${ROLE_ARG_PREFIX}${role}`;

export function parsePreloadRole(argv: readonly string[]): PreloadRole {
  // Last occurrence wins, so a later explicit argument overrides an earlier one rather than
  // the reverse.
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (typeof arg !== 'string' || !arg.startsWith(ROLE_ARG_PREFIX)) continue;
    const value = arg.slice(ROLE_ARG_PREFIX.length);
    if ((WINDOW_ROLES as readonly string[]).includes(value)) return value as PreloadRole;
    // A recognised prefix with an unknown value is a bug, not a request for more access.
    return FALLBACK_ROLE;
  }
  return FALLBACK_ROLE;
}
