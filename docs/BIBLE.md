# Bible module (Phase 4)

## No scripture ships with this application

Not an oversight — a decision, and the one that shapes everything else here.

Most Bible translations are under copyright. Bundling one would mean either distributing someone's
work without permission, or picking a single edition and thereby restricting which churches can use
this software. Neither is acceptable, so **the application contains no verse text at all** — not in
the product, and not in its tests, where every verse is obviously synthetic placeholder prose.

Three things enforce it rather than merely documenting it:

- `bible_translations.license` is `NOT NULL` in the schema (migration 0001).
- `validateBiblePackage` **refuses** a package with no licence, and refuses non-answers — `n/a`,
  `none`, `-`, `unknown`, `tbd`, `all rights reserved`. It does *not* refuse short real licences:
  `MIT` and `CC0` are complete statements of terms.
- The licence string is stored **verbatim** and displayed in the Bible workspace, and travels on
  every resolved passage as `copyrightNotice` so attribution is available wherever text is shown.

The visible consequence: a fresh installation cannot show scripture. The Bible section says so, and
says why, instead of showing an empty list that looks like a fault.

## The package format

One JSON file.

```json
{
  "translation": {
    "id": "example",
    "abbreviation": "EX",
    "name": "Example Version",
    "language": "en",
    "license": "Public domain",
    "sourceUrl": "https://example.org/where-this-came-from"
  },
  "books": [
    { "number": 43, "chapters": [["verse one", "verse two"], ["next chapter"]] }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `translation.id` | yes | `[A-Za-z0-9_-]`, max 64. Becomes a primary key and crosses IPC. |
| `translation.abbreviation` | yes | Max 16 characters. Shown on screen beside a reference. |
| `translation.name` | yes | |
| `translation.language` | no | Defaults to `en`. A label, not validated further. |
| `translation.license` | **yes** | See above. |
| `translation.sourceUrl` | no | Recorded so the origin of the text is traceable. |
| `books[].number` | either | Canonical position 1–66. |
| `books[].name` | either | Any name or alias the canon table accepts, so a third-party dataset usually imports unmodified. A local-language name is kept for display. |
| `books[].chapters` | yes | `chapters[c][v]` — nested arrays, not `{chapter, verse, text}` objects, which would triple the file size of a ~31,000-verse Bible in repeated keys. |

Nested arrays mean a chapter cannot have gaps by construction. Verse text is
whitespace-normalised **once, at import**, so the stored text is already clean and every consumer
agrees rather than each render guessing.

**Rejected:** unknown or duplicated books, empty books or chapters, non-string verse text, and
implausible sizes (>200,000 verses, >5,000 characters per verse, >150 chapters per book, >200 verses
per chapter). Import runs in the main process — the one driving the projector — so a corrupt or
hostile file must fail fast rather than being loaded in full first.

**Warned, not rejected:** an empty verse (some editions genuinely omit one) and a partial canon (a
New Testament, or one book for testing). Both are legitimate; both are things the operator should
know before Sunday.

Problems are **collected**, up to 50, each with a path like `books[12].chapters[3][5]`. Someone
fixing a hand-made package wants the list, not a game of whack-a-mole.

`resources/sample-translation.json` is a structural sample for exercising the import path. **It is
not scripture** — every "verse" says so in plain words. It exists so the pipeline and the workspace
can be verified without publishing anyone's translation.

## Reference parsing

`src/shared/domain/bible-reference.ts`. Pure, zero dependencies, ~26 tests.

Accepted: `John 3:16` · `John 3:16-18` · `John 3` · `Psalm 23:1-6` · `1 John 2:1` · `Rom 8` ·
`Matthew 5:3-12` · `Gen 1.1-5` · `Matthew 5:3–12` (en/em dash) · `III John 4` · `Jude 3` ·
`Song of Solomon 1:1` · `PSALM 119:105` · `john   3 : 16`.

Four decisions worth stating:

**A whole chapter is not its first verse.** `Romans 8` parses with `startVerse: null`, which is
deliberately distinct from `Romans 8:1`. Flattening the two would present one verse where a whole
chapter was asked for — a silent wrong answer.

**Ambiguity is refused, never resolved by list order.** `Jud` could be Judges or Jude; `Ph` could be
Philippians or Philemon. The parser returns both candidates and the workspace offers them as buttons.
Guessing would put the wrong passage in front of a congregation and nobody would notice until it was
read aloud.

The canon table originally gave `hb` to *both* Habakkuk and Hebrews. The lookup map is
insertion-ordered, so Hebrews silently won and `Hb 2:4` would have produced the wrong book with no
warning. A test now enumerates all 288 accepted spellings and fails on any collision.

**In a one-chapter book a bare number is a verse.** `Jude 3` means the third verse — there is no
third chapter of Jude. `Jude` alone means the whole book. The five affected books (Obadiah, Philemon,
2 John, 3 John, Jude) carry a `singleChapter` flag; this is canonical structure, not
translation-specific data.

**A single psalm is cited in the singular.** `Psalms 23` normalises to `Psalm 23`. It is read aloud in
front of people.

**A reversed range is refused, not swapped.** `John 3:18-16` is usually a typo in one of the two
numbers, and guessing which would as often as not present the wrong passage.

### Syntax and existence are different questions

`parseReference` decides whether a reference is *well formed*. It knows nothing about what is
installed. `BibleRepository.lookup` decides whether the text *exists*, with its own codes:
`no-translation`, `book-missing`, `chapter-missing`, `verses-missing`.

Keeping them apart is what lets the workspace say **"this translation does not include Romans"**
instead of **"bad reference"**. Same input, two entirely different remedies.

`bible:lookup` therefore returns a discriminated **result**, not a thrown failure — because "that
translation has no Romans" is an *answer*, and collapsing it into a red error banner would throw the
specific remedy away.

## Storage

Translations are **local installations, not synced library content.** Migration 0003 gave these
tables no `revision`, `origin_device_id` or `deleted_at`, and the repository records no sync
operations.

A whole Bible is ~31,000 rows and several megabytes; pushing that through the change log would swamp
it to replicate something every machine can reinstall from its source. Deletes are therefore **real
deletes** — there is nothing to tombstone.

The consequence, stated plainly rather than hidden: installing a translation on the booth machine
does not install it on the office machine.

`bible_verses` is `WITHOUT ROWID` on a composite primary key
`(translation_id, book_number, chapter, verse)` — the access path for every lookup, so a separate
rowid would cost space and an indirection on every one of those rows. Search is FTS5 with
`remove_diacritics`, coordinates riding along as `UNINDEXED` columns so a hit resolves straight to a
reference.

Chapter and verse counts are read from the **installed text**, never a versification table, so the
operator's pickers offer only verses that exist. Versification genuinely differs between editions.

## Scripture in the presentation engine

**There is no second rendering path.** This was the governing constraint of Phase 4, and
`tests/presentation.test.ts` fails if one appears — including an assertion that `SlideCanvas` contains
no scripture-specific branch at all once comments are stripped.

A scripture cue is an ordinary `Cue`: its verses are in `lines`, exactly where lyrics go. It adds two
optional fields:

- `caption` — the reference, rendered **inside** the z3 text layer. So it inherits the theme's
  alignment and scrim, `Clear` hides it along with the verses it names, and it animates with them. A
  reference that outlived its verse would be worse than none.
- `scripture` — the structured citation (translation, book, chapter, start and end verse, normalised
  reference, licence). **Not flattened into a display string**: the confidence monitor wants the
  reference, an operator wants to know which translation is on screen, and attribution needs the
  licence. Flattening would force each of them to re-parse what was already known.

Caption size is derived from the **fitted** body size, not the theme's declared size, so on a dense
slide that auto-fit has shrunk the caption shrinks with it.

### Splitting a passage

`packPassageIntoSlides` calls **`fitSlideText`** — the same tested function the renderer uses to size
type. A verse joins the current slide only while the result still fits at full size; the moment it
would force a shrink, the slide closes. So scripture breaks at verse boundaries according to the same
geometry that decides whether lyrics fit, rather than a guessed verses-per-slide constant that would
disagree with the renderer the moment a theme changed its type size.

A theme with large type therefore produces more slides than one with small type, automatically.

Two details: a single verse too long to fit alone still gets its own slide (auto-fit shrinks it there
— the alternative is an infinite loop or a dropped verse), and there is a ceiling of 6 verses per
slide regardless of fit, because "it fits" and "it can be read from the back row in the time it is on
screen" are different questions and only the first can be computed.

Verse numbers appear on multi-verse slides and are **omitted** on single-verse ones, where the caption
already says which verse it is.

### Camera + Scripture

Falls out of the existing layer stack with no new code, exactly as Camera + Lyrics does: the camera is
z1, text is z3. The camera layer knows nothing about scripture, and a test asserts that.

### What a service stores

A scripture item stores its **reference and translation id** in `service_items.config`, not a copy of
the text. Re-opening a service always reads the currently installed translation rather than a stale
snapshot. Two readings in one service may use different translations, which is ordinary in a bilingual
church.

If a reference no longer resolves — a mistyped edit, or a translation the operator removed — the item
is reported as `scripture-unavailable` with `phase: null`. That last part matters: it is a **data
problem the operator can fix**, not a missing feature they must wait for, and the running order says
so inline the moment the service is opened.

## Known limitations

- **No translation is included.** One must be imported before scripture can be presented.
- **66-book Protestant canon only.** Deuterocanonical books are a data-table change; every consumer
  reads the table rather than assuming a count.
- **Per-service verse-per-slide overrides are not exposed.** `packPassageIntoSlides` accepts
  `maxVersesPerSlide` and `showVerseNumbers`, but no UI writes them — that belongs with the Phase 8
  service builder.
- **The file dialog is untested here.** The build environment has no Electron binary, so
  `dialog.showOpenDialog` has never been exercised. Everything behind it — reading, validating,
  installing — is tested through an injected seam.
- **Search ranks by FTS5 `rank` only.** No proximity weighting or phrase boosting.
