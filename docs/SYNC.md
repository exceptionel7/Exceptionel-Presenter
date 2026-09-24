# Synchronisation model

**One library is authoritative. Other machines are replicas that pull from it.**

Not a single isolated station, and not multi-master sync where any computer can edit
anything and the results are merged.

## Why this shape

The question that matters is not "how many computers?" but **which direction do edits
travel?**

Churches work like this: someone builds Sunday's service midweek, often on a different
computer in the office or at home. Someone else runs it Sunday from the booth. Even a
"single operator" church usually has two machines involved.

That flow is one-directional — prep → booth. The booth operator on Sunday morning is
*running* the service, not editing the song library. Almost nobody edits the same song on
two computers in the same week.

Multi-master sync would force us to solve a problem the users do not have: "two people
changed this chorus differently, which wins?" With a single writer per entity, that question
never gets asked.

There is also a failure mode that matters more here than in most software. **A sync bug on
Sunday morning is catastrophic.** If the booth machine can accept an inbound merge, a
background pull can rewrite the running order ten minutes before the first song. With
pull-only-when-asked — and never during a service — that is structurally impossible.

## What was built now, and why it could not wait

Migration `0003` adds the foundation. Each item is cheap today and painful to retrofit,
because retrofitting means reconstructing history that was never recorded.

### 1. Tombstones (`deleted_at`)

Deletes mark the row instead of removing it.

A hard delete leaves evidence only in the change log. Prune that log, or have a replica miss
the entry, and **the deleted song comes back on the next pull**. Data returning from the
dead is among the worst sync bugs there is, and it cannot be fixed after the fact — the
information needed to distinguish "never seen" from "deliberately deleted" is gone.

Two consequences fall out for free:

- **Restore.** Nothing was destroyed, so `restore()` brings a song back with every section
  intact. Accidental deletion stops being a disaster.
- **Unique indexes had to become partial.** `themes(name)` and `media_assets(hash)` are now
  `UNIQUE ... WHERE deleted_at IS NULL`. Without that, deleting a theme called "Christmas"
  would permanently reserve the name, and deleting a media file would block ever
  re-importing that exact file.

### 2. Lamport revisions (`revision` + `origin_device_id`)

Ordering uses a counter, not a timestamp.

Last-write-wins on `updated_at` assumes clocks are correct. Church booth computers are
frequently months or years off — they are rarely-rebooted machines nobody administers. A
wrong clock makes LWW **silently discard the newer edit**, with no error anywhere. A
Lamport counter needs no clock at all: every local write takes
`max(our counter, anything observed) + 1`, so it always sorts after every change we know
about.

`origin_device_id` breaks ties on concurrent edits. It is arbitrary but *consistent*, which
is the property that stops two replicas reaching opposite conclusions and diverging. A test
exhaustively verifies convergence: for every pair of versions, both sides keep the same one.

The counter is allocated inside the write's transaction, so a rolled-back write rolls the
counter back too. A gap in revisions would look like a lost change during a pull.

### 3. Device identity (`app_identity`)

One row holding this installation's `device_id`, its `lamport_counter`, and `upstream_uri`
— which names the library it pulls from. `upstream_uri IS NULL` means **this machine is
authoritative**.

The id is generated on first access rather than in the migration. A migration runs
identically everywhere, so generating it there would give a restored backup the *same*
device id as the machine it came from — and two devices sharing an id breaks tie-breaking.

### 4. Scoping: what must never sync

| Scope | Examples | Reason |
|---|---|---|
| **Library** — syncs | songs, services, themes, playlists, presentations, announcements, media metadata | the shared content of the church |
| **Device** — never syncs | `camera_profiles`, `display_profiles`, `session_recovery` | they hold OS-assigned device and monitor ids, meaningless on another computer |

Syncing `display_profiles` would point the booth's projector output at a monitor id that
only exists on someone's laptop.

Settings are mixed, so they carry a `scope` column derived from the key:

- `presentation.defaultThemeId` → **library**
- `display.*`, `camera.*`, `app.*`, `confidence.*`, `autosave.*`, `cloud.*`,
  `presentation.aspectRatio` → **device**

`presentation.aspectRatio` is device-scoped because the projector's shape is a property of
the room, not of the library. Scope is always derived from the key and never supplied by the
caller, so a setting cannot be mis-scoped by a bug at a call site.

### Children are versioned by their parent

`song_sections`, `service_items`, `playlist_items` and `presentation_slides` get **no** sync
columns. Repositories replace them wholesale alongside their parent, so the parent row's
revision already versions them. Giving them their own revisions would invite partial merges
that produce a song with two choruses and no verse.

## One deliberate asymmetry

When a delete and an edit are genuinely concurrent — identical revision *and* identical
origin — **the edit wins and the row survives.**

The two outcomes are not equally bad:

- If delete won, someone's edit would vanish with no trace and no way to recover it.
- If the edit wins, a song someone deleted comes back — which is visible, obviously wrong,
  and fixed by deleting it again.

Recoverable beats silent. A delete that is genuinely *later* still wins normally; this rule
governs only true ties.

## Roadmap

| Stage | Status | Effort | Ongoing cost |
|---|---|---|---|
| Sync foundation (schema, clock, tombstones) | **done** | — | none |
| File export/import (`.exppkg`) | Phase 5 | ~1–2 days | none — no server, no accounts |
| Pull from a shared folder (Dropbox / OneDrive / NAS) | Phase 9 | ~1 week | none — the church's own storage |
| Hosted multi-device sync (Supabase) | Phase 10+, only on demand | ~1 month | hosting, auth, support, and we would then hold churches' data |

File export/import lands in Phase 5 rather than Phase 9 because it solves the prep → booth
handoff immediately and needs no infrastructure at all: a worship leader puts `sunday.exppkg`
on a USB stick. For most churches that is sufficient permanently.

Hosted sync is deliberately last. By the time it is built we will know what churches actually
ask for, instead of guessing now and carrying the cost.

## What will never be synced

**Camera video never leaves the computer.** Streams are opened locally in the renderer via
`getUserMedia` and are never routed through IPC, let alone the cloud. Media *metadata* syncs;
the binary files do not, unless explicitly requested.

**The application works fully offline.** Cloud features are additive. Losing internet mid-service
degrades nothing in songs, installed Bible translations, media, cameras, displays, playlists
or themes.
