# PROGRESS.md

Where the work stands. Durable architecture/conventions are in `CLAUDE.md`.

_Last updated: 2026-09-25, at the end of the session that merged #71–#77._

## Where things stand

**Branch:** `claude/multi-account-cloudwatch-insights-shyq4m` (the standing
feature branch — restarted from `main` each round, same name).

**Open:** only the PR carrying these notes. Everything else is merged, and
nothing is half-written.

**Merged before this session:** #63 (rail rename, portal menu, folded
catalogue), #64 (autosaved live sessions + session strip), #65 (one Sessions
list, templates under Add), #66 (strip ⋮ + page-title card), #67 (Aggregator
tabs layout), #68 (every session is an Aggregator), #69 (spacing, Create
button, Tabs first, saved-items rework, services/tools back under Add), #70
(CloudWatch and OpenSearch split into two group permissions; saved rows read
as their name).

**Merged this session:** #71 (moved these notes and the e2e suites into the
repo), #72 (session categories — Slack-style groups in the rail with
drag-to-file — and a freeform "Dashboard" layout for the Aggregator, panes
placed and resized by dragging), #73 (a closed session stays inside its
category, dimmed; the dashboard layout refuses to let panes overlap while
being dragged or resized, and snaps them to a grid and to their neighbours'
edges/gaps), #74 (dashboard panes resize from any corner instead of just
bottom-right; dragging toward the bottom edge auto-scrolls; moving/resizing
keeps a minimum gap, shown while dragging as a dashed "cut lines" preview;
the resize-handle corner glyphs were dropped in favour of the cursor
changing shape), #75 (resizing, not just dragging, is now blocked from
crossing the canvas's own edges — growing a pane's top edge could push it up
over the "Panes" card, growing or dragging its right edge could push it past
the canvas's width and force the page into horizontal scroll; resize
handles now cover the four edges as well as the four corners, each moving
only the one dimension it sits on), #76 (a first attempt at "new panes land
in the first free place" and a `scrollbar-gutter: stable` canvas edge — it
only held up for panes opened all at once into a fresh session, which is all
its suite, smoke41, exercised), #77 (the dashboard fixed for how it's
actually used — panes added one at a time, moved, closed and reopened,
sessions closed and reopened — each bug reproduced in the browser first):

- *Panes jumping / landing on each other.* A never-dragged pane had no stored
  place and was re-laid-out every render, so it jumped whenever a pane before
  it moved; a closed pane reopened on top of whatever had taken its spot.
  `resolveDashboard()` now keeps each non-colliding stored rect, gives the
  rest the first free spot in reading order (`firstAvailableRect()`, which
  searches the real gaps between panes), and an effect stores every new
  placement at once. Closing a pane forgets its spot; expanding a minimised
  pane that others moved under relocates *it*. Panes start flush with the
  "Panes" card; neighbour edges beat the 20px grid when snapping.
- *Can't drag after reopening a session.* The canvas width came from a
  page-wide `document.querySelector`, which with two sessions mounted found
  the hidden one's 0px canvas and clamped every drag/resize in the other.
  Now measured per session with a ref + `ResizeObserver`.
- *Closing a session lost its last changes* — and a session closed before
  its first save reopened empty — because closing removes it from the
  workspace before the 1.2 s sync debounce fires. `WorkspaceSync.close()`
  now pushes its state first, on the same request chain as the close.
- *Scrollbar at the window's edge*: `.shell`'s right padding moved inside
  `.content`, so every card is 16px clear of a scrollbar that now sits
  against the window.
- *From an audit:* dragging a minimised pane overwrote its height with the
  40px header's; Escape now cancels a dashboard move/resize; a
  browser-cancelled pointer no longer commits.

  Coverage: `smoke42.mjs`, confirmed to fail against the previous code
  before passing.

## Done and working

Everything below is merged and verified against the running app.

- **Sessions.** One session type (Aggregator) holding panes; tabs / side-by-side
  / stacked / dashboard layouts, tabs default and offered first. In tabs/
  side-by-side/stacked, panes reorder by dragging (pointer events, with edge
  auto-scroll) and minimise individually. In **dashboard**, panes get a
  freeform pixel position and size instead (`dashboardRects` in session
  state; a pane with no place yet, or whose place is taken, gets the first
  free spot in reading order, stored at once so it never moves by itself;
  the canvas width is measured per session, never with a page-wide
  selector): dragging
  a header moves a pane, a handle on any corner or edge resizes it (an edge
  handle moves only that one dimension), both snap to a 20px grid and to
  neighbouring panes' edges/gaps, and neither a drag nor a resize is allowed
  to end with two panes closer than the standard 16px gap — it slides along
  whichever axis is still free, or holds at the last position that kept the
  gap. Neither can cross the canvas's own edges either: not left/top (where
  the "Panes" card is) or right (the canvas's measured width, the same as
  the Panes card's, which `scrollbar-gutter: stable` keeps from shifting
  when a vertical scrollbar appears or disappears); there's no ceiling on the bottom edge,
  which the canvas grows and auto-scrolls to reach instead. While dragging or
  resizing, the pane itself follows the raw pointer and a dashed "cut lines"
  outline shows the snapped, gap- and boundary-respecting spot it will
  actually land in on release; Escape cancels. Sessions autosave to
  `live_sessions` (1.2 s debounce, and a close pushes its latest state first),
  survive a reload, follow you to a fresh browser profile, and split Close
  (kept, dimmed in the panel, still inside its category if it had one) from
  Delete (gone, and it asks first).
