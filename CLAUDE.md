# CLAUDE.md

Durable notes for working in this repo. Current state of the work-in-progress
lives in `PROGRESS.md`; the user-facing feature tour lives in `README.md` (long,
read the section you need rather than the whole file), and deployment in
`DEPLOYMENT.md`. Where the platform is going -- workflows, plugins, a builder,
secrets, generic environments -- is planned in `PLATFORM_PLAN.md`: read it before
designing anything in those areas, and record decisions there as they are made.

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
- **A session's description and category are agent-settable too**
  (`set_description`, `set_category`/`list_categories`), the same as the
  session card's own fields -- `set_category` finds or creates the named
  `SessionCategory` and sets it on the row directly inside the `mutate`
  callback, the same way `rename` sets `row.title`; category_id isn't part
  of session `state`, so it isn't touched by the state dict the callback
  edits.
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
The agent's MCP tools re-check them (`platform_tools/panes.kind_for`,
`_flagged`), since the agent must never reach further than its user's UI
would -- **and so do the per-service routes now** (`resolve.require_flag`,
called at the top of every AWS-calling endpoint in `queries.py`, `tables.py`,
`buckets.py`, `cognito.py`, `opensearch.py`, `iot.py`, `log_groups.py`,
`tools.py`, right where `resolve_environment`/`resolve_role_name` already
were). This used to be a real, if not agent-reachable, gap: a group with an
environment and a role but a page's flag off could still reach that page's
API by a raw request, since only the frontend's own offer of the button (and
the agent's tools) ever checked the flag -- environment and role were the
*only* thing the routers themselves re-verified. Found and closed while
investigating a report of the agent reaching services/environments/roles a
user shouldn't have (that report's own mechanism was never reproduced by
tracing the agent's tool chain -- `kind_for`, environment validation and role
resolution all held at every call site checked, including the shared-session
cross-group case and `add_pane`/`run_pane` specifically; `test_router_flags.py`
and the new `test_platform_tools.py` cases cover both boundaries now, not
just `create_session`/`set_pane_inputs`). The Admin group (`is_admin`)
always passes both checks, same as before.

**No migration framework.** `ensure_columns()` in `db.py` adds missing columns
on startup (only ones safe to backfill — nullable or with a server default) and
**returns the `table.column` names it added**. When a new column's default is
wrong for rows that already exist, do a one-shot backfill in `main.py` keyed on
that return value (see `user_groups.opensearch_enabled`), never an unconditional
UPDATE on every start.

**Credentials (PLATFORM_PLAN.md Phase 1, §13).** Typed secrets, encrypted at
rest, never returned by any API -- to admins included: a secret field is
reported only in `secret_fields_set`, and replacing it is the only way to
change it (no reveal, D25).
- **Envelope encryption** (`crypto.py`). Each credential's secret fields are
  one AES-GCM ciphertext under a data key of its own; the data key is
  wrapped by a master key from `PLATFORM_MASTER_KEYS` (`id:base64,…`, a
  keyring) / `PLATFORM_MASTER_KEY_ID` (the one new writes use), read on
  every call. The ciphertext's associated data is
  `credential:{id}:{type_id}:{type_version}`, so bytes copied onto another
  row fail to decrypt instead of handing out the wrong secret. Rotation
  (`python -m app.keys rotate`) re-wraps data keys only, in committed
  batches, resumable; `check` proves every credential still decrypts. **No
  keyring means credentials are off** (503 with a readable reason, the rest
  of the app unaffected); a malformed keyring, a wrong key under a known id,
  or a missing id is reported as exactly that, never as "no credentials".
- **Types are data** (`credential_types.py`, table `credential_types`): a
  list of fields (kind, secret, required, default, help). Admins define
  their own -- including from a pasted JSON example (`infer`, which
  flattens nesting and writes an output template that rebuilds the pasted
  shape). The built-ins are seeded rows kept in step with `BUILTINS` by
  `ensure_builtins()` (startup, and conftest), locked, plus the only checks
  that need code (`CHECKS`: JSON, SSH key, certificate, AWS STS). A type's
  `output_template`, `inject` and `http_test` are **CEL** (`cel-expr-python`,
  D8), never Python, so an admin-written template is as safe to evaluate as
  ours; `http_test` goes through `tools_http_client`'s SSRF guard. A secret
  field can never be made public again; removing a field that holds values
  needs `confirm_remove`; a type in use can't be deleted.
