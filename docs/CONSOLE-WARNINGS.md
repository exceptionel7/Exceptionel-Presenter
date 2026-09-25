# Console warnings in development — what they are

Every message that appears in DevTools or the `npm run dev` terminal on a healthy
development run, with a verdict for each. Anything not on this list is worth investigating.

Current state on a clean run: **0 errors, 1 warning**, and that warning is Electron's own.

---

## `Electron Security Warning (Insecure Content-Security-Policy)`

> This renderer process has either no Content Security Policy set or a policy with
> "unsafe-eval" enabled. This exposes users of this app to unnecessary security risks.
> **This warning will not show up once the app is packaged.**

**Verdict: benign and expected. No action.**

Electron emits this whenever it sees `'unsafe-eval'` in a CSP. Ours is there deliberately and
only in development, because Vite's dev transform requires it. `src/main/security/policy.ts`
adds `'unsafe-eval'` and `'unsafe-inline'` **only** when a dev server URL is present and the
app is not packaged.

Two tests hold that line:

- packaged CSP contains no `unsafe-eval` and no `unsafe-inline` in `script-src`
- the relaxation cannot leak into production even if a dev-server URL is still set

Not suppressed. `ELECTRON_DISABLE_SECURITY_WARNINGS` would hide this *and* every genuine
security warning Electron might raise later, which is a bad trade for a tidier console.

Verify it is gone in a real build with `npm run dist`.

---

## `Request Autofill.enable failed` / `Request Autofill.setAddresses failed`

> `{"code":-32601,"message":"'Autofill.enable' wasn't found"}`
> source: `devtools://devtools/bundled/core/protocol_client/protocol_client.js`

**Verdict: benign, not our code. No action.**

Chrome DevTools asks for the `Autofill` domain of the DevTools Protocol; Electron does not
implement it. The source path is inside DevTools itself. It appears only while DevTools is
open and has no effect on the application.

---

## `(node:NNNN) ExperimentalWarning: SQLite is an experimental feature`

**Verdict: expected. No action.**

`node:sqlite` is still flagged experimental by Node, though it is available unflagged and is
used in production by this app deliberately — see `docs/ARCHITECTURE.md` §3 for why it is
preferred over `better-sqlite3`. The API we depend on is small: `DatabaseSync`, `prepare`,
`run`, `all`, `get`, `exec`. A `SqliteDriver` interface isolates it, so swapping engines would
not reach any calling code.

The test suite suppresses this with `--disable-warning=ExperimentalWarning` for readable
output; the application itself does not suppress it.

---

## `Download the React DevTools for a better development experience`

**Verdict: informational. No action.** React prints this in development builds.

---

## FIXED: `'console-message' arguments are deprecated`

> Please use `Event<WebContentsConsoleMessageEventParams>` object instead.

**Was caused by our own code**, in the renderer-log forwarding added to make blank-window
failures visible. Electron changed the event from
`(event, level: number, message, line, sourceId)` to a single details object with a string
`level`, and the old form is scheduled for removal.

Fixed in `src/main/windows/console-message.ts`, which reads **both** shapes. Both are tested.
Handling both rather than committing to the new one is deliberate: this is the code that makes
renderer failures visible, so if it silently stops working after an Electron upgrade, every
future renderer bug becomes invisible again — exactly the failure it exists to prevent. It
returns `null` on an unrecognised shape rather than throwing inside a main-process handler.

---

## Where to look when something is wrong

The `npm run dev` terminal is the first place to check. It receives:

| Prefix | Meaning |
|---|---|
| `[window:<role>] loading <url>` | which URL each window is opening |
| `[preload] exposed window.exceptionel for role "<role>"` | the bridge installed successfully |
| `[renderer:<role>] …` | forwarded renderer console output |
| `[preload:<role>] … threw:` | the preload failed — the UI will report "could not reach its application core" |
| `[renderer:<role>] failed to load …` | navigation or dev-server failure |
| `[crash] <role> renderer gone` | the renderer process died |

In development every severity is forwarded, including the preload confirmation. A packaged
build forwards only warnings and errors, so a live service is not slowed by log traffic.

**If `[preload] exposed window.exceptionel` is missing**, the bridge did not install and the
UI will show the "could not reach its application core" screen. That is the single most useful
line in the terminal.