- **Shell.** Left rail: Home, every session grouped into named categories you
  drag sessions into and out of (Slack-style, collapsible, with a count badge;
  uncategorized sessions sit above them) — open sessions at full strength,
  closed ones dimmed in place rather than pulled into a separate list — then
  ＋ Add — "Start new session…", every service and tool as a one-click session
  named after it, then saved templates. The strip above the body carries the
  open tabs, a ＋ mirroring Add, and a ⋮ for the session on screen; it sits in
  a sticky dock so it is exactly as wide as the cards. A page-title/description
  card sits under the rail. All gaps are 16px; the body's scrollbar sits at
  the window's edge, with the cards 16px clear of it.
- **Panes:** CloudWatch Logs Insights, OpenSearch, IoT (things + certificates
  with detail panels), DynamoDB, S3, Cognito; tools: HTTP client, MQTT tester,
  JWT, Base64, diff.
- **Assistant:** per-pane "build a query" plus a cross-service question over
  whatever the open panes have registered (LiteLLM, optional — hidden unless
  configured).
- **Admin:** environments, user groups (IAM role, visible environments, one
  flag per page — CloudWatch and OpenSearch now separate), users, app title and
  logo, themes, and one **Saved items** panel (Session Templates first, then Log
  Queries, IoT Searches, S3, DynamoDB, HTTP Requests, MQTT Topics).
- **Tests:** 163 backend tests green; 30 Playwright suites green.

## In progress / where I left off

Nothing. The tree is clean and everything is merged; the next session starts
by restarting the branch from `main`
(`git fetch origin main && git checkout -B <branch> origin/main`).

**Dashboard ideas offered to the user, not started** (their call which, if
any): a "Tidy up" action that re-packs every pane; maximise a pane to fill
the canvas (and back); moving and resizing from the keyboard; and — the one
with the most reach — storing x/width as fractions of a column grid rather
than pixels (Grafana-style). Sessions sync across browsers and templates are
shared, so a dashboard built on a wide monitor currently gets slid in or
re-placed on a laptop (`resolveDashboard`), and a re-placement is stored.

## Known issues

- **smoke21 occasionally fails** on a click that times out under load; it
  passes on a re-run. smoke29 used to fail the same way — a fresh profile read
  the server's session list before it had landed — and was fixed by waiting for
  the row rather than reading the rail the instant it renders. Prefer that fix
  to calling a suite flaky. smoke35 has the same class of flake now: a strict
  string compare of the sticky dock's background against the page's ends up
  `rgba(…, 0.992)` on one side once in a while — a paint that hadn't quite
  settled, not the colours actually differing — and passes standalone.
- **A category left in the dev database changes every session's ⋮.** Once any
  category exists, `SessionMenuItems` (correctly) adds "Move to <category>" to
  the menu — which broke smoke30's old hardcoded three-item list the one time
  a "Prod" category from manual testing was still sitting in the database when
  the suite ran. `clearWorkspace()` in `harness.mjs` now clears categories too,
  and any suite that creates one deletes it at the end (see smoke37) — but a
  suite that seeds a category outside that helper and forgets to clean up will
  reintroduce this for whatever runs after it.
- **Templates accumulate.** Nothing prunes saved templates, and the dev database
  has ~20 junk ones from test runs ("Agg save 17899…", "Legacy CloudWatch
  template"). Harmless, but it makes the Add list and the Session Templates tab
  long in screenshots.
- **Deleting a template in Settings doesn't refresh the Add list** until
  something else reloads the templates context. Minor, unreported by the user.
- **Dashboard positions are pixels.** See the column-grid idea above: on a
  narrower window than the one a dashboard was laid out in, panes past the
  right edge are shown slid back inside, and one that would then collide is
  re-placed in the first free spot — permanently, since placements are stored.
- The `user_groups.aggregator_enabled` column is dead — every session is an
  Aggregator, so nothing reads it. Left in place deliberately (dropping it is a
  schema change for no gain); there is no toggle for it in Settings.

## Working agreements from this session

- The user reports UI issues in batches, numbered. Work the whole batch, then
  one commit and (when asked) one PR per batch.
- **Verify in the browser, not in the diff.** Every real bug this session was
  found by driving the running app — instrumented probes for a menu that closed
  itself, computed-style checks for `hidden`, forced scrollbar gutters for a
  width mismatch. Reading the diff would have missed all three.
- **Reproduce the user's actual sequence before fixing, and prove the new
  suite fails on the old code.** #76 shipped a placement fix whose suite only
  opened panes all at once into a fresh session; the user's flow (one at a
  time, moving in between, closing and reopening) failed in three separate
  ways it never touched. #77 started from a scratch script driving exactly
  that flow, and checked smoke42 against the old code with
  `git stash push -- frontend/src` before trusting it.
