<div align="center">

# EXCEPTIONEL PRESENTER

**Present Worship. Share the Word. Inspire the Room.**

A professional worship presentation desktop application for churches, worship teams,
pastors and media teams.

</div>

---

## Status: Phase 5 of 10 — in progress

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
| Electron shell, windows, React UI | **Working** | run on Windows |
| Presentation engine (cues, themes, the layer stack) | **Working** | 22 + 28 tests, and run on real hardware |
| Bible translations | **Working** | 26 + 26 + 23 + 16 + 18 tests, and run on real hardware |
| Wireless phone camera (QR pairing, PIN, WebRTC) | **Working** | 42 + 27 tests, and run on real hardware |
| Media import — classify, hash, de-duplicate, copy | **Working** | 19 + 23 tests against real files on disk |
| Media library index — search, categories, favourites, delete | **Working** | 24 tests against real SQLite |
| Media serving, backgrounds, media slides, the Media screen | **Written, not yet run** | 16 + 17 + 9 + 15 + 20 tests — see *Verification honesty* |
| Video poster frames | **NOT IMPLEMENTED** | needs a video decoder; see `docs/MEDIA.md` |
| Audio playback | **NOT IMPLEMENTED** | audio imports and is stored, but nothing plays it |
| Theme designer (typography, spacing, transitions) | **NOT IMPLEMENTED** | Phase 9 — backgrounds are editable now |
| Service builder (drag-and-drop, templates) | **NOT IMPLEMENTED** | Phase 8 |
| Local camera devices, camera profiles | **NOT IMPLEMENTED** | Phase 6 |
| Multi-display / projector output | **NOT IMPLEMENTED** | Phase 7 |
| Cloud / folder sync (the engine itself) | **NOT IMPLEMENTED** | Phase 9+, foundation ready |
| OBS / NDI / streaming | **NOT IMPLEMENTED** | Phase 10, seams only |

```
# tests 878   # pass 878   # fail 0
LOCAL TYPECHECK: CLEAN (109 files fully checked, 26 renderer files name-resolved)
```

### Verification honesty

The development sandbox this was built in has **no network access**, so `npm install` and
the Electron binary were unavailable. Consequences, stated plainly:

- Everything marked **Working** above was genuinely executed and tested — real SQLite,
  real constraints, real FTS5 queries, real transaction rollback, real files on a real disk.
- The rows that say **and run on real hardware** were additionally confirmed by the author
  running the packaged application on Windows: lyrics and scripture on a real screen, a
  phone camera paired over the LAN with text composited over the live feed.
- Anything marked **Written, not yet run** has unit tests but has never executed inside
  Electron. For Phase 5 that specifically means protocol registration, real image and video
  playback, video seeking, thumbnail generation and the file dialog. `docs/MEDIA.md` lists
  them individually rather than leaving it implied.
- No rendered layout has been verified at multiple viewport widths from the sandbox. There
  is no display here.

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

The sandbox this was built in has no network access, so a local gate stands in for the real
typecheck: `npm run typecheck:local` checks main, preload, shared and tests with full
semantics using the shims in `tools/local-typecheck/`, and the renderer for syntax and name
resolution only. It cannot see React's or Tailwind's types, so run the real
`npm run typecheck` once dependencies are installed. See `tools/local-typecheck/README.md`.

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
