# Media library — Phase 5

Import, storage, serving and presentation of images, video and audio.

This document is about the decisions, not the API surface — the types are in
`src/shared/domain/media.ts` and `src/shared/ipc-contract.ts`, and both carry their own reasoning.

---

## What works, and what does not

| | State |
|---|---|
| Import images, video and audio | **Works** |
| De-duplication by content hash | **Works** |
| Image backgrounds behind lyrics and scripture | **Works** |
| Video backgrounds behind lyrics and scripture | **Works** — silent, looping |
| An image or video as a slide of its own, in the running order | **Works** |
| Image thumbnails in the media grid | **Works** |
| Choosing a background from the interface | **Works** — Themes → Customise → Edit background |
| **Video poster frames** | **NOT IMPLEMENTED** — see below |
| **Audio playback** | **NOT IMPLEMENTED** — audio imports and is stored, but nothing plays it |
| Editing typography, spacing, scrim or transitions | **NOT IMPLEMENTED** — Phase 9 theme designer |
| Drag-and-drop reordering of media in a service | **NOT IMPLEMENTED** — Phase 8 service builder |

Nothing in this phase has been run in Electron. See [Unverified](#unverified).

---

## Formats are decided by EXTENSION, not by the type the OS reports

Thirteen extensions are accepted: `.jpg .jpeg .png .webp .gif .avif` / `.mp4 .m4v .webm` /
`.mp3 .m4a .wav .ogg`.

An operating system's idea of a file's type comes from its own registry, which on Windows is
routinely wrong or absent for media a church has been handed on a memory stick. The extension is what
the person who made the file chose, it is what Chromium will actually use to pick a decoder, and it is
identical on every machine. Where the two disagree, the extension is the one that predicts whether
playback works.

**Only formats Chromium decodes without a platform codec are accepted.** This is deliberately
conservative, and it is the difference between a file that imports and a file that plays. A `.wmv`
imports fine on a laptop with the right codec installed and then fails on the booth machine on Sunday
morning — so it is refused at import, **by name, with the remedy**:

> Windows Media Video needs a system codec that is not always present. Convert it to MP4.

`.wmv`, `.avi`, `.mov`, `.mkv`, `.flv`, `.wma`, `.aiff`, `.tif`, `.tiff`, `.psd` and `.heic` each get
their own message. "Unsupported file" tells an operator nothing they can act on.

**SVG is refused outright.** It is a document that can carry script, and it would be rendered inside a
window that has access to our preload bridge. Not worth the risk for a background.

Size ceilings are per kind: 64 MB for an image, 512 MB for audio, 4 GB for video. The ceiling exists
because import reads the whole file to hash it; it is what stops someone accidentally selecting a
40 GB video export and stalling the application at the moment they can least afford it.

---

## Import COPIES files in

`<userData>/media/` holds the originals, `<userData>/thumbnails/` the generated previews. Two reasons
not to reference files where they sit:

1. `src/main/security/policy.ts` already required every stored `abs_path` to resolve inside one of the
   app's own roots. Referencing a file on the Desktop breaks that invariant, and a renderer would then
   be handed paths from anywhere on the disk.
2. A volunteer tidying their Downloads folder on Saturday night must not be able to empty a slide on
   Sunday morning. Once a background is in a service, the file behind it belongs to the app.

### Hashing is asynchronous, and that is not a style preference

The ceiling for a video is 4 GB, and the main process is what dispatches cues to the projector.
`readFileSync` on that file would hold the process for the entire read. Audience-screen video would
keep playing — that decode lives in the renderer — but the operator's next slide change would sit in a
queue until the read finished. A chunked `open`/`read` loop hands each chunk to libuv's threadpool and
lets the event loop keep turning, so an import during a service is merely slow rather than a freeze.

### De-duplication is enforced by the database, not by a check in front of it

The stored filename is the first twelve hex characters of the file's SHA-256, then a sanitised name.
Identical content therefore always lands on the same path, and `idx_media_hash` is UNIQUE over **live
rows only**.

That partial index is load-bearing in both directions. It means importing the same background from two
memory sticks stores it once — and it means deleting a background does not permanently block importing
it again, which a full unique index would.

### Delete is a tombstone, but the file is real

`media_assets` is a synced table, so a delete leaves a tombstone for the deletion to propagate. The
file on disk still has to go, or "delete" frees nothing.

That combination creates a trap: delete a file, re-import the identical file, and the tombstone's
`abs_path` now names a file belonging to the **new** row. So `MediaRepository.delete` reports whether
any live row still references the path, and the caller unlinks only when none does. Getting this wrong
deletes media that is still in Sunday's service.

`deleteStoredFile` is the only route from a database row to `unlink`, and it refuses any path outside
the media roots.

### A re-import repairs a missing file

`storeFile` runs on every import, even when the hash is already known. It is a no-op when the file is
already there and a repair when it is not — so a library whose media folder was partly lost (a failed
backup restore, a volunteer "cleaning up") heals itself on the next import of the same file, instead of
de-duplicating against a row whose file no longer exists and leaving a blank slide.

---

## Boundary: a renderer never sees a path {#boundary}

Renderers address media by ID over a custom protocol: `app-media://<assetId>`, and
`app-media://<assetId>/thumbnail` for the preview.

Why not simply allow `file:`:

- It would widen `img-src` and `media-src` to the whole disk. Any markup that ends up in the app could
  then read files the operator can read.
- Real paths in the DOM contain the operator's account name (`C:\Users\…`), which then appears in
  screenshots, bug reports and the DevTools network panel.
- An ID is checked against a row. A path can only be checked against a guess.

The scheme name is not new: `security/policy.ts` has named `app-media:` in its Content-Security-Policy
since Phase 1, and `tests/security.test.ts` asserts that the policy never contains `file:`.

Three mechanisms keep the boundary:

- **`media:list` returns `MediaAssetView`**, written out field by field rather than as an `Omit<>` of
  the entity — so adding a path-shaped field to `MediaAsset` later cannot quietly publish it. `hash` is
  withheld too: the renderer has no use for it, and it is the one field that would let a compromised
  renderer recognise files it was never shown.
- **`media:import` takes no payload.** Main opens the dialog, so the only importable file is one a human
  explicitly chose. Same rule as `bible:import`.
- **No media channel is reachable from the audience or confidence windows.** A background reaches the
  audience as an `app-media://` URL inside its cue; the protocol serves it without IPC. Giving that
  window `media:list` would let a display that renders whatever it is told enumerate the library.

`tests/media-ipc.test.ts` asserts that no response from any media channel contains the temp directory,
either media root, `absPath`, `thumbnailPath` or `hash`.

### Resolution always goes id → row → path

Never id → path directly. Stored filenames contain the content hash, so deleting an asset and importing
the same bytes again reuses the path — a window still holding the deleted asset's URL must get a 404,
not its replacement.

A malformed URL is **400** and a well-formed URL for something that no longer exists is **404**, kept
distinct. While debugging a blank projector, "the caller is wrong" and "the caller is stale" are
completely different problems.

### The Range header is forwarded, and it has to be

A `<video>` element does not read a file start to finish; it asks for byte ranges, and it asks for a
range purely to discover how long the media is. Dropping the header returns the whole file with status
200 for every request, and Chromium concludes the stream is not seekable — `seekable` reports 0–0 and
setting `currentTime` snaps back to zero. For a worship video that means it can only ever be played
from the beginning.

Electron had its own regression in this area between 37.0.0 and the fix in
[electron/electron#47703](https://github.com/electron/electron/pull/47703), backported to `37-x-y` on
2025-08-06 and so first present in v37.2.6. `package.json` therefore pins `^37.3.0` rather than
`^37.0.0`. (The umbrella issue, [#38749](https://github.com/electron/electron/issues/38749), is still
open; the specific scrubbing regression is the part that was fixed.)

The Content-Type served is **ours**, from the record written at import, not whatever the file fetch
guessed. Letting a sniffed `application/octet-stream` win would reintroduce exactly the inconsistency
that classifying by extension exists to avoid.

### Scheme privileges

`standard`, `secure`, `supportFetchAPI`, `stream`, `corsEnabled` — and `bypassCSP: false`.

- `stream` is **required** for `<video>` and `<audio>`. Without it a media element receives the whole
  file as one buffer and cannot play progressively or seek at all.
- `secure` is required or the window treats it as mixed content and blocks it, which presents as a
  silently blank background.
- `standard` puts the asset ID in the URL **host** position, which Chromium canonicalises to lower
  case. Generated ids are lower case by construction (`newId` uses a lower-case hex UUID) and
  `tests/media-protocol.test.ts` pins that, because an uppercase id would 404 every background.
- Not bypassing CSP, deliberately: the policy already permits exactly this scheme and nothing more, and
  a scheme that bypasses CSP would also be exempt from every future tightening of it.

`registerSchemesAsPrivileged` runs at **module scope** in `src/main/index.ts`, not inside `bootstrap`.
It is only honoured before the app is ready; registering it late fails silently, and the symptom is
every background simply being absent with one console warning to explain it.

---

## Presentation: the existing layer stack, not a new path

```
z3  TEXT      lyrics | scripture   ← unchanged
z2  MEDIA     imported image | video   ← Phase 5 made this real
z1  CAMERA    live phone/USB feed      ← unchanged
z0  BASE      solid | gradient
```

Two sources feed the one media layer, and `resolveSlideMedia` is the single place that decides between
them:

- a **theme** can carry a background (`background.mediaAssetId` + `fit`);
- a **cue** can BE a piece of media, when the running order contains an image or video item.

A cue's media wins; a cue with no opinion gets the theme's background; an explicit `null` paints
nothing. That rule is a pure function rather than component logic, so the operator's preview and the
audience screen resolve it identically — and a test can check it without a browser.

Camera-over-lyrics and Scripture-over-camera are untouched. A background has exactly one `kind`, so
choosing media cannot displace a camera.

Two details in `SlideCanvas` are load-bearing:

- The layer is **keyed on the asset ID, not the cue**. Keying on the cue would remount the element on
  every slide change, so a background video would restart from frame one — and re-buffer — each time the
  operator advanced a lyric over it.
- It is **hidden, not unmounted**, when the layer is not visible. Unmounting destroys the element, so
  returning from a black-out would restart the clip rather than resume it. An operator blacks out between
  songs and expects the loop to still be running when they come back. The camera layer has always
  worked this way; the media layer matches it.

### Background video is silent and looping

A background is scenery. The church PA carries the service's sound, and a loop with its own audio would
talk over the worship leader. Muting is also what makes autoplay work at all — Chromium refuses to
autoplay a video with sound, so an unmuted background would sit on its first frame and look broken.

Playing a video *for* its audio is a different feature, and it is NOT IMPLEMENTED.

### A media item that cannot present says so, and says it is fixable

An image or video item with no file chosen, or whose file has been deleted, is reported as
`missing-media` — **not** `not-implemented`. Media works; this is something the operator can fix on
Thursday rather than something they must wait for a release to get. The distinction reaches the
interface, so the running order shows a reason with a remedy instead of a phase number.

The **asset's** kind wins over the item's kind. They can disagree — an item saved as `image` whose
asset was replaced, or a hand-edited running order — and trusting the item would build an `<img>` for
an MP4, which renders as a broken-image icon on the projector.

---

## Video poster frames are NOT IMPLEMENTED

Extracting a frame needs a video decoder. Electron's `nativeImage` has none, so the options are to
bundle ffmpeg (a large per-platform native dependency, for a thumbnail) or to load the file into a
hidden renderer, seek it and paint it to a canvas. The second is feasible and is where this should go,
but it means a window whose only job is decoding, competing with the projector for GPU time — not
something to add during a phase that has to stay safe for a Sunday.

So a video's `thumbnailUrl` is `null`, and **every** surface that shows previews renders a labelled
placeholder saying there is no preview frame. Not a blank square: an operator who sees an empty tile
concludes the import failed and imports the file again.

Image thumbnails are 480px wide, never upscaled past the original, and the dimensions recorded are the
**original's** — those are what tell you whether a background can fill a 16:9 projector without being
stretched.

---

## Making the capability reachable

`background.mediaAssetId` was honoured by the renderer, carried by the theme spec and served by the
protocol — and settable from no interface at all. A capability with no way to invoke it is not a
feature, and this project has already shipped that exact mistake once: in Phase 3 the service theme
picker saved a field that precedence made inert, so a control the operator could set did nothing.

Phase 5 therefore added two controls it would otherwise have skipped:

- **Themes → Customise → Edit background.** Built-in themes stay immutable — they are what an operator
  falls back to when a custom theme goes wrong — so "Customise" creates a CHILD theme that inherits
  everything and overrides only its background. That is the mechanism themes were built around, and it
  means a later correction to the built-in still reaches the child.
- **Media → Add to a service.** `buildCues` turns an image or video item into a real cue, but the
  minimal service builder adds songs only and the full builder is Phase 8. Without this button the
  media-cue path would be implemented and unreachable.

Both are narrow on purpose. The theme editor edits the background and nothing else, and says so on
screen.

---

## Unverified {#unverified}

**Nothing in this phase has run in Electron.** The build sandbox has no Electron binary, no
`node_modules` and no display (docs/ENVIRONMENT.md), so the following are implemented and tested at
the unit level but have never executed:

- protocol registration and whether Chromium accepts the privileges as declared;
- actual image display and video playback from `app-media://`;
- **seeking** — the Range forwarding is asserted at the handler level, not against a real `<video>`;
- thumbnail generation, because `nativeImage` needs Electron;
- the file dialog, and therefore the whole import path end to end;
- every rendered layout in this phase, at every viewport width.

`npm run typecheck` and `npm run build` have also not been run here for the same reason. The local gate
(`node tools/local-typecheck/check.mjs`) covers main, preload, shared and tests with full semantics, and
the renderer for syntax and name resolution only — it cannot see React's or Tailwind's types.
