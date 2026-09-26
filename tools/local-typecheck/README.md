# Local typecheck shims

Ambient declarations that let `tsc` check this codebase **in an environment where
`npm install` cannot run**, such as the offline sandbox described in `docs/ENVIRONMENT.md`.

**On a normal machine you do not need any of this.** Run `npm run typecheck`, which uses the real
`@types/node` and Electron's own types and is the authoritative check.

## Why these files are here and not in `tests/`

They are outside every `tsconfig` `include` on purpose. `node-shims.d.ts` declares globals such as
`process` and `Buffer`, and `electron-shims.d.ts` declares the `electron` module. On a machine with
the genuine types installed, both would conflict with the real declarations and break
`npm run typecheck`.

## Why they matter

Without them, the files that import `electron` — `src/main/index.ts`, `src/main/windows/*`,
`src/preload/index.ts` — could not be typechecked in the sandbox at all. They were only
*parse*-checked, which does not perform scope analysis.

That gap let a real bug reach a release: `wireless` and `cameras` were referenced by a handler
created before their `const` declarations, so the app died at startup with
`Cannot access 'wireless' before initialization`. TypeScript reports that as **TS2448** the instant
it can see the file. Every unit test passed, because the fault was in wiring rather than logic.

## The command

```bash
npm run typecheck:local          # → node tools/local-typecheck/check.mjs
```

`check.mjs` runs two passes and is the only invocation anyone should use. **Do not hand-roll a
`tsc` command**; the previous practice of doing so is what caused the failure described below.

`--types ""` stops `tsc` looking for `@types/*` packages that are absent.

## The renderer pass, and the bug that made it necessary

`src/renderer/**` imports React and Tailwind types that cannot be resolved without
`node_modules`, so it is checked with `--noResolve`. That produces a great deal of unavoidable
noise (TS2307 cannot-find-module, TS7026 unknown JSX, and so on), and the ad-hoc command in use
before `check.mjs` coped by grepping for **syntax errors only** — `error TS1[0-9]{3}:`.

That filter was blind to the single most likely mistake a human makes.

`src/renderer/output/OutputApp.tsx` called `useWirelessCameraHost()` **without importing it**. The
output renderer threw `ReferenceError` on its first render, mounted no React tree, and therefore
subscribed to no IPC events. `webContents.send` has no acknowledgement, so every message main sent
it was absorbed in silence: the phone's `ready` never produced a WebRTC offer, and the entire
Wireless Camera feature was dead. The window is hidden, so there was nothing to see either.

`tsc` had been reporting it as **TS2304** the whole time. The filter discarded it.

`check.mjs` therefore uses an **allow-list of fatal codes** rather than a deny-list of noise —
TS2304, TS2552, TS2448, TS2454 and friends — because a deny-list silently forgives every code
nobody has thought about yet. Which is exactly what happened.

## What this cannot catch

Type *compatibility* inside the renderer: wrong props, a mismatched hook return, a bad Tailwind
plugin type. Those need `npm run typecheck` with dependencies installed. `check.mjs` says so on
every successful run rather than letting a green tick imply more than it proves.

## Deliberate looseness

Listener parameters are `any[]` and many Electron APIs are approximated. These shims exist to catch
**scope errors, arity mistakes and obvious typos in our own code**, not to reproduce Electron's API
surface. Anything that depends on precise Electron types must be verified with `npm run typecheck`
on a real install.
