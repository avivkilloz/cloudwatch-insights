# CLAUDE.md

Durable notes for working in this repo. Current state of the work-in-progress
lives in `PROGRESS.md`; the user-facing feature tour lives in `README.md` (long,
read the section you need rather than the whole file), and deployment in
`DEPLOYMENT.md`.

## What this is

An extensible platform whose unit of work is the **session**: a named workspace
holding whatever you need side by side, with one assistant that sees across all
of it. Today a session holds panes onto AWS services (CloudWatch Logs Insights,
OpenSearch, IoT Core, DynamoDB, S3, Cognito) and self-contained tools (HTTP
client, MQTT tester, JWT, Base64, diff), across several accounts and regions
behind one login.

It started as a multi-account AWS debugging console and is deliberately
outgrowing that. Do not design as if AWS debugging were the ceiling — where it
is going:

- **Plugins.** Services and tools become extensible: other clouds, in-house
  systems, anything. Nothing service-specific belongs anywhere a registry entry
  would do; `sessions/paneTypes.tsx` is that seam.
- **More kinds of section than services and tools.** A session will hold chat,
  code and workflow sections the way it holds panes today.
- **Dashboards** (saved views), **workflows** (n8n-style runs you keep and
  re-run), **chat** with people and with agents, and a **code** section
  (code-server with Claude, working in the context of the session). These four
  already exist as placeholder pages in `pages/pageTypes.tsx`.
- **A platform agent** that acts on the platform itself — creating and filling
  sessions, driving the tools — not only answering questions about what is open.

**What to call it** is genuinely unsettled, so avoid over-claiming in
user-facing copy. It is not an IDP in the Backstage sense (no software catalog,
no golden paths, no self-service provisioning); it is closer to an extensible
operations/engineering workbench, with Backstage (plugins), Grafana
(dashboards), n8n (workflows) and VS Code (workspace) as architectural cousins
rather than models. "Platform" is the safe word; **session**, **pane** and
**template** are the precise words for its parts, and the project uses them
consistently.

**Stack:** FastAPI + SQLAlchemy + Postgres (backend, Python 3.12) · React 18 +
TypeScript + Vite (frontend, no UI framework, no CSS framework — one hand-written
`styles.css`) · Docker images + Helm chart + ArgoCD for deployment.

## Layout

```
backend/app/
  main.py            app wiring: create_all, ensure_columns + one-shot backfills, routers
  db.py              engine/session, ensure_columns() additive schema evolution
  models.py          SQLAlchemy models        schemas.py  Pydantic in/out models
  auth.py            session cookie, get_current_user/require_admin, user_out()
  bootstrap.py       creates the Admin group + admin user on startup (idempotent)
  resolve.py         which IAM role a request assumes (group.role_name)
  aws_client.py      STS assume-role helper every *_client.py goes through
  *_client.py        one module per AWS service (iot, dynamodb, s3, cognito, opensearch…)
  ai_assistant.py    LiteLLM REST call + prompt building
  routers/           one file per resource; every route is auth-gated
backend/tests/       pytest, one file per area, real Postgres (no mocks of our own code)

frontend/src/
  App.tsx            shell: header, rail column, scrolling body, mounted sessions
  api.ts             the only place that talks to the backend; types + methods
  AuthContext.tsx    current user; every page gates its own features on it
  sessions/          the session model (see below)
  pages/             one file per pane or page + pageTypes.tsx (non-session pages)
  components/        shared UI; components/tools/ holds the self-contained tools
  styles.css         all styling, theme tokens at the top
helm/ argocd/ docker-compose.yml   deployment
```

## Architecture decisions that are easy to get wrong

**Every session is an Aggregator.** There is one session type
(`SESSION_TYPE = "aggregator"`). A session holds *panes* — its `services` state
key lists them, `layout` is how they are arranged (`tabs` | `columns` |
`stacked` | `dashboard`, tabs being the default), `activePane` is the selected
tab. Sessions can be filed into named categories in the rail. Opening
"CloudWatch" means a session holding one CloudWatch pane. Start sessions through
`useStartSession()` (`sessions/start.ts`) — `start`, `startOne`,
`startFromTemplate` — rather than calling `open()` with a hand-built state bag.

**Session state is one bag per session, keyed by pane.** `useSessionState(key,
initial)` inside a `SessionKeyScope prefix={paneId}` reads and writes
`"<paneId>.<key>"`. It seeds from the session's bag **on mount only** — so
anything that fills a session's state must do it *before* mounting it (this bit
us once on reopening a closed session).

**Panes stay mounted.** Hidden, never unmounted, so a running query or a scroll
position survives switching tabs, layouts or sessions. Consequences: any DOM
selector must be scoped to `.session-body:not([hidden])` — and inside a
component, prefer a **ref** to any selector at all: a page-wide
`document.querySelector(".x")` returns the *first* session's `.x`, often a
hidden one measuring 0px (this is what froze dashboard drags whenever a second
session was open). A hidden element also measures 0, so treat a 0 width as
"not visible", not "shrunk". And `.aggregator-pane[hidden] { display: none }`
is required because an author `display: flex` beats the UA's `[hidden]` rule.

**Sessions autosave to the server** (`live_sessions` table, `sessions/sync.ts`):
1.2 s debounce, diffed by encoded fingerprint, and **requests are chained
through `WorkspaceSync.enqueue`** so a close or delete can't be overtaken by an
in-flight PUT that would revive it. The closed-session listing carries no state;
full state is fetched on reopen. **Anything that takes a session out of the
workspace must push its state first** — the debounced flush only ever sees
the sessions still in the workspace, so a close used to drop the last second
of changes (and a never-saved session reopened empty). `WorkspaceSync.close()`
does push-then-close on the chain; use it, not a bare `closeLiveSession`.

