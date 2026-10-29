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
  would do. The seam is the **pane manifest** (`backend/app/panes/manifests/*.yaml`,
  below); `sessions/paneTypes.tsx` holds only the panes still drawn by hand.
- **More kinds of section than services and tools.** A session will hold chat,
  code and workflow sections the way it holds panes today.
- **Dashboards** (saved views), **workflows** (n8n-style runs you keep and
  re-run), **chat** with people and with agents, and a **code** section
  (code-server with Claude, working in the context of the session). These four
  already exist as placeholder pages in `pages/pageTypes.tsx`.
- **What's built here is kept as a plugin** (PLATFORM_PLAN.md §20.4, D70): pane
  types, steps, workflows, credential and connection types made in the platform
  are written through to a git repo in exactly a plugin repo's format; never a
  deployment's values or state (credentials, connections, users, sessions, runs),
  which stay in Postgres.
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
  connections.py     connection types, labels, group identities, the one-time migration (Phase 2)
  resolve.py         which connection a request targets and who it runs as there (resolve_target/_identity)
  aws_client.py      STS assume-role helper every *_client.py goes through
  *_client.py        one module per AWS service (iot, dynamodb, s3, cognito, opensearch…)
  mqtt_client.py     MQTT connections the server holds for the MQTT tester's runs (D54)
  workflows.py       workflows: the definition (YAML, CEL templates), runs, the in-process runner,
                     approvals (§22)
  yaml_edit.py       changes to a definition's YAML by path, spliced and checked by meaning (D117)
  row_paths.py       paths into a reply for a request's rows: dotted, [0], [Key=Name] (D124)
  build_drafts.py    what's being built and not saved: text, Id and Building chat, per person (D125)
  step_types.py      step types made in the Builder: an HTTP request, a chain of steps or code, used by workflows (D122)
  runner_client.py   code run in the runner: a job per run (runner_jobs, its token), problems() before it runs (§25)
  outbound.py        what code sends out (ctx.http / ctx.aws), made here as whoever runs it (D133)
  workflow_doors.py  between workflows and sessions: investigate a run, draft a workflow from a
                     session, the Workflow pane's handlers, a run's own chat (§22.10)
  templates.py       published templates: made portable, kept in the store, opened for an environment (§23)
  builder.py         the Builder: pane types made in the platform, checked and merged into the registry (§24)
  blobs.py           the blob store: filesystem or S3, metadata in `blobs` (§8.2, D91)
  store.py           the store repo: what's built here, written through to git as a plugin (§21), a folder per
                     pane, step and workflow (D140)
  gitrepo.py         the store's private clone, driven through the git CLI (no secret in a URL or argument)
  live_store.py      the one server-side write path for live sessions (versioned, announced)
  pane_outputs.py    the one write path for a pane's outputs, apart from the state (D21)
  live_events.py     pg_notify on write, one LISTEN per replica, fan-out to event streams
  presence.py        which tabs are connected (tab_presence), so which sessions are watched
  platform_tools/    what the platform agent can do, over MCP at /mcp (see below)
  panes/             pane manifests: manifests/*.yaml, manifest.py (the schema), state.py
                     (v2 key migration), live.py (live functions' Python twins),
                     handlers.py, runs.py (background runs, D51), refresh.py (auto-refresh,
                     §18.3), timewindow.py
  routers/           one file per resource; every route is auth-gated
backend/tests/       pytest, one file per area, real Postgres (no mocks of our own code)
backend/dev/         fake_aws.py: the app with Logs Insights/OpenSearch/MQTT faked, for e2e

runner/              the code runner (§25): app/ (POST /jobs; a subprocess per job, its slot's uid, limits),
                     sdk/ (platform_sdk -- ctx.http/aws/log -- and bootstrap.py, what a job runs), tests/

platform-agent/      the agent container: app/ (LangChain create_agent + MCP adapter,
                     streamed /chat, check.py the answer check, builder.py the Builder's
                     loop), dev/fake_llm.py (scripted stand-in model and check), tests/,
                     evals/ (scenarios for a real model)

frontend/src/
  App.tsx            shell: rail column (brand, sessions, page info, account), scrolling body, mounted sessions
  api.ts             the only place that talks to the backend; types + methods
  AuthContext.tsx    current user; every page gates its own features on it
  sessions/          the session model (see below)
  agent/             AgentContext (the Global and per-session conversations, panel
                     layout), selection.ts (each session's checked rows, for attaching)
  panes/             manifest.ts (loaded manifests, key migration), ManifestPane.tsx (the
                     generic renderer), live.ts (live functions), DiffView.tsx
  appBuild.ts        is a newer build deployed (version.json), for the stale-tab reload
  pages/             one file per pane or page + pageTypes.tsx (non-session pages)
  components/        shared UI (every pane is drawn from its manifest now; no page per tool)
  styles.css         all styling, theme tokens at the top
helm/ argocd/ docker-compose.yml   deployment
```

## Architecture decisions that are easy to get wrong

**Panes are described by manifests (PLATFORM_PLAN.md §15).** One YAML file
per pane type in `backend/app/panes/manifests/`, validated by a strict Pydantic
model (`panes/manifest.py`: a typo fails startup and the tests, naming the file)
and served, filtered by the group's flags, at `GET /api/pane-types`.
- **Ported vs drawn by hand.** `state: v2` + `rendered: true` (Base64, Diff,
  JWT, the API table, DynamoDB, Cognito, S3, IoT, the HTTP client, CloudWatch,
  OpenSearch, MQTT -- every pane, since 3b-5) means the generic renderer
  (`frontend/src/panes/ManifestPane.tsx`) draws it from the manifest's
  `layout` alone, and its keys are `<pane>.in.<input>` / `.out.<output>` /
  `.view.<key>`. `sessions/paneTypes.tsx`'s `DRAWN` (panes with a page of
  their own) is empty; a manifest without `rendered` would only describe
  its pane to the agent and the catalogue until a page drew it.
- **One action endpoint for the browser and the agent** (§16.3.1):
  `POST /api/panes/{type}/actions/{action}` runs a `request` action or a
  `handler` registered by name in `panes/handlers.py` (`aws.dynamodb.scan`),
  and `run_pane` calls the very same function (`routers/panes.run_handler`)
  -- the manifest's `on_change` actions whose inputs are set, then its `main`
  one. Never give a ported pane a route of its own or the agent a runner of
  its own: that is the drift this exists to end. (For a pane still drawn by
  hand, `handler` names its legacy agent runner in `platform_tools/panes.
  HANDLERS`.) `run_handler` checks the group's flag itself and fills an
  unset input with its default. Every pane's old per-service routes are gone
  (D49; their bodies are the handlers), the logs' and saved queries' last,
  in 3b-4, with the agent's `list_log_groups`/`list_opensearch_*`:
  `list_options` runs any input's loader -- a two-level picker's groups per
  environment, and with `parent` its second level (a domain's indices).
- **A background run** (`poll: {handler, stop}`, CloudWatch's Run; D51,
  §16.9.1) isn't the browser's to poll: the action starts the queries,
  stores a `pane_runs` row and writes `out.run`, and a task on the server
  polls them into the pane's outputs through `pane_outputs.write` (origin
  `"run"`) -- so every tab, member and the agent see one stream, and
  a reload carries on. It polls **only while the session is watched**
  (`presence.watched`: a participant's connected tab, recorded from the
  event stream, with the session open in their workspace -- or an agent
  turn waiting); unwatched it pauses, and after 10 minutes it stops the
  queries. Any replica claims a run whose heartbeat lapsed. Stop
  (`POST /api/panes/{type}/stop`, the agent's `stop_pane`) is anyone's who
  can edit; a viewer can do neither. The browser's Run pushes the session
  first (`flushAll`: a pane added a second ago must exist on the server)
  and gets back only the run; its button is busy until `out.run` says
  otherwise. A pane with a `time_range` sends the browser's zone (`_tz`).
- **A run can be a connection, not a query** (MQTT, D54, §16.13): its
  handle holds no `query_id` (`runs._live`: live unless it has an error),
  its poll never says done, and its `poll` says how: `every` (1 s),
  `append: {messages: 200}` (each poll's rows go in front, capped -- a
  quiet poll writes nothing, so the version doesn't move),
  `unwatched_stop` (120 s: a socket nobody looks at is closed sooner than
  a query) and `agent_wait` (how long `run_pane` waits before answering
  with what came so far). The action's `restart_on: [topics]` restarts it
  as whoever changed those inputs (the browser's `changeInputs` sends
  `restart`, the agent's `set_pane_inputs` does it itself), keeping what
  was received (`runs.start(keep=True)`); `max_running` caps one person's
  runs of that action (5); `stop_label` names Stop ("Disconnect"). A stop
  handler may return outputs, which are written (Disconnect clears
  "Connected to…"). The connection lives in the replica that started it
  (`mqtt_client.REGISTRY`); a run marked stopped elsewhere is closed by
  its own replica on its next tick, and one another replica claims
  reconnects there.
- **Charts** (§16.11, D11/D53): a `chart:` layout item over an output whose
  config names a `kind: chart` view key. Beside a card title it is only the
  type picker (an unused chart adds no row -- the near-empty row the user
  disliked for Saved); in the card, the x / y / aggregate / series pickers
  and the chart. The spec is the view key, so it syncs, templates keep it,
  and the agent sets it with `set_pane_view` (any view key; a chart spec is
  checked by `panes.chart_spec`). The frame is worked out in the browser
  (`panes/frame.ts`) from what the output holds -- never stored. ECharts is
  imported only by `panes/chart/EChart.tsx`'s dynamic `import()` of
  `echartsCore.ts` (line, bar, pie, grid, tooltip, legend, canvas), so a
  session with no chart never fetches it; keep new imports going through
  that file. Colours are the dataviz reference palette's validated eight, its
  light or dark steps by the theme's `color-scheme` (`chart/palette.ts`);
  past eight series the rest fold into "Other", never a made-up hue.
  Series offers only string columns with at most 20 distinct values
  (`frame.groupable`): a column with a value per row (`@message`) drew one
  series per log line and a legend of whole lines over the chart. A time x
  with more than 60 distinct times is folded into buckets of one width
  from `STEPS` (about 60 bars, "Per 5m" under the chart), every empty
  bucket filled, so raw rows aren't a spike per row.
- **Zoom by dragging** (`panes/chart/zoom.ts`): on the histogram and on a
  time-series chart over time, in a pane with a `time_range` input,
  ECharts' `lineX` brush is armed as the cursor; a drag sets the range to
  `custom` with what was dragged (to the second, at least 1 s) through
  `changeInputs` and runs the main action again. "Undo zoom" pops a stack
  kept per pane in the tab only (the inputs are the shared truth; the
  history of how you got there isn't).
- **The log-volume histogram** (D52, output `volume`, render `histogram`):
  OpenSearch adds a `date_histogram` to the same search, always; CloudWatch
  starts a counting query (`timewindow.count_query`: the user's commands
  split outside quotes and `/regex/`, `fields`/`display`/`sort`/`limit`/
  `dedup` dropped, `stats count(*) as count by bin()` appended) only while
  the pane's `histogram` input is on, as `role: histogram` handles of the
  same background run -- polled, stopped and unwatched-stopped with it.
  Off, a run writes `volume: null` so an old histogram doesn't sit over new
  rows. A query with its own `stats` gets a `note` instead. Every bar of the
  window is filled (`_filled`), at 0 where nothing matched.
- **Several connections** (`type: connections`, IoT): the handler fans out
  itself through `handlers.fan_out`, one group per connection
  (`{environment_id, environment_name, <rows>, error}`, the shape every
  fan-out pane always stored), and a list's `groups` config flattens them,
  stamping each row with its environment and putting failed ones in Target
  errors. The agent's `flatten` and the browser's are twins: row numbers
  agree.
- **A row action** (`args: {connection: group.environment_id, thingName:
  row.thing_name}`, paths only) is what expanding a row fetches (cached in
  the tab, D47; fetched in every tab that has the row open, D48), what
  "Include detail" fetches for export and attach, and what `inspect_row`
  runs for the agent. Its detail is drawn by `panes/DetailSections.tsx` from
  the list's `detail.sections`, so a plugin's rows can be as rich as IoT's.
- **Send is `effects: external`**: the agent can fill the HTTP client in
  (`targetId` included) but `_handler_runner` never runs it. The exchange
  (request beside response, auth said by name) is built server-side and
  always offered to the agent's chat (`render: attach`).
- **Layout items are keyed by their place in the manifest**, not among those
  shown: two outputs that take turns by `when` (IoT's things and
  certificates) were otherwise one component sharing a selection.
- **What a ported pane's state means.** Inputs are the source of truth -- a
  run never writes them back (S3's browse used to write `bucket`/`prefix`).
  A person's change to an input goes through the renderer's `changeInputs`:
  it clears what the input `resets` and runs the actions whose `on_change`
  names it, once each, with the new values; the agent's `set_pane_inputs`
  applies the same `resets`. Picker options (a loader's `{options}`) live in
  the tab only, never the session (D47). `view.` keys -- expanded rows -- are
  session state, synced and agent-settable like inputs (D48): how a pane
  looks is what the agent and other members change to show you something.
  Load more (`page`) appends and sums without bumping `resultsVersion`, so
  the selection survives.
- **Text from data uses `panes/template.ts`**: `{{ path ?? 'default' }}`,
  `{{ a ? b : c }}`, `| bytes | time | encode_path`. Nothing else -- no calls
  -- so a manifest from anywhere can only read what it's given.
- **A pane's settings are its ⚙** (D57, §18.6; `panes/PaneSettings.tsx`): in
  its header, or the selected tab in the tabs layout -- auto-refresh, the
  session variables it follows, whether it shows its inputs in view mode, and
  saved inputs; never in its cards (a select and a menu beside the first
  card's title read as clutter). The
  frame owns the header, the pane what the menu holds: AggregatorPage leaves
  a spot per pane (`components/paneMenuSlot.ts`, element and the pane's own
  name) and ManifestPane portals into it -- a click there bubbles through the
  pane, not the header, so it neither folds nor drags. "↻ 30s" shows beside
  it while the pane refreshes. Suites open it with `harness.openPaneMenu`.
- **Session variables** (D60, §18.7; `panes/variables.ts` and its twin
  `app/panes/variables.py`): `variables: {environment?, time?}` at the
  session's level, added and set in the card's Variables row
  (`components/SessionVariables.tsx`; a bar of their own under the card read
  as a stray card and was left behind when the card moved to the side panel).
  Folded, the card is its header alone -- to change a variable, expand it (the
  user's call: controls in the folded header were clutter). Binding is by input type, never per
  pane: Environment binds every AWS `connection`/`connections` input, Time
  range a layout `time_range`'s three inputs. **Automatic**: every pane
  follows unless `<pane>.unlinked` names the variable. The value is *copied*
  into the pane's inputs (ManifestPane's effect; `variables.apply` for the
  agent and a new pane), so refresh, the agent and templates see an ordinary
  input. A bound input is drawn read-only (`Bound`, a disabled fieldset with
  `display: contents`) with "From the session's … · Unlink". Changed in this
  tab (`announceVariableChange`), a bound pane's change is a person's
  (`changeInputs`) and its main action runs again if it had run and refresh
  could run it; changed elsewhere, inputs are only brought in line -- or
  every open tab would run every pane. The agent's `set_variables` runs
  nothing, like `set_pane_inputs`; setting a bound input unlinks it.
- **View mode** (D61): `viewMode` (the card's Mode: Edit | View), a pane's
  `<pane>.inputs` (`shown`/`hidden`) overriding it, and always on for a
  viewer member. `inView` keeps outputs, charts, sort, copy, errors and drops
  inputs, buttons, help, examples, the time range; a card is drawn only while
  one of its outputs or errors holds something (`showsInView`; a `run`
  output that is only running or done doesn't count, or the Query card stayed
  for its status line). Sort by is a view sort of the rows on screen, so it is
  in the results' own toolbar (`LogsView`), never a query card. Items keep
  their manifest keys -- hidden, not removed. A pane in view mode starts with
  `ViewModeLine` ("Updated … · Refresh", through the refresh route).
- **Saved inputs** (D46): in the ⋮ (the items, then "Save these inputs
  as…"); one table (`saved_inputs`) by pane type, the user's own; the server keeps
  only the manifest's non-sensitive inputs whatever the browser sends. The
  per-pane stores move into it once each, as their pane is ported
  (`panes/saved.py`, a `Settings` marker per move).
- **Clear** (D58): a card's `clear:` names the outputs its Clear empties --
  its results, never `run`, and not everything stored (DynamoDB's table
  info, MQTT's "Connected to…" stay). Shown only while one holds something;
  it goes through `POST …/outputs/{pane}/clear` with `ranAt` and
  `resultsVersion`, for everyone (a viewer's stays on their screen). An
  untitled card's Clear is put in its output's own title row (`TitleExtra`).
- **The browser loads manifests before any session mounts** (`PaneTypesGate`,
  App.tsx): the catalogue (`registerManifestPanes`), the renderer and the
  key migration all need them.
- **Moving a pane to v2 migrates its keys everywhere they can come from**, with
  no marker -- idempotent, a new key already present wins: on the server at PUT,
  read-out, `live_store.mutate`/`create` (`panes/state.migrate`); in the
  browser on load and on opening a template (`migratePaneKeys`). Input *names*
  never change in a port: the agent and its scripts use them.
- **Live functions** (D43) are a pane's outputs worked out as you type:
  TypeScript in `panes/live.ts`, a Python twin in `backend/app/panes/live.py`
  for the agent, both held to `backend/tests/fixtures/live_functions.json`
  (pytest, and `smoke63` via esbuild). Change one, change the other and the
  fixtures. Their outputs aren't stored -- the inputs are.
- **`sensitive` inputs** live in the component's memory only: never session
  state, templates, the agent. A pane whose inputs are all sensitive (JWT) has
  no agent run.
- **A `request` action** (the API table's Fetch, Prometheus' Run) runs
  server-side through `routers/panes.run_request`: a GET on a connection of
  any HTTP type -- the one its `connection` input names in `connection_type`
  -- the group's identity applied only if one exists, the SSRF guard, the
  reply masked. The agent runs the same function (D44). Declaratively, never
  code (D67): `fixed_path`; `params`, each a literal, `{input: key}` or
  `{window: start|end|step}` (epoch seconds over the inputs `window` names,
  in the browser's `_tz`, ~240 steps); and `rows` (`extract_rows`: `at`,
  `explode`, `columns` with `as: text|number|time`, `spread`, `labels` --
  one `name{k="v"}` series column), or the API table's `rows_at` input.
  **Prometheus** (`prometheus.yaml`) is the proof: no handler, no route, no
  registry entry -- only its manifest, which also ships its connection type
  (`connection_types:`) and suggests its catalogue category.
- **A `request` with a `service` is an AWS call** (D110, `aws_request.py`):
  `service`/`operation` (botocore's names; `list_functions` is
  `ListFunctions`), typed `params`, `paginate`/`max_items`, `rows`, on the
  `connection`/`connections` input of type aws, as the caller's identity.
  `run_request` hands it over first thing, so nothing else dispatches on it.
  Reads only, minus `DENIED` (credentials, secret values) -- `refused()` runs
  at check *and* at `call`, so a manifest that slipped past still can't.
  Several connections: rows flattened with `Environment`, failures in
  `error`. botocore loads models offline (`problems` checks names and
  parameters with no AWS call); tests use a `Stubber` client, the dev
  backend `PUT /api/dev/fake-aws`.
- **An action can be main *when* an input says so** (D119): `main: {input:
  searchMode, equals: rules}` (a `When` on inputs only); `Manifest.
  main_action(values)` / the browser's `mainAction(m, inputs)` take the first
  whose condition holds, else the `main: true` one. Everything that runs "the
  pane" passes the inputs: the agent (`panes._chosen_runner`), refresh and
  Run on open (`refresh_action(stored inputs)`), a bound variable's rerun, a
  zoom, Enter on a `submit` naming a main action, a workflow draft. Only a
  handler or a request can be chosen so. The buttons are layout items with
  `when`; actions themselves have no `when`.
- **A request may name its `output`** (D118, `routers/panes.written`/
  `request_keys`): its rows go there and a run replaces only that output and
  `error`. Without one it writes `rows` and replaces every output, so two
  requests in one pane (IoT's jobs and rules) each need their own. The
  browser's unstored path (a preview, a viewer) follows the same rule.
- **A tab left open across a deploy** sees `version.json` change (vite writes
  it; nginx serves it `no-store`), says so, and reloads at the next page or
  session switch -- after `flushAll()`, or the cut-off debounced save loses
  the last second and the server's older copy wins on the way back.

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

**A pane's outputs are not session state** (D21, PLATFORM_PLAN.md §18.2).
They are one record per (session, pane) in `pane_outputs`, versioned on
their own, written only by the server -- the action endpoint (given
`session`/`pane`, it stores what it ran: `routers/panes.apply_outputs`, the
browser's old rules of resets, Load more's append/sum and `ranAt`/
`resultsVersion`), background runs, the agent, refresh -- and announced as
`{kind: "outputs", pane, version}`, after which a tab GETs that one pane's
outputs. The session's version doesn't move, so a 1-second poll or a refresh
no longer resends the whole session or makes someone's save a 409. Session
reads carry `outputs` beside `state`; `out.*` keys found in a state (old
rows, an old tab, IndexedDB) move into a record when the pane has none and
are dropped when it has one (a record is newer), on every write, no marker.
A session write that drops a pane drops its record (ids are reused). The
browser keeps them in `sessions/outputs.ts` -- not IndexedDB, not the sync
fingerprint, not templates -- and a pane reads them with `usePaneOutputs`.
- An action for a pane the server hasn't saved yet answers **409 before
  running anything**; the browser flushes and asks again. (Flushing before
  every action made each one a round trip slower.)
- A reply carries the pane's stored outputs as `__outputs`: the asking
  tab's own write comes back with its origin, so its event is skipped as an
  echo, and the tab takes the reply instead. The refresh answer carries
  `outputs` for the same reason. A viewer's clicks aren't stored: the reply
  is theirs, shown in their tab only (`setLocal`).
- An input change's `out.` resets go to the server as `clear` on the first
  action they set off (one write, so they can't cross), or alone
  (`POST …/outputs/{pane}/clear`); the agent's `set_pane_inputs` clears the
  same way.

**The catalogue** (D66, §19.2; `catalogue.py`, `routers/catalogue.py`,
`sessions/catalogue.tsx`) is how panes are offered, everywhere: the default
page, the side panel's Add list, the strip's +, a session's card and the group
form all read `useCatalogue()` -- never group panes by `group` again. Categories
are rows with a fixed `key` (what a manifest's `category:`, else its `group`,
suggests) and a `name` an admin can change -- so a rename doesn't make the next
start recreate the old one (`ensure_categories` creates only a suggested key
that's missing). An admin's arrangement (`PUT /api/catalogue/layout`, the whole
thing) places every pane in it, pinning it against a manifest's later
suggestion; deleting a category places its panes in another. Favourites and
hidden are each person's (`catalogue_preferences`): Favourites first in the
shorter lists (not on the default page, where each card has its star), hidden
left out until "Show hidden". `GET /api/catalogue` gives each person only the
panes their group may use and drops empty categories except for an admin.
Access isn't here: moving a pane never changes who can use it. A suite that
arranges it puts it back (smoke81), or later suites see a different order.
A category has a `description` (the line under its heading on the default
page, edited with its name in Settings → Catalogue): null means its key's
default (`catalogue.DESCRIPTIONS` -- the Services/Tools/Platform lines the
browser used to hard-code), `""` an admin's "none"; a heading without one
keeps the same space before its cards (`.home-group-title.bare`).

**Home → a session** (R3, D63, §18.9). Per user, on `users`
(`home_session_id` -- the row's id, a client_id being only unique per owner --
and `home_session_title` for the note once it's gone; no foreign key, users
and live_sessions would point at each other), through
`/api/live-sessions/home` (declared before `/{client_id}`, or "home" is read
as a session id): GET says `home` (reachable now, owner or member), `missing`
(deleted or left) or neither; `PUT /{client_id}/home`; DELETE clears it, which
is also how the default page's note is dismissed. Not in `UserOut`: whether
it's reachable needs a query, and `user_out` serves every user listing. In the
browser `SessionsApi.home/setHome/goHome`: the brand calls `goHome` (activate,
or reopen if closed), and a load whose view is `home` lands there once, after
the lists and the home answer are in (`landing`). "Start new session…" still
shows the default page. `harness.clearWorkspace` clears it, or a deleted home
leaves its note on every later suite's default page.

**Auto-refresh** (R4, D22, §18.3; `panes/refresh.tsx`, `app/panes/refresh.py`).
A pane's `<pane>.refresh` (seconds; 0 off; unset follows the session's
`refresh`) is session state -- synced, kept by templates, set by the agent's
`set_refresh`. The timer is the tab's: only while the session is on screen
and the tab visible, jittered, asking at once when overdue, backing off by
the failures on the pane's outputs (`refresh: {failures, error, at}`). The
run is the server's: `POST /api/panes/{type}/refresh` decides under the
record's lock -- fresh (within 80% of the interval), another refresh under
way, a run going -- and otherwise runs `Manifest.refresh_action()` (main, or
the request; never `effects: external`, live or a stream) with the session's
stored inputs, as the caller. Floors: 10 s, 60 s for `cost: per_run`
(CloudWatch); env vars only raise them. A viewer's tab refreshes too, as the
viewer, only when they can reach every connection the pane's inputs name
(`refresh.unreachable`; otherwise "unreachable", nothing written, D62).
Set in the pane's ⚙, the session's on its card. **Run on open** (D77, §21.8)
is its other half: `<pane>.refreshOnOpen` (or the session's
`refreshOnOpen`) is a freshness window in seconds; when the session comes on
screen in a visible tab, each such pane asks once, with `fresh` instead of
`every`, and the server runs it only if its outputs are older than that
(the same lock and rules; a pane whose required inputs aren't set answers
`not_ready`, no failure). The ask waits for the window rather than being
dropped: on a load the state can arrive after the pane is on screen.

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
- **A load never lets this browser's stale copy win** (PLATFORM_PLAN.md
  §18.8). It used to push its whole local copy whenever anything was written
  before the server's list arrived -- and a pane's mount always writes -- so a
  stale browser undid changes made elsewhere and revived sessions deleted
  elsewhere (with the version it had just adopted, so the server took it). Now
  `useSessionState`'s first write is a `seed`, each open session is
  `mergeSession(base, local, server)` against the base stored beside the
  workspace in IndexedDB (`StoredWorkspace.bases`; without one, only what was
  done since the load is overlaid), a local-only session survives only if it
  was opened since the load or this browser never saw it on the server
  (`cwi-synced-<user>`, localStorage), and nothing is pushed before the list
  is in. Any new mutator in SessionContext records itself in `SinceLoad`.
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
  version, announce with origin `"agent"`), and a pane's results only through
  `pane_outputs.write`, which is how open panes follow the agent live. A run
  happens *between* two writes -- inputs, then results -- never holding a
  lock while AWS answers. The agent's readers see outputs through `_full`
  (the state with each pane's outputs back under `out.`).
- `platform_tools/panes.py` builds `KINDS` from the manifests (inputs, help,
  flag) and the registries of what only code can say (`HANDLERS`, `IMPLIES`,
  `ROW_LISTERS`, `DETAILERS`, by the names manifests use). For a pane still
  drawn by hand it is the server's copy of the pane's state keys and shapes
  (tagged Sets, `results` vs `osResults`, `resultsVersion` bumps) and has to
  move with the page: rename a key and the agent silently writes the old one.
  A ported pane's keys come from its manifest (`input_key`/`output_key`). The
  MCP tests pin the shapes.
- A pane's outputs may hold 4 MiB (`pane_outputs.OUTPUT_BYTES`); every
  writer trims to fit with `pane_outputs.fit` (the longest list halved).
- The agent can't know a dashboard's pixel width, so `arrange_dashboard`
  leaves a grid `dashboardPlan` and AggregatorPage turns it into rects the
  first time it measures the canvas, then clears it.
- **Two conversations.** *Global* (the panel's Global tab; its Agent page went at the user's ask) is
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
- JWT isn't agent-*drivable* on purpose: its state is browser-only (a
  pasted credential). It is still in `KINDS`, with no inputs, so the agent
  can add, name and arrange it -- left out entirely, the MQTT tester (then
  browser-only too) was reported as not existing. Every kind the user's
  group has belongs in `KINDS`. MQTT is drivable since 3b-5: the agent sets
  the topics, connects (`run_pane` waits `agent_wait` and returns what came)
  and disconnects (`stop_pane`), as itself. Anything with side effects
  outside the platform (sending HTTP, publishing) is `effects: external`
  and isn't a tool until the approval step exists.
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
`UserGroup`, which carries its identities (who it is on each kind of
connection -- its AWS role, D31), the visible environments and **one grant
per pane type** (D65, §19.1: `group_pane_grants`; the Admin group needs none).
`pane_access.py` is the one answer -- `allowed`/`require`, called by
`/api/pane-types`, the action and request endpoints (`run_handler`,
`run_request`), the HTTP client's Send and the agent's `available_kinds`; never
read a group boolean for a pane again. The old booleans (`logs_enabled`,
`tools_enabled`, …) are shorthand in the API only: read as "has any pane whose
manifest `flag` names it", written by granting or revoking those panes;
`pane_types` is the exact list and wins. They were migrated into grants once
(`pane_grants_migrated`), and a manifest's `flag` is optional -- a pane type
without one (a plugin's) is granted to no group until an admin ticks it in
Users → Groups → Panes. `agent_enabled` stays a boolean: the agent isn't a
pane. `/api/auth/me` returns `pane_types` (and the booleans) so the frontend
can decide what to offer (`enabledFor` in `paneTypes.tsx`).
The paragraph below is the history of how the routers came to check at all.
The agent's MCP tools re-check them (`platform_tools/panes.kind_for`,
`_flagged`), since the agent must never reach further than its user's UI
would -- **and so do the per-service routes now** (`resolve.require_flag`,
(now `pane_access.require`), called at the top of every AWS-calling endpoint left in `tools.py`, right
where `resolve_environment`/`resolve_role_name` already were; a ported
pane's actions -- every AWS call now, MQTT's included -- get it from
`routers/panes.run_handler`, and the action endpoint
answers a group without the pane's flag with the 404 of a pane that doesn't
exist). This used to be a real, if not agent-reachable, gap: a group with an
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

**The store repo** (D70, D78, D80, PLATFORM_PLAN.md §20.4, §21; `store.py`,
`gitrepo.py`, `routers/store.py`, Settings → Store). What admins define --
credential and connection types today; workflows, steps and panes as they
come -- is written through to a git repo in exactly a plugin repo's layout,
never a deployment's values or state.
- **Items stay in their own tables**; `store_items` tracks each (its file, the
  blob last written or read, `state`), and a change is queued in
  `store_outbox` **in the change's own transaction**: every save path calls
  `store.record(db, kind, id, op, actor)` before its commit (a no-op without a
  store). A new kind is one `Kind` entry (`dump`/`load`/`remove`), nothing else.
- **One writer at a time**: `flush()` takes a Postgres advisory lock, syncs a
  private shallow clone (fetch, hard reset -- a cache, never the truth),
  applies the outbox in order, commits as whoever saved, pushes, and replays
  on a refused push. A remote file that isn't the recorded blob is a
  **conflict** -- never overwritten; Settings → Store compares and resolves
  (Keep mine sets the expected blob to theirs and queues a write). Git
  unreachable: the rows wait, items say `pending` with why, `store.manager`
  retries with backoff (kicked after each commit), Sync now tries at once.
- **Restore** (`store.startup()`, at import in `main.py` after the built-ins
  and manifest types): what the repo holds and the database lacks is loaded,
  unless a delete of it is pending; a seeded manifest type is overwritten by
  the repo's edited copy; the first time a repo is configured, what was here
  is queued as one commit ("adopted", a Settings marker per url/branch/path).
  The session doesn't autoflush: anything that queries what it just added
  flushes first.
- **Ids** (D78): with a store, a new type is `<namespace>:<name>`
  (`store.full_id`, which the create routes call); built-ins and older ids
  stay bare. `:`, because `.` splits a pane id from its keys.
- **Config**: Helm env (`STORE_GIT_*`, a secret dir with `token` or
  `ssh-privatekey`/`known_hosts`) wins and locks Settings; else Settings keys
  `store.*`, its credential resolved through `credential_store.resolve()` as
  the admin who chose it. Only https/ssh (`file://` only with
  `STORE_GIT_ALLOW_FILE_URLS`, which pytest and the dev stack set); a URL with
  credentials is refused; the token goes through `GIT_ASKPASS`, a key through
  `GIT_SSH_COMMAND`, both masked. Tests run against real git (a bare repo).

**Workflows** (PLATFORM_PLAN.md §20.7, §22, D82–D86; `workflows.py`,
`routers/workflows.py`, `pages/WorkflowsPage.tsx`). Pipelines on a page of
their own (the rail's Workflows row), never a session.
- **A step is a pane's Action** -- a manifest's `request` or `handler`, run
  through `routers/panes.run_request`/`run_handler`, the very functions the
  action endpoint and the agent's `run_pane` call -- or a `note`. Never give
  workflows a runner of their own for something a pane does: that is the drift
  D49 ended. Background runs (`poll`) and `effects: external` actions are
  refused on save until 4b-2 (approvals).
- **The definition is YAML kept verbatim** (`source`; the store's file, a
  `Kind` with `file=`, its `id:` line added on save) beside what it parsed to
  (`definition`). It's checked in full on save (`parse`/`check`): strict schema,
  unique ids, pane/action/input existing, CEL compiling, `steps.<id>` naming an
  earlier step -- each error with its line (`_line`, through `yaml.compose`).
- **Templates are CEL in `{{ … }}`** over `params`, `steps.<id>.outputs/.status`,
  `item`, `index`, `run`, with the strings and math extensions (`join`):
  one whole template is its typed value, text around makes a string;
  `if`/`for_each` are expressions, braces optional. A map or list given to a
  `text` input is sent as its JSON (`_inputs`: an HTTP body). The files in
  `examples/workflows/` are checked by the tests -- keep them valid.
- **A parameter's choices load like a pane picker's** (D94, §22.9):
  `options_from: {pane, input, with}` borrows a pane input's loader, `with`
  over the other parameters only; `parameter_options` runs it as the caller
  through `run_handler`/`run_request` and flattens `{options}`/`{groups}`
  (`_flat_options`). `multiple` makes a text parameter a list. The form
  (`TextParam`, `useParamOptions`) lists again when a parameter it reads
  changes and stays typeable. A run takes a value that is plainly one listed
  choice -- another case, or part of just one -- as that choice
  (`_as_listed`, on `start`): asked for "/fake/API", the agent's run queried a
  log group that doesn't exist; anything else is kept as given.
- **A run acts as its starter** (every step through `pane_access.require` and
  the handler's own connection check), and **its inputs and outputs are its
  starter's, their group's and admins'** (`can_read`, D84) -- other granted
  groups see that it happened. **Editing is an admin's or its group's
  builders'** (D121, `can_create`/`can_edit(user, workflow)`): a builder's
  workflow gets `owner_group_id` and a grant to their group on creation;
  granting others stays an admin's; a builder names only panes their group may
  use (`access_errors`, at validate, save and the agent's check).
- **Step types** (D122, `step_types.py`, `built_step_types`, store `steps/`):
  `request` (an HTTP call on a connection input of an HTTP type, any method,
  CEL over `inputs`; `send` mirrors `run_request`'s identity, SSRF guard and
  masking) or `steps` (a workflow's steps over `inputs`, `outputs` mapped;
  no approval, artifact or background run inside). A workflow step names one
  (`step:`, `with:`); `_run_step_type` runs it, a chain inline through
  `_run_one` (depth `MAX_DEPTH`), and `_gate` asks a person for one that's
  `external` (any method but GET, or a chain holding one). A registry like
  built panes', loaded by `builder.load` (one generation); the store restores
  steps before workflows, whose check needs them. `workflows.check_steps`/
  `check_params` are shared by both. Try (`/api/builder/steps/try`) sends a
  draft request once, as the builder.
- **Runs run in-process**: `start` queues (with a row per step); `manager`
  claims with `SKIP LOCKED` in any replica and runs on a thread, a heartbeat
  per step; `sweep` fails a run whose heartbeat lapsed (not resumed, D85).
  Outputs are capped per step (`pane_outputs.fit`, 1 MiB). Tests call
  `workflows.drain()` (no lifespan, no manager).
- **The run page** reads the run every second while it's going, and is
  `?run=<id>` (`setRunParam`; opening the app at it shows it). Stage outputs
  are a table for rows, JSON otherwise -- the pane renderers are a session
  away (Investigate, below).
- The agent has `list_workflows`, `run_workflow` (waits up to `wait_seconds`),
  `get_workflow_run`.
- **4b-2** (§22.8, D87–D93): a `poll` action is a step -- started and polled
  on the runner's thread until done, a stream (`agent_wait`) listened to for
  `listen` s, both stopped on cancel/timeout -- with no `pane_runs` row.
  **Approvals** (`approvals`, general for the agent's external actions next):
  a step with `approval:`, and always an `effects: external` one (`_gate`),
  parks as `waiting` holding no thread; `decide` queues the run (approve) or
  fails the step (`_refuse`, `continue_on_error` carries on); `sweep` expires
  them. Who decides: `may_decide` (`anyone` = `can_read`, `others`, `admins`);
  the event kind `approvals` (no client_id) reaches deciders, and the browser
  passes it on as `APPROVALS_EVENT` (`workflowApprovals.ts`). **A run resumes
  from its records**: `_execute` reads back any step in `STEP_DONE` -- after an
  approval, and in a rerun from a stage (`rerun_from`: the old run's
  definition, earlier steps copied, `reused`). `retry` wraps the call only;
  every call runs on a thread of its own with its own session (`_call`,
  bounded by `timeout`, its error masked there). **Blobs** (`blobs.py`,
  `models.Blob`, `GET /api/blobs/{id}` checked by `can_read`): outputs over
  1 MiB keep a cut copy in the row and the whole in `outputs_blob_id`, which
  `_whole_outputs` reads back for later steps; `artifact:` steps; deleting a
  workflow removes its files; `blobs.clean` hourly. Tests set `STORAGE_PATH`
  to a temp dir (conftest).
- **4b-3, the doors** (§22.10, D95–D98; `workflow_doors.py`). **Investigate**
  (the run page's button, the agent's `investigate_run`, a reader's only): a
  new stacked session, a pane per stage that ran a pane action (a `for_each`
  stage a pane per item, ten at most), its inputs as the step ran them --
  through the agent's `panes.convert`, so tagged Sets stay Sets, and with
  what they imply (`kind.implies`: log groups tick their environment) -- its
  outputs written as the pane's own record; notes, files and decisions in the
  description. **Make repeatable** (the session card, admins): `POST
  /api/workflows/draft` writes YAML (a step per pane with a server action,
  each connection a parameter, implied inputs left out, several lines a `|`
  block), handed to the editor through `workflowFocus.ts`'s `offerDraft`,
  unsaved. **The Workflow pane** (`manifests/workflow.yaml`, handlers
  `platform.workflows.*`): a background run whose poll writes the run's
  summary and stages; its parameters are an input of type `workflow_params`
  (`of: workflow`), drawn by the Workflows page's own fields
  (`components/WorkflowParamFields.tsx`) and stored as key -> value
  (`coerce_params` also takes a connection's label, a list comma-separated;
  rows from before the form still read). Its picker has no `load_label`, so
  it loads by itself (`OptionsPicker`, once per mount). It links to its run
  (`runLink`, an output of `render: link`): a link into the app (`?run=`,
  `?workflow=`) is shown in place by `workflowFocus.followAppLink`, never a
  page load. The agent's `open_workflow` returns the same as `show`
  (`{href}`), which the agent service passes on beside `session_id` and the
  browser follows (always for `open_workflow`; with Follow for a run
  `run_workflow` waited on).
  **This run** (`workflow_runs.chat`, merged by turn id, `GET/POST
  /api/workflow-runs/{id}/chat`): the agent panel's second tab while a run is
  on screen (`setRunFocus`), sent as `scope: "run"` with `run_id`; the agent
  service reads `get_workflow_run` before the model speaks (`run_prompt`).

**Published templates** (PLATFORM_PLAN.md §23, D99–D102; `templates.py`,
`routers/templates.py`, `sessions/published.ts`, Library's Published tab, the
default page's Ready-made sessions). A saved template stays its owner's;
Publish (an admin's) copies it into `published_templates` under a namespaced
id, kept in the store (`Kind` `template`).
- **Portable on publish**, by each input's manifest type, never per pane:
  AWS connection inputs removed and the pane relinked to the Environment
  variable (left defined, empty); `log_groups` merged under `$environment`
  (the runs read the map's keys, so it's re-keyed on opening); non-AWS
  connections, credentials, OpenSearch indices and a workflow's connection
  parameters removed; a secret-looking header's value blanked. What changed
  is answered in words and shown to the publisher.
- **Offered** to whoever's group may use each of its panes
  (`templates.usable`, `pane_access.granted`) -- no grant of its own -- in
  place of the saved template it was published from (`saved_session_id`,
  told only to its owner as `from_saved_session_id`): both, under one name,
  read as a duplicate.
- **Opened by the server** (`templates.instantiate`): the environment the
  opener chose (and can reach) set, `variables.apply` per pane, the log
  groups re-keyed, then `live_store.create`; the browser `openFromServer`s
  it. From Add with one environment it opens at once; otherwise the default
  page's card asks. The agent: `get_context.templates`, `open_template`.

**The Builder** (PLATFORM_PLAN.md §24, D71, D103–D113; `builder.py`,
`routers/builder.py`, `pages/BuilderPage.tsx`). Phase 5-1: pane types made in
the platform, for a group with `builder_enabled` (admins always).
- **A built pane type is a manifest**, kept verbatim in `built_pane_types` and
  the store (`Kind` `pane`, `panes/<name>.yaml`, its `id:` line added), checked
  by the same strict model plus `builder.check` (always v2 and rendered; no
  `flag` or `connection_types`; handlers and live functions must exist; not a
  bundled id). Nothing of the builder's own code runs until Phase 6.
- **The registry merges it** (`pane_manifest.set_built`; `bundled()` stays
  cached, `manifests()` is the merge) and tells listeners -- the agent's
  `KINDS` is rebuilt in place. The saving replica loads at once; others follow
  the `builder.generation` Settings row within 5 s (`builder.manager`). Tests
  reset it in conftest (`builder.load`). Anything holding manifests at import
  time would miss a built one: read `manifests()` when needed.
- **Its id**: with a store, the Id typed is saved in its namespace
  (`lambda` -> `default:lambda`; the editor says so under the field, from
  `/schema`'s `namespace`), and the YAML may say either (D111). Check holds
  the YAML's id to that (`new_id`); a draft without an Id isn't held to
  anything -- its id line used to fail against "draft" first, and Check
  dropped that error, so nothing after it was checked.
- **Its handlers are its builder's group's** (D113, `usable_handlers`): only
  handlers of pane types that group may use (admins: all), held by Check,
  Preview, Save and the agent's check; the handler lists show only those. A
  built pane is its group's at once, so without this a builder reached a
  handler (DynamoDB's scan) an admin never granted them.
- **The preview** (D112): the real `ManifestPane`, given the draft's manifest
  from `/api/builder/preview`, in no session (outputs stay in the tab), its
  server actions sent through `panes/actionRunner.ts`'s context to
  `/api/builder/preview/actions` with the text it was drawn from --
  `run_request`/`run_handler` with `draft=True` (no pane grant for a draft;
  the Builder grant and D113 instead), nothing stored. Background runs aren't
  previewed. The agent's `preview_definition` is the same run, sampled.
- **The form** (5-2d, D115, `pages/BuilderForm.tsx`): Edit as YAML | Form
  over the one text. Every change goes through `pages/builderYaml.ts` --
  `setIn`/`deleteIn`/`append`/`swap`, splices at the `yaml` package's node
  offsets -- never `doc.toString()`: re-printing re-folded descriptions and
  re-spaced inline mappings, a hundred-line diff for a label. A rename
  follows the key into the layout and the requests. What the form doesn't
  cover stays the YAML's ("+N in the YAML"). Examples come without id, flag
  and connection types (`builder.example_source`), so they check clean.
- **Its builder's group is granted it on creation**; others when an admin
  grants it (D65). The browser reloads pane types, the user and the catalogue
  after a save (`useReloadPaneTypes`), so "Open in a session" works at once.
- **The agent panel's second tab is about what's on screen** -- a session,
  a run (This run) or an editor (Building) -- and isn't there with none of
  them (`AgentPanel`'s `hasSecond`; the chosen tab is kept for when one
  comes back): it used to sit there saying "Open a session…".
- **The agent builds beside the editor** (5-2, D107-D108). An editor that may
  be edited registers itself (`agent/buildFocus.ts`'s `useOfferBuild`: the
  Builder's, a workflow's `DefinitionSection`), and the agent panel's second
  tab is then **Building** (scope `"build"`, its turns in memory per editor
  key). The turn carries the editor's text; the router lets only whoever may
  edit it ask; the agent service reads `build_reference` first and attaches
  the text (`prompt.build_prompt`, `turn_reads`). The text is also the turn's
  **working draft** (D114, on the token: `build_kind/id/draft`):
  `edit_definition` changes it with find-and-replace edits, checked;
  `read_draft` shows it numbered; check/propose/preview use it without a
  `source`, and a refused proposal fails (it showed ✓). Tools: `build_reference`
  (`builder.reference`, generated from the models -- never hand-written
  docs), `read_definition`, `check_definition`, `propose_definition` -- the
  last only returns a checked draft as `propose`, which the browser puts in
  the editor unsaved (`apply`, with a notice). There is no save tool on
  purpose. A new tool for a model to build with belongs in `reference`, not
  the prompt.
- **A turn beside an editor is the Builder's loop, not the chat agent**
  (D116, `platform-agent/app/builder.py`; `AGENT_BUILDER=agent` brings the
  chat agent back). The code takes every step -- reference, plan, the AWS
  operations and examples the plan named, changes, check, repair (`rounds`),
  propose -- and asks the model only for one JSON object at a time (a plan;
  changes by path), its reasoning and a fence allowed around it, asked
  again when it isn't one. Nothing a model does there can end the turn
  halfway, so don't give it tools or a choice of steps back. Out of rounds,
  the draft is proposed with its problems (`even_with_problems`). Its steps
  are preamble (never replayed); `plan_change`/`write_changes` are the
  model's calls, labelled in `AgentChat`. Its model and rounds are its own
  (`AGENT_BUILDER_*`, Helm `agent.builder`), and it can run as its own
  Deployment (`agent.builder.deployment`, the backend's
  `AGENT_BUILDER_URL` for `scope: "build"`).
- **Changes by path** (D117, `yaml_edit.py`, `change_definition`): `set`/
  `add`/`remove` at `actions/list/request/rows`, a list item named by its
  key/id/title, `field=value` or index -- applied to the data, spliced over
  that key or item (a key on a list item's dash line keeps its dash), then
  read back: the text must mean that data, else the section is written whole,
  else refused. The Python twin of `pages/builderYaml.ts`. An alias (`*x`)
  can't be changed through. `describe_aws_operation` is botocore's model
  (no call), and `aws_request.problems` holds `rows.at`/columns to the reply.
  Changes are read as models write them (D120, `yaml_edit.normalise`): no op
  with a value is a set, `/-` an add, `replace`/`append`/`delete`, lists and
  mappings written as text (never over a text value); a refusal carries
  `SHAPE`, and the builder loop adds the model's own first change rewritten.
  A field a part can't have is reported with the fields it can
  (`builder._fields_at`). The loop's prompts are `.format()`ed even without
  placeholders: their braces are doubled. A part written with dots is that
  path (`yaml_edit._dotted`, D145) where no key is named so and its first
  piece is one -- the check names places with dots, and a model copied
  `layout.2.items` into changes that made top-level keys of that name; such
  a key is reported as one, with the remove that fixes it.
- **Rows that open are checked against what they open onto** (D146,
  `builder._opening_problems`): a row action's `row.<column>` against the
  columns the rows' request names (`Environment` on a fan-out), and a
  detail's `d.…` templates and section paths against the AWS reply its row
  action answers with (`aws_request._walk`), or its one row's columns. Code's
  detail is only known by running it. Both checked clean before and opened
  onto empty fields (`row.jobId` for a `Job ID` column; `d.job_id` where
  DescribeJob keeps `d.job.jobId`).
- **The loop keeps its work** (D147): a reply it can't read after changes
  were made puts the draft in the editor with what's left, never just an
  error; a reply cut off at the length limit (`repair.cut_off`) is said so
  and asked for in parts, and isn't sent back. A value per row that needs
  another call per row makes the listing action code (D148, the rules).
  Code the agent writes into the YAML is moved into `<action>.py` by
  `change_definition` (`_code_to_files`, D149; only code that change wrote);
  the loop names the files before the draft, says when a problem survived
  the round meant to fix it (D150, 6 rounds by default), and a turn left
  with problems offers **Fix what's left** (`AgentChat`'s `onFix`). Its
  replies may run to 16000 tokens unless `AGENT_BUILDER_MAX_TOKENS` says
  otherwise (0: send none) -- left to the provider, a reasoning model's
  thinking plus a set of changes was cut off mid-JSON.
- **The reference says what each field means** (D151,
  `panes/manifest_docs.py`, keyed by model class and alias; a test fails for
  a field without words or words without a field -- add both together).
  **Recipes** (D152, `panes/recipes/<name>/pane.yaml` + files, first line
  `# Recipe: …`): whole pane types the reference lists and `read_definition
  ("recipe:<name>")` reads; `test_recipes.py` saves and runs each, so keep
  them working. Code names a row's environment with `ctx.name(connection)`
  (`outbound.name`).
- **A clean draft is tried** (D153, `builder.try_draft`, MCP
  `try_definition`): main action with defaults and its connections in the
  chosen environment, then the first row opened; empty columns, a row action
  given nothing and detail paths that aren't there are problems for the
  loop's repair rounds (access errors are notes). With connections and no
  environment it answers `needs_environment`, and the loop proposes and
  emits `{type: "choices", action: "try"}`; a pick asks "Try it on X" with
  `try_on`/`try_now` on the build focus (AgentContext's `tryOnRef`, per
  editor, this tab). The agent service's `Focus` must name every field the
  backend sends -- it dropped `files`, so the loop never knew the files were
  there until its first change.
- **Empty data isn't a problem** (D154): trying calls an AWS column or detail
  field that's empty, or there but null, a note (Check already held its path
  to the reply's shape; an in-progress job has no `completedAt`); only an HTTP
  request's column empty in every row, or a field a code detail doesn't hold
  at all, is a problem. **Fix what's left** sends `fix_now` (no plan: check,
  try, repair), and out of rounds the loop reads what's left again
  (`Builder.left`) -- the last failure may have been a refused change.
  Check names `ctx.<anything but http/aws/name/log>` and `ctx.http(None|url)`
  in every Python file (`runner_client._ctx_problems`). A change naming the
  YAML as a file (`definition.yaml`, the id) is the YAML's
  (`server._yaml_named_as_file`); `actions[2].args` is a path; `op: edit` a set.
- **A blank draft starts from the closest working pane** (D155): the
  backend sends `blank` (a pane draft that's empty or exactly
  `builder.STARTER`, no files); the plan's `start_from` names a recipe or
  example, else `Builder.start_from` picks the recipe whose `#` notes share
  most words with the request (`_words`, `MIN_SHARED`, ties none), and
  `Builder.seed` makes the draft that pane (YAML without its notes, files
  written) before the changes. A draft with work in it is never replaced.
  Recipe notes are what the matching reads: write them in the words a
  user would use.
- **A table exports rows with their detail** like a list (D154,
  `ListView.IncludeDetail`, `useTableDetail().withDetail/load`): `detail.include`
  labels the box beside Export, `merge` the fields added. Never an export
  action -- code can't see which rows are selected.
- **The editor's tabs and Preview** (`Workspace.tsx`, `BuilderPage.tsx`): a
  file is added from a "+" that's the last tab (`.workspace-add`, named in a
  tab of its own; Esc or empty cancels), and the Preview card is there only
  while Preview (`.builder-preview-toggle`, pressed) is on -- the editor has
  the width otherwise; a stale drawing offers "Draw again"
  (`.builder-preview-redraw`), since Preview pressed again closes it.
- **Drafts** (D125, `build_drafts.py`, `/api/build-drafts`,
  `pages/buildDraft.tsx`'s `useBuildDraft`): each editor (pane, step,
  workflow) keeps its text, a new one's Id and its Building chat as its
  builder's own draft -- made by the first change, saved ~1 s after each and
  on unmount, put back on opening (an existing one's only once its saved
  text is in, or that load overwrote the draft). One per person per saved
  thing (`target_id`, a partial unique index); a new one's are rows of their
  own in the lists. The chat rides on the editor's `BuildFocus.draft`
  (`saveTurns`, `keep` for a proposal arriving after the editor closed), so
  a turn that outlives its editor still lands. Create/Save leaves only the
  chat, moved onto the saved one (`changed: false`); deleting the thing
  forgets everyone's drafts of it. Never the store's.
- **Rows that open, and paths** (D124): a row action may be a `request`
  (`routers/panes.run_row`; its detail is its one row, `{rows}`, or the
  reply without `rows`), its connection by the row's `Environment` name
  (`aws_request.connection_id`); a `table` takes `detail`/`expand` like a
  list (`ListView.useTableDetail`). Reply paths are `row_paths` --
  `[Key=Name]`, the CLI's `[?Key=='Name']` and its `| [0]`, nothing else of
  JMESPath -- at run and in the offline check. A built pane's table/list
  `config` and detail sections are held to `builder.CONFIG`/`SECTION_KEYS`:
  keep them in step with what the renderer reads.
- **Changes by line, and Clear** (D126): `yaml_edit` also takes `{"op":
  "lines", "from", "to", "text"}` -- the draft's lines as the loop shows them
  numbered, made bottom-up before the path changes, refused if a key ends up
  said twice in one mapping (YAML keeps the last silently: a stray
  `run_label` renamed another action's button). A path part `[2]` (or
  `actions[2]`) is a list item; asked of a mapping it's an error, never a
  new key. A Clear button is a card's `clear:`, never an action: the
  reference, the loop's rules and the no-kind action error say so.
- **The editors** (D127, `components/CodeEditor.tsx`): pane, step and
  workflow YAML with a line gutter (lines don't wrap, the gutter follows the
  scroll, Check's lines marked); the textarea keeps its id
  (`#builder-source` etc.) for the suites. In the Builder the two columns
  stretch to one height and the editor fills the definition's card.
- **Workflows in the Builder** (D128): Panes | Workflows | Steps (the user's names: never "Pane types");
  `WorkflowEditor` (WorkflowsPage.tsx) is the Builder's -- definition and
  access, Runs ▸ to the Workflows page. The Workflows page's New workflow and
  "Open in the Builder" go there through `workflowFocus.openInBuilder`.

**Code** (PLATFORM_PLAN.md §25, D130–D135; `runner/`, `runner_client.py`,
`outbound.py`, `routers/runner.py`). Python a builder writes, `code: |`
defining `run(inputs, ctx)`, on a built pane's action (a fourth kind beside
handler, live and request; `ManifestAction.served` is "handler or code", use
it wherever a handler used to be asked for) or a step type.
- **Never run in the backend.** `runner_client.run` mints a job (a
  `runner_jobs` row, its token hashed), POSTs it to the runner
  (`RUNNER_URL`, `RUNNER_TOKEN`) and finishes the row; without a runner it's
  a 503 that says so (D135), and Check still checks (`problems`: parses,
  has a two-argument `run`, at its YAML line).
- **The runner holds nothing** (D131-D132): a fresh `python -I -S
  bootstrap.py` per job, limits by rlimit, as its slot's uid when the runner
  is root (its image is, with every capability dropped but SETUID, SETGID,
  CHOWN, KILL), and swept as that uid after (`jobs._sweep`: its processes,
  then its files). A job's interpreter is the runner's own real one
  (`RUNNER_PYTHON`): a slot's uid can't enter a venv in someone's home.
- **Out only through the platform** (D133): the SDK's `ctx.http`/`ctx.aws`
  POST `/api/runner/calls` with the job's token; `outbound` makes the call as
  the job's user -- the connection by id or name among theirs, its own type
  passed to `resolve_target` (not AWS's), their identity injected, the SSRF
  guard, masked. A pane's code reads (GET/HEAD; AWS through `refused`); a
  step type's `changes: true` is `external` (approval) and its job
  `may_change`. Calls are capped (200) in the database, not the SDK alone.
- A pane's code returns only outputs it declares (`run_code`, unless it's a
  row action); a preview also gets `__logs` and a failure's log in its
  error. The Builder shows "The code's log"; the step editor's Try shows the
  outputs and the log. `runner_jobs` older than 30 days are pruned hourly.
- **Code lives in files** (6-1b, D136-D140): a pane's or a step's `files`
  (name -> text, a JSON column beside `source`; on the manifest and the step
  `Definition` as the private `_files`) and `code: {file: x.py, function:
  run}` naming one (`panes.manifest.CodeFile`); inline `code: |` still works.
  `runner_client.program` builds the job: every file, read-only in the job's
  own `src` dir appended to its path (so they import each other and never
  shadow the standard library -- `file_problems` refuses those names too),
  the entry imported as a module. Problems and failures carry `file` and that
  file's `line` (`builder.where`). Every route, draft and agent token carries
  `files`; the editors are `components/Workspace.tsx` (a tab per file over
  the one `CodeEditor`, `#<id>-file` for a file's textarea). The agent writes
  `{"op": "file", "name", "text"}` / `{"op": "lines", "file", …}`
  (`server._change_files`), sees the files numbered in the loop's context,
  and its proposals carry `files`; a multi-line string set into YAML is a `|`
  block (`yaml_edit._block`), never the quoted one-liner a model's Python
  became.
- **The store keeps a folder per pane, step and workflow** (D140; `Kind.main`
  -- `pane.yaml`/`step.yaml`/`workflow.yaml` -- and `Kind.files`): the
  outbox row's content is the folder's files as JSON, its version the
  folder's git tree (`gitrepo.tree_hash`, worked out here and equal to git's,
  `Repo.tree`); `_legacy` items still in a flat `<name>.yaml` restore as
  before and are moved by their next write -- `_move_to_folders` queues that
  once for all of them, one commit, at `restore()`.
- **Dependencies** (6-2, D141-D144; `deps.py`, `runner/app/venvs.py`):
  `requirements.txt` is a file of the workspace, names only (no options,
  URLs or paths: uv runs in the backend, so `-r /etc/passwd` or an index of
  the writer's would be this process reading or fetching). Check, Save,
  Preview, Try and the agent's check/propose lock it (`deps.locked`, uv
  `pip compile --universal --generate-hashes --only-binary :all:`, cached)
  into `requirements.lock`, whose first line hashes the requirements it came
  from (`is_fresh`): a matching lock is never redone, a stale one doesn't
  check. Only the platform writes the lock (the agent's `_change_files`
  refuses it; the editor's tab is read-only); Check's reply carries `files`
  when it locked. A job's lock goes to the runner with an index URL that is
  this backend with the job's token as its password (`runner_client.
  index_for`); `/api/runner/simple/` and `/files/` serve a token only the
  wheels its job's `deps_lock` names, fetched from `DEPS_INDEX_URL` once,
  checked against the hash, kept in `DEPS_CACHE_DIR`. The runner builds a
  venv per lock (shared, read-only to jobs, LRU past `RUNNER_VENVS_MB`) --
  ahead on save (`runner_client.prepare` -> `POST /venvs`, a `venv:` job
  row), else before a run -- and a job with one runs that venv's python
  with `-I`. Tests use `tests/wheels.py`, an index made of wheels built on
  the spot (no PyPI); it answers HEAD, which uv's compile asks first.
- **The runner checks itself at start** (`main.self_check`: one trivial job;
  `/health` answers 503 with the reason) -- with Helm's four capabilities a
  chmod after the chown (FOWNER), Popen's `cwd=` entered as root
  (DAC_READ_SEARCH) and root listing a job's home to remove it all failed,
  and every job said "Internal Server Error". `test_runner.py` runs a job
  under `setpriv` with exactly those capabilities.
- Tests: `runner/tests` (as root the isolation ones run: CI runs them both
  ways), backend `test_code.py` (a real runner subprocess and the backend in
  a thread for its callbacks), `test_store_folders.py`, `smoke103`, `smoke104`.

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
  only). Send (`http.send`) goes through `/api/tools/http-request`'s own
  function, which resolves it and applies its type's `inject` server-side,
  and masks the response -- an echoing server would hand the token straight
  back otherwise. The agent
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

**All AWS calls run as the caller's group's identity** on the connection
(`resolve.resolve_identity`), through `aws_client.py`: a role assumed from the
platform's own AWS identity, or access keys. Nothing reads ambient
credentials per service.

**Connections, environments and group identities (PLATFORM_PLAN.md §14,
Phase 2).** A connection says *where* (an AWS account and region, a base
URL); a group's identity says *who* (D31).
- **An environment is a named group of connections** (`models.Connection`,
  `connections.py`), several of one type allowed (D32): Prod can hold *iot*
  and *eks*. `connections.label()` names one "Prod" while it is its
  environment's only connection of its type and "Prod · iot" otherwise, so
  nothing anyone saw changed on the migration. Group access stays on
  environments.
- **Connection ids come from the environments' own sequence**
  (`server_default nextval('environments_id_seq')`), and an environment's
  first connection takes the environment's id. That is the whole migration
  of stored state (D34): every `environment_id` in pane state, templates,
  saved items and agent inputs is now a connection id that names the same
  place. Payloads and pane state keep the `environment_id(s)` keys until
  Phase 3 renames them with the one state shape. Panes don't know any of
  this: `api.listEnvironments()` returns `/api/targets?type=aws` shaped as
  `Environment`.
- **Who a request runs as** (`resolve.resolve_identity_values`): the group's
  override for that connection, else its default for the connection type,
  else the connection's own credential, else an error naming what's missing.
  Through `credential_store.resolve()` like any credential, so checked,
  audited (at most hourly per credential/user/purpose, D36 -- an AWS pane
  makes many calls a minute) and masked. `aws_client.Identity` keeps its
  secrets out of `repr`.
- **The IAM role is an "AWS role" credential** (built-in `aws_role`), the
  group's default AWS identity. `connections.migrate_legacy()` made one per
  group from `user_groups.role_name` and one AWS connection per environment,
  once (a `Settings` marker, not "has no connection yet", so a deleted
  connection doesn't come back on restart); conftest runs it the same way.
  `role_name` and `environments.account_id/region` are no longer read; the
  user-group and environment APIs still take and return them, on top of the
  new model (`set_group_role`, `environment_summary`).
- **A credential with no secret value needs no master key** (D35): an AWS
  role without an external ID is a name. `_seal`/`_open` ask for the keyring
  only when there is something to encrypt or decrypt; without that, a
  deployment with no `PLATFORM_MASTER_KEYS` lost AWS on the upgrade.
- **Connection types beyond AWS are HTTP APIs of a kind** (D67, §19.3):
  a Base URL always first (`connections.BASE_URL_FIELD`; `is_http`), then
  plain fields -- never secret, a secret is a credential -- and any
  credential type with an `inject` as a group's identity. Admins make them in
  Settings → Environments → Types (`ConnectionTypesSettings.tsx`; ids never
  change, panes name them); a manifest's `connection_types:` are seeded once
  when missing (`ensure_manifest_types`, `origin: "manifest:<pane>"`) and are
  then the admin's to edit. Built-ins are locked; a type with connections, or
  one a pane reaches (`needed_by`), can't be deleted; a field a connection
  holds a value for can't be removed. `get_context`'s `http_apis` lists every
  non-AWS connection with its `type`.
- **The HTTP client's Target** (`http_api` connections, D33): `url` is then a
  path joined to the base URL server-side, signed with the group's identity
  there (or the connection's own), through the same SSRF guard.
- The agent sees each AWS connection in `get_context`'s `environments`
  (`name` is the label) and a pane input may name a connection by id or
  label, or an environment when it has exactly one AWS connection --
  several, and it is told to choose (`panes._visible_environment`).
- **Settings → Environments / Users → Groups** use the Credentials layout
  (`settingsLayout.tsx`): connections are saved one by one (each is its own
  record panes point at), with "Test as…" a group; the group's Identities
  replace the IAM role field ("A new AWS role…" creates the group's own
  `aws_role` credential on Save). Users and their groups are one tab with a
  `ViewSwitch` (D50), as Credentials and Types are; "Saved" is **Library**
  (Templates, Saved inputs, and the per-pane stores not yet migrated).

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
The panel's ✕ and menu say Leave for a member and call that; a Delete the
server refuses puts the session back with a notice (`SessionsApi.notice`) --
a member's Delete used to 404 silently and the session came back on reload.

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

**A change to the roster is announced to the member it touches**, on the
same commit: an invite as an `"upsert"` (their open browser fetches the
session and adds it to their rail), a removal as a `"delete"` (it leaves
their rail), and a permission change as `"access"` -- the session's version
doesn't move, so an upsert would be skipped by a browser already holding
it, and `"access"` makes it re-read the row for its `role` (a viewer's
browser keeps its edits to itself, so one made an editor did until a
reload). Before this, none was announced: a session shared with someone
showed up only when the owner next wrote it, since `commit_write` is what
tells every participant (`smoke70`).

**Pictures** (D129): `SessionMemberOut`/`SessionParticipant` carry
`avatar_url`; the card's Members and each question in a session or run chat
show the asker's (`AgentChat`'s `pictures`, read from `/participants` by
user id and again for an author not yet among them) -- never stored in
`agentChat`, which would repeat the same image per turn.

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
- **A turn that stops while it still means to act is asked to carry on**
  (`repair.stopped_short`): no answer, an answer ending on a colon, one that
  announces a step before anything ran, **and, after it has called tools, a
  last sentence that plainly looks ahead** ("Now let me run the workflow.",
  "Next, I'll…" -- `_ANNOUNCES_AFTER`; "I'll keep it running" is a report),
  or a reply the provider cut off at its length limit (`cut_off`). Twice per
  stretch between tool calls (it was per turn, and a long build turn spent
  them early), an empty reply once; still announcing after a nudge, the turn
  ends with a notice that it stopped short (`guard.stuck`). A real turn read the workflows, said
  what it would do next and stopped; the user had to tell it so.
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
  A kind opts in from its manifest (`inspect`): a ported pane's rows are
  its list outputs as the pane draws them, and its detail is the list's row
  action (a second look-up, acting as the caller and refused for an
  environment they can't reach); a pane still drawn by hand names a row
  lister in `PaneKind.rows`. `get_context` says which kinds can. IoT's detail is the thing's shadows, certificates and
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
- **What the agent reads it can write back, and it can see a run.** A pane's
  description (`_describe_pane`, under `get_session` and every change tool)
  gives inputs in the shape `set_pane_inputs` takes (`panes.agent_value`: a
  headers input as name -> value, not the editor's rows -- shown the rows, a
  model sent `query: []` back and was refused), a background pane's `run`
  (running / stopped by whom / "not running: run_pane starts it (Connect)")
  and its short text `outputs` ("Connected to … as …"). `set_pane_inputs`
  says "Only the inputs changed; nothing ran." Without these, a model filled
  the MQTT tester in and reported it connected, three turns running.
- **Every answer is checked against what the turn ran** (`check.py`, D55,
  PLATFORM_PLAN.md §17): one more model call reads the request, the turn's
  calls and results, the sessions it touched as they are *after* the answer
  (read by the platform, so "connected" meets the pane's run status) and the
  answer, and says ok / not_done / unsupported. A failed answer is retracted
  and redone once (not after a grounding redo); a second miss stands with a
  notice. The check is the platform's own step in the chat (`check_answer`,
  `preamble`, so never replayed in history), never blocks a turn (a failed or
  unreadable check passes), runs on a per-turn HTTP client (langchain_openai
  shares one per base URL, and a kept-alive connection from another event
  loop failed the next check), and is `AGENT_CHECK`/`AGENT_CHECK_MODEL`
  (Helm `agent.check`). The guard's nudge also catches "Let me reconnect…."
  ending on a period before the turn has called anything, and after a failed
  call it quotes the failure. Scenarios to try a real model against live in
  `platform-agent/evals` (its README); add one for every conversation the
  agent gets wrong.
- **The agent is seen working** (D59, §18.6). A running turn's
  `TurnProgress` says what it's doing (its running step, "Working out the
  next step", "Writing the answer") and for how long, the whole time --
  "Thinking…" showed only until the first step, and a reasoning model's
  quiet between steps read as stopped. The other chat's tab has a dot, the
  compose box says where the agent is busy (with Show), and the panel's
  toggle is marked while closed. A session turn is written into `agentChat`
  when asked (`startedAt`, the question only): only the asking browser
  streams, so members saw nothing until the answer. That browser filters its
  stored copy out for the live one (`liveTurnId`); a "running" turn older than
  10 minutes is `abandoned` (its browser went away). `mergeChatTurns` keeps
  the answered copy of a turn over a "running" one.
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
  the agent and the fake model running (`frontend/e2e/README.md`). A run the
  server polls can't be faked in the page, so the suites serve the backend as
  `uvicorn dev.fake_aws:app`: accounts starting "0000" are answered there
  (smoke69), every other account goes to AWS as before; a `.fake` HTTP host
  answers with what a suite `PUT /api/dev/fake-http` there; and
  `harness.mockPaneActions` (which fakes an action's AWS part in the page)
  hands its result to `/api/dev/store-result`, which stores it with the
  server's own code -- results are the server's to store, and one faked in
  the page alone never reaches a second tab.
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
- **The rail's pages** (Workflows, Builder) each have a drawn icon
  (`Icon` `workflow`/`builder`); with the rail hidden the strip shows the
  same icons right after its toggle (`.session-bar-page`, the approvals
  dot on Workflows). A stored view naming a page that's gone (`agent`)
  loads as home (`SessionContext.knownView`).
- **There is no header bar.** The brand (`components/Brand.tsx`) is the
  rail's header bar (`.rail-head`, padded like the strip so it's level with
  the tabs), or starts the strip while the rail is hidden. The account's
  picture ends the strip, or the docked agent panel's header (a floating one
  leaves it on the strip). Anything that measured from a 53px header is
  measured from the window's top now.
- **Small square buttons are drawn icons** (`components/Icon.tsx`, one
  16-unit grid and stroke) in `button.icon-btn`, one 24px box: a pane's
  header and tab, the session card's header, the ✎ beside a name. Text
  glyphs (✎ ⋮ − ✕ ▲) took their size from the font, so the boxes came out
  wide and uneven. 24px keeps a pane header 40px high (`DASHBOARD_HEADER_H`).
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
  description (edited in the same kind of box), adds, layout and mode (each
  its own row, one segmented control each), refresh, variables (a chip per
  variable with its ✕, "+ …" for the rest), and members (see sharing, above)
  -- the one section that isn't backed by session state, fetched instead
  from its own API on mount. Every control in those rows is 28px high, and
  the members are one grid with the invite row, so a member's permission and
  ✕ sit over the invite's select and button. It folds to its header (`cardCollapsed`, per session like a
  minimised pane), in the body and in the side panel alike, to its header
  and the session's name. PageInfo is
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
