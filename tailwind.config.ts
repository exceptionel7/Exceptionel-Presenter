import type { Config } from 'tailwindcss';
import { INK, SILVER, SIGNAL, STATUS, TYPE } from './src/shared/brand.ts';

/**
 * Tailwind consumes src/shared/brand.ts directly, so the palette cannot drift from the
 * logo. Add colours there, not here.
 */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: INK,
        silver: SILVER,
        signal: SIGNAL,
        status: STATUS,
      },
      fontFamily: {
        sans: [TYPE.ui],
        mono: [TYPE.mono],
      },
      boxShadow: {
        /** The red halo on an armed LIVE button — visible in peripheral vision. */
        live: `0 0 0 1px ${STATUS.live}, 0 0 20px ${STATUS.liveGlow}`,
        panel: '0 1px 0 0 rgba(255,255,255,0.04), 0 8px 24px -12px rgba(0,0,0,0.7)',
        glass: 'inset 0 1px 0 0 rgba(255,255,255,0.06)',
      },
      backgroundImage: {
        'gradient-signal': `linear-gradient(135deg, ${SIGNAL[400]} 0%, ${SIGNAL[600]} 100%)`,
        'gradient-silver': `linear-gradient(160deg, ${SILVER[100]} 0%, ${SILVER[300]} 45%, ${SILVER[500]} 100%)`,
        'gradient-panel': `linear-gradient(180deg, ${INK[800]} 0%, ${INK[850]} 100%)`,
      },
      transitionDuration: {
        /** House limit. Operator UI must never feel like it lags a keypress. */
        snap: '120ms',
      },
      keyframes: {
        'live-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        'live-pulse': 'live-pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