- **`credential_store.resolve()` is the only way a consumer gets a secret**:
  it checks the actor's group may use it (its own group's, or a global one
  granted to it -- D15), audits the use, and registers the decrypted values
  with `masking.py`, which masks them in every log record for the rest of
  the request (a log-record factory, so handlers added later are covered)
  and in any text passed through `mask()` (a test's message, an echoed
  response). It refreshes the type row after its commit -- returned expired,
  a caller with a closed session couldn't read it. `apply_inject` registers
  what it *computes* from them too (`register_derived`: a Basic header's
  base64, a URL-encoded parameter, a templated value) -- none holds a raw
  secret, so httpbin's `/get` echoed a Basic password back readable.
- **Admins only manage credentials and types** (D24); anyone else sees the
  names and types of what their group can use, nothing more
  (`CredentialSummary`). Group credentials are never granted -- they already
  belong to their group.
- **`audit_events`** (`audit.py`) is general: credentials are its first
  writer. The caller commits, so an audit record and its change land in one
  transaction. `detail` holds which fields changed, never values.
- `tests/test_credentials.py` wraps the admin client to keep every response
  body and asserts the secret appears in none, across a whole lifecycle.
- **Settings → Credentials** (`components/settings/CredentialsSettings.tsx`)
  is one tab with a *Credentials | Types* switch (a ninth tab wrapped), each
  view fetching its own data. Lists are plain tables whose rows open the
  item; everything done to one is in the opened view, in the session card's
  `CardSection`/`CardRow` sections -- four buttons per row and paragraphs
  of help were what made the first version read as cluttered. A stored
  secret shows "•••• set" with Replace, never a value; an empty secret
  input on save means "keep it" (the API's own rule), so an edit to a
  username can't wipe a password. A type with a check is saved first and
  tested second -- a credential can be right and still fail a test the
  platform can't complete. Access (grants) is part of the draft and saved
  by Save; its picker never offers admin groups (they can use everything)
  and stays, disabled, once every group has it -- when it vanished, two
  groups granted read as a limit of two. A built-in type opens read-only
  inside a disabled `fieldset`, with its Advanced toggle outside it (a
  disabled fieldset disables its buttons too). The type editor folds
  output template, HTTP `inject` and `http_test` under Advanced: how a
  credential is used belongs to what uses it (PLATFORM_PLAN.md D30).
  `readableError()` (`api.ts`) shows the backend's `detail`, not
  "400 Bad Request: {…}".
- **The HTTP client's Auth** (`credentialId` in the pane's state, an id
  only). `/api/tools/http-request` takes `credential_id`, resolves it and
  applies its type's `inject` server-side, and masks the response -- an
  echoing server would hand the token straight back otherwise. The agent
  can set it by name (input kind `credential` in `panes.py`, which stores
  the id of one the user's group can use) and `get_context` lists
  credential names and types, never values; it still can't Send.
- **Deployment.** `backend.masterKey.existingSecret`/`keyId` in Helm: no
  inline value, and never generated by the chart -- Argo CD renders
  without cluster access, so a generated key would change on every sync
  and orphan every credential. docker-compose carries a dev key marked as
  such. The backend logs at startup whether credentials are on and tries
  one credential per master key, so a wrong key shows at start, not at
  first use. `smoke58`/`smoke59` need a key (`frontend/e2e/README.md`).

**All AWS calls assume a role** resolved from the caller's group
(`resolve.resolve_role_name`), through `aws_client.py`. Nothing reads ambient
credentials per service.

**Sharing a session with other users is being built in phases** (`models.SessionMember`,
`routers/live_sessions.py`'s `/members` routes and its own `_reachable`,
`SessionCard`'s Members section). Phase 1 (done) is only the roster: an
owner invites a user by username at a permission ("viewer" or "editor").
Phase 2 (done) is the session card's own Members `CardRow` on top of that
API -- fetched on the session's mount, not through session state, since the
roster is the owner's alone and doesn't belong in the synced JSON.

**Phase 3 (done): an invited member can actually reach the session.**
`_reachable()` in `routers/live_sessions.py` replaces `_owned()` for every
route except delete and managing the roster (both stay strictly the
owner's): it returns the row plus the caller's own `SessionMember` if
they're not its owner, 404 either way if they're neither. `state`, `title`,
`type` and `version` are the one document every reachable caller sees
alike -- an editor can write them (a viewer gets 403), the same live way a
second tab of the owner's own always could: `commit_write` in
`live_store.py` now fans an "upsert" out to every participant (owner +
members), not just the row's `user_id`, so an editor's edit reaches every
open browser that can see the session, live, through the existing
per-user `pg_notify`/SSE plumbing -- unchanged itself, just called once per
participant instead of once. **`position`, `category_id` and `closed_at`
are never shared, though** -- `SessionMember` carries its own copies of all
three, because a session shared with several people needs one independent
panel position/category/closed-state per person, the same as it needs one
independent `SessionCategory` per person (`category_id` points at *that
member's own* categories, never the owner's). A member's PUT/close writes
only ever touch their own `SessionMember` row for these; the owner's PUT
and close are completely unchanged. Deleting stays owner-only (cascades to
every member via `ON DELETE CASCADE`); a member instead **leaves**
(`DELETE /{client_id}/members/{their_own_user_id}`, allowed for self-removal
even though managing anyone *else*'s membership stays the owner's alone).

A `client_id` is only unique *per owner*
(`uq_live_sessions_user_client` -- two different people's browsers can mint
the same one), so `_reachable` never looks a session up by client_id alone
once ownership fails: it goes through the caller's own `SessionMember` row,
which is what stops it from ever resolving to some other owner's unrelated
session that happens to share an id.

Every reachable caller still acts under **their own group's** environments
and IAM role, never the owner's -- there is no per-session access grant,
"access control is per group, never per user" holds exactly as before.
`LiveSessionOut`/`Summary` gained a `role` field (`"owner"` or the
member's permission) for exactly this reason on the frontend too: a
viewer's autosave has nowhere to go, so `sync.ts`'s `pushOne` skips the PUT
outright for `role === "viewer"` -- without that guard, the mere act of
*receiving* someone else's live edit would queue a save right back that
403s on every flush for as long as the session stayed open. That one guard
is deliberately the whole frontend change here: nothing else (the rail, a
pane's controls, "add pane", "run") is gated on role yet -- a viewer can
still click things that will fail server-side. Graying those out is its
own future phase, not bundled into this one.

**Phase 4 (done): the session-tab chat is a real conversation, not just
one user's Q&A with the agent.** The mechanism needed almost none of its
own plumbing -- `agentChat` is a key in the same `state` dict phase 3
already made the one shared document, so once a session has members, every
turn synced there already reaches everyone live, for free. What phase 4
actually adds:
- `AgentTurn` gains `author` (who asked -- absent on an unshared session's
  turns, and in the Global tab, which is always just you) and
  `agentInvoked` (false for a plain message between people).
- **Gated on whether the session is actually shared, not on scope alone**:
  an unshared session's chat behaves exactly as before (every message goes
  to the agent) -- `AgentContext.tsx`'s `isShared()` checks the viewer's own
  `role` (a member already knows) or, for the owner, a one-time
  `listSessionMembers` fetch per session viewed (an owner has no other way
  to learn their own session is shared). Once shared, a message that
  doesn't match `@platform-agent\b` (case-insensitive) is appended straight
  to state via `writeSessionState` and never reaches `/api/agent/chat` at
  all -- the gating is entirely client-side, since there's no security
  reason to enforce it server-side, only a product one (not answering every
  line of a chat). A mention still gets the full existing flow, with the
  question prefixed `"<name>: "` for the agent's own benefit once shared
  (never for an unshared session, so a message like "rows" that already
  triggers something specific isn't quietly changed into "you: rows").
- `routers/agent.py`'s own session-scope check uses the new
  `live_store.reachable()` (owner or member) instead of `live_store.get`
  (owner only), so an invited member can start a turn about a shared
  session at all. **The agent's own tools still can't act on it for
  anyone but the owner** -- `get_context`'s `viewing_session` (and every
  tool built on `live_store.get`/`mutate`) stays strictly owner-scoped (see
  `live_store.get`'s own docstring) since several tools write owner-only
  row fields directly (`rename`, `set_category`) the way phase 3 took care
  to route through the *right* target for the *browser's* writes; doing
  the same throughout `platform_tools/server.py` is its own future phase.
  So today, a member who mentions the agent can talk to it, but a request
  that needs the agent to touch the session itself gets "You aren't
  looking at a session, so there's nowhere to put it" -- confirmed, not
  just anticipated, by asking the fake model directly as an invited member.
- `sync.ts`'s `mergeSession` treats `agentChat` as an append log, not an
  ordinary "whichever side changed it wins" value: `mergeChatTurns` unions
  by turn id (remote's own turns, plus whatever this side added that base
  didn't have). Without this, two people's messages landing in the same
  ~1.2s debounce window could see one silently overwrite the other, since
  every other key's merge picks one whole value rather than combining
  array elements -- fine for a field someone edits in place, wrong for a
  chat log where every message is meant to survive.
- The compose box's placeholder and the empty-chat intro say the
  `@platform-agent` convention once a session is shared; someone else's
  message renders on the left (`.agent-question-theirs`) instead of the
  right, so a shared conversation reads like any other chat UI.

Verified live with two real users (an owner and an invited editor): a
plain message never reaches the agent once shared, mentioning it does, the
owner sees the editor's message and its author label live and vice versa,
and neither side's message is lost when both send within the same
debounce window.

**Phase 5 (done): the agent's own tools reach a session shared with the
caller, not just one they own.** This closes the gap phase 4 confirmed
rather than just anticipated. `live_store.get` stays strictly owner-only
(its docstring says so, and one caller still wants exactly that reading);
everything the agent's tools use instead goes through
`live_store.reachable()` (owner match first, then the caller's own
`SessionMember` via the same join `_reachable` in the router uses) or the
new `live_store.reachable_sessions()` for `list_sessions` (owned rows plus
every row shared with the caller, sorted by *that caller's own*
`position` -- a shared row's position lives on their `SessionMember`, not
the owner's row, same as phase 3 already keeps category and closed-state
separate per person). `live_store.mutate()` now hands its `change`
callback the caller's own `SessionMember` (`None` for the owner) alongside
the state and the row, refuses outright with "You have read-only access
to this session" for a viewer, and reopens *the caller's own* closed-state
on a write (`member.closed_at`, never the owner's) -- exactly the split
phase 3 already drew for the browser's own PUT. Every `platform_tools`
function built on `mutate`'s callback picked up the new parameter
(`_member`, unused, in most of them since `state`/`title` are the one
shared document); only `set_category` needed real branching, writing
`member.category_id` instead of `row.category_id` when the caller isn't
the owner -- the same "per participant, never the owner's" rule its
phase-3 sibling (`position`/`closed_at`) already followed, just not yet
applied to this one field. `_describe_session` (what every tool's session
description is built from) gained a required caller `user_id` and now
reports that caller's own `role` ("owner" or their permission) and their
own category/closed-state, resolved through a small `_membership()` lookup
-- a viewer tool call fails with a message naming *why* ("read-only
access"), not just *that* it failed. `mutate`'s return signature stayed a
plain `(row, result)` rather than growing a third `member` element, to
keep the ~10 call sites' unpacking untouched; `_describe_session` instead
re-resolves membership itself, one extra indexed query traded for far
fewer call-site edits. Verified against the pre-phase-5 code the same way
phase 3's tests were: 5 new tests in `test_platform_tools.py` (a viewer
member reaches `get_session`/`list_sessions` and sees their own role; a
viewer's `add_pane` is refused and the state is untouched; an editor's
`add_pane` succeeds and the owner's own read sees it; `set_category` on a
shared session sets the member's own category, never the owner's row;
`get_context`'s `viewing_session` reports an invited editor's role) all
fail against the pre-phase-5 `live_store.py`/`server.py`, confirming they
exercise real new behavior; full backend suite green afterward.
`platform-agent/tests` needs no changes -- it drives the real LangChain
agent against its own hand-rolled stub MCP server (`get_context`,
`create_session`, `run_pane`), never the real `platform_tools/server.py`,
so nothing here touches it.

**The invite field suggests usernames as you type.** A follow-up to phase 2's
UI, not a new access-control phase: `GET /api/users/suggest?prefix=` (new,
`routers/users.py`) returns up to 8 `{id, username}` matches, ordered,
excluding the caller. Deliberately **not** `require_admin` like `list_users`
-- open to any authenticated user, since the invite endpoint it feeds was
already open to inviting any user by exact username, in any group; this only
makes that existing reach discoverable instead of requiring an exact guess
(a real widening of *what's easy to enumerate*, decided explicitly, not
assumed). Deliberately `UserSuggestion` (id/username only), never the full
`UserOut` (group, admin, tab flags), and capped at 8 rather than a
browsable listing -- an empty prefix returns `[]`, not everyone. The
frontend debounces (150ms) so it's one request per pause in typing, not
one per keystroke, and filters out anyone already a member client-side (no
point suggesting someone the invite would just 409 on). Selecting a
suggestion (`onMouseDown` + `preventDefault`, not `onClick` -- the click
would land after the input's own `onBlur` already closed the dropdown)
fills the field the same as typing the exact name would; the existing
submit flow is otherwise untouched.

**Four follow-up fixes/features on top of sharing, reported after real use:**
1. The invite dropdown was as wide as the whole invite row, not the input it
   belongs to -- `.session-member-invite .session-card-input`'s own
   `max-width: 560px` capped the input but not its wrapper
   (`.session-member-invite-field`, `flex: 1`), so the dropdown (anchored
   `left: 0; right: 0` to that wrapper) visibly overhung the field on a wide
   card. Fixed by capping the wrapper the same 560px.
2. Picking a suggestion set `inviteUsername` to that exact name, which
   re-triggered the debounced fetch effect and reopened the dropdown with
   the one match that name now finds. `suppressNextSuggestFetch` (a ref, not
   state -- it has to be read and cleared inside the very next effect run,
   before a render) skips exactly that one re-run; typing anything further
   clears it back to normal.
3. Inviting someone updated the agent panel's own "is this session shared"
   gating (`AgentContext`'s `sharedSessions`) only the next time the session
   was viewed (a reload, or switching away and back) -- the one-time
   `listSessionMembers` fetch that answers this had no way to know an invite
   had just happened. `AgentContext` now exposes `refreshShared(sessionId)`
   (the same fetch, pulled out of the view-change effect so both can call
   it), and the session card's `inviteMember`/`removeMember` call it on
   success -- immediate, no reload.
4. The session chat's compose box now suggests "@" mentions: every current
   participant plus the agent's own handle (`AGENT_HANDLE`), narrowing as
   you type. Unlike the invite field's username search (a global, unbounded
   user list needing server-side prefix search and a debounce), a session's
   participants are few, so this fetches the whole small list once **per
   mention** (the moment "@" starts one, via the new
   `GET /{client_id}/participants`) and filters it locally after that --
   never cached across mentions, so an invite made moments earlier is never
   stale here either. `/participants` is deliberately reachable by any
   participant, not owner-only like `/members`: it's read-only, carries none
   of that route's management capability, and includes the owner (which
   `/members` doesn't), since a member @mentioning someone needs the
   owner's name as much as any other participant's. Picking a suggestion
   splices `@name ` into the compose text at the mention's own span (found
   via the textarea's `selectionStart`), not a whole-value replace, since a
   mention can sit anywhere in a longer message, not just at the end.
   Related, closing a gap `_describe_session` had (an owner asking the agent
   "are there members here?" got "no members" even when there were --
   nothing in that function ever looked): it now reports a `members` list
   (username + role) whenever a session actually has more than just its
   owner, sourced the same way the new route is, so every tool built on it
   (`get_context`, `get_session`, `list_sessions`) answers correctly.

**A viewer's chat messages, and the agent's replies to them, reached no one
but themselves.** `sync.ts`'s `pushOne` skipped a viewer's PUT unconditionally
-- correct for the panes/layout a viewer genuinely can't edit, but that same
guard also covered `agentChat`, which chatting has no business being gated
by: talking in a shared session's chat isn't editing the session's content.
So a viewer's own turns (plain messages and agent-invoked questions alike)
never left their browser -- no PUT, no version bump, no `commit_write`, no
notification to the owner or anyone else -- while the viewer's own screen
still showed them (an optimistic local write to session state that simply
never got pushed). Fixed with a narrow carve-out on both sides: `sync.ts`'s
new `chatOnlyChange(base, session)` compares `session` against the last
server copy this browser agreed with (title, type, category and every state
key except `agentChat` all have to match exactly); `pushOne` now sends a
viewer's PUT through when that holds, instead of skipping it outright.
`upsert_live_session` (`routers/live_sessions.py`) independently enforces
the identical rule server-side (comparing `payload.state` against `row.state`
key by key, `payload.title`/`payload.type` against the row's) -- never
trusting the frontend's own gate alone, and refusing (403, same as before)
the moment anything besides the chat log would change, so a viewer can't
smuggle a real edit through by bundling a chat message onto it. Confirmed
live with two real users (an owner and an invited viewer): the viewer's
plain message, their `@platform-agent` question, and the agent's actual
reply to it, all now reach the owner -- and a viewer still can't push any
non-chat change, exactly as before.

**Two further follow-ups, unrelated to sharing's access-control model but
found while using the feature:**
- **The agent panel now defaults to the Session tab when you open a
  session.** It only did this by accident of `AgentContext`'s `tab` state
  happening to start on `"global"` regardless of what's on screen. Two
  changes: the initial state now depends on the view at mount (`view ===
  "session" ? "session" : "global"`), so a session already open when the
  panel first mounts starts there too; an effect watches `view`'s own
  transitions and switches to "Session" the moment it moves from something
  else *into* `"session"` (opening one), but leaves the tab alone when you
  merely switch between two sessions that are both already open (`view`
  stays `"session"` the whole time, so the transition never fires) -- so it
  doesn't fight a deliberate choice to keep Global open while browsing.
  Neither is persisted, matching `tab`'s existing behavior: a fresh load
  re-decides rather than reopening wherever the panel was left.
- **The pane tabs' rename box could overflow its own tab.**
  `.aggregator-tab .aggregator-pane-rename` had a fixed `width: 150px`, but
  `.aggregator-tab` itself is `flex: 1 1 0` (evenly divided across however
  many are open) and can be narrower than that with several panes open --
  the input then overflowed past its own tab's right edge, visibly dragging
  the ✕ beside it out of place along with it (not centered, not where the
  ✕ normally sits). Fixed by sizing the input the same way the label it
  replaces already is (`flex: 1; min-width: 0`), so it always fills exactly
  its own tab's share of the row, however wide that turns out to be.

**A shared session's chat no longer requires agent access to use at all.**
`AgentChat.tsx`'s `unavailable` disabled the whole compose box the moment a
user's group lacked `agent_enabled` -- right for the Global tab and an
unshared session (nothing to do there without the agent), wrong for a
*shared* session, whose chat is people talking to each other and doesn't
need the agent for that. Now that message (and the disabled box) only
applies when `!shared`. An `@platform-agent` mention from such a user still
reaches `ask()` and still gets sent to `/api/agent/chat`, which already
403s ("The agent isn't turned on for your group...", unchanged,
`routers/agent.py`'s existing `_allowed` check) -- shown the same way any
other failed turn already is, so there's no separate "no access" copy to
keep in sync with the backend's own message, and the agent is never
actually invoked either way.

**Two reports about the agent's own answers, one fixed, one mitigated by prompt
only (LLM behavior, not a code bug with a deterministic fix):**
- **`MarkdownLite.tsx` required a blank line around a heading or table to
  recognize it at all** -- `renderBlock` only ever checked `lines[0]`/
  `lines.length === 1` of a whole blank-line-delimited block, so a real
  model's "Here's what I found:\n| Name |...\n|---|...\n" (no blank line
  before the table) or "### Summary\nDetails" (none after the heading) fell
  through to one literal `<p>`, "|" and "###" shown as plain text. Rewritten
  to scan a block's lines and recognize a heading, a table start (a row
  containing "|" immediately followed by a separator row) or a list run
  wherever it begins, consuming exactly the lines that belong to it and
  falling back to a paragraph for the rest -- fixed regardless of blank
  lines either side. `dev/fake_llm.py` gained a `"markdown"` script
  (`smoke56.mjs`) mixing both shapes into surrounding prose with no blank
  line either side, specifically to keep exercising this.
- **The agent sometimes answers from memory of an earlier run instead of
  actually running the tool again**, or about a session's state without
  re-reading it. First mitigated by prompt wording alone; since then made
  structural (next section) -- the turn reads the context itself, and the
  history carries what each answer actually ran.

**The agent's turn is grounded in code, not left to the model's
instruction-following.** Three reports from real use with a reasoning model
behind LiteLLM -- a turn that wrote the same four sentences of plan until it
ran out of tokens; a table of thing names no search had returned ("the
results are in the iot pane", nothing there); and, in a shared chat, an
admin told "there is no IoT Prod" because an earlier member without it had
asked first, even after "refresh and check again" -- traced to these, each
fixed where it happens:
- **Every turn opens with its own reads** (`agent.py`, `_read`): `get_context`,
  and `get_session` in a session chat, called by the agent service before
  the model says a word, attached after the latest message
  (`prompt.turn_reads`, marked `READS_MARK`) -- not in the system prompt,
  where a long shared chat left them far from the question and a model
  answered an admin from what an earlier answer told someone without their
  access -- and shown in the chat as steps (`preamble: true`; "Checked who's asking and
  what they can reach"). A shared chat's turns are each minted for whoever
  sent that message, so this read is always *theirs* -- the prompt says it
  replaces anything earlier in the conversation about access. The model can
  still call both again itself.
- **History carries each answer's tool steps**, not only its words: the
  browser sends `steps` (the provider's own call id, name, args, ok, the kept
  300-char summary; preamble steps left out, each turn makes its own) with
  each assistant message, and `agent.conversation()` rebuilds them as real
  tool calls and results -- **only with that provider id**, and only for a
  tool this turn has under a valid name. Ids invented here (`h25_0`) were
  copied by a model whose chat template writes a call as its id then its
  arguments: it sent `h25_0 <|tool_call_argument_begin|>...` back as a tool's
  name. A step without a usable id goes as words only.
- **What the model sends back is made safe before anything sees it**
  (`repair.py`, `TurnGuard`, a `create_agent` middleware). A tool call whose
  name isn't one of the turn's tools is recovered to the tool it contains
  (`functions.run_pane:0`, args parsed from the markup) or renamed
  `unreadable_tool_call`, which is answered "not a valid tool" so the model
  can retry; unparseable-argument calls become ordinary calls, so each gets
  its answer. Sent back as it was, Bedrock refused the whole request
  (names must match `[a-zA-Z0-9_-]+`) and the turn died with a 400. And a
  step that ends with no tool call and no answer, or on the colon of a step
  it announced and never took ("Let me search now:"), is asked once per
  turn to carry on (`NUDGE`); still nothing, and the turn ends with a
  readable error instead of stopping silently. `dev/fake_llm.py` refuses
  bad tool names the way Bedrock does, so the tests reproduce the 400.
- **A run of a pane pointed at an environment the asker can't reach is
  refused up front** (`server._check_reachable`), naming the input and the
  asker's own environments. It used to run and fail per environment with a
  bare "Environment 2 is not configured", which a model in a shared chat
  read as "IoT Test isn't there" and went round in circles. With
  only words, a made-up answer and a real run looked the same next turn, and
  another person's get_context was indistinguishable from a fact.
- **Reasoning is kept apart from the answer** (`text.py`). These models put
  it in `content` as `...</think>answer` -- the opening tag is in the chat
  template -- so until "</think>" arrives there's no telling, and words are
  streamed as answer and then taken back (`retract`) and resent as
  `thinking` when it does. The browser folds them into "Thought process";
  a stored turn from before this is split the same way at render
  (`splitThinking`). Each step's answer starts a new paragraph (steps used
  to run on into each other mid-sentence).
- **A step that loops is stopped** (`text.looping`: its last 160 characters
  already seen 4 times), its words retracted, with a readable error. And
  `temperature` is no longer pinned to 0 (`AGENT_TEMPERATURE`, Helm
  `agent.temperature`, unset by default): greedy decoding is what reasoning
  models are documented to loop under. `AGENT_MAX_TOKENS` caps a step.
- **An answer whose details no tool returned is taken back and redone**
  (`grounding.py`, checked in `TurnGuard`): its table cells and `code`
  spans are looked for in this turn's tool outputs, tool args and the
  user's own message with its reads (attached rows count); when most of 3+
  are found nowhere, the answer's id goes in `guard.discarded`, the turn
  retracts its words, and the model is told once which details nothing
  returned and to run the tool or say it can't. A member was shown another
  person's earlier rows as "Found 20 things in IoT Prod", nothing run. A
  second answer that still does it shows, with the warning (`notice`) under
  it, as before.
- **A row can be looked at in full** (`inspect_row`): the run's sample cuts
  values down, and a search can't show what only a row's own detail holds.
  A kind opts in from its registry entry (`PaneKind.rows`, the last run as
  rows in sample order; `detail`, a second look-up, acting as the caller
  and refused for an environment they can't reach), and `get_context` says
  which kinds can. IoT's detail is the thing's shadows, certificates and
  jobs -- a model asked about "deviceType in the Search shadow" had written
  a filter on a shape it never saw, misread the error, and said shadow
  indexing was off. The prompt's matching rule is generic: an error or an
  empty result is about the input first; look at the data and try another
  form before calling a feature missing.
- **Acting "on behalf of" someone else is refused by the server**, not just
  the prompt: a run acts as the asker, so a shared pane its owner pointed
  at an environment the asker can't see gets that environment's "not
  configured" error, never its data (`test_nobody_can_run_a_shared_pane_
  with_the_owners_access`, which passed before this too -- the leak wasn't
  there; the stale answer was).
- **A session chat's turn can only change that session**, enforced by the
  server, not the prompt: its token carries the row's id
  (`AgentToken.session_scope_id`, set only for `scope: "session"`), and
  every write tool goes through `server._mutate`, which refuses any other
  row (checked on the locked row, not the client id, which is only unique
  per owner); `create_session` is refused there too. Asked the prompt's
  way, a model still wrote into a session off screen, and the user saw an
  answer with nothing in their panes. A Global turn is unlimited (Follow
  opens whatever it writes to). And filling or running a pane unfolds it
  if it was minimised, as it already made it the active tab.
- **No per-service tuning of the agent.** Services and tools will be added
  by plugins, so the agent must never need a new prompt line, script or
  hint to use one. The prompt names no service (the kinds come from
  `get_context`); a kind describes its inputs once, in its registry entry
  in `panes.py`, the way a plugin will ship them -- one line of syntax,
  not advice for a query that once went wrong; and a bad query is fixed by
  the model reading the error or the empty result that comes back. (A
  sentence of IoT shadow tips added after one failed search was taken back
  out for exactly this reason.)
- Smaller: `run_pane` says where its results are (`shown_in`, by the names
  the user sees); a one-column table (`|---|`) renders
  (the separator regex wanted two); and a Global turn whose Follow opens a
  session no longer flips the panel to the Session tab, which had hidden
  the very turn doing the work.
- Coverage: `platform-agent/tests` (`test_text.py`; five new turn tests
  against the fake model's `think`/`loop`/`invent`/`whoami` scripts, all
  failing on the old `app/`), backend `test_platform_tools.py`/
  `test_agent_chat.py`, and `smoke57` (fails on the old `frontend/src`).

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
  Fold and move share a pane header button's own `.secondary` look and box
  (`+`/`−` to fold, same as a pane's own minimise button), not a bespoke
  icon-button style, and the body's side padding matches a pane body's own
  12px so the inner section cards don't sit further in.
  Each section is a label column and a values column (`CardRow`): name and
  description (edited in the same kind of box), adds, layout (one
  segmented control), and members (see sharing, above) -- the one section
  that isn't backed by session state, fetched instead from its own API on
  mount. In the body it folds to its header (`cardCollapsed`,
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
- **The tabs layout's pane tabs are one joined, evenly-divided row**
  (`.aggregator-tabs`/`.aggregator-tab`), like the session card's own
  segmented Layout control -- each tab is `flex: 1 1 0` rather than sized to
  its label, so the row is always as wide as a pane in the stacked layout
  (the same container, no width rule needed) however many tabs are open.
  The Settings page's own section tabs (`.settings-tabs`, wrapping the
  general-purpose `.tabs`/`.tab` pair) are joined the same way; other uses
  of `.tabs`/`.tab` (e.g. Saved items) keep their old shrink-wrapped look.
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
