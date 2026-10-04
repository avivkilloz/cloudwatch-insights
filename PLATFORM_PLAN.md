# PLATFORM_PLAN.md

The plan for turning this platform from an AWS debugging console into a generic,
extensible workbench: workflows, plugins, an internal builder, secrets, and an
"environment" that means something for any provider.

**How to use this file.** It is the working record of an ongoing discussion, kept in
the repo so a session that ends early loses nothing. Update it as decisions are made:
move an item from *Open questions* to the *Decision log* (with the date and the
reason), and tick roadmap items as they land. `CLAUDE.md` holds what is already built;
`PROGRESS.md` holds where the current work stands; this file holds where we are going
and why.

_Started 2026-10-04. Status: **agreed 2026-10-04**: D1–D22 and requirements R1–R4 (§11). No open questions. Next:
detail Phase 1 before building it._

---

## 1. The ideas, organised

What was asked for, grouped. Everything later in this file refers back to these.

**Extensibility, from three directions**

- **Workflows.** A global page (not a session page), under Home in the rail, also
  reachable from an icon in the subheader next to the expand/minimise button. A
  workflow has a pane's capabilities: it takes inputs, detects them dynamically, does
  something and produces outputs. But it runs like a Jenkins build with parameters,
  not as a window on a session's dashboard. Its steps can be built-in, custom, or
  provided by external plugins.
- **External.** Import ready-made panes, secret types, configuration types,
  workflows and steps from public repos, or from private repos given a token or SSH
  key. A marketplace/store page, possibly fed by a registry repo of plugin manifests
  that external developers push to or open PRs against. The implementation is open
  for discussion.
- **Internal.** Inside the platform: custom configurations, custom
  credentials/secrets, custom steps for workflows and panes, and a "pane builder"
  page.

**Challenges named**

1. The platform has assumed AWS throughout (MQTT picks an AWS environment to find the
   broker). It has to serve any provider and any source.
2. The agent can drive today's panes. It must be able to drive *any* pane of *any*
   kind, so panes must be built in a way the agent can interact with fully.
3. Environments, with group access to them, are worth keeping: "do this in
   environment X" is how users talk to the agent. But an environment means different
   things to different providers (an AWS account and region; something else
   elsewhere).
4. Some configuration and secrets apply per user group, others globally.

**What a pane is (as described)**

- An object/window that runs code from inputs and produces outputs in different
  formats.
- Inputs can be arranged in separate cards, in different formats.
- Outputs can be lists, text, diagrams, iframes and more.
- An input can be plain (string, number, static choice list), or **based on
  platform configuration** (credentials/secrets, environment variables,
  environments, users), or **dynamic**: its options come from code run on other
  inputs' values (pick an environment → list its buckets → pick a bucket → list its
  files).

**Secrets (as described)**

- Stored securely.
- Possibly text, file or JSON.
- Open question: should credential *types* be handled separately (username/password,
  AWS keys, SSH keys…), as Jenkins does? Research what Jenkins, n8n and others do, and
  pick the best approach. See §6.

---

## 2. The one idea that holds it together: the **Action**

Panes, workflow steps, the agent's tools, and the "dynamic options" of an input are
all the same thing seen from different sides:

> an **Action** is a typed function: an *input schema*, a *handler* that runs
> server-side, and an *output schema*.

- A **pane** is one or more Actions plus a *layout*: which input goes in which card,
  how each output is rendered, which button runs which Action. It is interactive and
  lives in a session.
- A **workflow** is a sequence (later a graph) of Actions with *parameters*, whose
  *runs* are recorded and can be re-run. It is batch and lives on the Workflows page.
- An **agent tool** is an Action, exposed over MCP and generated from its schema.
  The agent can then drive every pane and every step, whoever wrote it.
- A **dynamic input** ("list the buckets of the chosen environment") is a small
  Action whose output is a list of options and whose inputs are the other fields it
  depends on.

Why this is the right cut:

- It answers challenge 2 by construction. The agent never needs to be taught a pane:
  it reads the same schema the UI renders from. This is already half-true today:
  `backend/app/platform_tools/panes.py`'s `PaneKind`/`Input` is a hand-maintained
  copy of each pane's inputs for the agent. The plan makes that schema the **single
  source of truth** for the UI too, instead of a second copy that must move with
  every page (the trap CLAUDE.md warns about).
- It answers the earlier "no per-service tuning of the agent" rule (CLAUDE.md). A
  plugin ships its schemas; the agent needs nothing new.
- Workflows reuse panes' building blocks rather than a parallel system: a step
  "list S3 objects" is the same Action the S3 pane runs.
- External and internal extensibility become one thing: a plugin contributes Actions
  (plus types, renderers and layouts), and the builder authors Actions and layouts.

## 3. Core model (proposed vocabulary)

Kept small. Each is a registry: built-ins ship with the platform, plugins add more.

| Concept | What it is | Today's equivalent |
|---|---|---|
| **Provider** | A family of systems: AWS, GCP, Kubernetes, GitHub, Postgres, "HTTP API"… | Implicitly AWS everywhere |
| **Connection type** | What it takes to reach one instance of a provider: a schema of fields, some secret; how to test it; how to get a client from it. | `Environment(account_id, region)` + group `role_name` |
| **Connection** | One configured instance of a connection type (e.g. AWS account 1234 in eu-west-1 via role X). | An `Environment` row |
| **Environment** | A named place users talk about ("Prod", "IoT Test"), holding **one or more connections**. The unit of group access. | `Environment` row (one AWS target) |
| **Credential type** | A schema for a secret (username+password, AWS keys, SSH key, bearer token, text, file, JSON…), with which fields are secret. | none |
| **Credential** | One stored secret of a credential type, scoped globally or to a group. | none (only `role_name`) |
| **Config value** | A non-secret setting, scoped globally or to a group. | `Setting` (branding only) |
| **Action** | Input schema → handler → output schema (§2). | `PaneKind.run` + the routers it calls |
| **Pane type** | Actions + an input layout (cards) + output renderers. | `PANE_TYPES` (frontend) + `KINDS` (agent) |
| **Workflow** | Parameters + ordered steps (each an Action), with recorded runs. | placeholder page |
| **Plugin** | A versioned package contributing any of the above. | none |

### 3.1 Environments, generalised (challenge 3)

**Decided (D1): an environment becomes a named group of connections, and stays the
unit of access.**

- "Prod" can hold an AWS connection (account + region + role), a Kubernetes context,
  a Postgres DSN, a GitHub org: whatever lives in "prod".
- A pane or step asks for an input of type *connection of type X*. When the user (or
  the agent) says "in Prod", it resolves to Prod's connection of that type. If Prod
  holds two connections of one type (two AWS regions, say), the input asks which one.
