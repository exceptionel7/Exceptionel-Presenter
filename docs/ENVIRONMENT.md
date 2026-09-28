# Build Environment Report — Exceptionel Presenter

Captured from the Kiro Web sandbox before any code was written. This determines what
can be **verified here** versus what must be verified **on your machine**.

## Verified facts

| Probe | Result |
|---|---|
| `network_mode` | `INTEGRATIONS_ONLY` |
| `curl https://registry.npmjs.org/react` | HTTP `000` (no route) |
| `curl https://github.com` | HTTP `000` (no route) |
| `npm view electron version` | `403 Forbidden` |
| `npm view react / vite / typescript / tailwindcss / better-sqlite3` | all fail |
| npm cache (`/root/.npm/_cacache`) | empty |
| Chromium / Playwright browser binary | not present, cannot download |

### Consequence

**`npm install` cannot run in this sandbox. The Electron binary cannot be downloaded.**
Therefore the Electron app **cannot be launched or hardware-tested here**. Anything
involving real monitors, projectors, cameras, or fullscreen must be verified by you
locally. I will not claim otherwise.

## What *is* available, and is genuinely usable

| Tool | Version | Use |
|---|---|---|
| Node.js | 22.23.2 | runtime |
| `node:sqlite` (`DatabaseSync`) | built in | **real SQLite, zero native install** — probe-verified: created a table, inserted, selected |
| `node:test` | built in | real unit tests, zero dependencies |
| `tsc` (global) | 7.0.2 | typecheck all non-JSX TypeScript |
| `eslint`, `prettier` (global) | — | lint/format |

> Note: `NODE_OPTIONS` in this sandbox points at a missing preload script
> (`/opt/amazon/kiro-agent/proxy-bootstrap.js`). Every `node`/`npm` invocation must be
> prefixed with `unset NODE_OPTIONS;` or it crashes with `MODULE_NOT_FOUND`.

## Verification strategy this forces on us

This is the single most important architectural constraint, and it pushes the design in
a direction that is *better* anyway:

1. **Put real logic in dependency-free TypeScript.** The presentation state machine,
   slide model, song parser, Scripture reference parser, theme resolution, playlist
   model, migration runner, and repositories are written as pure TS with no imports
   from `electron`, `react`, or npm packages. These I can compile with the global `tsc`
   and execute under `node:test` — **actually run, actually verified, here, now.**
2. **Keep Electron/React as a thin shell.** The main process, preload bridge, and React
   components become adapters over already-tested logic. They are the only part that
   is "written but not executed here".
3. **Use `node:sqlite` instead of `better-sqlite3`.** No `node-gyp`, no native rebuild
   per Electron version, no Windows build-tools requirement for your users. Behind a
   `SqliteDriver` interface so `better-sqlite3` can be swapped in later if you want it.

Every deliverable will be labelled with one of:

- **VERIFIED HERE** — code was compiled and executed in this sandbox; output shown.
- **TYPECHECKED ONLY** — compiles clean, not executed (no runtime available).
- **UNVERIFIED — NEEDS LOCAL RUN** — requires Electron/hardware on your machine.
- **NOT IMPLEMENTED** — stub that reports its own unavailability honestly.


## What cannot be verified here, and what stands in for it

Stated plainly because a milestone report that blurs these is worthless.

| Check | Status in this environment | What is done instead |
|---|---|---|
| `node --test` | **runs** | the real suite, against real SQLite and a real TLS socket |
| `npm run typecheck:local` | **runs** | `tools/local-typecheck/check.mjs`, both passes |
| `npm run typecheck` | **cannot run** — needs `node_modules` | the local gate, which is narrower for the renderer |
| `electron-vite build` | **cannot run** — no `node_modules`, no registry | nothing; must be run on a real machine |
| Electron launch | **cannot run** — no Electron binary | nothing |
| DevTools console | **cannot run** — no browser | renderer errors are forwarded to the terminal, so a real run surfaces them |
| Rendered layout geometry | **cannot be measured** | `tests/operator-layout.test.ts` resolves the real width classes to pixels and bounds the arithmetic |
| Phone camera, WebRTC | **cannot run** — no phone, no network | verified by the user on hardware |

### The layout limitation specifically

`tests/operator-layout.test.ts` does **not** measure a rendered layout. It extracts the width tokens
actually present in the source, resolves them through Tailwind's scale, and asserts the
non-shrinkable parts of the shell leave a usable work area at 1024, 1280 and 1920.

That is a real constraint — the sum of fixed widths is not a matter of opinion — and it catches the
class of regression that matters: someone widening a sidebar past what the narrowest supported
viewport can hold. It cannot catch a long unbroken string pushing a flex item wide, so the test also
asserts every fixed sidebar is paired with a `flex-1 min-w-0` work area, which is the structural
property that makes such a string shrinkable.

It matters more than it would elsewhere because `styles.css` sets `body { overflow: hidden }`. That is
right for a kiosk-style application — a stray scrollbar during a service would be worse than none —
but it means an overflowing shell fails **invisibly**, clipping a control rather than revealing it.
The width arithmetic is the compensating control for that choice.
