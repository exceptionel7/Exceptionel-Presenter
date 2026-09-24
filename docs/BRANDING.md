# Branding — Exceptionel Presenter

## Source of truth

`src/shared/brand.ts` holds every colour and type token, sampled from the supplied logo.
`tailwind.config.ts` imports that file directly, so the palette cannot drift from the
brand. **Add or change colours there, never in the Tailwind config or in components.**

| Token | Value | Role |
|---|---|---|
| `ink.900` | `#0A1421` | the logo's navy ground; app background |
| `silver.100–600` | `#FFFFFF → #6E8299` | metallic wordmark ramp; all UI text |
| `signal.400 → signal.600` | `#2BA3F7 → #1F5FE8` | the play-triangle gradient; brand accent + interactive |
| `status.live` | `#FF2D46` | broadcasting to the audience **now** |
| `status.ready` | `#FFB020` | armed / configured, not live |
| `status.ok` | `#22C55E` | connected, healthy |
| `status.black` | `#000000` | true black for the audience screen |

### One rule worth stating plainly

**Signal blue is never used for status.** It is the brand accent and marks things you can
click. Live state is red, armed is amber, healthy is green. An operator in a dark room
must never have to ask whether a blue glow means "this is a button" or "this is on air".

## Assets

| File | Status | Purpose |
|---|---|---|
| `resources/logo-mark.svg` | present | vector recreation of the C + play mark, for in-app UI (title bar, splash, onboarding) |
| `resources/icon.png` | **YOU MUST ADD THIS** | 1024×1024 PNG of your original logo. `electron-builder` generates all Windows `.ico` and macOS `.icns` sizes from it. |

### Why `icon.png` isn't here

I can write text files, not binary ones, so I could not save the raster logo you
attached. Export it at **1024×1024 PNG** and drop it at `resources/icon.png` before
running `npm run dist`. Until then, installer builds will fall back to the default
Electron icon — `electron-builder` will warn, and that warning is correct rather than a
bug.

The SVG is a faithful *recreation* for UI use, not a trace of your file. If your original
has gradient stops or geometry I approximated differently, replace
`resources/logo-mark.svg` with a real export from your design tool and the UI will pick
it up unchanged.

## Typography

- UI: **Inter** (`TYPE.ui`), falling back to system UI fonts.
- Timers/timecode: **JetBrains Mono** (`TYPE.mono`) — chosen for tabular figures so a
  running clock doesn't visibly jitter as digits change width.
- Neither font is bundled yet (no network in the build sandbox). The fallback chain is
  system-safe, so nothing breaks; bundling is a Phase 9 polish item.

## Audience-screen discipline

Branding stops at the operator interface. The presentation renderer shows **only** what
the service calls for — no watermark, no logo, no accent colour bleed — unless the
operator explicitly places a logo element on a slide. Theme tokens, not brand tokens,
govern the audience output.
