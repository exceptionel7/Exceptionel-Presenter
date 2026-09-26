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

Run from the repository root:

```bash
tsc --noEmit --ignoreConfig --strict --erasableSyntaxOnly --noUncheckedIndexedAccess \
  --target es2023 --module preserve --moduleResolution bundler \
  --allowImportingTsExtensions --skipLibCheck --types "" \
  tools/local-typecheck/electron-shims.d.ts tools/local-typecheck/node-shims.d.ts \
  src/main/**/*.ts src/preload/*.ts src/shared/**/*.ts tests/*.test.ts
```

`--types ""` stops `tsc` looking for `@types/*` packages that are absent.

## Deliberate looseness

Listener parameters are `any[]` and many Electron APIs are approximated. These shims exist to catch
**scope errors, arity mistakes and obvious typos in our own code**, not to reproduce Electron's API
surface. Anything that depends on precise Electron types must be verified with `npm run typecheck`
on a real install.
