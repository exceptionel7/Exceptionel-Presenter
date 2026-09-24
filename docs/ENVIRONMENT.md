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
