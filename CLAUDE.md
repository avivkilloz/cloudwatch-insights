# CLAUDE.md

Durable notes for working in this repo. Current state of the work-in-progress
lives in `PROGRESS.md`; the user-facing feature tour lives in `README.md` (long,
read the section you need rather than the whole file), and deployment in
`DEPLOYMENT.md`.

## What this is

An extensible platform whose unit of work is the **session**: a named workspace
holding whatever you need side by side, with an agent that works across all of
it. Today a session holds panes onto AWS services (CloudWatch Logs Insights,
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
  live_store.py      the one server-side write path for live sessions (versioned, announced)
  live_events.py     pg_notify on write, one LISTEN per replica, fan-out to event streams
  platform_tools/    what the platform agent can do, over MCP at /mcp (see below)
  routers/           one file per resource; every route is auth-gated
backend/tests/       pytest, one file per area, real Postgres (no mocks of our own code)

platform-agent/      the agent container: app/ (LangChain create_agent + MCP adapter,
                     streamed /chat), dev/fake_llm.py (scripted stand-in model), tests/

frontend/src/
  App.tsx            shell: rail column (brand, sessions, page info, account), scrolling body, mounted sessions
  api.ts             the only place that talks to the backend; types + methods
  AuthContext.tsx    current user; every page gates its own features on it
  sessions/          the session model (see below)
  agent/             AgentContext (the Global and per-session conversations, panel
                     layout), selection.ts (each session's checked rows, for attaching)
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

**A pane is an instance, not a type** (`sessions/panes.ts`). A session can hold
several panes of one kind, so `services` lists pane *ids*; `paneTypes` maps an
id to its kind and `paneTitles` to its (renamable) name. A pane missing from
those maps has an id equal to its type and is called by its kind's label —
which is every session and template saved before instances existed, so they
need no migration; keep that fallback. The first pane of a kind still gets the
type as its id, later ones `type~2`, `type~3` (never a `.`, which splits id
from key). **Closing a pane drops its `"<id>."` keys** (`useDropSessionKeys`):
ids are reused, so without that a pane added later would come back holding a
closed one's inputs. Anything keyed per pane (rects, minimised, AI
registration) goes by id; anything asking "what kind is this" goes through
`paneType()`. The Panes card only adds; closing is the pane's own ✕.

**Session state is one bag per session, keyed by pane.** `useSessionState(key,
initial)` inside a `SessionKeyScope prefix={paneId}` reads and writes
`"<paneId>.<key>"` — the pane's id, so two panes of one kind stay apart. It
seeds from the session's bag on mount, and afterwards takes any value that
changes under it which it didn't write itself (compared by identity, so its own
writes coming back are no-ops). Filling a session's state *before* mounting is
still the clean way to open one (this bit us once on reopening a closed
session). A remote change arriving later is now picked up too, rather than
lost.

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
full state is fetched on reopen.

**Sync is two-way; the browser is no longer the only writer.** Other tabs,
other machines and the platform agent all write sessions on the server.
- Every row has a `version`, and every PUT carries the `base_version` it was
  made from. A stale one gets a 409. The version check runs under a row lock
  (`with_for_update`); without it, two concurrent writes both passed.
- On a 409, the browser GETs the row and merges it (`mergeSession`): three-way
  per state key against the last agreed copy, with the server winning a true
  conflict. It then pushes again.
- Every write is announced with `pg_notify` on commit (`live_events.py`,
  `LISTEN` per replica). An event stream (`GET /api/live-sessions/events`)
  tells each of the user's tabs what changed. Events carry no state; tabs fetch
  it.
- Every request carries `X-Sync-Origin` (a per-tab id, or `"agent"`), so a
  tab can ignore the echo of its own writes.
- A mounted `useSessionState` follows a remote change to its key; it no longer
  only seeds on mount.
- **Order belongs to `/reorder`.** A PUT sets `position` only when it creates
  the session, and position is not in the sync fingerprint; otherwise a tab
  holding the old order pushes it back on its next save and two tabs
  ping-pong. A reorder is announced with its id order and every tab re-sorts
  to it (`followOrder`).
- Anything that writes a session outside the browser (the agent, a script)
  must go through the same versioned write and announcement. Never
  `UPDATE live_sessions` directly.

**The platform agent acts as the user, only through MCP, only through the
write path.** The browser never talks to the agent container: a turn goes to
`POST /api/agent/chat`, which checks `agent_enabled`, mints a per-turn token
(`platform_tools/tokens.py`, stored hashed, revoked when the stream ends), and
relays the turn. The agent calls `/mcp` with that token, so every tool acts as
that user with their group's environments and role. The agent never sees the
cookie and the browser never sees the token; keep it that way.
- Tools change sessions only through `live_store.mutate`/`create` (lock,
  version, announce with origin `"agent"`), which is how open panes follow the
  agent live. A run happens *between* two mutates -- inputs, then results --
  never holding the row lock while AWS answers.
- `platform_tools/panes.py` is the server's copy of each pane's state keys and
  shapes (tagged Sets, `results` vs `osResults`, `resultsVersion` bumps). It
  has to move with the pages: rename a pane's key and the agent silently
  writes the old one. The MCP tests pin the shapes.
- What a run writes must fit under the *browser's* 4 MiB cap
  (`BROWSER_STATE_BYTES`), not just the server's, or the browser drops the
  results on its next save; `_write_results` trims to fit.
- The agent can't know a dashboard's pixel width, so `arrange_dashboard`
  leaves a grid `dashboardPlan` and AggregatorPage turns it into rects the
  first time it measures the canvas, then clears it.
