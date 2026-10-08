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

_Started 2026-10-04. Status: **agreed 2026-10-04**: D1–D29 and requirements R1–R6 (§11), and D30
(2026-10-07). Phases 1 (§13) and 2 (§14, D31–D36) are built. Phase 3 is detailed in
§15 (D37–D42, drafted 2026-10-08 for review)._

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
| **Connection** | One configured instance of a connection type (e.g. AWS account 1234 in eu-west-1). *Who* it is used as comes from the caller's group (D31). | An `Environment` row |
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
  environment of the same name holding one `aws` connection. Ids are kept, so saved
  sessions and group access survive untouched. *Corrected 2026-10-07:* the group's
  `role_name` does **not** become the connection's role, since groups use different
  roles in the same account. It becomes the group's identity (D31, §14.3).
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

### 4.8 Categories: the catalogue is organised by people, not by code

Today every pane type is hard-wired as a "Service" or a "Tool"
(`sessions/paneTypes.tsx`, `SessionGroup`), and the Add-pane menu and Home are built
from that. Requirement R6: categories are the organiser's choice.

- **Categories are data:** a name, an icon and an order. Admins create, rename,
  reorder and delete them in **Settings → Catalogue**.
- **A pane type arrives with a suggested category:**
  - from its manifest (`category: "Observability"`);
  - from its plugin's author;
  - from whoever made it in the builder.

  A suggested category that doesn't exist yet is created, marked as coming from that
  plugin, so admins can merge or rename it.
- **Admins can move any pane type to any category**, by drag and drop in the
  catalogue. The placement is stored as an override, so **a plugin upgrade never
  undoes it**. The manifest's suggestion only applies until someone has placed the
  pane.
- **People get a personal layer:** **favourites** pinned at the top of the Add-pane
  menu, and hiding pane types they never use. Personal categories can come later if
  they're wanted.
- **One catalogue for everything you pick from a list:** pane types, workflow steps
  (Actions) in the builder and the workflow editor, and workflows themselves. Each
  shows its category and can be searched by name, category and tags.
- **Categories are only for finding things; access is a separate setting.** Today the
  "Tools" category doubles as a permission (`tools_enabled` lets a group use every
  tool). Moving a pane between categories must never change who can use it. So:
  - access moves to **per pane type** (Phase 3d's per-type permissions, rows of
    group × pane type);
  - categories become display-only;
  - the migration turns `tools_enabled` into a grant of each tool pane type, so
    nobody gains or loses anything.
- **Not session categories.** The rail's `SessionCategory` organises a user's
  *sessions*. This organises the *catalogue*. They are separate things with separate
  names in the UI: "Folders" for sessions in the rail if renaming is wanted, and
  "Categories" for the catalogue.
- **The agent:** `get_context` lists each kind's category. The prompt still names
  none (CLAUDE.md, "no per-service tuning").

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
- [x] **Phase 1: Credentials.** Built (one PR, D29). Credential types (the generic built-ins),
  encrypted store, write-only API, scopes (global and group), a Settings → Credentials
  UI, a test-on-save hook, an audit log, and the HTTP client's Auth as the first
  consumer. **Detailed in §13.** *Why first:* connections, plugins from private repos,
  declarative steps and workflows all reference credentials.
- [x] **Phase 2: Connections and generalised environments.** Built 2026-10-07 (one PR). Connection types (`aws`
  and `http_api`, built-in), environments as groups of named connections (several per
  type allowed, D32), group identities replacing the group's `role_name` (D31), and
  migration of today's environments and roles with ids kept (D34). The AWS routers
  resolve their client from a connection and the caller's group identity. The HTTP
  client can target an HTTP API connection (D33). **Detailed in §14.**
  *Exit:* everything works exactly as today, through the new model.
- [ ] **Phase 3: Actions, manifests and output components.** The largest phase,
  because every pane is ported (D5). **Detailed in §15**, shipped as four PRs, each
  with something to try in the UI (D41). The steps:
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
  - **3d, permissions, categories and a first new pane:**
    - Per-type permissions replace the boolean flags.
    - The catalogue with categories (§4.8, R6).
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

