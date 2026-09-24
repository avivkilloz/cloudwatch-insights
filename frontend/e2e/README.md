# Browser suites

Playwright scripts that drive the real app against a real backend. They are the
only test coverage the frontend has, and they are not part of `npm run build` or
CI — you run them yourself, against a dev stack, when you have changed the UI.

They are plain `.mjs` scripts rather than a test runner's files: each one logs
in, does a sequence of things a person would do, and prints `OK:` / `FAIL:` per
assertion. `harness.mjs` holds what they share.

## Running them

You need Postgres, the backend and the frontend up (see `PROGRESS.md` at the
repo root for the exact commands), with an admin account whose password matches
what the suites use.

```bash
cd frontend
node e2e/run-all.mjs          # every suite, one line each — about 25 minutes
node e2e/run-all.mjs 29 33    # just those two
node e2e/smoke33.mjs          # one suite, with all of its output
```

Configuration, all optional:

| variable | default | what it is |
| --- | --- | --- |
| `E2E_BASE_URL` | `http://127.0.0.1:5179` | where the frontend is served |
| `E2E_USER` / `E2E_PASSWORD` | `admin` / `SmokeTestPass123!` | the account they sign in as |
| `E2E_SHOT_DIR` | `e2e/screenshots` (git-ignored) | where screenshots land |
| `E2E_PLAYWRIGHT` | — | an installed Playwright to import, if `playwright` does not resolve |
| `E2E_CHROMIUM` | — | a Chromium executable to use instead of Playwright's own |

Playwright is deliberately **not** a dependency of this package — it would add a
browser download to every `npm ci` in CI, which builds the app and never runs
these. Install it where you run them (`npm i -D playwright`), or point
`E2E_PLAYWRIGHT` at a copy.

Each suite clears the workspace first — both the server's live sessions and this
browser's IndexedDB — so running them against a database you care about will
throw away your open sessions. Point them at a scratch database.

## Writing one

Start from the newest suite; the shape is always: a comment saying what this
covers, `launch()`, sign in, clear the workspace, drive the app, `report()`.

What has actually gone wrong here before, and what the harness or a check has to
account for:

- **Every session body stays mounted.** A pane selector that is not scoped to
  `SHOWN` (`.session-body:not([hidden])`) sees every open session's tabs at
  once, and passes for the wrong reason. The same goes for `.panel` — the first
  one in the body can belong to a session you are not looking at.
- **Headless Chromium draws overlay scrollbars** (0px wide), so a bug where an
  element is wider than the cards by exactly one scrollbar is invisible here.
  Force a real gutter first: `page.addStyleTag({ content: ".content {
  scrollbar-gutter: stable; }" })`.
- **`hidden` is not proof.** Check the computed `display`: an author
  `display: flex` beats the UA's `[hidden] { display: none }`, which is a bug
  this app has actually shipped.
- **Assert on elements, not on the page's text.** `indexOf("Open")` matched
  "OpenSearch"; `text=Start a session` matched a paragraph describing the home
  page. Use `:text-is(...)` against the element that should carry the string.
- **Clear IndexedDB as well as the server.** Clearing only the server leaves
  this browser's copy to be adopted and pushed straight back up — the adoption
  rule working correctly, and your suite failing for no reason.
- **Print what you found.** `check(ok, label, detail)` shows `detail` only on
  failure; a tally of what was actually on screen saves a whole rerun.
- **Leftovers break the next run.** A suite that creates a group, a user, a
  template or a category deletes it at the end *and* copes with finding one
  from a run that died half-way. A stray category is the quiet one: once any
  category exists, every session's ⋮ correctly grows a "Move to <category>"
  item, which breaks an older suite's hardcoded list of what the menu offers.
  `clearWorkspace()` clears categories along with sessions, but only for
  suites that call it.

`smoke21` occasionally fails on a click that times out under load; it passes on
a rerun. (`smoke29` used to fail the same way — a fresh profile read the
server's session list before it had landed — until it was made to wait for the
row instead. Prefer that fix to calling a suite flaky.)