**The dashboard layout** (`AggregatorPage.tsx`) is freeform: `dashboardRects`
(session state) holds a pixel `Rect` per pane, relative to the canvas.
`resolveDashboard()` is the single answer per render for what's drawn, what a
drag collides with and what gets stored: a stored rect is kept unless it
collides with one accepted before it, and every other pane gets
`firstAvailableRect()` (first free spot in reading order). **A placement is
stored the moment it's made** (an effect) — a position that's only ever
computed moves by itself whenever anything before it changes, which was the
"panes jump around" bug. Closing a pane deletes its rect, so it comes back in
the first free place. Panes never overlap or come within the 16px gap
(`resolveRect`), a minimised pane's footprint is just its 40px header (but its
stored height is kept), and the right boundary is the canvas's measured width
— the same as the "Panes" card's, so panes line up with the cards above.

**Workspace JSON is tagged** (`sessions/storage.ts`): `__cwiSet` / `__cwiMap` so
`Set`/`Map` survive persistence. Plain `JSON.stringify` flattens a Set to `{}`
and the next `.has()` takes the app down — always go through `encode`/`decode`.

**Old state shapes are migrated on load**, for both IndexedDB and server
payloads (`migrateLogsSplit` then `wrapAsAggregator` in `SessionContext.tsx`).
Saved templates carry `__savedStateVersion`; older per-page shapes are migrated
in `sessions/templates.tsx`. Assume any stored shape you invent will need a
migration later.

**Access control is per group, never per user.** A user belongs to one
`UserGroup`, which carries the IAM role name, the visible environments and one
boolean per page (`logs_enabled`, `opensearch_enabled`, `iot_enabled`, …).
`/api/auth/me` returns those booleans so the frontend can decide what to offer;
the backend re-checks on every route. The **Admin** group (`is_admin`) always
sees every environment.

**No migration framework.** `ensure_columns()` in `db.py` adds missing columns
on startup (only ones safe to backfill — nullable or with a server default) and
**returns the `table.column` names it added**. When a new column's default is
wrong for rows that already exist, do a one-shot backfill in `main.py` keyed on
that return value (see `user_groups.opensearch_enabled`), never an unconditional
UPDATE on every start.

**All AWS calls assume a role** resolved from the caller's group
(`resolve.resolve_role_name`), through `aws_client.py`. Nothing reads ambient
credentials per service.

## Conventions

- **Comments explain *why*, not what.** This codebase's comments are the record
  of decisions and of bugs already fixed — match that register, keep them in
  prose, and update them when the reasoning changes.
- **Formatting:** ~120 columns, 2-space indent in TS, 4 in Python. There is **no
  prettier config** — a bare `npx prettier --write` reformats to 80 columns and
  is wrong. Match the file you are in.
- **TypeScript:** no `any` in new code; types live next to what uses them, API
  types in `api.ts`. React function components, hooks only.
- **Python:** type hints on function signatures, Pydantic models for every
  request/response, `HTTPException` with a sentence a user could act on.
- **Errors surface to the user**, they are never swallowed: the frontend shows
  `.error-text`, the backend returns a readable `detail`. Partial failures
  across accounts are reported per account rather than failing the whole call.
- **Testing:** backend is pytest against a **real Postgres** (`backend/tests`,
  one file per area; `conftest.py` resets the schema and logs in as admin before
  each test) — so give it its **own database** (`cloudwatch_insights_test`),
  never the one the browser suites use, or they can no longer sign in. The
  frontend has no unit tests — it is verified by the **browser suites in
  `frontend/e2e/`** (`node e2e/run-all.mjs`; that folder's README carries the
  configuration and the traps that have already cost a release). Verify UI
  work by driving the running app, not by reading the diff: reproduce the
  user's *actual* sequence of actions first, and check that a new suite fails
  against the old code (`git stash push -- frontend/src`) before trusting it
  — a suite that only covers the easy path passes while the reported bug
  stays.
- **CSS:** one `styles.css`, theme tokens on `:root`. When inserting a rule with
  a script, **never anchor on a bare selector prefix** — `.rail-row-label {`
  also matches inside `.rail-row.active .rail-row-label {`, which silently
  splices the new block into an existing rule. Append at the end or match a
  unique full rule.
- **One 16px gap everywhere, and the scrollbar at the window's edge.** `.shell`
  pads top and left; `.content` (the scroll box) pads the *right*, inside
  itself, with `scrollbar-gutter: stable` and `scrollbar-width: thin`. That
  puts the scrollbar against the window and every card 16px clear of it, and
  keeps widths from jumping when a scrollbar appears. Don't move that right
  padding back onto `.shell` — the scrollbar floats 16px in from the edge.

## Constraints

- **Do not reintroduce `xlsx` or `exceljs`.** `xlsx@0.18.5` (HIGH: prototype
  pollution + ReDoS) and `exceljs@4.4.0` (moderate transitive) were rejected;
  spreadsheet export uses `write-excel-file`.
- **Never log or return AWS credentials, session cookies, or assumed-role
  tokens.** The HTTP client tool is SSRF-guarded on the backend
  (`tools_http_client.py`) — keep the guards if you touch it.
- Git: develop on the branch the session names, always
  `git push -u origin <branch>`, and open a PR only when asked. If that
  branch's PR is already merged, restart from the latest `main` keeping the
  branch name (rebase any unmerged commits onto it rather than dropping them).