Phase 3 PR 1's two are in §15.11. New ones go here as they come up.

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
| R5 | 2026-10-04 | **Users can create their own credential types without code**, e.g. from a JSON example, for their own panes and workflows (§13.3). | New custom panes and steps need new kinds of secret; waiting for code or a plugin would block them. |
| R6 | 2026-10-04 | **Pane categories are organised by people:** admins arrange the catalogue, plugin and builder authors suggest a category, panes can move between categories (§4.8). | "Services" and "Tools" were a starting point, not a structure that fits every installation. |
| D16 | 2026-10-04 | **Vocabulary:** Connection, Action, Credential, Builder, Effect (as proposed in the naming table that was §10). | Settled early because it appears in the UI and in every plugin manifest. |
| D17 | 2026-10-04 | **Effects a sandboxed plugin may request:** `toast` always; `copy` only in response to a click inside its frame; `open_link` and `download` always confirmed, showing the full address or file name; `attach_to_agent`, `open_pane` and `set_input` allowed. | Blocks phishing links, malicious downloads and clipboard tricks without getting in the way of normal use. |
| D18 | 2026-10-04 | **Run retention:** a global default, adjustable per workflow up to an admin maximum. Default: last 100 runs or 30 days, whichever keeps more; artifacts 14 days; pinned runs kept forever; a one-line audit record kept for a year. | Enough history to compare and re-run, without unbounded storage. |
| D19 | 2026-10-04 | **Live panes come in three tiers** (§4.5): live CEL expressions over inputs (and bound components), then live server Actions, then sandboxed browser code (Pyodide or JS). JWT, Base64 and Diff move to tier 1. | Instant, safe, native-looking and agent-usable for the common case; real code only where it's needed. |
| D20 | 2026-10-04 | **Sessions have variables**: session-level inputs that panes bind to, shown in view mode (§4.6). | What makes view mode a real dashboard: change the environment or time range once for every pane. |
| D21 | 2026-10-04 | **Outputs move out of the synced session state** into a per-pane store (small in Postgres, large as blobs), with the session keeping a pointer and version (§4.6). | Required for auto-refresh; also removes the 4 MiB browser cap and the agent's result trimming. |
| D22 | 2026-10-04 | **Auto-refresh floor:** 10 s by default, 1 minute for pane types that declare `cost: per_run`; admins can raise either. | Protects the APIs and the bill (CloudWatch Logs Insights charges per GB scanned). |
| D23 | 2026-10-04 | **Categories as in §4.8:** an admin-arranged, display-only catalogue that manifests only suggest into (admin placement survives upgrades), with per-user favourites and hiding, shared by panes, steps and workflows; access moves to per-pane-type grants. | Organising and access are different jobs; moving a pane must never change who can use it. |
| D24 | 2026-10-04 | **Phase 1: only admins manage credentials and credential types**; delegating a group's own credentials to its members is a later flag. | Smallest safe start. |
| D25 | 2026-10-04 | **Secrets are never revealed**, to admins included: replace only. | Grafana's model; nothing can leak what can't be read back. |
| D26 | 2026-10-04 | **Non-secret config values wait for their first consumer** (Phase 3 inputs or Phase 4 workflows). | Avoids a screen whose values nothing can use yet, and guessing how they'll be read. |
| D27 | 2026-10-04 | **The HTTP client's Auth is in Phase 1** as the first real consumer of credentials (§13.8). | Immediate value, and it proves storage, scopes, resolve, masking and audit in production before Phase 2 depends on them. |
| D28 | 2026-10-04 | **Secret files are capped at 1 MiB** until the blob store (D7, Phase 4). | Keeps encrypted values in Postgres small. |
| D29 | 2026-10-04 | **Phase 1 ships as one PR**, not the four of §13.9, so it can be tested as a whole. | The store alone has nothing to try in the UI. |
| D30 | 2026-10-07 | **How a credential is used belongs to what uses it, not to its type.** A credential type is a shape: its fields and which are secret. From Phase 2, a connection type (or a plugin's step) declares which credential types it accepts and how it applies each one. A type's own `inject` and `http_test` stay as the default for plain HTTP requests (the HTTP client, a declarative HTTP step), folded under *Advanced* in the type editor. | Asked while testing Phase 1: HTTP is the commonest way a secret is used, but an SSH key, a database password or a certificate is used some other way, and a type form led by HTTP options made every type look like an API login. n8n puts `authenticate` on the credential type; that suits a tool where nearly everything is HTTP, which this platform deliberately isn't. |
| D31 | 2026-10-07 | **Who a group is belongs to the group, as credentials; where a system is belongs to the connection.** A group has an identity per connection type (default) and per connection (override); a request uses the override, then the default, then the connection's own credential. The IAM role becomes an *AWS role* credential, the group's default AWS identity; `user_groups.role_name` stops being read (§14.3). | Groups in one account need different roles (read-only Backend, full Admin), so a role can't live on the connection. And the role was only "hardcoded" on the group because the platform started AWS-only: in a generic platform it is one more credential assigned to a group. |
| D32 | 2026-10-07 | **An environment can hold several connections of one type, each named** ("Prod · iot", "Prod · eks"). Pickers show an environment with one connection by its name alone. Access stays per environment (§14.4). | In practice one "prod" spans accounts and regions (IoT in one, EKS in another). Splitting it into "IoT Prod" and "EKS Prod" would put AWS's structure back into every conversation and break "do this in Prod". |
| D33 | 2026-10-07 | **Phase 2 ships a built-in `http_api` connection type** (base URL + identity), with the HTTP client as its consumer; admin-defined connection types wait for Phase 3. | Proves the model isn't AWS-only with something testable in the UI, as D27 did for credentials. A custom connection type would have no consumer before manifests. |
| D34 | 2026-10-07 | **Migrated connections keep their environment's id, and Phase 2 keeps the `environment_id(s)` keys in payloads and pane state**, now holding connection ids. They are renamed in Phase 3 with the one state shape (D9). | Saved sessions, templates and saved items keep working with no data migration, and pane state is migrated once (Phase 3) rather than twice. |
| D35 | 2026-10-07 | **A credential with no secret value set can be stored and resolved without a master key.** | An *AWS role* without an external ID is only a name. Without this, a deployment with no `PLATFORM_MASTER_KEYS` would lose AWS access on upgrade. |
| D36 | 2026-10-07 | **An identity's use is audited at most once an hour per (credential, user, connection)**; `last_used_at` still moves on every use. | A pane makes many AWS calls a minute; one audit row per call would bury everything else in the log. |
| D37 | 2026-10-08 | **Phase 3 is detailed and shipped a step at a time**, each detailed just before it's built (§15). | Later steps depend on what the first one's manifests turn out to need. |
| D38 | 2026-10-08 | **Outputs leave the synced session state (D21) in 3c, not 3a.** | It changes how results sync, how shared sessions see them and how the agent writes them, and its reason to exist is auto-refresh (3c). In 3a it would have turned a refactor into a risky change. |
| D39 | 2026-10-08 | **Manifests are YAML files in the repo**, one per pane type, checked against a schema and served at `/api/pane-types`. Handlers are Python functions they name. | The format plugins will ship (Phase 7), used by the built-in panes from the first day. |
| D40 | 2026-10-08 | **`environment(s)` becomes `connection(s)` in pane state and payloads in Phase 3**, through the same migration as the state shape; payloads accept both names for one release. | D34 deferred it so stored state is migrated once, not twice. |
| D41 | 2026-10-08 | **A PR only when there is something to try in the UI.** Phase 3 is four PRs: manifests with Base64, Diff and JWT ported and the API table pane (PR 1); the rest of 3b (PR 2); 3c (PR 3); 3d (PR 4). | Each PR is tested by the person who merges it, not only by the suites. |
| D42 | 2026-10-08 | **Each pane moves to the `in./out./view.` shape when it is ported**, with a per-pane-type version in the session; unported panes keep their keys. | A pane's code reads its own keys; switching them before it is rewritten is churn twice. Each pane is still migrated exactly once. |

## 13. Phase 1 in detail: credentials

_Drafted 2026-10-04 for review. Nothing is built until this section is agreed; its
own open questions are in §13.10._

### 13.1 Scope

**In:**
- **Credential types as data, not code** (R5): admins create their own in the UI,
  and the built-ins are just pre-installed, locked entries of the same kind (§13.3).
- **The encrypted store**, with envelope encryption under a master key from a
  Kubernetes Secret (D14).
- **Scopes and grants:** global credentials (usable by a group only by explicit
  grant, D15) and group credentials.
- **A write-only API.**
- **Test-on-save** for the types that can be tested.
- **A general audit log**, which the platform doesn't have yet. Credentials are its
  first user; workflows, plugins and connections will use it after.
- **Settings → Credentials.**
- **Recommended: one early consumer** to prove the whole path in production: the
  HTTP client's Auth option (§13.8).

**Out**, each for the phase that first needs it:
- **Connections:** Phase 2. Credentials have no AWS consumer until then, and each
  group's IAM `role_name` keeps working exactly as today.
- **Picking a credential as a pane input:** Phase 3.
- **Config values:** non-secret settings, deferred to the first phase that consumes
  them (see §13.10).
- **Personal credentials and external secret backends:** later (§9).

### 13.2 Data model

Five new tables. `create_all` makes new tables, so no `ensure_columns` work is
needed.

```
credential_types           -- built-ins are seeded rows (builtin = true, read-only); admins add their own
  id                 text pk -- "username_password", "acme_api_key"
  label, description
  version            int    -- bumped on every change to fields
  fields             jsonb  -- [{key, label, kind, secret, required, default, help, choices}]
  output_template    text   -- optional CEL map expression: the JSON shape consumers receive (§13.3)
  inject             jsonb  -- optional: how it authenticates an HTTP request (§13.3)
  http_test          jsonb  -- optional declarative test: a request, success = 2xx (§13.3)
  builtin            bool   -- true for ours: not editable, and may have a code test
  created_by / created_at / updated_by / updated_at

credentials
  id                 pk
  name               text, unique per scope (global, or within its group)
  type_id            fk credential_types (ON DELETE RESTRICT: a type in use can't be deleted)
  type_version       int    -- the type's schema version when last saved
  description        text
  scope              text   -- "global" | "group"
  group_id           fk user_groups, null for global   (ON DELETE CASCADE)
  public_fields      jsonb  -- the type's non-secret fields, e.g. username, certificate
  secret_ciphertext  bytea  -- AES-256-GCM over a JSON object of the secret fields
  secret_nonce       bytea  -- 12 bytes, fresh on every write
  wrapped_dek        bytea  -- this credential's data key, encrypted by the master key
  kek_id             text   -- which master key wrapped it (for rotation)
  secret_fields_set  jsonb  -- ["password"]: which secret fields hold a value (Grafana's secureJsonFields)
  created_by / created_at / updated_by / updated_at
  last_tested_at, last_test_ok, last_test_message
  last_used_at       -- set by resolve() (§13.4)

credential_grants          -- a global credential made usable by a group (D15)
  credential_id fk, group_id fk, granted_by, granted_at      pk (credential_id, group_id)

audit_events               -- general; credentials are the first writer
  id, at, actor_user_id (null for system), actor_kind ("user" | "agent" | "system"),
  action ("credential.create" | ".update" | ".delete" | ".test" | ".grant" | ".revoke" | ".use"),
  object_type, object_id, group_id, detail jsonb       -- detail never holds a secret
```

- **A data key per credential:**
  - Each credential gets its own random 256-bit data key (DEK), wrapped by the
    master key (KEK).
  - Rotating the master key re-wraps every DEK (a few bytes each). The secrets
    themselves are never re-encrypted.
  - A database dump on its own reveals nothing.
- **All of a credential's secret fields go in one ciphertext.** It is simpler than one
  per field, and fields are always decrypted together anyway.
- **Associated data binds each ciphertext to its row:**
  `credential:{id}:{type_id}:{type_version}`. Copying one credential's ciphertext
  into another row, or onto another type, fails to decrypt instead of silently
  handing the wrong secret to the wrong place.

### 13.3 Credential types: data anyone can define

**There is one kind of credential type: a schema.** It is a list of fields, each
public or secret. Admins create new types in Settings → Credential types, with no
code (R5). The built-in types are the same thing, pre-installed and locked. A plugin
will ship its types the same way (as data in its manifest).

**Defining one.** A type has fields, each with a key, a label, a kind (text,
multiline, number, bool, choice, json, file), and flags for secret, required,
default and help. There are two ways to make one:

- **Add fields one by one** in the form.
- **Paste an example**, the shortcut for exactly your idea. Paste
  `{"username": "", "password": "", "region": "eu-west-1"}`, and the editor proposes
  one field per key (with `region`'s value as its default), then you tick which are
  secret.

A credential of that type is then filled in through a form drawn from those fields.

**What a consumer receives.** By default, a JSON object of the fields:
`{"username": "…", "password": "…"}`.

- When something needs a different shape, the type's optional **output template**
  builds it.
- It is written in CEL (D8), the same language as workflow expressions, over the
  fields. That keeps it safe to evaluate: no code can run.

```
{"auth": {"user": username, "pass": password}, "endpoint": "https://" + host + "/api"}
```

- A custom pane or workflow step asks for **"a credential of type `acme_api_key`"**,
  and reads `cred.token` or `cred.auth.user` in its expressions (D8) or its Python
  handler.

**Optional extras a custom type can declare, still without code:**

- **`inject`, for HTTP:** how this credential authenticates a request. Any HTTP-based
  pane or step can then use any such credential, custom types included.

  ```
  inject:  header "Authorization" = "Bearer " + token
  inject:  basic(username, password)
  inject:  query "api_key" = key
  ```

  This is n8n's `authenticate`, made declarative.
- **`http_test`:** a request to send on save (method, URL and headers, templated from
  the fields, typically using `inject`). It passes on 2xx. It goes through the same
  SSRF guard as the HTTP client.

**Built-in types** (seeded, locked) cover the common shapes and keep the few checks
that need code:

| Type | Fields (secret ones in **bold**) | Check on save |
|---|---|---|
| `secret_text` | **value** | — |
| `secret_json` | **value** (must parse as JSON) | parses |
| `secret_file` | filename; **content** (upload, max 1 MiB) | — |
| `username_password` | username; **password** | — (`inject`: basic) |
| `api_token` | **token**; header (default `Authorization`); scheme (default `Bearer`) | — (`inject`: header) |
| `ssh_key` | username; **private_key**; **passphrase** | the key loads with its passphrase; shows the key type and fingerprint |
| `certificate` | certificate (PEM, public); **private_key**; **passphrase**; CA chain | parses, key matches certificate, shows subject and expiry; warns when it expires within 30 days |
| `aws_access_keys` | access_key_id; **secret_access_key**; **session_token** | `sts:GetCallerIdentity`, shows the account and ARN |

An admin who finds a built-in doesn't fit makes a custom type instead, or copies a
built-in as the starting point for one.

**Rules that keep custom types safe and stored values readable:**

- **A field can be made secret later, but never made public again.**
  - Public to secret re-encrypts the existing values, as it should.
  - Secret to public would expose values that were promised to stay hidden.
- **Editing a type in use bumps its version.**
  - Adding a field is always allowed: existing credentials show it empty, and a
    required one asks to be filled on the next edit.
  - Renaming or removing a field that holds values asks for confirmation, and
    lists the credentials affected.
- **A type with credentials can't be deleted** (`ON DELETE RESTRICT`); delete or
  move its credentials first.

**The same engine will define connection types in Phase 2.** Your AWS example,
`{account, region}`, is a *connection* type: mostly public fields, plus a reference
to a credential. It is defined in the same editor, with the same field kinds, paste
shortcut and output template. Credentials hold what is secret; connections hold where
and how to reach a system. So "a new custom pane for my in-house API" is:
- a credential type (the API key);
- a connection type (base URL, tenant, plus the credential);
- the pane.

All three can be made in the UI.

### 13.4 Encryption and keys

- **Library:** `cryptography` (AESGCM), a new pinned dependency. It's the standard
  choice, and also what loads SSH keys and certificates for the tests above.
- **The master key comes from the environment:**
  - `PLATFORM_MASTER_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>"`, a keyring;
  - `PLATFORM_MASTER_KEY_ID=k2`, the one used for new writes.

  Older keys stay in the ring only to unwrap DEKs until rotation finishes.
- **Helm:**
  - `backend.masterKey.existingSecret` and `existingSecretKey`, required whenever
    credentials are enabled.
  - **The chart does not generate the key.** `helm lookup`, the usual way to keep a
    generated value across upgrades, returns nothing under ArgoCD, which renders
    charts without cluster access. A generated key would be replaced on every sync,
    and every stored secret would become unreadable.
  - `DEPLOYMENT.md` gets the one-line `kubectl create secret … $(openssl rand
    -base64 32)` and a warning: **back the key up; losing it loses every
    credential.**
- **No key configured:**
  - The app still starts and everything else works.
  - The credential routes answer 503 with "Credentials are off: no master key is
    configured. See DEPLOYMENT.md", and Settings shows the same.
  - A key that is present but can't unwrap existing DEKs (the wrong key) stops
    credential use loudly, and is not mistaken for "no credentials".
- **Rotation:** `python -m app.keys rotate --to k3` re-wraps every DEK under the new
  key in batches, and is safe to re-run. Then drop the old key from the ring.
- **`resolve(credential_id, *, actor, purpose)` is the only function that decrypts.**
  - It checks the actor can use the credential: their group, or a grant.
  - It writes a `credential.use` audit event, updates `last_used_at`, and returns the
    values for that call only.
  - It registers the plaintext values with a **log-masking filter** for the rest of
    the request, so a value that reaches a log line or an error message comes out
    as `****`.
  - Phase 1's only callers are the test and the HTTP client (§13.8). Phase 2+
    connections and runs call it the same way.

### 13.5 API

All under `/api/credentials`, auth-gated like every route. **No response ever
contains a secret value**, to admins included: there is no reveal, only replace
(Grafana's model).

| Route | Who | Does |
|---|---|---|
| `GET /api/credential-types` | any user | the types and their field schemas, for the form |
| `POST` / `PATCH` / `DELETE /api/credential-types/{id}` | admin | create and edit custom types (built-ins are refused); the rules in §13.3 are enforced here |
| `POST /api/credential-types/infer` | admin | the "paste an example" shortcut: JSON in, proposed fields out |
| `GET /api/credentials` | admins: all. Others: their group's, plus global ones granted to their group | name, type, scope, public fields, `secret_fields_set`, test status, last used. Non-admins see names and types only (for picking one later) |
| `POST /api/credentials` | admin | create; secret fields are encrypted before the row is written |
| `PATCH /api/credentials/{id}` | admin | a secret field left out keeps its value; `clear: ["field"]` empties it; public fields replace |
| `DELETE /api/credentials/{id}` | admin | refused while anything references it (connections, from Phase 2), naming what does |
| `POST /api/credentials/{id}/test` | admin | runs the type's test |
| `POST` / `DELETE /api/credentials/{id}/grants/{group_id}` | admin | global credentials only |
| `GET /api/audit?object=credential:{id}` | admin | that credential's history |

- Errors are readable sentences (CLAUDE.md conventions), e.g. "A credential named
  'deploy-key' already exists in this group."
- **Admins only manage credentials in Phase 1**: create, edit, delete, test, grant.
  Delegating a group's own credentials to its members is a later flag (see
  §13.10).

### 13.6 Settings → Credentials

One admin tab next to Environments, User groups and Users, **Credentials**, with a
*Credentials | Types* switch inside it (two tabs wrapped the Settings row). Each is a
list whose rows open the item; what can be done to one is in the opened view, laid
out in the session card's sections (built 2026-10-07, after the first version's
four buttons per row and paragraphs of help read as cluttered).

The types list shows your own types first and the built-ins folded under one row. An
opened type has *Details*, *Fields* (with "Fill from an example…") and a folded
*Advanced* section: the output template with a live preview, and `inject` and
`http_test` (D30). A built-in opens read-only, with Copy.

The rest of this section describes credentials.

- **List:**
  - Columns: name (with its description), type, access ("All groups", the
    granted groups, "Admins only", or "*Group* only"), test status (a dot: passed,
    failed with its message, or not tested), last used.
- **Opened credential:** sections *Details*, *Values*, *Access* (global only) and
  *History*; Test and Delete in its header.
- **Create/edit:**
  - Pick a type, and the form is drawn from that type's fields.
  - A secret field that is set shows "•••• set" and a **Replace** button, never the
    value. A file field shows its filename and size, with Replace.
  - **Test** next to Save. Save runs the test first when the type has one, and saves
    anyway, with a warning, if the test fails, since a key may be valid somewhere the
    platform can't reach.
- **Grants:** for a global credential, its groups as tags plus an "Add a group…"
  picker, saved with Save. Admin groups are never offered (they can use every
  credential), and the picker stays once every group has it, saying so: when it
  vanished, two groups granted read as a limit of two.
- **History:** the credential's audit events (who, what, when, test results, uses).
- **Delete:** a confirmation. It is refused with the referencing items listed once
  connections exist.
- Non-admins see nothing new in Phase 1. Their read-only list arrives with the first
  place they can pick a credential, except the HTTP client in §13.8.

### 13.7 Audit log

- **Recorded for credentials:** create, update (*which* fields changed, never
  values), delete, test (with result), grant, revoke, use (by what: "HTTP client in
  session 'Checkout'").
- **Also recorded:** the actor (user, agent or system) and the group.
- **Retention:** one year, matching D18's audit line.
- **Read** by admins, per credential in Phase 1. A global audit page can come later.

### 13.8 First consumer: the HTTP client's Auth (recommended)

- The HTTP client pane gets an **Auth** select: none, or any credential the user's
  group can use whose type declares `inject`. That includes `username_password`,
  `api_token`, and every custom type that says how it authenticates.
- On Send, the backend resolves the credential and applies its `inject`
  server-side. The value never reaches the browser, the session state or the agent.
  The session stores the credential's **id**, and the response shown to the user has
  that header masked.
- It proves the whole path in production (store, scopes, resolve, masking, audit) a
  phase before connections depend on it. The SSRF guard (`tools_http_client.py`) is
  untouched.
- The agent can pick the credential by name when filling the pane, but still can't
  Send (no approval step yet), as today.

### 13.9 Delivery, tests and done

Four PRs, each usable on its own:

1. **Store and API:** the models, crypto, types, `resolve`, audit, routes, the
   rotation command and the 503-without-key behaviour. Tests:
   - encrypt/decrypt round trip;
   - a ciphertext moved to another row fails;
   - the wrong master key is refused loudly;
   - rotation re-wraps and the secrets still decrypt;
   - **no route returns a plaintext secret** (every response of the suite is scanned
     for the known test values);
   - scope visibility (group A can't see group B's credentials; a global one is
     visible only with a grant);
   - audit events are written for every action;
   - each built-in's check (an SSH key, a certificate, STS mocked at the boto3
     boundary as existing tests do);
   - custom types:
     - create from a pasted example;
     - the output template shapes `resolve()`'s result;
     - `inject` adds the right header;
     - `http_test` goes through the SSRF guard;
     - a secret field can't be made public;
     - a type in use can't be deleted;
     - a new version keeps old credentials readable.
2. **Settings UI:** a browser suite that defines a custom type from a pasted
   example, then creates, replaces a secret, tests, grants, reads the history and
   deletes. It also **intercepts every network response and
   fails if a secret value appears in any**, and fails against the old
   `frontend/src`, per CLAUDE.md.
3. **Deployment:** the Helm value, the docker-compose dev key, and `DEPLOYMENT.md`
   (creating the key, backing it up, rotating it).
4. **HTTP client Auth** (§13.8), with backend and browser tests showing the header
   is sent and never shown.

**Done when:** an admin can define a custom credential type from a pasted example,
store credentials of it and of each built-in type, test, grant and audit them; the HTTP client can authenticate with one; and no API response, log line,
session state or agent message has ever contained a secret value. The suites above
check each of these.

### 13.10 Open questions for Phase 1

All five settled 2026-10-04 as D24–D28 (§11).

## 14. Phase 2 in detail: connections, environments and group identities

_Drafted 2026-10-07, agreed (#103) and built the same day, as one PR. Where the
build differs from the text below, it says so in §14.11._

### 14.1 Scope

The idea in one line: **a connection says *where* something is, and a group says
*who* it is there.**

- *Where*: an account and region, or a base URL.
- *Who*: an IAM role, or an API token.

Today both are fused, AWS-only: an `Environment` row is an account and a region,
and the group carries one `role_name` used in every account.

**In:**
- **Connection types:** built-ins in code, stored as seeded rows like credential
  types. Two to start:
  - `aws` (account, region);
  - `http_api` (base URL), D33.
- **Connections:** one configured target of a connection type, inside an
  environment. An environment can hold several, each named (D32).
- **Environments as named groups of connections** (D1). They stay the unit of group
  access.
- **Group identities** (D31): which credential a group uses for a connection type,
  with optional per-connection overrides. The IAM role stops being a column on the
  group.
- **The *AWS role* credential type** (built-in): role name, plus an optional external
  ID (secret).
- **Migration of every existing environment and group role**, with ids kept, so saved
  sessions, templates and group access survive untouched (D34).
- **The AWS routers** resolve their client from a connection and the caller's group
  identity, instead of `Environment` plus `role_name`.
- **The HTTP client** can target an environment's HTTP API connection, the first
  non-AWS consumer (D33).
- **Settings:**
  - Environments are redone in the Credentials layout, opening into Details,
    Connections and Access.
  - User groups are redone the same way, with a new **Identities** section.
- **The agent** sees environments with their connections, and uses them by name.

**Out**, each for the phase that first needs it:
- **Connection types defined by admins** (in the credential-type editor): Phase 3,
  when a manifest-built pane can consume one. Before that, nothing could.
- **Tagging a connection with the services it is for**, so a pane picks it without
  asking: Phase 3, with manifests.
- **Renaming `environment_id(s)` in API payloads and pane state:** Phase 3, with the
  one state shape (D9). Phase 2 keeps the keys and changes what the values mean
  (D34).
- **Non-AWS connection types beyond `http_api`** (Kubernetes, Postgres, GitHub…):
  first-party plugins, later.
- **Chaining credentials**, e.g. access keys that then assume a role: later, if
  anyone needs it.

### 14.2 Data model

Three new tables, plus two columns that stop being read.

```
connection_types           -- seeded built-ins in Phase 2; admin-defined from Phase 3
  id                 text pk   -- "aws", "http_api"
  label, description
  fields             jsonb     -- the same field schema as credential types (§13.3): public settings
  identity_types     jsonb     -- credential type ids a group may use as its identity here
  builtin            bool

connections
  id                 int pk    -- migrated ones take their environment's id (D34)
  environment_id     fk environments (ON DELETE CASCADE)
  type_id            fk connection_types (ON DELETE RESTRICT)
  name               text      -- unique within its environment: "iot", "eks"
  config             jsonb     -- the type's fields: {account_id, region} | {base_url}
  credential_id      fk credentials, null   -- the connection's own identity, used only
                                            -- when the group has none (§14.3)
  position           int       -- order within its environment
  created_by / created_at / updated_by / updated_at

group_identities           -- who a group is, per connection type (D31)
  id                 pk
  group_id           fk user_groups (ON DELETE CASCADE)
  connection_type_id fk connection_types
  connection_id      fk connections, null   -- null: the group's default for the type
  credential_id      fk credentials (ON DELETE RESTRICT: an identity in use can't be deleted)
  unique (group_id, connection_type_id, connection_id)
```

- **The connection id sequence starts above the highest environment id.** Migrated
  rows are inserted with explicit ids, then `setval`, so a new connection can never
  take an id that a saved session already uses.
- **`environments.account_id` and `.region` become nullable and stop being read.**
  The same goes for `user_groups.role_name`. All three are dropped one release later,
  once the migration has run everywhere (§14.7).
- **Group access is unchanged:** `group_environment_access` still decides which
  environments a group sees. A group that sees an environment can use all of its
  connections, each with the group's own identity.

### 14.3 Who the request runs as: group identities

A request on a connection runs as **the first of these that exists**:

1. the caller's group's identity **for this connection** (the override);
2. the caller's group's identity **for this connection type** (the default);
3. **the connection's own credential**, e.g. a shared token on an HTTP API connection;
4. otherwise, an error naming what is missing: *"Your group (Backend) has no AWS
   identity for Prod · iot; ask an admin to set one in Settings → User groups."*

Rules:
- **The identity must be a credential the group can use** (its own group's, or a
  global one granted to it, D15), and of a type the connection type accepts
  (`identity_types`). Both are checked when it is set *and* when it is resolved,
  since a grant can be revoked in between.
- **The admin group follows the same rules.** Admins always *see* every environment,
  but they still need an identity to *act* in it, exactly as they need a `role_name`
  today.
- **Identities resolve through `credential_store.resolve()`**, so they are audited
  and masked like any other credential. One thing changes for them: a pane can make
  dozens of AWS calls a minute, so an identity's **use is recorded at most once an
  hour per (credential, user, connection)**. `last_used_at` is still updated on every
  use (D36).
- **A credential with no secret value set needs no master key** (D35). An *AWS role*
  with no external ID is just a name. Without this, a deployment with no
  `PLATFORM_MASTER_KEYS` would lose AWS access entirely on upgrade, since its migrated
  roles couldn't be stored.

The `aws` connection type accepts two identity types:

| Identity type | What the request does |
|---|---|
| `aws_role` (new built-in: **role name**; **external ID**, optional, secret) | Assumes `arn:aws:iam::{account_id}:role/{role_name}` from the platform's own AWS identity, exactly as today. The external ID is passed when set. |
| `aws_access_keys` (Phase 1 built-in) | Uses the keys directly, for an account the platform's own identity can't reach. |

The `http_api` connection type accepts any credential type that declares `inject`
(§13.3, D30).

The platform's own AWS identity (IRSA, an instance role) stays the only ambient
credential, and it is used only to assume roles. The assumed-credentials cache key
becomes (connection, credential id, credential version), so replacing a role or a
key takes effect at once.

### 14.4 Several connections per environment

Decided in D32. An environment can hold several connections of one type, each named:
Prod holds *iot* (account A, eu-west-1) and *eks* (account B, us-east-1).

- **Panes pick connections.** The picker lists every connection the user can see,
  grouped by environment:
  - an environment with **one** connection of the pane's type shows as just its name
    (**"Prod"**);
  - an environment with several shows each connection (**"Prod · iot"**,
    **"Prod · eks"**).
  - Picking several still queries each and labels results by that name, as picking
    several environments does today.
- **After migration every environment holds exactly one AWS connection.** So every
  picker, every result label and every saved session looks exactly as it does now,
  which is Phase 2's exit test.
- **The agent** gets each environment's connections from `get_context`: name, type,
  and the public config (region, base URL), never the identity. "The IoT things in
  Prod" then resolves to Prod · iot. A pane input can be given an environment where
  a connection is expected:
  - with one connection of the right type, it is used;
  - with several, the input is refused, listing them, so the model picks one rather
    than guessing.
- **Splitting access stays an environment decision.** If Backend may see Prod's IoT
  but not its EKS, those belong in two environments. That is a choice about group
  access, not about how AWS is organised.

### 14.5 Migration

Run once at startup, keyed on `connections` being created (the `main.py` one-shot
pattern), in one transaction:

1. **Each `Environment(id, name, account_id, region)`** becomes:
   - that environment, unchanged (same id, same name, same group access);
   - one `aws` connection with **the same id**, named `aws`, with config
     `{account_id, region}`.
2. **Each group with a `role_name`** gets:
   - an *AWS role* credential, scope = that group, named "*Group* AWS role", with
     `role_name` as its value;
   - a `group_identities` row making it the group's default for `aws`.

   The Admin group is included: it has a `role_name` today, and the legacy
   default-role setting was moved onto it by `bootstrap.py`.
3. **Audit:** one `system` audit event per created credential and identity.
4. **Pane state, templates, saved items and agent tokens need no change.** Every
   stored environment id is now also the id of that environment's only connection
   (D34).
5. **Proof the migration kept behaviour:**
   - Every existing backend test and browser suite passes unchanged.
   - A migration test builds the old schema with rows, migrates, then checks that
     every resolved (account, region, role) triple equals what `resolve.py` returned
     before.

Rolling back after the migration has run means restoring the database backup taken
before the upgrade; `DEPLOYMENT.md` says so. The old columns are kept for one release
for exactly this reason.

### 14.6 What changes in the code

- **`resolve.py`:**
  - `resolve_target(db, user, connection_id, type_id) -> Target`: a visible
    connection of the right type, plus its resolved identity.
  - It replaces `resolve_environment` + `resolve_role_name` at each call site in
    `queries.py`, `tables.py`, `buckets.py`, `cognito.py`, `opensearch.py`, `iot.py`,
    `log_groups.py` and `tools.py`.
  - `require_flag` stays as it is; per-type permissions are Phase 3d.
  - The not-visible error stays "… is not configured", never revealing which.
- **`aws_client.py`** takes a `Target` instead of `(account_id, region, role_name)`:
  `get_client(service, target)`, `get_credentials(target)`. Inside, assume-role
  versus direct keys is decided by the identity's type. Every `*_client.py` follows
  mechanically.
- **API payloads keep `environment_id` / `environment_ids`; the values are connection
  ids** (D34). Responses keep `environment_name`, which becomes the display name:
  "Prod", or "Prod · iot".
- **`platform_tools/panes.py`:**
  - The `environment(s)` input kinds validate connection ids, and accept an
    environment when it has exactly one connection of the type.
  - `_check_reachable` and `inspect_row`'s detail go through `resolve_target`.
  - `get_context` lists environments → connections.
- **The frontend:** the environment pickers (`LogGroupSelector`, the IoT, DynamoDB,
  S3 and Cognito pages, the OpenSearch index selector) take a list of *targets*
  from a new `GET /api/targets?type=aws`: `{id, label, environment, connection}`.
  Today they take environments. Nothing they store changes shape.
- **The HTTP client** (D33): a *Target* select listing `http_api` connections. With
  one picked:
  - the URL field takes a path, joined to the base URL;
  - Auth defaults to "the connection's identity", with an explicit credential still
    allowed to override it;
  - the joined URL goes through the same SSRF guard.

### 14.7 API

| Route | Who | |
|---|---|---|
| `GET /api/connection-types` | admin | the built-ins, with their fields and accepted identity types |
| `GET/POST /api/environments`, `GET/PATCH/DELETE /api/environments/{id}` | admin (GET list: everyone, filtered to what their group sees, as today) | an environment now returns its connections |
| `POST /api/environments/{id}/connections`, `PATCH/DELETE /api/connections/{id}` | admin | refuses a second connection with the same name; deleting one that saved sessions use warns, it doesn't block |
| `POST /api/connections/{id}/test` | admin | resolves as a chosen group and makes one cheap call (`sts:GetCallerIdentity` for `aws`; a GET of the base URL for `http_api`), so "does Backend reach Prod · iot?" is one click |
| `GET /api/targets?type=` | everyone | the connections the caller can use, with display labels: what pickers and the agent read |
| `GET/PUT /api/user-groups/{id}/identities` | admin | the group's default per connection type, and its overrides |

Every write is audited (`environment.*`, `connection.*`, `identity.*`). No response
carries a credential value; identities are reported by credential id and name only.

### 14.8 Settings

Both pages are redone in the Credentials layout: a list whose rows open into
`CardSection`s.

- **Environments.** Each row shows the name, its connections ("aws: 1234 eu-west-1",
  or "iot, eks") and the groups that see it. Opened, it has:
  - **Details:** name, description.
  - **Connections:** each with its type, name, config fields and optional own
    credential. Add, rename, reorder, remove, and **Test as…** a group.
  - **Access:** the groups that see it, as tags plus a picker. This is the same
    data as the group editor's environment list, editable from either side.
- **User groups.** Each row shows the name, its environments, members and identity
  ("AWS: Backend AWS role"). Opened, it has:
  - **Details:** name.
  - **Pages:** today's per-page switches.
  - **Environments:** what it sees.
  - **Identities**, new: per connection type, the default credential (a picker of
    credentials of an accepted type that this group can use), then overrides, one
    per connection, added from a picker of the connections it can see.
  - The *IAM role name* field is gone. It is the default AWS identity now, and the
    migration created it.

### 14.9 Delivery, tests and done

**One PR** after this plan's PR (as Phase 1, D29), since none of it is testable in
the UI in pieces. Tests:

- **Migration:**
  - ids kept;
  - one `aws` connection per environment, named `aws`;
  - each group's role is now a group credential and the group's default identity;
  - the (account, region, role) triples are unchanged;
  - running the migration twice changes nothing;
  - a deployment with no master key migrates and still reaches AWS (D35).
- **Resolution order:**
  - override, then default, then the connection's own credential, then a readable
    error;
  - a revoked grant stops an identity at resolve time;
  - an identity of a type the connection type doesn't accept is refused.
- **Several connections per environment:**
  - labels ("Prod · iot");
  - a pane querying two connections in one environment;
  - an environment given where a connection is expected: used with one connection,
    refused (listing them) with several.
- **Access:** a group sees an environment's connections only with access to it, and
  even then acts only with its own identity. The cross-group and shared-session cases
  in `test_platform_tools.py` all still hold.
- **Audit:**
  - identity uses are coalesced hourly, while `last_used_at` moves on every use;
  - no response carries a credential value (the Phase 1 recorder, extended to these
    routes).
- **HTTP client:**
  - target plus path;
  - the connection's identity is applied;
  - a base URL pointing inward is refused by the SSRF guard.
- **Browser:**
  - every existing suite passes unchanged (the exit test);
  - new suites for Settings → Environments (add a second connection, test as a
    group) and Settings → User groups → Identities, each failing against the old
    frontend.

**Done when:**
- everything works exactly as today through the new model;
- an admin can put two AWS accounts in one environment and give a group a different
  role in each;
- the HTTP client can call an environment's API through its connection;
- no role name is read from `user_groups` any more.

### 14.10 Open questions for Phase 2

None open as of 2026-10-07: D31–D36 settle what came up while drafting. New ones go
here.

### 14.11 As built (2026-10-07)

What the build changed or settled that the text above didn't:

- **Connection ids share the environments' id sequence.** This holds for every
  connection, not only migrated ones, and an environment's first connection takes
  the environment's id. So an environment made the old way (with an account and a
  region) still answers to its own id everywhere, and two connections never
  collide with a stored id.
- **The old fields stay in the API, on top of the new model.**
  - `POST /api/environments` with `account_id`/`region` creates that first AWS
    connection.
  - `role_name` on user groups reads and sets the group's default AWS identity
    (`connections.set_group_role`).
  - Old clients and every existing test keep working. Three test assertions
    changed: a group's role now shows in its credential list, and one test
    compared the role to a plain string.
- **The account ID is checked as digits, not exactly 12.** The old form took any
  account ID, and rejecting one that worked would have broken the "exactly as
  today" exit.
- **The migration runs once, recorded by a marker in `settings`**, not "for every
  environment without a connection". Otherwise a connection an admin deleted
  would come back on the next restart.
- **Hourly coalescing of identity uses is in memory**, so it is per replica.
- **The `aws` connection type's label is "AWS"**, so identities read "AWS
  (default)" and "AWS · Prod · eks".
- **Settings → User groups → Identities** offers "A new AWS role…", which creates
  the group's own *AWS role* credential on Save. Without it, a new group would
  need a trip to Credentials first.
- **Seven browser suites changed only their setup steps**: 13, 16, 17, 20, 22, 23
  and 36. They created an environment, or a group, through the one-step forms
  this phase replaced. What they then check is unchanged and passes, including
  the pane label "Demo Env (111122223333 · us-east-1)", since an environment
  with one connection is called just its name.

## 15. Phase 3 in detail: manifests, the renderer, and the first manifest-drawn panes

_Drafted 2026-10-08 for review. Phase 3 ships as four PRs, each with something to
try in the UI (D41). This section details the first, §15.1–15.9; the other three
are outlined in §15.10 and get their own detail just before they are built._

### 15.1 What PR 1 delivers, and what you can try

**You can try:**
- **Base64, Diff and JWT, drawn from manifests by the generic renderer.** They look
  and behave exactly as today; their browser suites pass unchanged.
- **The agent can fill and run Base64 and Diff**, because their manifests say how.
  It still can't fill JWT: a pasted token is `sensitive`.
- **A new pane that exists only as a YAML file: *API table*.**
  - It reads JSON from an environment's HTTP API connection (Phase 2) and shows it
    as a table.
  - The table can select rows, copy, export CSV/JSON, and attach rows to the agent.
- **Settings and every other pane:** unchanged.

**Underneath** (no visible change):
- a manifest for every one of today's eleven panes;
- `panes.py`'s `KINDS` generated from them;
- `GET /api/pane-types`;
- the `in.` / `out.` / `view.` state shape for the panes ported so far.

### 15.2 The manifest

One YAML file per pane type, in `backend/app/panes/manifests/`. They are checked
against a schema at startup and in the tests, and served to the browser at
`GET /api/pane-types`, filtered to what the caller's group may use. It is the same
format a plugin will ship in Phase 7 (D39).

```yaml
id: tool-base64
label: Base64
group: Tools                  # a suggested category (§4.8); the catalogue arrives in PR 4
flag: tools_enabled           # until per-type permissions (PR 4) replace the flags
about: Base64 encode or decode text.
help: >-
  Encode text to Base64 or decode it back, as you type.
state: v2                     # its keys are in./out./view. (§15.4); absent = still the legacy keys
inputs:
  - key: mode
    type: choice
    choices: [encode, decode]
    default: encode
    legacy_key: mode          # where it lived before v2, for the migration
  - key: input
    type: text
  - key: url_safe
    type: bool
    label: URL-safe
    legacy_key: urlSafe
actions:
  - id: convert
    live: base64.convert      # a live function (§15.5): reruns as the inputs change
outputs:
  - key: output
    render: code
    actions: [copy]
agent:
  run: Nothing to run: the pane shows the output once the inputs are set.
```

**Fields:**
- **Header:** `id`, `label`, `group`, `flag`, `about` (for the agent and the
  catalogue), `help` (the pane's intro).
- **Inputs:**
  - `key`, `type`, `label`, `help`, `default`, `choices`, `min`/`max`;
  - `sensitive` (kept out of session state, the agent and run records);
  - `options: {action, depends_on}` for a dynamic choice;
  - `connection_type` for a `connection` input;
  - `legacy_key`.
- **Actions:**
  - `id` and `run_label`;
  - one of: `handler` (a Python function registered by name), `live` (a live
    function), or `request` (a declarative HTTP request, as the API table uses);
  - `effects: external` when a run reaches outside the platform, which the agent
    may not do until the approval step (§15.7).
- **Outputs:**
  - `key` and `render` (`text | code | json | table | diff` in PR 1);
  - `actions` (`copy | export | attach | select` in PR 1);
  - `rows` (a path into the output, for a table) and `inspect`.
- **`agent`:** what `run_pane` says for this kind; today's `run_help`.

The schema is a Pydantic model (`panes/manifest.py`), so a bad manifest fails
startup and the tests with the file and field named.

### 15.3 The agent's registry, generated

`KINDS` stops being hand-written:
- **One `PaneKind` per manifest.** Its `Input`s come from the manifest's inputs,
  and its runner and row listers are looked up by the handler names they declare.
- **The converters stay keyed by input type**, as now: `environments`, `log_groups`,
  `headers`, `credential`, and the rest.
- **What only code can say stays code**, referenced by name from the manifest:
  - `implies` (picking log groups ticks their environments);
  - `rows` and `detail` (inspect_row);
  - the run functions.

The MCP tests already pin every kind's keys and shapes, so they prove the generated
registry equals the hand-written one. A test also compares `describe()` for each
kind before and after the switch.

### 15.4 The state shape, per pane as it is ported (D40, D42)

- **The shape.** A ported pane stores:
  - `<pane>.in.<input>` for its inputs;
  - `<pane>.out.<output>` for its outputs;
  - `<pane>.view.<key>` for view state.

  An unported pane keeps its legacy keys until its PR ports it. Its manifest's
  `state` says which it is. Every pane is still migrated exactly once.
- **The migration** reads each manifest's `legacy_key`s (inputs and outputs):
  - **In the browser on load**, after `migrateLogsSplit`/`wrapAsAggregator`, guarded
    by a per-pane-type version map in the session (`__paneStates: {"tool-base64":
    2}`), so it runs once per pane type, idempotently.
  - **On the server**, on the agent's read path and on every PUT. So an old tab
    left open across the deploy can't write the old keys back.
  - **For saved templates and saved items**, through `__savedStateVersion`.
- **Renaming `environment(s)` to `connection(s)`** (D34's deferred rename) rides
  on the same migration, for each AWS pane when PR 2 ports it. API payloads accept
  both names for one release.
- **A stale tab reloads.** Every response carries the frontend build id
  (`X-App-Build`). A tab whose build is older than the server's says "A new version
  is available" and reloads on the next navigation. Without this, a tab open across
  the deploy would read new-shape state it doesn't understand.

### 15.5 The renderer, first cut

`components/panes/ManifestPane.tsx` draws any manifest pane:
- **Inputs:** a card of rows (the session card's `CardRow` look). PR 1 has:
  - `string`, `text`, `number`, `bool`, `choice`;
  - `connection` (a picker of `/api/targets?type=…`);
  - `headers` (key/value rows).
- **Actions:** a Run button per action. A `live` action reruns as you type, with no
  button.
- **Outputs:** `text`, `code`, `json`, `diff` (today's DiffTool view, lifted out as
  a component), and `table`.
- **The table**, lifted from today's results lists:
  - select one or all rows;
  - copy a cell or a row;
  - export the selected or all rows as CSV or JSON;
  - attach the selected rows to the agent (`PaneSelectionShare`, as every pane does
    now);
  - expand a row to its full JSON.
- **Output actions** run as effects from the fixed vocabulary (§4.3): in PR 1,
  `copy`, `download`, and `attach`.

**Live functions (tier 1, D43).** `base64.convert`, `jwt.decode`, `jwt.verify`,
`jwt.sign` and `diff.compute` are built-in named functions:
- written in TypeScript for the browser, so they still update as you type;
- with Python twins, so the agent and later workflows can run them.

CEL in the browser, for live expressions people write themselves, arrives with the
builder (Phase 5). Until then there is nothing user-authored to evaluate, and
adopting a JavaScript CEL library now would be choosing one before we know what the
builder needs.

### 15.6 Porting Base64, Diff and JWT

- **Each becomes a manifest with `state: v2`.**
  - Its old component is replaced by `ManifestPane`.
  - Its live function is moved, not rewritten: the code is today's.
  - Its keys migrate (`urlSafe` → `in.url_safe`, and so on).
- **Done means its browser suite passes unchanged**, and a new check opens a session
  saved before the port and finds every input where it was.
- **JWT's token and secrets are `sensitive`:**
  - kept in the tab's memory only, never in session state, as today;
  - the agent sees the input exists but can't set it.

### 15.7 The API table pane, the first one with no code of its own

```yaml
id: api-table
label: API table
group: Tools
flag: tools_enabled
about: Reads JSON from an environment's HTTP API connection and shows it as a table.
state: v2
inputs:
  - { key: connection, type: connection, connection_type: http_api }
  - { key: path, type: string, help: "e.g. /v1/orders" }
  - { key: query, type: headers, label: Query parameters }
  - { key: rows, type: string, label: Rows at, help: "Where the list is in the reply, e.g. data.items; empty: the reply itself" }
actions:
  - id: fetch
    run_label: Fetch
    request: { method: GET, connection: connection, path: path, query: query }
outputs:
  - { key: rows, render: table, rows: rows, actions: [select, copy, export, attach], inspect: true }
  - { key: response, render: json }
```

- **`request` is a declarative HTTP action.** It is today's HTTP client path with
  no new code:
  - the connection's base URL and the caller's group identity are applied
    server-side (Phase 2);
  - it goes through the SSRF guard;
  - echoed secrets are masked.
- **GET only** in PR 1.
- **The agent may run it.** It reads from a connection an admin configured, with the
  group's own identity, which is exactly what the AWS panes do. That is different
  from the HTTP client, which sends anything anywhere and stays behind the approval
  step (D44).

### 15.8 What else changes

- **`paneTypes.tsx`** keeps each type's React-only parts (icon, render function).
  Label, help, group and flag come from the manifest. A manifest pane needs no entry
  there: a manifest with no React entry is drawn by `ManifestPane`.
- **The home catalogue and the Panes card** list manifest panes like any other, by
  the manifest's `group`.
- **Saved items** for ported panes go into one generic store keyed by pane type: the
  manifest's inputs under a name. This replaces the per-pane saved stores as each
  pane is ported.

### 15.9 Tests and done

- **Backend:**
  - every manifest validates;
  - the generated `KINDS` describe exactly what the hand-written ones did;
  - the state migration in both directions it can meet (legacy to v2, v2 untouched,
    idempotent), on the read path and on PUT;
  - each live function's Python twin matches the TypeScript on shared fixtures;
  - the API table's request, its SSRF refusal, masking, and the agent running it;
  - `/api/pane-types` filtered by group.
- **Browser:**
  - every existing suite passes unchanged (Base64, Diff and JWT included);
  - a new suite for the API table: pick a connection, fetch, select, export,
    attach;
  - a new suite for a session saved before the port reopening with its inputs;
  - each new suite failing against the old frontend.

**Done when** Base64, Diff and JWT are manifest panes indistinguishable from before;
the API table works from its YAML alone; and the agent's registry is generated.

### 15.10 After PR 1 (outlined; detailed before each is built)

- **PR 2, the rest of 3b.**
  - The remaining output components are extracted from their best current versions:
    - the log list (CloudWatch);
    - the expandable list with fetched detail (IoT);
    - the file browser with navigation (S3);
    - cursor pagination ("Load more").
  - S3, DynamoDB, Cognito, IoT, CloudWatch, OpenSearch and the HTTP client are
    ported, in that order, each with `environment(s)` renamed to `connection(s)`.
  - Visualizations: the data-frame chart spec, ECharts, KPI tiles (D11).
  - MQTT moves its connection server-side (D6).
- **PR 3, 3c (live dashboards):**
  - outputs move to their own store (D21, moved here by D38);
  - view mode;
  - session variables;
  - auto-refresh with coalescing;
  - Home → session.
- **PR 4, 3d:**
  - per-type permissions replace the boolean flags;
  - the catalogue with categories (§4.8, R6);
  - admin-defined connection types, in the credential-type editor, which the
    manifest-only panes can then use.

### 15.11 Open questions for Phase 3 PR 1

- **Live functions now, CEL in the browser with the builder** (D43, recommended).
  The alternative is adopting a JavaScript CEL library in PR 1.
- **The agent may run GET requests on admin-configured HTTP API connections**
  (D44, recommended). The alternative is keeping every HTTP request behind the
  approval step until Phase 4.

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