- Screenshots are welcome in the reply when the change is visual — but
  headless Chromium doesn't paint scrollbars in them, so anything about the
  scrollbar has to be shown with measured geometry, not a picture.
- Keep the user's own wording for features ("session", "pane", "template") —
  they are precise about it.

## Dev environment

Postgres, backend and frontend, from the repo root:

```bash
# 1. Postgres (the container has a local cluster; docker-compose.yml also works)
pg_ctlcluster 16 main start
# first time only:
sudo -u postgres psql -c "CREATE USER cloudwatch_insights WITH PASSWORD 'cloudwatch_insights' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE cloudwatch_insights_smoke OWNER cloudwatch_insights;"
sudo -u postgres psql -c "CREATE DATABASE cloudwatch_insights_test OWNER cloudwatch_insights;"

# 2. Backend (port 8000)
cd backend
DATABASE_URL="postgresql+psycopg2://cloudwatch_insights:cloudwatch_insights@127.0.0.1:5432/cloudwatch_insights_smoke" \
ADMIN_PASSWORD='SmokeTestPass123!' \
python3 -m uvicorn app.main:app --port 8000

# 3. Frontend (Vite proxies /api to 127.0.0.1:8000)
cd frontend && npx vite --port 5179
```

Log in as `admin` / the `ADMIN_PASSWORD` you started the backend with.

**Env vars:** `DATABASE_URL` (or `POSTGRES_HOST` + friends) · `ADMIN_PASSWORD`
(bootstraps the admin user) · `COOKIE_SECURE=false` for plain-HTTP local use ·
`LITELLM_API_KEY` / `LITELLM_BASE_URL` / `LITELLM_MODEL` to enable the assistant
(all three, or it stays hidden).

**Checks:**

```bash
cd backend && DATABASE_URL="postgresql+psycopg2://cloudwatch_insights:cloudwatch_insights@127.0.0.1:5432/cloudwatch_insights_test" python3 -m pytest tests -q
cd frontend && npx tsc --noEmit && npm run build
```

pytest **must** get the `_test` database, never `_smoke`: `conftest.py` drops
and recreates the schema with its own admin password, after which the browser
suites can't sign in and every environment is gone. (It happened once this
session; recovery was `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` on
`_smoke` and restarting the backend, which re-bootstraps the admin.)

**Browser suites** live in the repo at `frontend/e2e/`. `node e2e/run-all.mjs`
from `frontend/` runs all 30 — about 25 minutes, one line per suite — and
`node e2e/run-all.mjs 29 33` or `node e2e/smokeNN.mjs` runs a subset. They need
the dev stack up and they clear the workspace first, so point them at a scratch
database. `frontend/e2e/README.md` has the configuration (`E2E_BASE_URL`,
`E2E_USER`/`E2E_PASSWORD`, `E2E_PLAYWRIGHT`, `E2E_CHROMIUM`) and, more usefully,
the list of traps that have already cost a release. Playwright is deliberately
not a dependency of the package; in this container:
`E2E_PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.mjs`.
Each suite's header comment says what it covers; 35 covers the spacing/Add
round, 36 the permission split and saved-row naming, 37 a closed session
staying inside its category, 38 the dashboard layout's collision prevention
and snapping, 39 its multi-corner resize, auto-scroll and minimum-gap
follow-ups, 40 its canvas-boundary fixes and edge resize handles, 41 panes
opened together packing into the canvas and the stable scrollbar gutter, and
42 the real-use flows from #77 (one-at-a-time placement, reopen, two
sessions, close-then-reopen, minimised drag, Escape, scrollbar geometry).

## Next steps, in order

1. Restart the branch from `main` (the notes PR aside, nothing is in flight).
2. Pick up the user's next batch of UI issues — that has been the rhythm of
   every round.
3. If the user picks one of the dashboard ideas above, the column grid is a
   stored-shape change: `dashboardRects` would need a migration (CLAUDE.md,
   "Old state shapes are migrated on load").
4. Optional, only if the user wants them: prune the junk templates from the dev
   database; refresh the templates context after a delete in Settings; decide
   whether CI should run the browser suites (it does not — they need a backend,
   a seeded Postgres and an admin login, which is its own piece of work).
