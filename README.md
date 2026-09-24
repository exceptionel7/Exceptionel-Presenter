<div align="center">

# EXCEPTIONEL PRESENTER

**Present Worship. Share the Word. Inspire the Room.**

A professional worship presentation desktop application for churches, worship teams,
pastors and media teams.

</div>

---

## Status: Phase 2 of 10 — in progress

This is an in-development product, not a finished release. The table below is the honest
state of every subsystem. Anything not marked **Working** is not pretending to work.

| Subsystem | Status | Verified how |
|---|---|---|
| SQLite schema + migrations | **Working** | 28 tests against real `node:sqlite` |
| Song library + full-text search | **Working** | repository tests |
| Services, themes, settings, shortcuts | **Working** | repository tests |
| Song → slide conversion | **Working** | 18 tests |
| Sync foundation (tombstones, revisions, device identity) | **Working** | 23 + 29 tests |
| Crash recovery + autosave | **Working** | repository + 14 autosave tests |
| Live presentation state engine | **Working** | 11 reducer tests |
| IPC contract + validation + role isolation | **Working** | 31 + 20 tests |
| Electron security policy | **Working** | 19 tests |
| Electron shell, windows, React UI | **Not yet run** | see *Verification honesty* below |
| Bible translations | **NOT IMPLEMENTED** | Phase 4 |
| Media library | **NOT IMPLEMENTED** | Phase 5 |
| Live cameras | **NOT IMPLEMENTED** | Phase 6 |
| Multi-display / projector output | **NOT IMPLEMENTED** | Phase 7 |
| Cloud / folder sync (the engine itself) | **NOT IMPLEMENTED** | Phase 9+, foundation ready |
| OBS / NDI / streaming | **NOT IMPLEMENTED** | Phase 10, seams only |

```
# tests 246   # pass 246   # fail 0
STRICT TYPECHECK: CLEAN
```

### Verification honesty

The development sandbox this was built in has **no network access**, so `npm install` and
the Electron binary were unavailable. Consequences, stated plainly:

- Everything marked **Working** above was genuinely executed and tested — real SQLite,
  real constraints, real FTS5 queries, real transaction rollback.
- The Electron main process, preload bridges and React components are **written but have
  not been run**. Monitors, projectors, cameras and fullscreen behaviour must be verified
  on real hardware.

That constraint shaped the architecture for the better: all real logic lives in
dependency-free TypeScript under `src/shared` and `src/main/db`, which is why it is
testable at all. Electron and React are a thin shell over an already-tested core.

## Getting started

Requires **Node 22.16+** (for the built-in `node:sqlite`) and npm.

```bash
npm install
npm run dev          # launch the app in development
npm test             # run the test suite (no Electron needed)
npm run typecheck    # strict TypeScript across main, preload and renderer
npm run dist         # build installers for the current platform
```

Before `npm run dist`, add your logo as `resources/icon.png` (1024×1024) so
`electron-builder` can generate the Windows and macOS installer icons.

After `npm install`, delete `tests/node-shims.d.ts` — it is a stand-in for `@types/node`,
which could not be installed in the build sandbox.

## Architecture

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The three decisions that
shape everything else:

**1. The main process owns live state.** Operator windows send *intents*; a pure reducer
in `src/shared/domain/live-state.ts` produces the next state; main broadcasts it to every
output window. If the UI owned this, a second output would drift and "Black → restore"
would be a UI hack rather than a state field.

**2. `node:sqlite`, not `better-sqlite3`.** The built-in module needs no `node-gyp`, no
ABI-matched rebuild per Electron major, and no Visual Studio build tools on Windows. It
sits behind a `SqliteDriver` interface, so the choice is reversible.

**3. The audience output window is read-only by construction.** Its preload exposes a
narrow surface, and the IPC dispatcher independently refuses every mutating channel from
an output-role window. An audience display is never one bug away from editing the library.

**4. Deletes are tombstones, ordered by a logical clock — not wall-clock time.** One library
is authoritative and others pull from it; see [`docs/SYNC.md`](docs/SYNC.md). Church booth
computers frequently have clocks that are months off, which would make timestamp-based
last-write-wins silently discard the *newer* edit.

```
src/
├─ shared/      ZERO dependencies. Pure TS. Unit-tested. The product's brain.
├─ main/        Electron main: security, windows, IPC, database, services
├─ preload/     Role-scoped contextBridge surfaces (operator | output | confidence)
└─ renderer/    React: operator UI, audience output, confidence monitor
```

## Bible translations

**No scripture text is bundled.** `bible_translations.license` is `NOT NULL`, so text
cannot be installed without recorded terms. Translations are added through properly
licensed or public-domain packages.

## Platforms

Windows and macOS are the build targets. Linux is architecturally supported (an AppImage
target exists) but untested.

## Licence

Proprietary. All rights reserved.
