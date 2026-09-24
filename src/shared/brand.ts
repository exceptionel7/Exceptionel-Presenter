/**
 * EXCEPTIONEL PRESENTER — brand tokens.
 *
 * Sampled from the supplied logo: a deep navy ground, a metallic silver wordmark and
 * "C" mark, and a cyan→blue gradient play triangle.
 *
 * These are the single source of truth. tailwind.config.ts consumes them, so the UI
 * and the logo can never drift apart.
 */

export const BRAND = {
  name: 'Exceptionel Presenter',
  shortName: 'Exceptionel',
  tagline: 'Present Worship. Share the Word. Inspire the Room.',
} as const;

/**
 * Ink: the navy field the logo sits on, extended into a working UI ramp.
 * 950 is the logo background; lower numbers step up toward panel surfaces.
 */
export const INK = {
  950: '#060D16', // deepest — audience-adjacent surfaces, letterboxing
  900: '#0A1421', // logo background
  850: '#0E1A29', // app chrome
  800: '#132132', // panel
  750: '#18293D', // raised panel
  700: '#1F3348', // border / divider
  600: '#2C4460', // hover border
  500: '#425B78', // muted stroke
} as const;

/**
 * Silver: the metallic wordmark ramp. Used for text and the logo mark gradient.
 */
export const SILVER = {
  100: '#FFFFFF',
  200: '#EEF3F9',
  300: '#D8E1EC',
  400: '#B9C6D6',
  500: '#94A5BA', // secondary text
  600: '#6E8299', // tertiary text
} as const;

/**
 * Signal blue: the play triangle. Reserved for brand accent and interactive
 * affordances — NEVER for status. Status colours below are separate so an operator
 * can never confuse "this is a button" with "this is live".
 */
export const SIGNAL = {
  300: '#5CC2FF',
  400: '#2BA3F7', // triangle highlight
  500: '#1E8FEF',
  600: '#1F5FE8', // triangle shadow
  700: '#1A4BC4',
} as const;

/**
 * Status palette. In a dark room mid-service these must be unmistakable at a glance
 * and distinguishable for the most common colour-vision deficiencies — which is why
 * LIVE is red, output-ready is amber, and healthy is green rather than blue.
 */
export const STATUS = {
  live: '#FF2D46', // broadcasting to the audience RIGHT NOW
  liveGlow: 'rgba(255, 45, 70, 0.45)',
  ready: '#FFB020', // armed / configured but not live
  ok: '#22C55E', // connected, healthy
  idle: '#6E8299', // nothing happening
  black: '#000000', // true black for the audience screen — not a near-black
  error: '#F43F5E',
} as const;

/** The logo's play-triangle gradient, reused for primary actions and the mark. */
export const GRADIENT = {
  signal: `linear-gradient(135deg, ${SIGNAL[400]} 0%, ${SIGNAL[600]} 100%)`,
  silver: `linear-gradient(160deg, ${SILVER[100]} 0%, ${SILVER[300]} 45%, ${SILVER[500]} 100%)`,
  panel: `linear-gradient(180deg, ${INK[800]} 0%, ${INK[850]} 100%)`,
} as const;

/**
 * Type scale. Operator UI runs dense and small; audience output is driven by themes
 * instead, so nothing here applies to the presentation renderer.
 */
export const TYPE = {
  ui: "'Inter var', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Tabular figures — timers and timecode must not jitter as digits change. */
  mono: "'JetBrains Mono', 'SF Mono', 'Cascadia Mono', ui-monospace, monospace",
} as const;