- **Two conversations.** *Global* (the panel's Global tab, the Agent page) is
  about the platform and lives in memory. *Session* is one per session,
  stored in that session's state under `agentChat` (so it syncs and survives
  a reload; it's an output key, so templates leave it out). A session turn
  is sent with `scope: "session"`; the backend checks the session is the
  user's and the agent adds a prompt keeping it to that session.
- **Checked rows reach the agent** the way they reached the retired ✦
  assistant: each pane renders `PaneSelectionShare` with its selected rows,
  its Aggregator pools them per session and publishes them to
  `agent/selection.ts`, and the Session tab attaches them to the question
  (as a JSON block after it, capped to fit the backend's 60k-character
  message limit). The assistant itself (`/api/ai`, `ai_assistant.py`, the
  floating widget) is gone; `backend.ai` in Helm is now only the agent's.
- MQTT and JWT aren't agent-*drivable* on purpose: their state is
  browser-only (a live connection; a pasted credential). They are still in
  `KINDS`, with no inputs, so the agent can add, name and arrange them --
  left out entirely, it told a user asking for an MQTT tester that none
  existed. Every kind the user's group has belongs in `KINDS`. Anything with
  side effects outside the platform (sending HTTP, publishing) isn't a tool
  until the approval step exists.
- The MCP endpoint owns a fresh SDK session manager per app lifespan
  (`McpEndpoint`), so tests that call `/mcp` need `with TestClient(app)`.
  `mcp` is pinned to 1.x on both sides: `langchain-mcp-adapters` requires it.

**Anything that takes a session out of the
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
— the same as the session card's, so panes line up with the cards above.
When the canvas narrows (a wider dock, a smaller window), a pane past its edge
is slid in and cut down to fit *for drawing only*; its stored rect keeps its
own width, so it grows back when there's room. Whether it's past the edge is
asked of that stored width -- asked of the cut-down one, a pane flush with
the left edge never counted as overflowing and ran on under the dock.

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
`/api/auth/me` returns those booleans so the frontend can decide what to offer.
The per-service routes do *not* re-check them -- the environment list and the
group's IAM role are what bound a call there -- but the agent's MCP tools do
(`platform_tools/panes.kind_for`, `_flagged`), since the agent must never
reach further than its user's UI would. Closing that gap in the routers is
worth doing; don't assume it's there. The **Admin** group (`is_admin`) always
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
- **The agent's tests** (`platform-agent/tests`) run the real LangChain agent
  and MCP adapter against a stub MCP server and `dev/fake_llm.py`, both served
  over HTTP in-process. Browser suite `smoke45` drives the whole path and needs
  the agent and the fake model running (`frontend/e2e/README.md`).
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
  itself, by `16px - --scrollbar-size`, with `scrollbar-gutter: stable`. So
  the scrollbar sits against the window *inside* the 16px, every card ends
  exactly 16px from whatever is beside it, and widths don't jump when a
  scrollbar appears. The docked agent panel doesn't change that: it is
  `position: fixed` over the body's right, and `.content` adds its width to
  that padding (`--dock-width`), so the scrollbar stays at the window's edge
  with the dock open. Don't move that right padding back onto `.shell` — the
  scrollbar floats in from the edge.
- **Scrollbars are styled once, at the end of `styles.css`**: WebKit/Blink
  pseudo-elements at `--scrollbar-size`, and `scrollbar-width: thin` only for
  Firefox. Never set `scrollbar-width` on an element: Chrome then ignores the
  pseudo-elements for it and draws a different, wider bar. Don't make a
  scrollbar's look depend on `:hover` either: Chrome doesn't repaint it when
  the hover changes. Headless Chromium hides scrollbars in screenshots
  (`--hide-scrollbars`); launch without it to look at one.
- **There is no header bar.** The brand (`components/Brand.tsx`) is the
  rail's header bar (`.rail-head`, padded like the strip so it's level with
  the tabs), or starts the strip while the rail is hidden. The account's
  picture ends the strip, or the docked agent panel's header (a floating one
  leaves it on the strip). Anything that measured from a 53px header is
  measured from the window's top now.
- **A session's card** (`components/SessionCard.tsx`) is styled like a pane
  card: a header bar (`.session-card-head`, `panel-alt`, clicking it folds
  the card, like a pane's own header) and, in its body, one inner bordered
  card per section (`CardSection`) instead of a ruled line between them.
  Header buttons (`session-card-fold`, `session-card-move`) stop their click
  from bubbling to the header or it double-toggles and cancels out -- the
  same trap `AggregatorPage.tsx`'s own pane header comment already names.
  Each section is a label column and a values column (`CardRow`): name and
  description (edited in the same kind of box), adds, and layout (one
  segmented control). In the body it folds to its header (`cardCollapsed`,
  per session like a minimised pane, and only there -- in the rail there's
  nothing to fold). PageInfo is
  only for non-session pages now. The description is the top-level state key
  `description` (`SESSION_DESCRIPTION_KEY`): it syncs, templates keep it,
  `start()` takes it (and a category), and the agent's `_describe_session`
  reports it.
- **The session's card can move into the rail** (`components/railSlot.ts`):
  a per-browser preference plus the rail's slot element, both small stores.
  It stays where it was put -- in the rail even while the rail is hidden.
  Only the session on screen portals its card there -- every session is
  mounted, and all of them would land in the one slot otherwise.
- **The rail and the dock resize** from a `ColumnResizer` in the gap beside
  them (widths per browser in localStorage), each drawing its line in the
  middle of the 16px gap. Neither may
  squeeze the body below `BODY_MIN_WIDTH` (App.tsx): each resizer's max is
  what the window leaves, and a stored width is drawn narrower (not
  forgotten) when the window shrinks. A layout inside the body must also fit
  any width it's given (`minmax(min(420px, 100%), 1fr)`, not `420px`).

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
