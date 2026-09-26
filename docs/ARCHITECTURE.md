# EXCEPTIONEL PRESENTER — Phase 1 Architecture

**Present Worship. Share the Word. Inspire the Room.**

Target: a professional worship presentation desktop application for Windows and macOS,
architected so Linux can be added without redesign.

---

## 1. Process model

Electron gives us four distinct runtime roles. Keeping them strictly separated is what
makes the audience screen trustworthy during a live service.

```
┌──────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node)                        the single source of  │
│                                            truth for LIVE state  │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ LiveStateStore │  │ WindowManager│  │ SQLite (node:sqlite)│   │
│  │ (reducer)      │  │ operator/    │  │ migrations +        │   │
│  │                │  │ output/      │  │ repositories        │   │
│  └───────┬────────┘  │ confidence   │  └────────────────────┘    │
│          │           └──────────────┘                            │
│  DisplayService · CameraRegistry · MediaService · Autosave        │
│  RecoveryService · ThemeService · BibleService                    │
└───────┬─────────────────┬─────────────────┬──────────────────────┘
        │ IPC (typed,     │                 │
        │ validated)      │                 │
   ┌────▼──────┐    ┌─────▼──────┐    ┌─────▼──────────┐
   │ PRELOAD   │    │ PRELOAD    │    │ PRELOAD        │
   │contextBridge    │contextBridge    │contextBridge   │
   ├───────────┤    ├────────────┤    ├────────────────┤
   │ OPERATOR  │    │ OUTPUT     │    │ CONFIDENCE     │
   │ RENDERER  │    │ RENDERER   │    │ RENDERER       │
   │ React UI  │    │ audience — │    │ slide/next/    │
   │ full      │    │ NO chrome  │    │ timer/notes    │
   │ controls  │    │ kiosk      │    │                │
   └───────────┘    └────────────┘    └────────────────┘
```

### Why main owns LIVE state

If the operator window owned live state, then: a second output window would drift, a
crash in the operator UI would strand the audience screen mid-slide, and "Black →
restore previous slide" would be unreliable. Instead:

- Operator renderer sends **intents** (`live:next`, `live:black`, `live:goToSlide`).
- Main **reduces** them into one authoritative `LiveState`.
- Main **broadcasts** the new state to every output and confidence window.

Result: outputs are pure render targets. Any number of them stay frame-consistent, and
Black/Clear/restore is a state field, not a UI hack.

```ts
interface LiveState {
  status: 'idle' | 'live' | 'black' | 'clear' | 'paused';
  activeCueId: string | null;     // what SHOULD be shown
  restoreCueId: string | null;    // what Black/Clear must return to
  slideIndex: number;
  themeId: string;
  cameraLayer: CameraLayerState | null;   // overlay compositing
  textLayer: TextLayerState | null;
  mediaLayer: MediaLayerState | null;
  transition: TransitionSpec;
  revision: number;               // monotonic; outputs discard stale frames
}
```

`revision` matters: it lets an output window that was slow or just opened ask for a full
resync and ignore out-of-order broadcasts.

---

## 2. Repository layout

```
exceptionel-presenter/
├─ package.json                  electron-vite, electron-builder (win + mac)
├─ electron.vite.config.ts       three renderer entries
├─ tsconfig.json                 project references
├─ src/
│  ├─ shared/                    ★ ZERO dependencies. Pure TS. Unit-tested.
│  │  ├─ ipc-contract.ts         one source of truth for every channel
│  │  ├─ domain/
│  │  │  ├─ live-state.ts        the reducer (pure function)
│  │  │  ├─ song.ts              sections → slides
│  │  │  ├─ bible-reference.ts   "John 3:16-18" parser
│  │  │  ├─ slide.ts             slide/element model
│  │  │  ├─ service.ts           service + cue list
│  │  │  ├─ theme.ts             theme resolution & inheritance
│  │  │  └─ camera.ts            provider capability model
│  │  └─ validation/             hand-rolled validators (no zod dep)
│  ├─ main/
│  │  ├─ index.ts                app lifecycle, single-instance lock
│  │  ├─ security/               CSP, permission gate, navigation guard
│  │  ├─ windows/                WindowManager: operator | output | confidence
│  │  ├─ ipc/                    handler registry; validate → handle → respond
│  │  ├─ db/
│  │  │  ├─ driver.ts            SqliteDriver interface
│  │  │  ├─ node-sqlite-driver.ts
│  │  │  ├─ migrator.ts          forward-only, transactional
│  │  │  ├─ migrations/          0001_init.sql, 0002_…
│  │  │  └─ repositories/        songs, bible, media, services, themes…
│  │  └─ services/               live-state, display, camera-registry,
│  │                             media, autosave, recovery, bible
│  ├─ preload/                   narrow contextBridge surfaces (per window role)
│  └─ renderer/
│     ├─ operator/               React + Tailwind production UI
│     ├─ output/                 React audience renderer
│     ├─ confidence/             React confidence monitor
│     └─ shared-ui/              design system primitives
├─ tests/                        node:test, runs against src/shared
└─ docs/
```