- Group access stays on environments, exactly as today ("access control is per group,
  never per user"). A group that can see Prod can use Prod's connections, never their
  secrets.
- The agent's existing phrase "do this in environment X" keeps working unchanged, and
  works for any provider.
- **Migration:** each existing `Environment(account_id, region)` becomes an
  environment of the same name holding one `aws` connection. The group's `role_name`
  becomes that connection's role. Ids are kept, so saved sessions and group access
  survive untouched.
- The MQTT case shows why: "pick an environment → find its broker" becomes "the MQTT
  pane asks for a connection that can supply a broker". The AWS connection type
  supplies one through IoT; a plain MQTT connection type (host, port, credentials)
  supplies one directly. The pane stops knowing about AWS.

Alternative considered: make "environment" itself typed (an AWS environment, a k8s
environment). Rejected for now: "Prod" would split into one entry per provider, and
"do this in Prod" would stop meaning one thing.

### 3.2 Scopes: global vs group (challenge 4)

Every credential and config value has a scope:

- **global:** visible to every group. Usable only by admins, or by groups granted
  the item.
- **group:** owned by one group and usable by its members.
- **(later) personal:** a user's own token, e.g. their GitHub PAT.

A connection references credentials, never embeds them. So one credential can back
several connections, and rotating it is one edit. This mirrors Jenkins'
global/folder stores and n8n's project sharing (§6), mapped onto the groups we
already have.

## 4. Panes, as plugins can build them

### 4.1 The pane manifest

A pane type is described by data (JSON/YAML), with handler code referenced by name:

```yaml
id: s3-browser
label: S3 browser
provider: aws
inputs:                       # one schema, rendered by the UI and read by the agent
  - key: environment
    type: environment          # platform-backed: the user's environments
  - key: connection
    type: connection
    connection_type: aws
    from: environment          # resolved from the environment chosen above
  - key: bucket
    type: choice
    options: { action: list-buckets, depends_on: [connection] }   # dynamic
  - key: prefix
    type: string
layout:                       # how the inputs are arranged
  cards:
    - title: Where
      inputs: [environment, bucket]
    - title: Filter
      inputs: [prefix]
actions:
  - id: list-objects
    handler: aws.s3.list_objects   # built-in, plugin-provided, or a declarative HTTP call
    run_label: List
outputs:
  - key: objects
    render: table              # table | text | json | code | chart | diagram | iframe | markdown | file
    inspect: true              # rows can be looked at in full (today's inspect_row)
```

### 4.2 Input types

- **Plain:** string, text (multi-line), number, boolean, choice, multi-choice, date
  or time range, JSON, file.
- **Platform-backed:** `environment`, `connection` (of a type), `credential` (of a
  type, by reference: the value never reaches the browser), `config`, `user`,
  `group`.
- **Dynamic:** any choice whose `options` come from an Action that `depends_on` other
  inputs. The UI calls it when those inputs change; the agent gets the same Action as
  a tool ("list the options for bucket"). This generalises what panes do by hand
  today, such as the log-group picker.

### 4.3 Output components, and the actions on them

Today's panes do far more with results than display them. CloudWatch lets you pick
rows, send them to the agent and export them; S3 copies an object's URI or URL. The
builder has to offer the same (decision D3). The model:

> an **output component** draws a piece of output, and offers **output actions**
> on all of it, on the selected rows, or on one row.

An output action is an Action too: it takes inputs (the row, the selection, or the
whole output), does something, and produces an output. What differs is *where* the
"does something" happens, and that splits actions into two halves that compose:

1. **Server half (optional):** an ordinary Action, run on the backend with the row's
   or selection's values as inputs. Example: "presign this S3 object". It needs the
   connection's credentials, so it can only run server-side.
2. **Client half:** an **effect** from a fixed, built-in vocabulary, applied in the
   browser to the server half's result (or straight to the row if there is no server
   half):

| Effect | Does | Example |
|---|---|---|
| `copy` | puts a templated string on the clipboard | `s3://{{ row.bucket }}/{{ row.key }}` |
| `open_link` | opens a templated URL in a new tab | the AWS console link for a log group |
| `download` | saves a file the server half produced, or a templated text | a presigned object download |
| `export` | writes the rows as CSV, JSON or XLSX (`write-excel-file`, per CLAUDE.md) | "export selected" |
| `attach_to_agent` | sends the rows to the session's agent chat | today's `PaneSelectionShare` |
| `open_pane` | opens another pane with inputs filled from the row (drill-down) | a thing → its shadows; a log line → search by its request id |
| `set_input` | writes a value into one of this pane's own inputs and optionally re-runs | click a field value to filter by it |
| `toast` | shows a short message | "Copied" |

