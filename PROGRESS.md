# PROGRESS.md

Where the work stands. Durable architecture/conventions are in `CLAUDE.md`.

_Last updated: 2026-09-24, end of the session that opened PR #71 and #72 and
is now finishing the round that follows them._

## Where things stand

**Branch:** `claude/multi-account-cloudwatch-insights-shyq4m` (the standing
feature branch — restarted from `main` each round, same name).

**Open:** only the PR carrying these notes. Everything else is merged.

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
placed and resized by dragging).

**In this round (not yet merged):** a closed session now stays inside its
category, dimmed, instead of dropping into one flat list at the bottom of the
rail (`backend/app/schemas.py`, `frontend/src/api.ts`,
`frontend/src/components/Sidebar.tsx`, `frontend/src/sessions/SessionContext.tsx`);
the dashboard layout added in #72 now refuses to let panes overlap while being
dragged or resized, and snaps them to a grid and to their neighbours'
edges/gaps (`frontend/src/pages/AggregatorPage.tsx`).

## Done and working

Everything below is merged and verified against the running app.

- **Sessions.** One session type (Aggregator) holding panes; tabs / side-by-side
  / stacked / dashboard layouts, tabs default and offered first. In tabs/
  side-by-side/stacked, panes reorder by dragging (pointer events, with edge
  auto-scroll) and minimise individually. In **dashboard**, panes get a
  freeform pixel position and size instead (`dashboardRects` in session
  state): dragging a header moves a pane, a handle on its corner resizes it,
  both snap to a 20px grid and to neighbouring panes' edges/gaps, and neither
  a drag nor a resize is allowed to end with two panes overlapping — it slides
  along whichever axis is still free, or holds at the last position that
  didn't overlap. Sessions autosave to `live_sessions` (1.2 s debounce),
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
  card sits under the rail. All gaps are 16px.
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
- **Tests:** 163 backend tests green; 26 Playwright suites green.

## In progress / where I left off

Nothing half-written — the tree is clean, verified against the running app,
and the only thing outstanding is the PR carrying this round's fixes (closed
sessions staying in their category, dashboard collision + snapping). Start the
next round by restarting the branch from `main`
(`git fetch origin main && git checkout -B <branch> origin/main`).

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
- Screenshots are welcome in the reply when the change is visual.
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

**Browser suites** live in the repo at `frontend/e2e/`. `node e2e/run-all.mjs`
from `frontend/` runs all 26 — about 25 minutes, one line per suite — and
`node e2e/run-all.mjs 29 33` or `node e2e/smokeNN.mjs` runs a subset. They need
the dev stack up and they clear the workspace first, so point them at a scratch
database. `frontend/e2e/README.md` has the configuration (`E2E_BASE_URL`,
`E2E_USER`/`E2E_PASSWORD`, `E2E_PLAYWRIGHT`, `E2E_CHROMIUM`) and, more usefully,
the list of traps that have already cost a release. Playwright is deliberately
not a dependency of the package; in this container:
`E2E_PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.mjs`.
Each suite's header comment says what it covers; 35 covers the spacing/Add
round, 36 the permission split and saved-row naming, 37 a closed session
staying inside its category, and 38 the dashboard layout's collision
prevention and snapping.

## Next steps, in order

1. Restart the branch from `main` (the notes PR aside, nothing is in flight).
2. Pick up the user's next batch of UI issues — that has been the rhythm of
   every round.
3. Optional, only if the user wants them: prune the junk templates from the dev
   database; refresh the templates context after a delete in Settings; decide
   whether CI should run the browser suites (it does not — they need a backend,
   a seeded Postgres and an admin login, which is its own piece of work).