The `src/shared` rule is absolute: **no `import` from `electron`, `react`, or any npm
package.** That is what makes the product's brain testable in CI, in this sandbox, and
independent of the shell.

---

## 3. Data layer

### Driver choice: `node:sqlite`

`better-sqlite3` is the conventional pick but it is a native module: it needs
`electron-rebuild`, matching Electron ABI, Visual Studio build tools on Windows, and it
breaks on every Electron major upgrade. `node:sqlite` (`DatabaseSync`) is compiled into
Node 22+ and Electron 33+, so there is **nothing to build**. Probe-verified working in
this sandbox.

It sits behind an interface so this is a reversible decision:

```ts
interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}
```

### Migrations

Forward-only numbered SQL files. The migrator records applied versions in
`schema_migrations`, runs each file inside a transaction, and refuses to start if the
database is newer than the app (prevents a downgrade corrupting a church's library).
`PRAGMA journal_mode=WAL` + `foreign_keys=ON` + `synchronous=NORMAL`.

### Schema (Phase 2 initial set)

```
schema_migrations(version, applied_at)

church_profile(id, name, logo_asset_id, timezone, onboarding_completed)
settings(key, value_json, updated_at)
shortcuts(action, accelerator, enabled)

songs(id, title, artist, author, copyright, ccli_number, song_key,
      notes, is_favorite, category, created_at, updated_at)
song_sections(id, song_id→songs, kind, label, sort_order, lyrics,
              slide_break_mode)

bible_translations(id, abbreviation, name, language, license, source_url,
                   install_state, verse_count, installed_at)
bible_books(id, translation_id→, book_number, name, abbreviation, chapter_count)
bible_verses(translation_id→, book_number, chapter, verse, text)   -- PK composite
   + FTS5 virtual table bible_verses_fts for keyword search

media_assets(id, kind, filename, abs_path, mime, bytes, width, height,
             duration_ms, thumbnail_path, category, is_favorite, hash)

themes(id, name, parent_theme_id→themes, is_builtin, spec_json)

presentations(id, title, theme_id→themes, kind)
presentation_slides(id, presentation_id→, sort_order, elements_json,
                    notes, theme_override_json)

services(id, name, service_date, theme_id→, notes, created_at, updated_at)
service_items(id, service_id→, sort_order, kind, label, ref_id, config_json)
   -- kind: song | scripture | slide | image | video | camera_scene | announcement

playlists(id, name, kind, notes)
playlist_items(id, playlist_id→, sort_order, service_id→ | item_json)

announcements(id, title, body, image_asset_id→, video_asset_id→,
              event_date, event_time)

camera_profiles(id, label, provider, device_id, resolution, framerate,
                mirrored, config_json)
display_profiles(id, os_display_id, label, role, bounds_json, scale_factor,
                 aspect_ratio, is_primary)
   -- role: operator | presentation | preview | confidence | unused

session_recovery(id, snapshot_json, heartbeat_at, clean_shutdown)
sync_oplog(id, entity, entity_id, op, payload_json, local_ts, synced_at)
```

`sync_oplog` exists from day one even though cloud sync is Phase 9 — retrofitting a
change log onto a live database is painful, adding an unused table is free.

### Local-first + optional cloud

```ts
interface DataProvider { /* read/write per entity */ }

LocalDataProvider  → SQLite. Always present. Never optional.
CloudDataProvider  → Supabase/Postgres. Opt-in, additive.
SyncEngine         → drains sync_oplog, last-write-wins per field,
                     conflict surface for the operator. Media files sync
                     metadata only; binaries stay local unless asked.
```

Camera video is **never** routed through either provider. Losing internet mid-service
degrades nothing in Songs, installed Bible translations, Media, Camera, Displays,
Playlists, or Themes.

---

## 4. IPC architecture

One contract file, imported by main *and* preload *and* renderer, so a channel cannot
drift between sides:

```ts
// src/shared/ipc-contract.ts
export interface IpcRequestMap {
  'songs:list':      { req: SongQuery;        res: SongSummary[] };
  'songs:save':      { req: SongDraft;        res: Song };
  'live:next':       { req: void;             res: LiveState };
  'live:black':      { req: void;             res: LiveState };
  'display:list':    { req: void;             res: DisplayInfo[] };
  'output:assign':   { req: OutputAssignment; res: OutputStatus };
  // …
}
export interface IpcEventMap {
  'live:state':      LiveState;
  'display:changed': DisplayInfo[];
  'camera:changed':  CameraDeviceInfo[];
  'error:notice':    ErrorNotice;
}
```

Rules enforced in code:

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  `webSecurity: true`, `allowRunningInsecureContent: false` on every window.
- Renderer gets **no** `require`, no `fs`, no `child_process`. Preload exposes only
  `window.exceptionel.{songs,bible,media,live,display,camera,settings,…}`.
- Every handler runs `validate(req)` from `src/shared/validation` before touching the
  database or filesystem. Invalid payload → typed error, never a throw into the void.
- **Role-scoped preload.** The output window's preload exposes a *read-only* surface: it
  can subscribe to `live:state` and nothing else. An audience display physically cannot
  mutate the service.
- File paths from the renderer are rejected unless they resolve inside the app's media
  root or arrived from a main-process-owned dialog. No path traversal.
- `will-navigate` / `setWindowOpenHandler` deny all external navigation.
  CSP set via `onHeadersReceived`, no `unsafe-eval` in production.

---

## 5. Presentation renderer (audience output)

A separate `BrowserWindow`, created by `WindowManager` on the bounds of the display
assigned the `presentation` role:

```ts
{ frame: false, kiosk: true, fullscreen: true, backgroundColor: '#000000',
  autoHideMenuBar: true, skipTaskbar: true, hasShadow: false,
  webPreferences: { preload: outputPreload, sandbox: true, contextIsolation: true } }
```

It renders a fixed **layer stack**, which is how Camera + Lyrics and Camera + Scripture
fall out of one mechanism rather than three special cases:

```
z4  FOREGROUND   logo / watermark
z3  TEXT         lyrics | scripture | announcement   (themed, animated)
z2  MEDIA        image | video | animated background
z1  CAMERA       live local MediaStream
z0  BASE         solid colour | gradient | black
```

- Design space is a normalised 1920×1080 canvas, CSS-transformed to fit the real output
  (16:9, 4:3, 21:9, 4K). Slide geometry stored resolution-independently, so the same
  service looks right on a 720p projector and a 4K LED wall.
- Cursor hidden, text selection disabled, context menu suppressed, drag/drop refused.
- Transitions are CSS/WAAPI on the layer that changed only — a lyric change does not
  restart the background video.
- `status: 'black'` renders opaque black over z0–z4 while `restoreCueId` is preserved,
  so resuming returns to the exact prior slide. `clear` hides only the TEXT layer,
  leaving camera/background live — that distinction is what operators actually need.

### One renderer, five surfaces

`src/renderer/shared-ui/SlideCanvas.tsx` paints every slide in the application: the audience
output, the operator's PREVIEW pane, the operator's LIVE pane and the theme gallery. Not four
implementations that resemble each other — that component, four times, with different props.

A preview exists so the operator can trust it. A second implementation of "how a theme renders"
would eventually disagree with the first, and the operator would discover the disagreement on the
projector, in front of a congregation, with no way to tell which one had been lying.

The confidence monitor is the deliberate exception: it is a legibility surface, not a preview, so it
ignores the theme entirely. Dark text on a pale background is unreadable from three metres, and
letterboxing a 55pt lyric into 16:9 wastes most of a stage screen.

Geometry is **container-relative, not measured**. The canvas is letterboxed with `aspect-ratio` and
sized in `cqh` units, where `1cqh` is 1% of the canvas height — so a theme's 84pt type is
`(84/1080)*100cqh` and lands proportionally identically in a 240px preview thumbnail and on a 4K
wall. No resize listeners, no `transform: scale()`, no measurement pass.

`annotate` is an operator-only prop that draws honest diagnostics: "no camera signal", "image
backgrounds arrive in Phase 5", "too much text to fit". The audience output never sets it. A caption
on a projector explaining the state of our backlog is worse than showing nothing.

### Why a cue carries its own text

`Cue.lines` holds the words, and the audience output never reads the library to get them.
`OUTPUT_ALLOWED_CHANNELS` grants that window `themes:list` and nothing else from the library — no
songs, no services. Phase 3 could have been built by relaxing that, which would have been less code
and a worse design.

So one broadcast carries one complete truth, and the output can never be asked to paint a slide
whose words it does not have. Only the *styling* is looked up, resolved locally from a single
`themes:list` on mount, which also means advancing a slide costs no IPC round trip.

### Text must fit, and fitting is pure

`fitSlideText` chooses a font size at which a slide is predicted to fit the theme's safe area. An
eight-line chorus at 84pt overflows a 1080-high canvas, and a long line wraps and overflows sooner —
text running off the bottom of a projector is the most visible failure this application has.

The vertical arithmetic is exact: available height, line count, line height and font size are all
known. Only the **wrapped** line count is estimated, from a documented average glyph advance, because
real per-glyph measurement needs a DOM and a loaded font. Keeping the decision pure buys two things:
it is unit-testable, and it is deterministic — so the preview and the audience screen compute the
same size from the same cue rather than two windows disagreeing about type size.

When even the smallest permitted size will not fit, that is reported rather than shrunk away. The
operator is told to split the slide; the audience sees the smallest readable type.

---

## 6. Display management

```ts
class DisplayService {
  list(): DisplayInfo[]   // screen.getAllDisplays() → id, label, bounds,
                          // workArea, scaleFactor, rotation, colorDepth,
                          // internal?, aspectRatio, derived status
  assign(displayId, role)  // persists to display_profiles, moves windows
  test(displayId)          // Test Mode: identify pattern on that screen
}
```

Subscribes to `display-added` / `display-removed` / `display-metrics-changed`. If the
projector assigned `presentation` disappears mid-service, the app does **not** silently
move the audience output onto the operator's screen — it raises an `error:notice`,
parks output, and offers explicit reassignment.

Honest limits, stated now: Electron's `screen` API does **not** expose refresh rate or
distinguish "a projector" from "a monitor". Section 22 of the brief asks for refresh
rate — it will be shown as `—` with a tooltip rather than fabricated, until a native
helper module is added. That helper is a Phase 7 item, marked **NOT IMPLEMENTED** in the
UI until real.

---

## 7. Camera architecture

The governing constraint: **a `MediaStream` cannot cross an IPC boundary.** So:

- **Enumeration and configuration** live in main (`CameraRegistry`, persisted to
  `camera_profiles`).
- **Acquisition and rendering** happen in the renderer that displays it. The output
  window calls `getUserMedia({ video: { deviceId } })` itself and paints to its own
  `<video>` element. Nothing is encoded, copied between processes, or uploaded.

```ts
interface CameraProvider {
  readonly id: string;
  readonly capabilities: CameraCapability[];
  isAvailable(): Promise<AvailabilityReport>;   // must explain *why* if false
  enumerate(): Promise<CameraDeviceInfo[]>;
  describeAcquisition(deviceId): AcquisitionPlan; // how the renderer should open it
}
```

| Provider | Phase 6 status |
|---|---|
| `UsbProvider` (`getUserMedia` / OS devices) | implemented |
| `CaptureCardProvider` | registered, reports **NOT IMPLEMENTED** + requirement |
| `NdiProvider` | registered, reports **NOT IMPLEMENTED** (needs NDI SDK native addon) |
| `RtspProvider` | registered, reports **NOT IMPLEMENTED** (needs ffmpeg/WebRTC bridge) |

Unavailable providers appear in the UI *greyed with a reason*, never as a fake button.
`AvailabilityReport` carries a discriminated reason — `permission-denied`,
`disconnected`, `in-use`, `no-devices`, `driver-missing` — which drives the Section 39
troubleshooting text instead of a generic "Camera unavailable."

Permission handling: main installs `setPermissionRequestHandler` allowing `media` only
for our own windows, and on macOS checks
`systemPreferences.getMediaAccessStatus('camera')` so we can distinguish "user denied at
OS level" from "device busy" — different problems, different fixes.

### Wireless camera: two independent channels

The phone camera has a **signalling** channel and a **media** channel, and they are
deliberately not coupled:

| | Path | Carries | Fails when |
|---|---|---|---|
| Signalling | phone ⇄ HTTPS/SSE ⇄ main ⇄ output window | SDP, ICE, state | the HTTP connection drops |
| Media | phone → Wi-Fi → output window | RTP video/audio | the devices stop reaching each other |

Two rules follow, both learned the hard way:

1. **A dropped signalling stream is not a lost camera.** `EventSource` reconnects by
   itself after any Wi-Fi blip. Treating that as a disconnect pushed a live feed into
   `reconnecting` and cleared its metrics, and nothing moved it back — the desktop peer
   had never changed state, so no recovery event was ever emitted. The authoritative
   signals that a camera is gone are the desktop's own `RTCPeerConnection` state and an
   explicit `bye`.
2. **A signalling stream is identified, not just keyed by session.** Node fires `close`
   on a superseded request *after* its replacement is registered, so a session-keyed
   teardown destroyed the stream it had just created — and then the phone's automatic
   retry did it again, for ever.

### What "connected" means

`connected` is reached only by `wireless:track`, which the output window sends when the
receiving track **unmutes** — the first RTP packet. Not when `ontrack` fires: that
happens as soon as the answer is applied, before any media exists. The operator preview
gates on `hasStream(state)` for the same reason, so a negotiated-but-silent connection
shows "Waiting for video…" rather than a black rectangle that looks like a working
camera.

ICE candidates are **queued on both ends** until a remote description exists. The desktop
starts trickling the moment it sets its local offer, which is before the phone has the
offer at all; `addIceCandidate` rejects in that window, and with no STUN or TURN
configured those host candidates are the only ones there will ever be.

---

## 8. Autosave & crash recovery

- Writes are debounced per aggregate (~400 ms) and committed in a transaction; WAL means
  a power loss costs at most the last debounce window, never the library.
- `session_recovery` holds a JSON snapshot of the open service + `LiveState`, updated on
  a heartbeat. Clean exit sets `clean_shutdown = 1`.
- On launch, if the newest row has `clean_shutdown = 0`, the operator is offered
  **"Recover Previous Session?"** with the service name and timestamp. Declining keeps
  the snapshot for one more launch rather than destroying it.

---

## 9. Integration seams (built as seams now, features later)

`OutputSink` is the abstraction that keeps Sections 30–31 from contaminating the
presentation engine:

```
OutputSink
├─ DisplayOutputSink      Phase 7, real
├─ ObsOutputSink          Phase 10 — obs-websocket; NOT IMPLEMENTED
└─ StreamOutputSink       Phase 10 — RTMP/YouTube/FB; NOT IMPLEMENTED
```

The presentation engine emits state; sinks consume it. Streaming never blocks or
back-pressures the audience display. No OBS or streaming capability will be surfaced in
the UI as working until it is actually implemented and tested.

---

## 10. Phase plan, with honest verification labels

Recall from `ENVIRONMENT.md`: this sandbox has no network, so `npm install` and the
Electron binary are unavailable. Labels are therefore promises about evidence, not
optimism.

| Phase | Deliverable | Verifiable here? |
|---|---|---|
| 1 | Architecture (this doc) + skeleton | ✅ done |
| 2 | Electron shell, React nav, DB + migrations, settings, dashboard | migrations/repos **VERIFIED HERE** via `node:test`; shell **needs local run** |
| 3 | Presentation engine: slides, preview, live, black/clear, next/prev | cue expansion, theme resolution, text fitting **VERIFIED HERE**; rendering **needs local run** |
| 4 | Songs + Bible: library, section→slide, reference parser, FTS search | **VERIFIED HERE** (pure logic + SQLite) |
| 5 | Media library: import, thumbnails, streaming playback | repo **VERIFIED HERE**; playback **needs local run** |
| 6 | Camera: detect, preview, switch, + lyrics, + Scripture | provider registry **VERIFIED HERE**; capture **needs local run** |
| 7 | Multi-display, output roles, confidence monitor | **needs local run** (real monitors) |
| 8 | Service builder, drag-drop, templates, autosave | model **VERIFIED HERE**; DnD **needs local run** |
| 9 | Themes, animations, timers, notes, backup, cloud sync | theme/timer logic **VERIFIED HERE** |
| 10 | OBS / NDI / capture / streaming seams | interfaces only, **NOT IMPLEMENTED** by design |

Phases 2–10 each end with: `tsc --noEmit`, `node --test`, migration run, and an explicit
statement of what you must click through locally.