So today's "Copy S3 URI" and "Copy object URL" are both just *client: copy* with a
template (they're built in the browser; see §4.7). A presigned "Download", which
doesn't exist yet, would be *server: presign → client: download*. Both are configurable in the builder with no code: pick
the scope (row, selection or all), optionally a server Action, then an effect and its
template.

**Why a fixed effect vocabulary rather than plugin JavaScript.** Effects are the only
code that runs in the browser with the user's session, so they are ours, written once,
and safe by construction. A plugin can still draw anything it likes through a
sandboxed iframe component (§7.4). That component asks the host to perform an effect
over `postMessage`, and the host decides whether to allow it.

**The component set.** Built-in and generic, each configured by the manifest:

- **table:**
  - Columns, each with a field, a label and a format: timestamp, bytes, duration,
    JSON, link, badge.
  - Sort, filter, a column picker, and paging or virtual scrolling for large results.
  - Row selection, and row expansion that fetches more through a detail Action
    (today's IoT expansion and the agent's `inspect_row`, made one mechanism).
  - Row, selection and toolbar actions.
- **log list:** a table variant tuned for log lines: wrapped messages, level colours,
  per-environment grouping, newest first. This is what CloudWatch and OpenSearch use.
- **key-value / detail:** one object's fields, with nested sections. Thing detail and
  Cognito user use it.
- **JSON tree, text, code, markdown, diff.**
- **chart, diagram (Mermaid).**
- **file list / tree:** S3's prefix browsing. Clicking a folder is a `set_input` effect
  on the prefix input.
- **stream:** messages appended live. MQTT uses it; see §4.4.
- **iframe:** sandboxed, for a plugin's own visuals.

**Visualizations: the inventory is the floor, not the ceiling.** §4.7 lists what
today's panes already do, and so what porting must not lose. The component set goes
well beyond it:

- **Charts:**
  - **time series** (line or area, many series, stacked, two axes)
  - **bar/column**
  - **pie/donut**
  - **scatter**
  - **histogram**
  - **heatmap** (also for latency distributions over time)
- **Numbers:**
  - **stat / KPI tile:** a value with unit, change against a previous period,
    sparkline, and threshold colours.
  - **gauge**.
  - **metrics grid:** a row of KPI tiles.
  - **table cells with sparklines or bars**.
- **Structure:**
  - **timeline / waterfall:** workflow runs, traces, deployments.
  - **node graph:** service maps, dependency graphs, IoT thing groups.
  - **Mermaid diagram**.
  - **Later:** a **map**.
- **Over the log list:** a log-volume histogram, as Kibana and Grafana show.

How it stays generic, and authorable in the builder and by the agent:

1. **One data shape for every visualization: a data frame** (Grafana's model).
   - An Action's output is a set of named fields (columns), each with a type: time,
     number, string, boolean or JSON.
   - Any visualization can draw any frame. The builder picks a visualization and maps
     fields to its roles: x, y, series, value, label, colour.
   - Tables, charts and KPI tiles therefore all read the same output, and one Action
     can feed a table and a chart side by side.
2. **Our own small declarative spec**, not a charting library's options:

   ```yaml
   - render: timeseries
     x: "@timestamp"
     y: [count]
     series: environment
     unit: requests
     thresholds: [{ value: 100, colour: warn }, { value: 500, colour: error }]
   ```

   - It is short enough for the builder's form and for the agent to write ("chart
     errors per environment over time").
   - It doesn't tie manifests to a library: we can change the renderer without
     touching a single plugin.
   - Units, decimals, thresholds and per-field overrides follow Grafana's
     field-options model.
3. **One charting library behind the spec, loaded only when a chart is on screen**
   (the way `write-excel-file` is today).
   - Recommendation: **Apache ECharts**. It covers every chart above, including
     heatmap, gauge and node graph, renders to canvas so large series stay fast,
     and is modular.
   - uPlot is lighter for pure time series, but would need a second library for
     everything else.
4. **Interaction through effects:**
   - Brushing a time range on a chart sets the pane's time inputs and re-runs
     (`set_input`).
   - Clicking a bar or a node can drill down (`open_pane`, `set_input`).
   - KPI tiles can link to the pane that explains them.

   It is the same vocabulary as table actions, so the builder offers one way to wire
   interactions.
5. **Dashboards** (saved views, a placeholder page today) are then sessions of panes
   drawing these components. Nothing dashboard-specific is needed beyond layout,
   which the session's dashboard layout already has.

**The agent and output actions.** Server halves are Actions, so the agent gets them as
tools ("presign row 3"). Client effects mean nothing to the agent (it has no
clipboard), except `export`: the agent can ask for an export as a server-side file and
link to it. The agent reads outputs through the same component data (`inspect_row`
generalised).

**Complexity.** Moderate, and mostly front-loaded.
- The effect vocabulary and the action plumbing are small.
- The real work is a generic table/log component good enough to replace CloudWatch's
  hand-built one (selection, expansion, virtual scrolling, export) without the pane
  getting worse.
- Most of these components already exist in some form inside individual pages. The
  work is extracting and generalising them, not inventing them (see the inventory in
  §4.7).

### 4.4 All panes behave the same: porting today's panes

Decision D5: there are no second-class "hand-written" panes. Every pane, built-in
included, is a manifest drawn by the one renderer with the one component set. That
is how the builder and plugins get everything today's panes have, and how the agent
can drive all of them.

How to get there without breaking anything:

1. **Manifest first, for the agent.**
   - Write each existing pane's manifest (inputs, actions, outputs), and generate
     `panes.py`'s `KINDS` from them.
   - Nothing visible changes. The agent/UI drift CLAUDE.md warns about ends here.
2. **Components by extraction.**
   - Build each generic component by lifting it out of the pane that has the best
     version of it today.
   - Each extraction is checked against that pane's browser suite, so the pane stays
     identical.
3. **Port pane by pane.**
   - Switch each pane to the generic renderer once its components exist, simplest
     first: Base64, Diff, JWT, then S3, DynamoDB, Cognito, IoT, and CloudWatch/
     OpenSearch last.
   - A pane is done when its browser suite passes unchanged.
4. **One state shape, reached by a versioned migration** (recommended; see open
   questions).
   - **The shape:** every pane stores
     - `<pane>.in.<input>` for its inputs;
     - `<pane>.out.<output>` for its outputs;
     - `<pane>.view.<key>` for view state: sort, expanded rows, column choice.
   - **What it buys:**
     - The renderer, the agent (`panes.py`) and templates all work the same way for
       every pane.
     - "Templates keep inputs, drop outputs" becomes "drop `.out.`" instead of a
       per-pane list of output keys.
     - A new pane can never get it wrong.
   - **The migration:** each ported manifest lists its old keys (`legacy_keys:
     {queryString: in.query, …}`), and one migration moves them.
     - It runs on load in the browser, next to `migrateLogsSplit`/`wrapAsAggregator`,
       and on the server's read path for the agent.
     - It is guarded by a `paneStateVersion` marker, so it runs once per session,
       and it is idempotent.
     - Saved templates get the same through `__savedStateVersion`.
   - **Why not keep the old keys forever:** the renderer would need a per-pane key
     map indefinitely, which is the drift problem CLAUDE.md already warns about.

Panes that need more than "run an Action, draw its output":

- **MQTT** keeps a live browser connection today. As a manifest pane it becomes:
  - a server-side **subscription Action**, which holds the MQTT client with the
    connection's credentials;
  - a **stream** output fed over the existing event-stream plumbing;
  - a **publish** Action.

  This moves the live connection to the server (D6). The reasons, weighed against
  keeping it in the browser:
  - **Any broker, not just AWS IoT.** A browser can only speak MQTT over WebSockets,
    so it can't reach a broker that listens only on TCP 1883/8883, which is most
    non-AWS brokers. A server can reach both.
  - **Secrets stay on the server.** A generic broker needs a username and password or
    a client certificate. In the browser, that secret would have to be handed to the
    page. Today's AWS case avoids this only because a presigned URL is a short-lived
    credential.
  - **Shared sessions see the same stream.** A browser connection belongs to one tab.
    A server subscription streams to every member viewing the session, and can keep a
    short history.
  - **The agent and workflows can use it**, which today they can't (CLAUDE.md: "MQTT
    and JWT aren't agent-drivable on purpose").

  What the browser did better, and what the server must match:
  - It costs nothing when nobody is looking. The server closes a subscription a
    couple of minutes after the last viewer leaves, and caps subscriptions per user.
  - Latency is a little higher: one extra hop through our event stream, tens of
    milliseconds, invisible for a tester.

  Publishing stays behind the approval step.
- **Base64, JWT, Diff** compute purely in the browser today. They become tier 1 live
  panes (§4.5): CEL expressions over the inputs and a bound diff component. They stay
  instant as you type, and gain agent and workflow use. A pasted JWT is a secret, so
  its input is marked `sensitive`: kept out of session state and the agent's history.
- **HTTP client:** its request is already a server Action (SSRF-guarded). Sending
  stays behind the approval step.

_Inventory of today's panes (inputs, dynamic lists, outputs, output actions): see
§4.7._

### 4.5 Live panes: three tiers, cheapest first

The goal is **live tools**: panes whose output updates as you type, like JWT,
Base64 and Diff today. Sandboxed browser code (tier 3) can do it, but it is the
hardest tier to build in, the slowest to start, and the hardest to make look native.
Most live tools need nothing that heavy, so there are three tiers, and the builder
offers them in this order:

**Tier 1: live expressions and bound components.** No code, instant, native.

- An output can be a **CEL expression over the inputs** (the same language as
  workflows, D8), e.g. `base64.decode(in.text)` or `jwt.decode(in.token).payload`.
- The browser evaluates it on every keystroke, in our own page. CEL is safe to run
  there without a sandbox: no loops, no side effects, no access to anything but the
  inputs it is given.
- The server evaluates the **same** expression for the agent and for workflows, so
  there is no twin to write.
- A **function library** sits on top of CEL: base64, URL, hex, hashes, HMAC, JWT
  decode/sign/verify, JSON parse/format, timestamps, regex. We implement and own it
  twice, in TypeScript and in Python, and one shared test corpus runs through both so
  the results always match.
  - Browser engine: `@marcbachmann/cel-js` (zero dependencies, TypeScript).
  - Server engine: `cel-expr-python`.
- Some live tools are just a **component bound straight to inputs**. Diff is the diff
  component with its left and right bound to two inputs; nothing runs at all.
- **It looks and runs exactly like a built-in pane, because it is one:** same
  renderer, same components, same styles, instant.

**Tier 2: live server Actions.** Python, works everywhere.

- `run: live` re-runs the Python Action when inputs change, debounced (around 150
  ms after typing stops).
- For anything that needs a library, data, or a connection: "look up this order id as
  I type", "validate this config against the schema in our repo".
- Costs one round trip per pause in typing, roughly a quarter of a second. Fine for
  lookups; noticeably less snappy than tier 1 for pure text transforms.
- Same renderer, same look.

**Tier 3: sandboxed browser code.** For plugin developers.

- Code shipped by a plugin or the builder runs in a **sandboxed iframe on a separate
  origin**, the way VS Code runs extension webviews and Figma runs plugins:
  - `sandbox="allow-scripts"` without `allow-same-origin`, so it has no access to our
    cookies, our storage, our DOM or our API;
  - no top-level navigation, popups or forms;
  - a strict Content Security Policy, with `connect-src` limited to the hosts the
    plugin declared and nothing by default.
- It talks to the host only through a small `postMessage` SDK:
  - read inputs;
  - return outputs;
  - ask for an effect (§4.3), which the host may perform or confirm;
  - call a **server** Action through the host, with the usual permission checks.
- **Secrets never reach it.** A call needing a credential goes through a server
  Action.
- **The language can be Python:** with **Pyodide** (CPython compiled to WebAssembly)
  in a Web Worker inside the sandbox, the same Python handler runs on the server for
  the agent and workflows and in the browser for live use. No twin. The cost is a
  first-load download of several MB and a few seconds to start (cached afterwards),
  and pure-Python packages only. JavaScript is the other option for plugin
  developers who want it; then a Python twin is needed for agent and workflow use,
  or the pane is marked browser-only and `get_context` says so.
- Also the home of **custom visual components** (a plugin's own chart or 3D view):
  the host hands them a data frame and they draw it.
- **How it looks:** the host passes our theme tokens (colours, fonts, spacing) into
  the frame and the SDK ships matching base styles. A careful plugin looks native; a
  careless one won't. That's acceptable for an escape hatch, not for the default path.
- **How secure:** it can't act as the user, can't read anything but what it is given,
  and can't reach the network beyond what an admin approved at install. The
  remaining risks:
  - It sees the data it is handed, so installing a plugin means trusting its author
    with that data (which is why installs are admin-approved).
  - Browser leaks such as DNS prefetching have been used to smuggle data out past
    strict CSPs (the Trail of Bits VS Code write-up).
  - It can draw a convincing fake form inside its own frame. The frame is always
    visibly framed and labelled with the plugin's name.

**Answers, in short:**

| | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| Live as you type | instant | ~¼ s per pause | instant after the first load |
| Secure | yes, by construction | yes, as any server Action | sandboxed; trusts the plugin author with its data |
| Easy in the builder | yes: pick functions, write a one-line expression | yes: like any Python Action | no: real code, for developers |
| Looks native | identical | identical | close, if the author uses the SDK's styles |
| Agent and workflows | same expression on the server | it is a server Action | Pyodide: same code; JS: needs a twin |

**Today's live tools move to tier 1:**
- **Base64:** expressions with `base64` functions.
- **JWT:** `jwt.decode`, `jwt.sign` and `jwt.verify` functions. The token and secret
  inputs stay `sensitive` and the expression runs in the browser, so a pasted secret
  never leaves it, as today.
- **Diff:** the diff component bound to its two inputs.

All three stay instant and look the same, and gain agent and workflow use.

### 4.6 Sessions as live dashboards

Four requirements (R1–R4, 2026-10-04) that together make a session work like a
Grafana dashboard, built on what sessions already are.

**R1: every pane follows the agent and other writers live.** Today, whatever the
agent writes to a session appears in open browsers at once. That has to hold for
every pane type, built-in, builder or plugin. It falls out of the design rather than
needing per-pane work:
- every pane's state is in the one shape (D9);
- every write goes through `live_store` (CLAUDE.md), announced over the event stream;
- the renderer, being the same for every pane, subscribes once.

Exceptions by design: `sensitive` inputs, and a tier 1/3 live output (§4.5), which
each browser recomputes from the synced inputs rather than syncing the result.

**R2: view mode (inputs hidden, outputs only).**
- **Two levels:**
  - A **session setting** `inputs: shown | hidden` turns the whole session into a
    dashboard: each pane shows only its title, its outputs, when it last refreshed,
    and a refresh button.
  - A **per-pane override** shows or hides one pane's inputs regardless of the
    session setting.
- **Editing stays one click away.** A pane's "edit" button reveals its inputs; a
  session's "edit layout" reveals all of them. A viewer member (shared sessions) only
  ever sees view mode.
- **Session variables**, recommended, and the piece that makes view mode useful.
  - Grafana dashboards put a few shared controls at the top (environment, time range)
    that drive every panel.
  - Here, a session can declare **variables** (any input type, D9's `in.` shape, at
    the session level), shown in a bar under the session card even in view mode.
  - A pane input can be bound to one (`{{ session.env }}`, the CEL of D8) instead of
    holding its own value.
  - Change the time range once and every pane re-runs. The agent sets variables the
    same way it sets inputs.

**R3: a session as the home page.**
- A per-user setting, Home → "this session" (from its ⋮ menu: "Set as my home page").
- It can be any session the user can reach, shared ones included.
- If that session is deleted, or the user leaves it, Home falls back to the default
  page, with a note saying why.
- Later, an admin could set a group default.

**R4: auto-refresh.**
- **Per pane:** `refresh: off | on open | every 30 s / 1 m / 5 m / …`. A session-level
  default applies to panes that don't set their own, as Grafana's refresh picker
  does.
- **It runs while the session is open in a browser, and only then.**
  - It pauses while the session isn't on screen or the browser tab is hidden (the
    Page Visibility API).
  - On return, it refreshes at once if it is overdue.
  - Relative time ranges ("last 15 minutes") are re-evaluated on every run.
  - Refreshing with nobody looking is a scheduled workflow (a later trigger), not
    this.
- **One run per interval, however many people are watching.**
  - A shared session open in five browsers must not run five queries.
  - The server coalesces: a refresh request for a (session, pane) whose last run
    started less than one interval ago gets that run's result instead of a new one.
  - The result reaches every viewer through R1.
- **Guard rails:**
  - An admin-set **minimum interval**, globally, with a stricter one per pane type
    if wanted.
  - A warning on panes whose runs cost money. CloudWatch Logs Insights charges per GB
    scanned ($0.005/GB at list price), and `limit` doesn't reduce what is scanned.
    A pane type's manifest can declare `cost: per_run` to get the warning and a
    higher floor.
  - A pane whose refresh keeps failing backs off and shows why, rather than hammering
    a broken query.
- **Outputs out of the synced state** (recommended, and needed before R4 is safe).
  - Today a run's results live in the session's synced state. Every refresh would
    rewrite that state, bump its version, and make every open tab fetch the whole
    session again, up to the 4 MiB cap.
  - With D9's `.out.` keys separated anyway, outputs move to their own store, one
    record per (session, pane), small ones in Postgres and large ones as blobs (D7).
  - The session state keeps only a pointer and a version. The event says "pane X has
    results v17", and each tab fetches just that pane's output.
  - The same change removes the browser's 4 MiB problem and the agent's
    `_write_results` trimming (CLAUDE.md), and lets large results exist at all.

### 4.7 Inventory of today's panes: the requirements list

What every existing pane does, gathered 2026-10-04. Porting (§4.4) is done when the
generic renderer and components can do all of it.

| Pane | Inputs (dynamic ones *in italics*) | Run | Output | Output actions |
|---|---|---|---|---|
| CloudWatch | environments; *log groups per environment* (`/api/log-groups`); time preset or custom range; limit; sort field (from the result's fields) and direction; query; saved query | async: start, poll every 2 s, **Stop** | log list: tags and summary per row, expand to all fields (client-side), sort, group by environment or log group, per-target errors | select / hide; export CSV, XLSX, JSON (selected or all); attach to agent; run again |
| OpenSearch | environments; *domains → indices* (two levels, with doc counts); time; limit; sort; timestamp field; Lucene query; saved query | sync search | same log list | same as CloudWatch |
| IoT | environments; mode (things or certificates); max results; query with examples; saved search | sync search | list with tags; row expansion **fetches detail** (thing: attributes, shadows, certificates and their policies, jobs; certificate: ARN, things, policies) | select / hide / export; **"include detail"** bulk-fetches detail for checked rows (5 at a time) into the export and the agent attachment |
| DynamoDB | environment (single); *table* (`/tables/list`), then a describe on choosing it (status, keys, item count); `field:value` filter; page size; saved table | scan, then **Load more** (cursor) | list keyed by the table's keys; expand to the item's JSON; loaded/scanned counts | select / hide / export; attach |
| S3 | environment; *bucket*; prefix by **navigation** (folders, breadcrumbs); recursive name search; saved bucket | browse on every navigation, then Load more | folders (clickable), then files (size, name, modified) | **copy S3 URI**, **copy object URL** (both client-side); select / hide / export (files); attach |
| Cognito | environment; *user pool*; `attribute:value` query | search, then Load more | list with status tags; expand to dates and attributes | select / hide / export; attach |
| HTTP client | method; URL; headers (key/value rows); body; saved request | send (backend, SSRF-guarded); the agent can fill it but not send | status, time, truncated flag; headers table; body as JSON or text | last exchange auto-attached to the agent; no copy or export |
| MQTT | environment; subscribe filter; publish topic and payload; saved topics. All browser-only, none persisted | connect (backend presigns a URL, the browser connects to IoT Core), subscribe, unsubscribe, publish: all in the browser | connection status and diagnostics; incoming message **stream** (newest first, capped at 200) | none |
| JWT | mode; token and verify secret, or algorithm, secret, header, payload. Not persisted, on purpose | **live** decode and verify in the browser; Generate | header and payload JSON; verify badge; token | copy the generated token |
| Base64 | mode; URL-safe; input | **live**, in the browser | output text | copy |
| Diff | original; changed; view mode | **live**, in the browser | unified, split or compact diff with foldable unchanged runs | none |

**What the generic set therefore needs**, beyond §4.3's list:

- **Async Actions with progress and cancel:** CloudWatch's start, poll and Stop. The
  Action reports progress and partial results while running, and has a cancel
  handle.
- **Cursor pagination ("Load more")** as a standard Action shape: the output carries
  a cursor, and the component offers Load more (DynamoDB, S3, Cognito).
- **Navigation as input:** S3's folders and breadcrumbs are `set_input` effects on
  `prefix` that re-run the pane.
- **Dependent pickers**, several levels deep: environments → domains → indices, with
  per-level "load" and filter.
- **Derived options:** CloudWatch's sort field takes its choices from the *output's*
  fields, not from an Action.
- **Bulk detail:** IoT's "include detail" is a selection action whose server half
  runs the detail Action for each checked row and merges the results into the export
  or agent attachment.
- **Saved items** are a per-pane-type feature today (saved queries, saved searches,
  saved tables and so on, in five different stores). Generically, "save these
  inputs under a name" belongs to the renderer, for every pane, in one store.
- **Live outputs:** JWT, Base64 and Diff recompute on every keystroke. They become
  tier 1 live expressions and a bound component (§4.5).
- **Sensitive inputs:** JWT's token and secret, and MQTT's state, are deliberately
  not persisted. Generically, an input marked `sensitive` stays out of session state,
  the agent's history and run records.
- **Auto-attach:** HTTP registers its last exchange with the agent without a
  checkbox. Generically, an output can be marked "always attached".

**Found along the way** (bugs or mismatches in today's code, not part of this plan):

- OpenSearch: the UI allows a limit up to 10000, but the backend schema caps it at
  1000.
- Cognito's help text promises group memberships, but nothing fetches them.
- Copy exists only in S3, JWT and Base64, with no shared component. The tools have no
  export, and Diff, MQTT, JWT and Base64 can't attach anything to the agent. Porting
  fixes all of this for free.

## 5. Workflows

The Jenkins "build with parameters" model, built from the same parts as panes:

- **Definition:** a name, a description, **parameters** (the same input types as
  panes, including dynamic ones and environment/connection/credential pickers), and
  an ordered **list of steps** (decision D4). Each step is an Action, with its inputs
  bound to parameters, constants, or the outputs of earlier steps. Steps can depend
  on each other, run conditionally, and loop; see §5.1.
- **Run:** a recorded execution. It stores the parameters used, each step's status,
  logs, outputs and timing, who started it, and artifacts. Runs are kept and can be
  **re-run** (with the same or edited parameters) or **cloned** into a session (open
  the outputs as panes).
- **Steps** come from three places: built-in Actions, Actions from installed plugins,
  and custom steps made in the builder (§7.3).
- **Triggers:** manual first, then schedule (cron), webhook, and "the agent ran it".
- **Approvals:** a step can require approval before it runs. This is the same
  approval step the agent already needs for side effects (sending HTTP, publishing
  MQTT; see CLAUDE.md), built once and used by both.
- **Agent:** the agent can list, start, follow and read workflow runs. A workflow is a
  tool whose inputs are its parameters.
- **UI:**
  - A **Workflows** page under Home in the rail (the placeholder already exists in
    `pages/pageTypes.tsx`), plus a subheader icon next to expand/minimise.
  - A list of workflows; each workflow's page holds its parameter form ("Build with
    parameters"), run history and run detail (steps, logs, outputs).
  - An editor for definitions: form-based first, visual graph later.

### 5.1 Steps: dependencies, conditions, loops

A list of steps, in the style of GitHub Actions or Ansible: easy to read and to
author, and each feature below covers a common need without becoming a graph editor.

```yaml
parameters:
  - { key: env, type: environment }
  - { key: prefix, type: string, default: "logs/" }
steps:
  - id: list
    action: aws.s3.list_objects
    with: { connection: "{{ params.env | connection('aws') }}", prefix: "{{ params.prefix }}" }

  - id: big
    if: "{{ steps.list.outputs.objects | length > 0 }}"            # condition
    for_each: "{{ steps.list.outputs.objects | selectattr('size', 'gt', 1000000) }}"  # loop
    action: aws.s3.head_object
    with: { key: "{{ item.key }}" }                                # one run per item
    continue_on_error: true

  - id: report
    action: core.markdown
    with: { text: "{{ steps.big.outputs | length }} objects over 1 MB" }
```

- **Dependencies:**
  - A step runs after the steps it references (`steps.list…`), and the list order
    covers everything else.
  - The platform builds the dependency order from the references and rejects a
    reference to a later step or a missing one when the workflow is saved.
  - Later, steps with no dependency on each other can run in parallel (GitHub's
    `needs`) without changing the format.
- **Conditions:** `if:` on any step, against parameters and earlier outputs. A skipped
  step's outputs are empty, and a later step can test `steps.x.skipped`.
- **Loops:** `for_each:` runs the step once per item (`item`, `index`). Its outputs
  are the list of each run's outputs. Max-parallel and stop-on-first-failure are
  settings.
- **Errors:**
  - A failure stops the run unless the step has `continue_on_error`.
  - `retry: { times, delay }` and `timeout` apply per step.
  - Later: an `on_failure` step, for clean-up or a notification.
- **Groups:**
  - A `steps:` block can nest under one `if` or `for_each`, so a loop can run several
    steps per item.
  - This is the one place the list becomes a tree. It is still drawn as an indented
    list, not a graph.
- **Expressions:** one language for conditions, data selection and templates.
  Recommendation: **CEL (Common Expression Language) inside `{{ … }}`**, the way
  GitHub Actions puts its own small expression language inside `${{ … }}`.
  - **Why CEL rather than Jinja2:** workflow expressions are written by many people
    (anyone with the builder) and evaluated on our servers. That calls for a
    language that is safe *by design*, not one made safe by a sandbox.
    - CEL has no loops, no attribute access to Python objects, no side effects, and
      cost limits, so every evaluation terminates.
    - It is what Kubernetes (validation rules), Google Cloud IAM conditions and Envoy
      use for the same job.
    - Jinja2's sandbox, by contrast, had two escapes to arbitrary code execution in
      four months: CVE-2024-56326, fixed in 3.1.5, and CVE-2025-27516, fixed in
      3.1.6.
  - **What it looks like:**
    - `{{ size(steps.list.outputs.objects) > 0 }}`
    - `{{ steps.list.outputs.objects.filter(o, o.size > 1000000) }}`
    - `"{{ params.prefix }}logs"` (string interpolation)

    That is as readable as Jinja2 for this job. Only Jinja2's filter syntax
    (`| length`) is missing, and CEL's macros (`filter`, `map`, `exists`, `all`)
    cover it.
  - **Our functions on top:** `connection(env, 'aws')`, `json()`, `now()`, string
    helpers. Each is a plain, side-effect-free function we register.
  - **Library:** Google's official **`cel-expr-python`** (announced March 2026; it
    wraps the C++ implementation, so semantics match Kubernetes'). Fallbacks if its
    wheels don't fit our image: `common-expression-language` (wraps the Rust
    implementation) or the pure-Python `cel-python`.
  - **Rules either way:**
    - Expressions see only parameters and outputs, never secrets.
    - Credentials are passed by reference (`credential` inputs), never interpolated
      into a string.
    - Expressions are checked for syntax and references when the workflow is saved.
- **Outputs and artifacts:** each step's outputs are stored with the run, capped in
  size, with large ones kept as files. The run detail shows them with the same output
  components panes use (§4.3).

## 6. Secrets and credentials: research and recommendation

### 6.1 How others do it

| Platform | Typed credentials? | Defined by | Storage | Scope / sharing | Notable |
|---|---|---|---|---|---|
| **Jenkins** | Yes: secret text, username+password, secret file, SSH private key, certificate; plugins add more (AWS…) | Java classes in plugins | Encrypted on the controller | **System** (Jenkins itself only), **Global** (all jobs), **Folder** stores; **domains** restrict by host/scheme | `withCredentials` binds a credential to env vars or a temp file for one block of a pipeline |
| **n8n** | Yes, per integration: `ICredentialType` with `properties` (fields), `authenticate` (how to inject into a request) and `test` (a request that validates it) | TypeScript in node packages | Encrypted with an instance encryption key | Owned by a user or project; shared with projects (enterprise) | Each node declares which credential types it accepts; the credential knows how to authenticate a request |
| **Windmill** | Yes: **resource types** defined by **JSON Schema**; a Hub of 200+ | JSON Schema; anyone can add one | Resources are JSON. Secrets live in **variables** (encrypted), referenced from resources as `$var:path` | Path-based folders/groups | A script's parameter can be typed as a resource type, and the UI offers matching resources |
| **Grafana** | Per data-source plugin | Plugin code | `jsonData` (plain) vs `secureJsonData` (encrypted, **write-only**: never returned to the browser; `secureJsonFields` says only *whether* a field is set) | Per org | The cleanest UI contract for secrets: write-only fields |
| **Airflow** | Connections with a `conn_type` and a JSON `extra` | Provider packages | The metadata DB, encrypted; or **pluggable secrets backends** (Vault, AWS Secrets Manager, GCP…) chained in lookup order | Global | Lets an organisation keep secrets in its own vault |

### 6.2 Recommendation

Take the best idea from each:

1. **Typed credentials, with types defined by schema, not code** (Windmill's JSON
   Schema + n8n's per-type `test`). A credential type is a manifest:
   - fields, each marked secret or not;
   - an optional `test` Action that checks it works;
   - optionally, how it injects itself into a request (n8n's `authenticate`), for
     declarative HTTP steps.

   This answers "text, file, JSON, or typed?": both. Built-in **generic types** cover
   the simple cases:
   - **Secret text**
   - **Secret file**
   - **Secret JSON**
   - **Username + password**
   - **Bearer/API token**
   - **SSH key** (+ passphrase)
   - **Certificate** (+ key)

   **Provider types** come from plugins (AWS: access keys or role-assumption; GCP
   service account; GitHub app…).

   Typing matters because it lets an input ask for "an SSH key" or "AWS credentials"
   and offer only matching ones, lets the platform test a credential on save, and
   lets the agent know what a credential is for without seeing it.
2. **Write-only secret fields** (Grafana). A secret field is sent once and stored
   encrypted. It is never returned by any API, to the browser or the agent; the UI
   only shows "set" and offers "replace". This extends the existing rule "never log or
   return AWS credentials" (CLAUDE.md) to every secret.
3. **Envelope encryption at rest.**
   - Each value is encrypted with a data key, and the data key with a master key held
     outside the database: a Kubernetes Secret first, or a KMS key later.
   - Rotating the master key re-wraps the data keys, not every value.
   - Python's `cryptography` (AES-GCM) does the work. No secret appears in logs, in
     session state or in an agent's context.
4. **Use by reference, resolved at the last moment, server-side.**
   - Session state, workflow definitions, run records and agent tool calls hold a
     credential's **id**, never its value.
   - The value is decrypted only inside the handler that needs it, for that run.
     Jenkins' `withCredentials` does this per block of a pipeline.
   - Run logs mask any secret value that appears in them, as Jenkins does.
5. **Scopes mapped onto groups:** global, group, and later personal (§3.2). Plus
   Jenkins' "system" idea: a credential marked for platform use only (plugin-registry
   tokens, the agent's LLM key) that no pane or workflow can ask for.
6. **Pluggable backends, later** (Airflow). The built-in encrypted store comes first;
   a credential could instead point at AWS Secrets Manager, Vault and so on, so an
   organisation keeps secrets where it already keeps them.
7. **Audit:** who created, changed, used (which run or pane, when) and tested each
   credential.

## 7. Plugins and the marketplace

### 7.1 What a plugin is

A git repository (or a subdirectory of one) with a `plugin.yaml` at its root:

```yaml
id: acme.k8s
name: Kubernetes
version: 1.2.0
platform: ">=2.0"              # compatible platform versions
contributes:
  connection_types: [k8s-cluster]
  credential_types: [kubeconfig]
  actions: [list-pods, pod-logs, rollout-restart]
  pane_types: [pod-browser]
  workflow_steps: [rollout-restart]
  renderers: []                 # sandboxed iframe components only
permissions:                    # shown to the admin on install, enforced at runtime
  network: ["*.k8s.acme.internal:443"]
  credential_types: [kubeconfig]
handlers:
  runtime: python               # or: declarative (no code), container
```

### 7.2 Where plugins come from

- **Direct install:** an admin installs from a git URL at a tag. Private repos use a
  credential (§6, a token or SSH key with scope "system"), so the platform's own
  secrets system serves itself.
- **Marketplace page:** reads one or more **registry repos**. The default one is
  `avivkilloz/cloud-insights-public-registry` (D13). Each registry is a repo
  of small manifests (name, description, repo URL, versions, tags, commit SHAs).
  - External developers add a plugin by opening a PR against the registry, the model
    Homebrew taps and the Terraform registry follow. Review happens there.
  - Organisations can add their own private registry alongside the public one.
- **Pinning:** an install records the exact commit SHA, and a checksum of what was
  fetched. Upgrades are explicit, show a diff of the plugin's permissions, and can be
  rolled back.

### 7.3 Internal: the builder

A global **Builder** page, with the same output as a plugin (manifests), stored in
the database instead of a repo:

- **Pane builder:** pick or define inputs (any type in §4.2, including dynamic ones),
  arrange them in cards, choose Actions, choose output renderers, and preview live.
- **Step builder:** a custom Action. Options, safest first:
  1. **Declarative HTTP**
     - Method, URL, headers and body templated from inputs.
     - A credential type that knows how to authenticate the request.
     - A response mapping, e.g. JSONPath into a table.

     This covers most in-house APIs with no code at all (n8n's declarative nodes do
     the same).
  2. **Composition:** a chain of existing Actions, i.e. a small workflow used as one
     step.
  3. **Code** (Python, later others), run only in the sandboxed runner (§8).
- **Export:** anything built here can be exported as a plugin repo, and an installed
  plugin can be copied into the builder to customise.

### 7.4 Trust levels

| Level | Who writes it | Runs where | Can do |
|---|---|---|---|
| Built-in | us | the backend process | anything the backend can |
| Declarative | builder / plugin | the backend, through a fixed HTTP executor (SSRF-guarded, as `tools_http_client.py` already is) | only the HTTP calls its manifest declares |
| Code | builder / plugin | an **isolated runner**: a separate container, no database access, no ambient cloud credentials, egress limited to the declared hosts | only what its resolved inputs and short-lived credentials allow |
| Browser Action / UI component | plugin / builder | a **sandboxed iframe** on a separate origin (`sandbox="allow-scripts"`, no same-origin, strict CSP), postMessage SDK (§4.5) | compute and draw what it is handed; ask the host for effects and server Actions; never the session cookie or a secret |

## 8. Execution and security

- **The runner:** a separate service (one or more pods) that takes a job (an Action
  id, resolved inputs, the credential values it was granted for this job) and returns
  outputs, logs and artifacts. Today's in-process handlers count as one kind of
  runner, so built-ins need no change.
- **The same access rules everywhere:** a pane run, a workflow step and an agent tool
  all go through one check before any handler runs:
  - the group's flag for the pane type (generalising today's `*_enabled` columns,
    see below);
  - the environment's access;
  - the credential's scope.

  This is the boundary CLAUDE.md's access-control section describes, made one function
  instead of one per router.
- **Per-type permissions:** today's fixed booleans (`logs_enabled`, `iot_enabled`…)
  can't scale to plugins. They become rows (group × pane type or plugin), with the
  existing columns migrated in.
- **The agent:**
  - It sees schemas, credential *names* and *types*, never values.
  - Side-effecting Actions are marked as such in their manifest and go through the
    approval step.
  - Its tools are generated from the registry, so a new plugin is drivable by the
    agent the moment it is installed.

### 8.1 Python dependencies for plugins and builder steps

Handlers are Python only (decision D2). **Yes, a pane's or workflow step's author can
choose their own dependencies**, with these rules:

- **Declared, pinned, locked.**
  - A plugin ships a `requirements.txt` (or a `pyproject.toml`), and the platform
    turns it into a **lockfile** with exact versions and hashes at install time.
  - A builder step has a "Dependencies" box that does the same when the step is
    saved.
  - The lock is what runs, so the same version of a step always runs with the same
    packages. Windmill does the same per script.
- **One isolated environment per (plugin version, lockfile).**
  - Each plugin version gets its own virtualenv. Two plugins can need conflicting
    versions of a library, and neither can break the platform's own (FastAPI,
    SQLAlchemy, boto3…).
  - The runner builds the venv with **uv** (seconds, not minutes) and caches it by
    lockfile hash, so identical locks share one venv.
  - A handler runs as a subprocess of that venv's interpreter. This is also what
    keeps plugin code out of the backend's process (§7.4, §8).
- **Installed only at install time, never at run time.**
  - Resolving and downloading happen when an admin installs or upgrades a plugin, or
    saves a builder step. The admin approves the dependency list alongside the
    plugin's permissions.
  - A run never reaches PyPI. That keeps runs fast and repeatable, and keeps the
    runner's network egress to the hosts the plugin declared.
- **Safer installs.**
  - Wheels only by default: a source distribution runs arbitrary build code at
    install time.
  - Hash-checked downloads (`--require-hashes`).
  - Optionally a private index or mirror, for air-gapped or vetted installs.
- **The platform provides a small SDK** (`platform_sdk`, our own package) in every
  venv:
  - typed access to inputs;
  - resolved connections and credentials, decrypted only inside the run;
  - log and progress calls, and helpers to return output components.

  It is versioned, and a plugin declares which SDK range it supports.
- **Python version:** one, the platform's (3.12 today). A plugin declares the range it
  supports, and an install that doesn't fit is refused with a reason.
- **Later:** per-plugin container images, for plugins that need system libraries.
  Heavier, but the same isolation idea. Not needed to start.

Built-in Actions keep running in the backend process with its own dependencies. Only
plugin and builder code goes through the runner's venvs.

### 8.2 File storage

Exports, workflow artifacts, large step outputs, plugin bundles and uploaded secret
files all need somewhere to live. Postgres is the wrong place for anything large.

**Decided (D7): a blob store with two backends, chosen in the Helm chart.**

```yaml
storage:
  type: s3            # s3 | filesystem
  s3:
    bucket: my-platform-files
    region: eu-west-1
    endpoint: ""      # empty for AWS; set for any S3-compatible server
    # credentials: IRSA / pod identity on EKS, or a Kubernetes Secret
  filesystem:
    path: /data/files
    persistence:
      storageClass: ""          # any class; must support ReadWriteMany for >1 replica
      accessMode: ReadWriteMany
      size: 50Gi
```

- **`s3` is the recommended default for real deployments.** Any S3-compatible store
  works (AWS S3, GCS through its S3 API, Ceph, MinIO and so on).
  - Every backend replica and every runner can reach it at once.
  - Downloads can be presigned URLs that don't pass through the backend.
  - Lifecycle rules can enforce retention.
  - Encryption at rest is handled by the store (SSE-S3/KMS).
- **`filesystem` is for single-node, development or air-gapped installs.** The
  volume can be any storage class, with one trap. The chart runs **2 backend replicas
  by default** (`values.yaml`), and an EBS volume is ReadWriteOnce: it attaches to
  one node, so replicas on two nodes can't both mount it. The filesystem backend
  therefore needs either:
  - a ReadWriteMany class (EFS on AWS, Filestore on GCP, NFS, CephFS); or
  - one backend replica.

  The chart should refuse the combination of RWO with more than one replica rather
  than fail at runtime.
- **Postgres keeps only metadata:** key, size, sha256, content type, owner and group,
  what it belongs to (run, export, plugin), created time and expiry. Every download
  checks permissions against that row first, so the store itself is never browsed
  directly.
- **Retention:** per kind (exports expire in days, run artifacts follow the
  workflow's retention, plugin bundles are kept while installed), enforced by a
  periodic clean-up and, on S3, lifecycle rules too.
- **The secrets store is separate**: secret files are encrypted values (§6.2), not
  blobs, unless they are large. A large one is stored encrypted in the blob store,
  with its key in the secrets store.

## 9. Roadmap (proposed order)

Each phase ships something usable on its own. Order chosen so each phase builds the
foundation the next one needs.

- [x] **Phase 0: this plan.** Discussed and agreed 2026-10-04 (D1–D22, R1–R4).
- [ ] **Phase 1: Credentials and config.** Credential types (the generic built-ins),
  encrypted store, write-only API, scopes (global and group), a Settings → Credentials
  UI, a test-on-save hook, and an audit log. *Why first:* connections, plugins from
  private repos, declarative steps and workflows all reference credentials.
- [ ] **Phase 2: Connections and generalised environments.** Connection types (`aws`
  first, built-in), connections referencing credentials, environments as groups of
  connections, and migration of today's environments with ids kept. The AWS routers
  resolve their client from a connection instead of `Environment` + `role_name`.
  *Exit:* everything works exactly as today, through the new model.
- [ ] **Phase 3: Actions, manifests and output components.** The largest phase,
  because every pane is ported (D5). In three steps, each shippable:
  - **3a, manifests for the agent:**
    - The manifest format, and a manifest for every existing pane.
    - `KINDS` and the agent's tools generated from the manifests.
    - The one state shape (D9), and outputs in their own store (§4.6).
    - No visible change.
  - **3b, the generic renderer and components:**
    - Input cards and dynamic options.
    - The output components and output actions (§4.3), extracted from today's panes,
      plus the visualizations (data frames, the chart spec, ECharts, KPI tiles).
    - Panes ported in the order of §4.4, each passing its own browser suite
      unchanged. MQTT moves its connection server-side.
  - **3c, sessions as live dashboards:** view mode, session variables,
    auto-refresh with coalescing, and Home → session (R2–R4, §4.6). R1 holds
    throughout, and each step's browser suites check it.
  - **3d, permissions and a first new pane:**
    - Per-type permissions replace the boolean flags.
    - One new non-AWS pane built only from a manifest (e.g. a generic HTTP/JSON API
      pane), to prove the model on something that isn't a port.
- [ ] **Phase 4: Workflows.**
  - The blob store (§8.2), which runs and artifacts need first.
  - Definitions with parameters and steps, and recorded runs, run on the in-process
    runner.
  - The Workflows page (list, Build with parameters, run history, run detail) and the
    subheader icon.
  - The agent can start and read runs.
  - The approval step, shared with the agent.
- [ ] **Phase 5: The builder.** Declarative HTTP steps, composed steps, and the pane
  builder with live preview.
- [ ] **Phase 6: The isolated runner and code steps.** A separate runner service,
  egress limits, and short-lived credentials per job. One venv per plugin version,
  built with uv from a locked `requirements.txt` at install time (§8.1). The
  `platform_sdk` package. The browser runtime for plugin and builder code: the
  sandboxed plugin origin and its postMessage SDK (§4.5).
- [ ] **Phase 7: Plugins and the marketplace.** `plugin.yaml`, install from git (tag,
  SHA and checksum pinned; private repos through credentials), a registry repo
  format, the Marketplace page, upgrade and rollback, permission review on install.
- [ ] **Later:** pluggable secret backends (Vault, AWS Secrets Manager), personal
  credentials, workflow triggers (cron, webhook), graph workflows, dashboards (saved
  views), more providers as first-party plugins (Kubernetes, GCP, GitHub…).

## 10. Open questions (to discuss)

None open as of 2026-10-04: every question raised so far is settled in §11. New ones
go here as they come up, typically while a phase is detailed before it is built.

## 11. Decision log

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-10-04 | **An environment is a named group of connections** (§3.1). It stays the unit of group access; today's environments become one AWS connection each, keeping their ids. | "Do this in Prod" keeps meaning one thing for any provider. |
| D2 | 2026-10-04 | **Server-side handlers are Python only.** Each plugin or builder step can bring its own dependencies, locked and installed into an isolated venv per plugin version (§8.1). | Matches the backend and keeps one runtime to secure. Per-plugin venvs keep dependency conflicts away from the platform and from other plugins. |
| D3 | 2026-10-04 | **Output components are rich and configurable in the builder**, including output actions (copy, export, open link, attach to the agent, drill-down…). Each is an optional server Action plus a client effect from a fixed vocabulary (§4.3). | Today's panes already do this by hand; built panes must be able to do the same. A fixed effect set keeps browser-side code ours. |
| D4 | 2026-10-04 | **Workflows are a list of steps** with dependencies (by reference), conditions (`if`), loops (`for_each`) and nested groups (§5.1). Not a graph to start. | Easy to author and read; covers dependencies, conditions and loops. Parallelism can come later without a format change. |
| D5 | 2026-10-04 | **All panes behave the same:** every pane, built-in included, is a manifest drawn by one renderer with one component set. Today's panes are ported (§4.4). | Gives the builder and plugins everything today's panes can do, and lets the agent drive every pane the same way. |
| D6 | 2026-10-04 | **MQTT's live connection moves to the server** (a subscription Action and a stream output); publishing stays behind the approval step (§4.4). | Makes MQTT usable by the agent and workflows, like every other pane. Costs one server-side subscription per open MQTT pane. |
| D7 | 2026-10-04 | **File storage is a blob store with an S3-compatible or a filesystem backend, chosen in Helm**; Postgres keeps only metadata (§8.2). | Postgres is wrong for large files. S3 suits multi-replica deployments; filesystem suits single-node or air-gapped installs, given a ReadWriteMany volume or a single replica. |
| D8 | 2026-10-04 | **Workflow expressions are CEL inside `{{ … }}`** (§5.1), via `cel-expr-python`. | Safe by design (no loops, no object access, bounded cost) for expressions many people write and our servers evaluate; Jinja2's sandbox had two code-execution escapes in four months. |
| D9 | 2026-10-04 | **One session-state shape for every pane** (`<pane>.in.*`, `.out.*`, `.view.*`), reached by a versioned, idempotent migration on load in the browser and on the server's read path (§4.4). | The renderer, the agent and templates treat every pane alike; no per-pane key maps to keep in sync. |
| D10 | 2026-10-04 | **Plugins and the builder can ship browser code** (JS/TS) for Actions and visual components, run in a sandboxed iframe on a separate origin behind a postMessage SDK, never seeing a secret; an optional Python twin makes it usable by the agent and workflows (§4.5). Built-in browser code is ours and runs unsandboxed. | Some panes only make sense in the browser (live typing, the user's own machine); the sandbox stops plugin code acting as the logged-in user. |
| D11 | 2026-10-04 | **Visualizations are our own declarative spec over data frames, drawn with Apache ECharts**, loaded on demand (§4.3). | One data shape for tables, charts and KPIs; a spec short enough for the builder and the agent; the library can change without touching plugins. |
| D12 | 2026-10-04 | **Runs execute in the backend process until the isolated runner exists** (Phase 6). | Simplest; fine for built-ins and declarative steps, which are all there is before Phase 6. |
| D13 | 2026-10-04 | **Registries:** a default public registry is configured out of the box; admins can remove it and add any number of public or private registries. The default registry is [`avivkilloz/cloud-insights-public-registry`](https://github.com/avivkilloz/cloud-insights-public-registry) (created 2026-10-04; its owner reviews PRs for now). Its format is defined in Phase 7. | Easy start for everyone, full control for organisations that want only their own. |
| D14 | 2026-10-04 | **The secrets master key starts as a Kubernetes Secret** (a Helm value), with KMS as a later backend. | No cloud dependency to start; envelope encryption makes a later move to KMS a re-wrap, not a re-encrypt. |
| D15 | 2026-10-04 | **Global credentials are usable by non-admin groups only by explicit grant.** | Nothing is shared by accident; matches "access control is per group". |
| R1–R4 | 2026-10-04 | **Requirements:** every pane follows the agent and other writers live (R1); a session or pane can hide its inputs and show only outputs (R2); a session can be a user's home page (R3); panes can auto-refresh while the session is open (R4). See §4.6. | Asked for, so that a session can work like a live Grafana dashboard. |
| D16 | 2026-10-04 | **Vocabulary:** Connection, Action, Credential, Builder, Effect (as proposed in the naming table that was §10). | Settled early because it appears in the UI and in every plugin manifest. |
| D17 | 2026-10-04 | **Effects a sandboxed plugin may request:** `toast` always; `copy` only in response to a click inside its frame; `open_link` and `download` always confirmed, showing the full address or file name; `attach_to_agent`, `open_pane` and `set_input` allowed. | Blocks phishing links, malicious downloads and clipboard tricks without getting in the way of normal use. |
| D18 | 2026-10-04 | **Run retention:** a global default, adjustable per workflow up to an admin maximum. Default: last 100 runs or 30 days, whichever keeps more; artifacts 14 days; pinned runs kept forever; a one-line audit record kept for a year. | Enough history to compare and re-run, without unbounded storage. |
| D19 | 2026-10-04 | **Live panes come in three tiers** (§4.5): live CEL expressions over inputs (and bound components), then live server Actions, then sandboxed browser code (Pyodide or JS). JWT, Base64 and Diff move to tier 1. | Instant, safe, native-looking and agent-usable for the common case; real code only where it's needed. |
| D20 | 2026-10-04 | **Sessions have variables**: session-level inputs that panes bind to, shown in view mode (§4.6). | What makes view mode a real dashboard: change the environment or time range once for every pane. |
| D21 | 2026-10-04 | **Outputs move out of the synced session state** into a per-pane store (small in Postgres, large as blobs), with the session keeping a pointer and version (§4.6). | Required for auto-refresh; also removes the 4 MiB browser cap and the agent's result trimming. |
| D22 | 2026-10-04 | **Auto-refresh floor:** 10 s by default, 1 minute for pane types that declare `cost: per_run`; admins can raise either. | Protects the APIs and the bill (CloudWatch Logs Insights charges per GB scanned). |

## 12. Research sources

- Jenkins credentials (types, scopes System/Global/Folder, domains, binding):
  [CloudBees: injecting secrets](https://docs.cloudbees.com/docs/cloudbees-ci/latest/secure/injecting-secrets),
  [Ansible jenkins_credential module](https://docs.ansible.com/ansible/12/collections/community/general/jenkins_credential_module.html)
- n8n credential files (`ICredentialType`: properties, authenticate, test; encryption
  key; project sharing):
  [n8n docs: credentials files](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files)
- Windmill resources and resource types (JSON Schema; secrets as variables referenced
  from resources):
  [Windmill: resources and resource types](https://www.windmill.dev/docs/core_concepts/resources_and_types)
- Grafana `jsonData` / `secureJsonData` / `secureJsonFields` (write-only secrets):
  [Grafana: add authentication for data source plugins](https://grafana.com/developers/plugin-tools/how-to-guides/data-source-plugins/add-authentication-for-data-source-plugins)
- Airflow connections and chained secrets backends:
  [Airflow: AWS Secrets Manager backend](https://airflow.apache.org/docs/apache-airflow-providers-amazon/9.22.0/secrets-backends/aws-secrets-manager.html)
- Windmill per-script Python dependencies (imports parsed, a lockfile per script,
  cached by workers):
  [Windmill: dependencies in Python](https://www.windmill.dev/docs/advanced/dependencies_in_python)
- Jinja2 sandbox escapes:
  [CVE-2024-56326](https://advisories.gitlab.com/pypi/jinja2/CVE-2024-56326/),
  [CVE-2025-27516](https://advisories.gitlab.com/pypi/jinja2/CVE-2025-27516/)
- CEL in Python:
  [Google: announcing cel-expr-python](https://opensource.googleblog.com/2026/03/announcing-cel-expr-python-the-common-expression-language-in-python-now-open-source.html),
  [cel-python](https://pypi.org/project/cel-python),
  [common-expression-language](https://pypi.org/project/common-expression-language)
- GitHub Actions expressions (`${{ }}`):
  [GitHub docs: expressions](https://docs.github.com/en/enterprise-server@3.17/actions/reference/workflows-and-actions/expressions)
- Grafana data frames and field options:
  [Grafana: work with data frames](https://grafana.com/developers/plugin-tools/create-a-plugin/develop-a-plugin/work-with-data-frames)
- VS Code webviews (sandboxed, message passing, CSP), and how a misconfigured one was
  escaped:
  [VS Code Webview API](https://vscode-api.js.org/interfaces/vscode.Webview.html),
  [Trail of Bits: escaping misconfigured VSCode extensions](https://blog.trailofbits.com/2023/02/21/vscode-extension-escape-vulnerability/)
- EBS is ReadWriteOnce; EFS for ReadWriteMany:
  [Baeldung: Kubernetes access modes](https://www.baeldung.com/ops/kubernetes-access-modes-persistent-volumes)
- Pyodide (CPython in WebAssembly; first-load size and start-up, Web Workers):
  [Pyodide: downloading and deploying](https://pyodide.readthedocs.io/en/stable/usage/downloading-and-deploying.html),
  [Pyodide roadmap](https://pyodide.org/en/314.0.5/_sources/project/roadmap.md)
- CEL in JavaScript:
  [@marcbachmann/cel-js](https://socket.dev/npm/package/@marcbachmann/cel-js/overview/8.0.0),
  [cel-js](https://www.npmjs.com/package/cel-js)
- Browsers reach MQTT only over WebSockets:
  [HiveMQ: MQTT over WebSockets](https://www.hivemq.com/blog/mqtt-essentials-special-mqtt-over-websockets/)
- Grafana dashboards (refresh picker, kiosk mode, variables):
  [Grafana: use dashboards](https://grafana.com/docs/grafana/latest/dashboards/use-dashboards/)
- CloudWatch Logs Insights pricing (per GB scanned):
  [AWS CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
- Backstage plugin architecture (frontend/backend plugins, extension points):
  [Backstage: architecture overview](https://backstage.io/docs/overview/architecture-overview),
  [Backstage: extension points](https://backstage.io/docs/backend-system/architecture/extension-points)
