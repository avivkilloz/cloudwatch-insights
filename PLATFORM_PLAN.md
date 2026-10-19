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
§15 (D37–D44, agreed 2026-10-08); its PR 1 is built. The rest of 3b is detailed in §16
(D45–D50, agreed 2026-10-11). Phase 3 is done (2026-10-16); the direction after it
-- the pane contract, workflows and sessions, the builder, and the store repo -- is
§20 (D68–D79, D81, agreed 2026-10-16), and Phase 4a is detailed in §21 (D80)._

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
the database and written through to the store repo in a plugin repo's format
(D70, §20.4); who may use it, and what the agent does in it, are D71 and D72
(§20.3):

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
  existing columns migrated in. _Built in 3d-1 (§19.1, D65): rows per pane type._
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
    plugin's permissions. _For builder steps, superseded by D71 (§20.3): a builder
    chooses their own, pinned and hashed, from a mirror if an admin sets one._
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
  - **3b, the generic renderer and components** (done 2026-10-14, five PRs, §16;
    every pane is drawn from its manifest):
    - Input cards and dynamic options.
    - The output components and output actions (§4.3), extracted from today's panes,
      plus the visualizations (data frames, the chart spec, ECharts, KPI tiles).
    - Panes ported in the order of §4.4, each passing its own browser suite
      unchanged. MQTT moves its connection server-side.
  - **3c, sessions as live dashboards:** view mode, session variables,
    auto-refresh with coalescing, and Home → session (R2–R4, §4.6). R1 holds
    throughout, and each step's browser suites check it. Three PRs (D56, §18):
    3c-1 (results in their own store, auto-refresh) built 2026-10-15; 3c-2
    (view mode and variables) 2026-10-15; 3c-3 (Home) 2026-10-16.
  - **3d, permissions, categories and a first new pane** (three PRs, D64,
    §19; built 2026-10-16):
    - Per-type permissions replace the boolean flags.
    - The catalogue with categories (§4.8, R6).
    - One new non-AWS pane built only from a manifest (e.g. a generic HTTP/JSON API
      pane), to prove the model on something that isn't a port.
- [ ] **Phase 4: the store repo, then workflows** (re-planned 2026-10-16, D74, §20.5).
  - **4a, the store repo** (D70, D78, D80; detailed in §21; built 2026-10-16): what's built here
    kept as a plugin, written through to git, restored on start; run on open
    (D77) rides with it.
  - **4b, workflows** (§5, D69, D75, §20.2, §20.7; detailed in §22, D82–D86,
    three PRs; 4b-1 built 2026-10-17): the blob store (§8.2),
    definitions in the store, recorded runs on the in-process runner, the
    Workflows page, a workflow's page and the live run page, rerun from a stage,
    the agent starting and reading runs, the approval step shared with the
    agent, and the doors between runs and sessions.
  - **4c, published templates** (D76, §20.8; detailed in §23, D99–D102; built 2026-10-19).
- [ ] **Phase 5: The builder** (three PRs, §24, D103–D108; 5-1, pane types as YAML, and 5-2's agent build tools, built 2026-10-19). A per-group grant (D71); declarative HTTP steps,
  composed steps, and the pane builder with live preview; the form and YAML
  editors (D73); the agent's build tools (D72).
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

None open as of 2026-10-08 (§15.11's two became D43 and D44). New ones go here.

2026-10-16: §20.6 (the store's release version; who a scheduled run acts as became D81).

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
| D43 | 2026-10-08 | **Live panes use built-in live functions for now** (TypeScript in the browser, a Python twin for the agent and workflows); CEL in the browser arrives with the builder (Phase 5). | Nothing user-authored needs evaluating before the builder, and choosing a JavaScript CEL library now would be choosing before knowing what the builder needs. |
| D44 | 2026-10-08 | **The agent may run GET requests on admin-configured HTTP API connections** (the API table pane), with the group's own identity; arbitrary requests (the HTTP client) stay behind the approval step. | It reads from a system an admin configured, as the AWS panes do; it doesn't send anything anywhere the user chose. |
| D45 | 2026-10-11 | **The rest of 3b ships as five PRs** (§16.1): pickers, lists and Load more (DynamoDB, Cognito, S3); detail and requests (IoT, HTTP client); logs; charts; MQTT on the server. Phase 3 is eight PRs, amending D41's count. | Each is a sitting's worth of testing, and each adds something new to try. |
| D46 | 2026-10-11 | **Saved inputs are one store for every pane type, separate from templates**; the five per-pane stores migrate into it as each pane is ported (§16.3.4). | Filling the pane you're in is not starting a session; every pane gains it at once. |
| D47 | 2026-10-11 | **Picker options live in the tab's memory, not the session** (§16.2). | Less synced state; the agent stops writing option lists; the chosen value shows while the list reloads. |
| D48 | 2026-10-11 | **How a pane looks is session state, synced like its inputs**: `view.` keys (expanded rows, group-by, sort, the diff's view) go to the server and every viewer, for every pane, including IoT and the logs, which keep them in memory today. | Arranging what is on screen is exactly what the agent will do to show users something, and what one member does to show another; per-browser view state would hide it. |
| D49 | 2026-10-11 | **Old per-pane routes are kept for one release after their pane is ported**, then removed (§16.3.8). | A tab that hasn't reloaded yet keeps working; PR 1's stale-tab reload covers the rest. |
| D50 | 2026-10-11 | **Settings → "Saved" becomes "Library"** (Templates and Saved inputs; the user asked for "Storage or similar", "Library" was proposed back for the reason given, and changing it is one word), and **Users and User groups become one tab** with a Users / Groups switch, as Credentials / Types (§16.3.4, §16.3.9). | "Library" says reusable things you start from or load; "Storage" is kept for files and blobs (D7), which will need a section of their own. One tab for people and their groups, as for credentials and their types. |
| D51 | 2026-10-12 | **A long-running action (a CloudWatch query) is polled by the server, and only while someone is looking** (§16.9). The server keeps the run in a `pane_runs` row and writes each poll's results into the session through the same versioned, announced path as the agent. It polls as whoever started the run, and only while the session is open in at least one connected browser (any participant's, with the session open in their workspace) or an agent turn is waiting on it. Unwatched, it pauses; still unwatched after 10 minutes, it stops the queries in AWS. A run whose replica died is picked up by another. | The user chose server polling so a shared session sees one stream, and asked that it not run all the time. Browser polling would have had every open tab poll, each as its own user, so a member without that environment's access would write errors into the shared results. |
| D52 | 2026-10-14 | **The log-volume histogram counts every match: always for OpenSearch, on request for CloudWatch** (§16.11). OpenSearch adds a date-histogram aggregation to the same search. CloudWatch runs a second, counting query only while the pane's Histogram toggle is on (off by default). | The user's choice. Counting from the returned rows would cover only the newest 100 and couldn't show when a spike began. OpenSearch's count is free, but CloudWatch bills per GB scanned, and a second query scans the log groups again. |
| D53 | 2026-10-14 | **A chart on table-like results is picked in the pane, not fixed by its manifest** (§16.11). Type, x, y, series and aggregate are chosen from the result's own columns, and stored as a view key (D48). So it syncs to every member, templates keep it, and the agent sets it with `set_pane_view`. | The user's choice. The API table's columns aren't known until it runs, so a manifest-fixed chart couldn't chart it. The builder (Phase 4) will add manifest-defined charts on top. |
| D54 | 2026-10-14 | **An MQTT connection is a background run, held by the server** (§16.13). It follows D51's rule: open while someone is looking, closed 2 minutes after the last viewer leaves, at most 5 open per user. The pane's topics are an input, and changing them while connected reconnects as whoever changed them, keeping the messages. Publishing is a person's action (`effects: external`); the agent can connect and read, but not publish. | D6 moved the connection to the server, and D51 already answered "only while someone is looking" the way the user wanted. A stream is just a run whose poll is the connection's buffer. The 2 minutes are the plan's (§4.4) "closes a couple of minutes after the last viewer leaves". |
| D55 | 2026-10-15 | **Every answer of the agent's is checked against what its turn ran** (§17). One more model call reads the request, the turn's tool calls and what they returned, the sessions it touched as they are after the answer, and the answer, and says ok, not done, or unsupported. A failed answer is taken back and redone once; a second miss stands with what was found under it. Alongside, replayable scenarios run against the real model on demand. | The user's choice, over a check only on turns that changed something, scenarios only, or a second supervising agent. The prompt already forbade claiming what no tool showed, and the agent claimed an MQTT connection three turns running anyway. The root cause was facts the agent couldn't read (§17.1); the check is for the next kind of miss, and costs one call per answer. |
| D56 | 2026-10-15 | **3c ships as three PRs: auto-refresh first** (with results moving to their own store, D21), then view mode and session variables, then Home → a session (§18). | The user's choice. The store is what makes a refresh cheap: without it, every refresh resends the whole session to every tab. |
| D57 | 2026-10-15 | **A pane's settings are a ⋮ in its header** (or its tab, in the tabs layout): auto-refresh and saved inputs now, and later the dashboard's "hide inputs" (§18.6). | The user's request: a select and a menu beside the first card's title were cluttered and inconsistent. One place has room for what the settings grow into. |
| D58 | 2026-10-15 | **A results card has Clear, which empties the outputs its manifest names (`clear:`) for everyone** (§18.6). | The user's request. The manifest names what to clear, because not everything a pane stores is a result: DynamoDB's table info and MQTT's "Connected to…" stay. |
| D59 | 2026-10-15 | **A session turn is stored when it's asked**, and every running turn says what it's doing and for how long (§18.6). | The user's request for feedback while the agent works. Only the asking browser streams the steps, so the members of a shared session saw nothing until the answer. The stored copy is only the question; past 10 minutes it is taken as abandoned. |
| D60 | 2026-10-15 | **Session variables bind automatically, by input type** (§18.7). An Environment variable sets every AWS connection input, a Time range every layout time range, unless the pane is unlinked. The value is copied into the pane's inputs, and the tab that changed it re-runs the panes that had run. | The user's choice, over linking each input by hand: least setup, like Grafana, and a new pane follows too. Copying keeps inputs the one truth, so refresh, the agent and templates need nothing new. |
| D61 | 2026-10-15 | **View mode hides a pane's inputs and actions and keeps its outputs**: a session setting, a per-pane override in its ⚙, and always on for a viewer member (§18.7). | R2's two levels. A viewer can't change inputs anyway, so showing them was only clutter. |
| D62 | 2026-10-15 | **A viewer's tab refreshes a dashboard as the viewer, when they can reach every connection the pane uses** (§18.7). Otherwise nothing runs, and nothing is recorded as a failure. | The user's choice, over editors only or the owner's access lent to viewers. Everyone still acts as themselves, and a dashboard watched only by viewers still refreshes. |
| D63 | 2026-10-16 | **Home → a session is per user, set from the session's ⋮, and the brand is the way there** (§18.9). "Start new session…" keeps the catalogue; a session that's gone leaves the default page with a note, and the setting is cleared when the note is dismissed. The session variables move into the session card (the user's report). | R3. The brand is what every app treats as "home"; the catalogue is what you start things from, so it stays one click away whatever home is. |
| D64 | 2026-10-16 | **3d ships as three PRs: per-type permissions first** (3d-1), then the catalogue with categories (3d-2), then admin-defined connection types with a Prometheus pane built from a manifest alone (3d-3) (§19). | The user's choice. Access first: the catalogue is display-only once access stops riding on "Tools", and a new pane type needs grants before anyone but an admin can try it. |
| D65 | 2026-10-16 | **A group's access to panes is one row per pane type** (`group_pane_grants`), checked by one function for the browser, the agent and every handler. The old booleans stay in the API as shorthand -- read from the grants, written as grants -- and are migrated once, so nobody gains or loses anything. A pane type no group has been granted is an admin's alone until one is. | §8's "rows (group × pane type)". The shorthand keeps scripts and the agent's tests working; a new pane type arriving with access for everyone would be a grant nobody made (D15's rule). |
| D66 | 2026-10-16 | **The catalogue's categories are data, matched to a pane's suggestion by a fixed key; an admin's placement pins the pane; favourites and hiding are each person's** (§19.2). Renaming a category changes its name, never its key; deleting one moves its panes to another; arranging the catalogue places every pane in it. | §4.8 and R6. A key apart from the name is what lets an admin rename "Tools" without a restart bringing "Tools" back for the panes that suggest it. |
| D67 | 2026-10-16 | **A connection type beyond AWS is an HTTP API of a kind: a base URL, the fields an admin (or the manifest that needs it) adds, and any credential type that says how to sign a request.** Admins define them in Settings → Environments → Types; a manifest can ship the type its pane needs, seeded once and an admin's to edit. A declarative request can name a fixed path, query parameters from inputs or the pane's time window, and rows to read out of nested replies -- enough for Prometheus from a manifest alone (§19.3). | 3d's proof: a pane on a system the platform has no code for. HTTP covers most of what plugins will reach; a type that needs a protocol of its own (SQL, gRPC) waits for plugins with code (Phase 7). |
| D68 | 2026-10-16 | **The pane contract -- inputs, actions, outputs, views -- is what "a pane can be anything" means** (§20.1). Media and documents are panes like any other; an embedded page is allowed but opaque, sandboxed and marked as one the agent can't see; every pane says in text what it holds. | The user's direction: any kind of content in a shared session. Whatever speaks the contract is shared, agent-driven, templated and refreshed for nothing; an iframe as the usual way in would make the platform a tab manager. |
| D69 | 2026-10-16 | **Workflows stay pipelines with stages on their own page (§5), sharing Actions and renderers with panes** (§20.2). A step is a pane's Action; a stage's outputs are drawn as a pane's; a run can be rerun from a stage, opened into a session, a session made into a workflow, and a workflow put in a session as one pane. | The user's model (Jenkins, n8n, Argo). Drawing a workflow as a session's panes was the wrong picture; the doors between them are the part worth having. |
| D70 | 2026-10-16 | **What is built here is kept as a plugin: the platform writes it through to a store repo in exactly a plugin repo's format** (§20.4), configured in Helm or Settings, restored on start, never blocked by git. Only what a plugin can ship goes there -- never credential values, connections, users, grants, sessions or runs. | The user's call: definitions must survive the deployment going down. One format makes export a copy and lets another deployment install the store; deployment state stays in Postgres, which keeps its own backups. |
| D71 | 2026-10-16 | **The Builder is a per-group grant, and a builder may write anything, code and dependencies included** (§20.3). Code runs in the isolated runner as the person running it, is handed no raw secret where the egress proxy can sign for it, and reaches other groups only through an admin's grant (D65). | The user's call over limiting code to admins. Safety from where code runs and whose access it uses, not from who wrote it; the grant that exists is the review point. |
| D72 | 2026-10-16 | **The agent builds through the same definitions as the Builder's form and the YAML**, with generic tools: the schema and examples, validate, preview on a real connection as the user, save with the user confirming (§20.3). | It matters to the user that the agent helps build panes and workflows; one artifact with several editors is what kept the browser and the agent in step for actions. |
| D73 | 2026-10-16 | **Editors: a form and the YAML first, a drag-and-drop graph later, all over one definition; where a node sits is kept apart from what the workflow means** (§20.2). | The user's choice. Kept apart, a moved box is never a change to the workflow in the store repo's history. |
| D74 | 2026-10-16 | **Phase 4 splits: 4a the store repo, 4b workflows; then the builder (5), the runner and code (6), plugins (7)** (§20.5). | The store decides how definitions are kept from the first one; it's testable on its own with today's admin-defined types. |
| D75 | 2026-10-16 | **Workflows have a global page (list, Workflows \| Runs), a page each (Build with parameters, history, definition, triggers, access), and a run page that is live and shared like a session but holds no panes, with its own "This run" chat** (§20.7). Who sees a workflow is a grant per group; a run acts as whoever started it. | The user's question of where workflows live. A run is watched together like a session; it is investigated in one through "Investigate in a session". |
| D76 | 2026-10-16 | **A saved template stays its owner's; Publish makes it plugin content in the store and the catalogue, portable by binding its connection inputs to the Environment variable and dropping credential ids** (§20.8). | The user's idea: plugins that ship ready dashboards. Connection ids mean nothing in another deployment; session variables (D60) are what make a dashboard travel. |
| D77 | 2026-10-16 | **Refresh gains "on open": a pane runs once when someone opens or switches to the session, only if its outputs are older than a freshness window**, decided by the server under the same lock and rules as interval refresh (§20.8, §21.8). | The user's request for dashboards. The window is what keeps tab switches and members arriving together from each running it again. |
| D78 | 2026-10-16 | **Plugin content is `<namespace>:<name>`; built-ins and existing ids stay bare; a plugin's namespace is its id, the store's is configured** (§20.9). | Two plugins (or a plugin and the store) can both ship a "prometheus". `:` because `.` splits a pane id from its keys and pane types are URL segments. |
| D79 | 2026-10-16 | **The first audience is the user's own teams in one company: teams are groups, and nothing per person (sign-up, personal connections or types) is built for now** (§20.10). | The user's answer. Group policies already fit; a team admin role is the next need, later. |
| D80 | 2026-10-16 | **4a writes through an outbox in the change's own transaction, by one writer at a time (an advisory lock) in a private shallow clone, with the `git` CLI; items stay in their own tables and are tracked by the blob last written or read, which is what conflicts are judged by** (§21). | A save can't come apart from its pending commit, two replicas can't race a push, and any git host works over HTTPS or SSH. Tracking by blob needs no history, so a shallow clone serves. |
| D81 | 2026-10-16 | **A workflow run nobody started -- a schedule or a webhook -- acts as the workflow's owner**, named on the trigger and on each run it starts (§20.7). | The user's choice, over a service identity per group: no identity that is nobody's, and "access is per group" holds -- the owner's group is the one used. |
| D82 | 2026-10-17 | **4b ships as three PRs: define and run (4b-1), the harder steps -- background runs, approvals, retries, the blob store (4b-2) -- and the doors to sessions (4b-3)** (§22.1). | Each is something to try. Running what panes already do is most of the value; approvals and background runs need machinery of their own. |
| D83 | 2026-10-17 | **A workflow is YAML kept verbatim; its steps are pane actions with CEL templates, checked in full on save** (§22.2). | One action vocabulary for panes, the agent and workflows. A broken reference found on save beats a run failing half-way. |
| D84 | 2026-10-17 | **Admins define workflows (until the Builder grant); groups are granted to run them; a run acts as its starter, and its inputs and outputs are seen only by the starter's group and admins** (§22.3). | Outputs come from the starter's environments; another group granted the workflow may not reach them. |
| D85 | 2026-10-17 | **Runs are run in-process by any replica, claimed with SKIP LOCKED, recorded step by step; an interrupted run is marked failed, not resumed** (§22.4). | The isolated runner is Phase 6. Resuming half a run safely needs idempotent steps; rerunning is one click. |
| D86 | 2026-10-17 | **4b-1's run page shows outputs as a table or JSON, and is addressed as `?run=<id>`** (§22.5). | The pane renderers need a pane; they come with Investigate in a session (4b-3). A link is what makes a run shareable. |
| D87 | 2026-10-17 | **A step over a background run waits for it on the runner's own thread**: started and polled as the starter until done; a stream (a poll with `agent_wait`, MQTT) listens for `listen` seconds and is then stopped; cancel and timeout stop it with the action's own stop (§22.8). | A run has no session and nobody watching, so the pane's background machinery (presence, `pane_runs`) has nothing to hold on to; the action's own start, poll and stop handlers are the whole of it. |
| D88 | 2026-10-17 | **Approvals are one general record (`approvals`); a step waits on one when it says `approval:` or when its action is `effects: external` (always)**; the run then holds no thread (`waiting`) and a decision resumes or fails it. Who decides: whoever may read the run (default), `others` (not the starter) or `admins`; unanswered by its `timeout` (24 h) it expires. The agent's external actions use the same record next, with their card in the chat (§22.8). | An external effect is a person's decision, in a workflow as from the agent. A thread parked for a day would be lost on any restart; a record isn't. |
| D89 | 2026-10-17 | **`retry` retries the call only, never its expressions or a refusal (401/403/404); `timeout` bounds each attempt** -- a call past it is abandoned and its result dropped, since a running call can't be interrupted (§22.8). | Retrying what can only fail the same way again is noise; a refusal is an answer. |
| D90 | 2026-10-17 | **Rerun from a stage is a new run of the old run's definition and parameters, the steps before it copied as they were** -- only for someone who may read the old run; resuming after an approval is the same mechanism: a run carries on from its records (§22.8). | The stages before were run against that definition; rerunning them against a newer one would mix two workflows in one run. |
| D91 | 2026-10-17 | **The blob store (§8.2, D7) is `blobs.py`, filesystem or S3, chosen in Helm's `storage:`; Postgres keeps the metadata and every download is checked against it**. A step's outputs over 1 MiB keep their cut-down copy in the row and the whole (to 64 MiB) as a blob, which later steps and a resumed run read whole (§22.8). | Large outputs were cut for every reader, later steps included. |
| D92 | 2026-10-17 | **Artifacts are a step kind (`artifact:` a name, a value, json/csv/text) written to the blob store and downloaded from the run page; run blobs are kept 90 days by default** (§22.8). | A file is what a run hands on: an export, a report. |
| D94 | 2026-10-19 | **A workflow parameter's choices load the way a pane picker's do: `options_from` names a pane input with a loader and gives its inputs from the other parameters; the form lists them as the person filling it in, and still takes typed text. `multiple` makes a text parameter a list** (§22.9). | The user's ask (pick log groups once an environment is chosen). Borrowing the pane input's loader keeps one way of listing things; a builder's own parameters (Phase 5) will use the same seam. |
| D95 | 2026-10-19 | **Investigate a run opens a new session of the asker's: a pane per stage that ran a pane action (a `for_each` stage's first ten items each), with the inputs it ran with and its outputs as the pane's own, drawn by the pane renderers; notes and files go in its description** (§22.10). | A stage's outputs were a table or JSON on the run page; in a session people and the agent can sort, chart, expand rows and run again. |
| D96 | 2026-10-19 | **Make repeatable drafts a workflow from a session -- a step per pane with a server action, its set inputs as `with`, each connection-valued input a parameter defaulting to what it holds -- and opens it in the editor, unsaved** (§22.10). | A draft to finish by hand, not a workflow made behind the person's back; editing stays an admin's (D84). |
| D97 | 2026-10-19 | **The workflow pane is a manifest like any other** (group Platform, no flag: granted per group): a workflow picker, parameters as name/value rows, Run as a background run polled into its summary and stages, Stop cancelling the run (§22.10). | No hand-drawn pane: it proves the seam a plugin uses. Parameters typed as text take a connection by name. |
| D98 | 2026-10-19 | **"This run" is a run's own chat**: stored on the run, shared by its readers, its turns reading the run first (`get_workflow_run`); the agent panel's second tab is "This run" on a run page (§22.10). | The question about a run is asked looking at it; it's the run's, as a session's chat is the session's. |
| D99 | 2026-10-19 | **A published template is its own row (`published_templates`, a namespaced id), made portable when it's published, never a person's saved template shared** (§23). Publishing is an admin's, from Library; the saved template stays its owner's. | Plugin content needs a string id the store can name a file by, and must not change when its author edits their own copy. Editing is an admin's until the Builder grant, as a workflow's is (D84). |
| D100 | 2026-10-19 | **Portable is decided per input by its manifest type**: AWS connection inputs follow the Environment variable (unlinked ones relinked); log groups kept under `$environment`, given to the environment chosen on opening; other connections, credentials, OpenSearch indices and a workflow's connection parameters left out; a header whose name says secret keeps its name, not its value. Every change is said, in words, to whoever publishes. | Nothing service-specific: a plugin's pane is made portable by the same rules. A template goes to a git repo, so a pasted token mustn't; and the publisher should know what the opener will have to fill in. |
| D101 | 2026-10-19 | **Opening a published template is the server's**: the environment chosen first (asked on its card on the default page; with one environment, nothing to ask), the variable set, each pane's bound inputs copied in, the log groups re-keyed, the session made through `live_store.create`. Offered on the default page ("Ready-made sessions") and under Templates in Add and the strip's ＋. | The re-keying (connection ids as map keys) is the server's to know; the browser opens what was made, as it does an investigated run. |
| D102 | 2026-10-19 | **Who is offered one is who may use each of its panes** (`pane_access.granted`); no grant of its own. The agent sees them in `get_context` and opens one with `open_template`. | Access is per group, per pane type (D65); a template is panes, so it needs nothing more. |
| D103 | 2026-10-19 | **A built pane type is a manifest, nothing else**: the same YAML and strict model as a bundled one, kept verbatim (`built_pane_types`, the store's `panes/<name>.yaml`) and merged into the registry beside the files (§24). Always `state: v2`, `rendered: true`; no `flag`, no `connection_types` of its own; its actions are requests, handlers the platform has, or live functions it has. | One definition the renderer, the action endpoint, the agent and the store already understand: nothing new to keep in step, and nothing of the builder's own code runs until Phase 6. |
| D104 | 2026-10-19 | **Phase 5 is three PRs**: 5-1 the Builder grant and pane types as YAML (check, create, store, catalogue, open in a session); 5-2 the form editor and a live preview over the same definition, and the agent's build tools (D72); 5-3 steps and workflows for builders (editing no longer an admin's alone, D84). | Something to try in each, as 4b was split. |
| D105 | 2026-10-19 | **A pane type's builder's group is granted it on creation**; any other group when an admin grants it (D65). An edit is everyone's at once; Delete takes its grants and placements with it. | D71 "a builder uses their own work at once" -- by group, since access is never per user. |
| D107 | 2026-10-19 | **The agent builds beside the editor, and only proposes** (§24): the panel's second tab is Building while an editor is open; `propose_definition` puts a checked draft in the editor, replacing its text, and the user saves. No save tool. | The user asked for the agent in the side panel while editing. Replacing the editor's text with a whole checked definition is the simplest exchange a person can review; a save the agent makes is one nobody looked at. |
| D108 | 2026-10-19 | **What the agent needs to build is read, not written down**: the turn reads `build_reference` (generated from the strict models and the registries) and the editor's text before the model speaks; examples are the bundled and saved definitions (`read_definition`); its mistakes come back from the same check as Check's. The backend's MCP is enough -- no separate documentation for the agent, no per-service hints. | Documentation drifts from the models; the models, the examples and the check's errors can't. It also holds for a plugin's panes, which bring their own manifests. |
| D106 | 2026-10-19 | **Replicas follow a save by a generation** (`builder.generation`, a Settings row bumped in the save's transaction), checked every 5 s; the saving replica loads at once. | No new broadcast to build; a few seconds' lag on another replica is fine for a definition. |
| D93 | 2026-10-17 | **The platform's own pages (Workflows; later Dashboards, Chat) sit at the top of the rail, above Sessions; the Workflows row shows how many approvals wait for you** (§22.8). | The user's call: a page of the platform isn't something found under Add. |

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
are outlined in §15.10 and get their own detail just before they are built. PR 1 is
built; where it departed from this draft is in §15.12._

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
  - key: urlSafe              # names don't change: the agent and its scripts use them
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
  - Its keys move under `in.` (`urlSafe` → `in.urlSafe`); input names stay, since the
    agent and its scripts use them.
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

- **PR 2, the rest of 3b** (detailed in §16, which proposes splitting it into five).
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

Both settled 2026-10-08 as D43 (live functions now, CEL in the browser with the
builder) and D44 (the agent may run the API table).

### 15.12 PR 1 as built

Where the build departed from §15.1–15.9, and why:

- **The migration has no marker.** §15.4's `__paneStates` map is gone:
  - the migration is idempotent on its own: a legacy key present moves under `in.`
    (or `out.`), and a new key already there wins, since it is what the pane has
    been showing;
  - a tab left open across the deploy keeps writing old keys, so there is no
    "done" worth recording.

  It runs in these places:
  - on the server: `panes/state.migrate` on every PUT, on every read-out
    (`_out`), in `live_store.mutate`/`create`, and in the viewer's chat-only check;
  - in the browser: `panes/manifest.migratePaneKeys`, the third step of
    `migrateSessionList` (the IndexedDB copy, and server rows), and in
    `templateState` (a template is never rewritten, so it migrates on every open).
- **The stale-tab check is `version.json`, not an `X-App-Build` header.**
  - Why: the backend and frontend are separate images, so the backend can't know
    which frontend build is deployed.
  - How it works:
    - the build writes its id beside `index.html` and compiles the same id in;
    - nginx serves the file `no-store`;
    - the tab checks it on focus, on becoming visible, and every five minutes.
  - When the ids differ:
    - a one-line notice appears;
    - the tab reloads at the next switch of page or session, or on "Reload now";
    - before reloading it waits for `flushAll()` (every session saved locally and
      to the server). Without that wait, the debounced save was cut off and the
      server's older copy won on the way back.
  - The dev server answers with its own id.
- **Layout is part of the manifest.** §15.5 planned a fixed "card of rows". As built,
  a manifest has a `layout`: cards with a title, an optional `aside` beside it, and
  items.
  - Items can be: `input`, `output`, `action`, `text`, `copy`, `row`, `toolbar`.
  - Visibility: `when: {input, equals}` or `{output, present}`.
  - Text: a title, label or placeholder may depend on an input
    (`{by: mode, values: …}`).
  - Why: it was the only way to port the three tools without changing how they
    look.
  - Checked: all twelve states of the three tools (empty, typed, errors, each diff
    view, JWT both ways) were pixel-compared against the old components. They are
    identical except JWT's sample `iat`, which is the time the pane is drawn.
- **Input and output vocabulary as built:**
  - **Input types:** `text` (one line, or `rows` high), `int`, `choice` (a select,
    or `buttons`, with `choice_labels`), `bool`, `connection`, `headers`. Any input
    may set `width` (a one-line box's pixels).
  - **Output renders:** `text`, `code`, `json`, `diff`, `table`, plus `badge`
    (JWT's verdict) and `error`.
  - **Dropped for now:** `options: {action, depends_on}`, since no pane needs a
    dynamic choice yet.
- **The table** has:
  - select one or all, hide the selected;
  - copy (the checked rows, or all, as JSON);
  - export (CSV/XLSX/JSON);
  - attach (the agent's Session tab offers checked rows by the pane's name).

  Changes from the plan:
  - Cells are one line, with the full value as a tooltip. A row isn't expanded in
    place; the agent reads one in full with `inspect_row`.
  - "Rows at" is an input (`rowsAt`), named in the request as `rows_at`, rather
    than a path on the output.
- **Catalogue registration.**
  - `paneTypes.tsx` keeps only the panes still drawn by their own components.
  - `registerManifestPanes` adds a rendered manifest's pane at startup, in manifest
    `order`.
  - `PaneTypesGate` (App.tsx) holds the app until `/api/pane-types` answers, so no
    session mounts before its ported panes can be drawn or migrated.
  - A manifest's `description` and `help` are the catalogue's exact text.
  - **Saved items:** §15.8's generic store isn't built. None of the three ported
    tools had saved items, so it waits for PR 2's AWS panes.
- **The agent:**
  - Base64 and Diff run through their Python twins. A list output is cut to 100
    items in what the model reads (`LIVE_SUMMARY_ITEMS`).
  - JWT has no run at all: every input is sensitive, so there is nothing the agent
    could set, and `run_pane` returns its `agent.run` text.
  - `get_context` lists `http_apis` (id, name, base URL) for the API table's
    connection input.
  - The `headers` type is described as "object: name -> value", since a query uses
    it too.
- **Twins and fixtures:**
  - `backend/tests/fixtures/live_functions.json` holds 25 cases. They were computed
    by the old tools' own code (and the `diff` library) before the port.
  - Both sides must match them: pytest checks the Python twins, and `smoke63`
    bundles `panes/live.ts` with esbuild and checks it.
  - The Diff twin compares lines with their newlines, as `diffLines` does.
  - The fixture's empty-secret case was dropped: WebCrypto refuses a zero-length
    HMAC key, so the old tool errored on it too.
- **`describe()` before and after** was compared once, not kept as a test, because
  the hand-written registry no longer exists to compare against. The output was
  identical except for two intended changes: the new API table, and Diff now
  runnable.
- **Browser suites:**
  - `smoke62`: the API table. Its reply is stood in for with `page.route`, because
    the sandbox has no DNS; pytest covers the real request path.
  - `smoke63`: the ported tools, a pre-port template and an old tab's keys, and the
    TypeScript fixtures.
  - `smoke64`: the stale tab.
  - `smoke20` needed one change: its fixed list of add buttons now ends with
    "API table".

## 16. Phase 3b in detail: the AWS panes, the HTTP client and MQTT

_Drafted 2026-10-11 for review, after PR 1 (§15) merged. Built on an inventory of the
seven panes still drawn by hand (state keys, backend calls, cards, agent keys, the
browser-suite selectors each depends on). §4.7 is the requirements list; this is how
to meet it without any pane getting worse._

### 16.1 Splitting 3b so each PR has something to try (D41)

§15.10 put the rest of 3b in one PR: seven pane ports, four new output components,
charts and MQTT on the server. That is too much to try in one sitting, so it splits
by what the panes share. Each PR ports panes **and** adds something visibly new:

| PR | Ports | Builds | New to try |
|---|---|---|---|
| **3b-1** Pickers, lists and Load more | DynamoDB, Cognito, S3 | connection pickers; options from a loader; cascades; a run on a pick; the expandable list; cursor paging; the file browser; row copy; the restored-results note; one store for saved inputs | **Saved inputs for every pane** ("Save as…" / "Load…"), including Cognito, Base64 and the API table, which had none; **Settings → Library**; **Users and groups in one tab** |
| **3b-2** Detail and requests | IoT, HTTP client | a multi-connection picker; per-connection errors; a detail action per row, lazy and in bulk; a mode switching outputs; the request/response viewer; an action only a person may run (`effects: external`) | **Row detail anywhere:** "Include detail" and expand-to-fetch on any pane with a detail action. The agent inspects certificates too. |
| **3b-3** Logs | CloudWatch, OpenSearch | the log list (merged targets, sort, cap, group by); two-level lazy pickers; a time range input; start / poll / **Stop** | **The agent can stop a running query**, and Stop survives a reload. OpenSearch's limit is fixed (§4.7). |
| **3b-4** Charts | none | data frames, the chart spec, ECharts loaded on demand, KPI tiles (D11) | **A chart on the API table**, and a log-volume histogram over the log list |
| **3b-5** MQTT on the server | MQTT | a subscription action, a stream output, publish behind approval (D6) | **The agent can subscribe**, and a shared session sees one stream |

Phase 3 becomes eight PRs: PR 1 (done), these five, then 3c and 3d as before.

The order goes simplest first, as in §4.4. Each PR leaves every pane working, and
the old routes stay for one release (§16.3.8).

### 16.2 What the manifest gains, for all of 3b

What PR 1's manifests can't yet say, and the form each takes. Each is introduced in
the first PR that needs it:

- **Connection inputs drawn generically.**
  - **Single** (`connection`, PR 1's type) gains a per-type label: `{name} ({account_id} · {region})` for AWS,
    `{name} ({base_url})` for HTTP.
  - **Multiple** (`connections`): today's environment checkbox list.
  - Both replace `environment` / `environments` as part of the rename (D40, §16.3.6).
- **Options from a loader:** `options: {action: list_tables, depends_on: [connection]}`.
  - The loader is a server action returning `[{value, label}]`.
  - It runs on demand ("Load tables") or when `depends_on` changes, and is cached in the
    tab. **Options are no longer stored in the session** (§16.6, Q3).
  - The agent gets the same action, so `list_dynamodb_tables` becomes generic.
- **Cascades:** `resets: [tableName, out.items]` on an input clears what depends on it
  when it changes. This is today's hand-written clearing, declared.
- **A run on a change:** `run_on: {change: bucket}` on a server action runs it when that
  input changes (S3's "pick a bucket shows it", DynamoDB's describe on pick).
- **Bookkeeping and view keys are migrated too.** `ranAt` and `resultsVersion` move to
  `out.`, `expanded` to `view.` (the inventory found the migration missed them).
  `view.` keys are session state, synced to every viewer and settable by the agent
  (D48).
- **Runs no longer write their inputs back.**
  - Today S3's run writes `bucket` and `prefix`.
  - In v2 the inputs are the source of truth, and the run returns what it showed
    (`out.shownPrefix`) only where the display needs it.
- **`when` gains `in: [GET, HEAD]`** (the HTTP Body card) and **`not`**.
- **Enter runs** a one-line input's card action (`submit: run`).

### 16.3 PR 3b-1 in detail: DynamoDB, Cognito and S3

#### 16.3.1 One action endpoint, for the browser and the agent

- Today each pane calls its own routes (`/api/tables/scan`, `/api/cognito/users`,
  `/api/buckets/browse`), and the agent runs separate `run_*` functions that write
  legacy keys.
- After the port, both call **`POST /api/panes/{type}/actions/{action}`** (PR 1's
  endpoint). It dispatches to a handler registered by name (`aws.dynamodb.scan`).
  - The handler takes the inputs and a cursor, and returns outputs.
  - The flag, connection and identity checks happen once, in the endpoint, as
    `run_request` does now.
  - The agent's `run_pane` calls the same handler and writes its outputs with
    `output_key`.
  - One code path, so the browser and the agent can't drift (the reason for D5).
- Loaders are actions too: `list_tables`, `list_user_pools`, `list_buckets`. The
  `describe` action fetches DynamoDB's table info.

#### 16.3.2 The list component

The rows of DynamoDB, Cognito and the API table, generalised from today's
`.result-row` lists (the API table's grid stays available as `render: table`):

- **Summary:** a template over the row (`{{ row.username }}`). It can read another
  output (DynamoDB's summary uses the table's keys from `out.tableInfo`).
- **Tags:** a field with tones from a value map, e.g. Cognito's
  `status: {CONFIRMED: ok, UNCONFIRMED: pending}` and `enabled: false → "disabled"
  error`.
- **Expanded:** `json` (DynamoDB) or `fields` (a key/value table with sections:
  Cognito's dates and attributes). Expanded rows are `view.expanded`, synced (D48),
  so the agent or a member can open a row for everyone looking.
- **Toolbar:**
  - select all, hide / show hidden, export, attach (PR 1's);
  - a count line from a template ("{{ n }} item(s) loaded, {{ out.scannedCount }}
    scanned so far");
  - an empty text.
- **Paging:** `page: {cursor: lastEvaluatedKey, append: [items], sum: [scannedCount]}`
  on the action.
  - The output carries the cursor, and the component shows **Load more** while it is
    set.
  - Load more re-runs the action with the cursor and appends.
  - It doesn't bump `resultsVersion`, so the selection survives (as today).
- **The restored-results note** with "Run again", for any pane with a server run.

#### 16.3.3 The file browser (S3)

- **Breadcrumbs from a prefix input:** clicking one sets `prefix` and re-runs (the
  `set_input` effect of §4.3).
- **Folder rows navigate** and can't be selected. **File rows** are a list (size and
  time formats).
- **Row copy is a templated `copy` effect.** "Copy S3 URI" is `s3://{{ in.bucket }}/{{
  row.key }}`, and "Copy object URL" uses an `encode_path` filter. This is the first
  use of §4.3's effects, and it works on any list.
- **Search** is an input that switches the run to recursive, with a "Clear search"
  that resets it.

#### 16.3.4 Saved inputs, one store for every pane

- **"Save as…" and "Load…" on every manifest pane** save the pane's inputs under a
  name, by pane type, in one table (`saved_inputs`).
  - Both are one **Saved ▾** menu at the right of the pane's first card title.
    3b-1 shipped them as a row of their own above the cards, which left an almost
    empty row between two full ones; the user found that odd.
  - Sensitive inputs are never saved.
  - Loading writes the inputs and, for a pane that runs on a pick, runs.
- **The old stores migrate into it** as each pane is ported. In 3b-1 that is
  `saved_sessions` pages `tables` and `buckets`; IoT's searches, saved queries, HTTP
  requests and MQTT topics follow in their PRs.
- Each migration is once-only, keyed by a `Settings` marker, as Phase 2's was.
- **Settings → Library** (D50, formerly "Saved") has two views, as Credentials has:
  *Templates* and *Saved inputs*. Saved inputs are listed in one table with a pane-type
  column and filter, rather than one tab per store; the per-store tabs go as each is
  migrated.
- **How it differs from a template:** a template starts a new session; saved inputs
  fill the pane you're in. Both stay (Q2).

#### 16.3.5 The three panes

- **DynamoDB:**
  - a connection; a table from `list_tables`, which runs `describe` on pick and
    shows its info tags;
  - `queryString` and `limit`, then Scan;
  - the list with JSON expansion and Load more.
- **Cognito:**
  - a connection; a user pool from `list_user_pools`, with the label
    `{{ name ?? id }} ({{ id }})`;
  - `queryString` (Enter runs it), then Search;
  - the list with status tags and a fields expansion, and Load more.
  - The help text drops the group memberships it never fetched (§4.7).
- **S3:**
  - a connection; a bucket from `list_buckets`, which browses on pick;
  - the file browser, search, and Load more.

All three look and behave as today, checked by:
- the same pixel comparison as PR 1;
- smoke13, smoke22 and smoke23, unchanged.

#### 16.3.6 `environment` → `connection` (D40), for these three

- **Inputs:** `environmentId` becomes `in.connection`, through each manifest's
  `legacy_key`.
- **Payloads:** they accept both `environment_id` and `connection_id` for one release.
- **The agent:** it already names connections by id or label. The manifest now says
  "connection".
- **Saved shortcuts:** their `environment_id` becomes `connection` on migration.
- **Untouched:** IoT, logs and MQTT keep `environment(s)` until their PRs.

#### 16.3.7 Tests

- **Backend:**
  - each handler, through the endpoint and through `run_pane`, giving the same
    outputs;
  - loaders;
  - paging (append, sum, the cursor);
  - the saved-inputs store and the once-only migration of `tables` / `buckets`;
  - both payload names accepted;
  - the legacy-key migration including `ranAt` / `resultsVersion` / `expanded`.
  - `test_platform_tools.py`'s pinned keys for these panes move to the v2 shape.
- **Browser:**
  - smoke13, 22 and 23 pass unchanged;
  - a new suite for saved inputs: save, load, and an old saved table / bucket opening
    after migration, on DynamoDB, S3, Cognito and Base64;
  - a new suite for row copy and breadcrumbs;
  - both new suites fail against the old frontend.

#### 16.3.8 Old routes

- `/api/tables/*`, `/api/cognito/*` and `/api/buckets/*` stay for one release, for a
  tab that hasn't reloaded yet (PR 1's stale-tab reload covers the rest).
- They are removed in 3b-2, along with the old pages' components.

#### 16.3.9 Settings: Users and groups in one tab

- **Users** and **User groups** become one tab, **Users**, with a *Users | Groups*
  switch in the Credentials layout (`settingsLayout.tsx`). Each view keeps today's
  screens and behaviour.
- With "Saved" renamed **Library**, Settings goes from nine tabs to eight and stops
  wrapping.
- Suites that open these tabs by name (smoke13, 16, 17, 20, 22, 23, 36, 60, 61)
  change only their navigation steps.

### 16.4 PR 3b-2 in detail: IoT and the HTTP client

_Detailed 2026-10-12, after 3b-1 merged, from an inventory of `IotPage.tsx`, the
two IoT result lists and detail panels, `HttpClientTool.tsx`, and the routes and
agent runners behind them. Nothing here needed a new decision: D45–D50 cover it.
The few choices made along the way are noted where they apply._

#### 16.4.1 Fan-out across connections

- **A `connections` input** (`type: connections`, `connection_type: aws`) is
  today's environment checkbox list, drawn generically. IoT's
  `selectedEnvironmentIds` becomes `in.connections` (D40, `legacy_key`), stored
  as a plain list (the legacy Set still reads).
- **The handler fans out, not the endpoint.** A handler gets the connection ids
  and returns one group per connection, `{id, name, rows…, error}`. It uses a shared
  helper (`panes/handlers.fan_out`) that resolves each connection as the caller,
  runs them in parallel and turns any failure into that group's `error`.
  - A generic endpoint fan-out would have had to rename the stored fields every
    IoT session already holds (`environment_id`, `environment_name`, `things`).
  - Handlers are code anyway, so a plugin calls the helper just as easily.
- **A list draws groups** (`config.groups: {rows, name, error, as}`). It
  flattens each group's rows, stamping the group's name on each row under `as`
  (what export and attach always called `environment`). Groups with an error
  become the **Target errors** box above the rows, as before.
- **The agent** reads the same groups. Its run summary keeps its per-environment
  counts and errors.

#### 16.4.2 A detail action per row

- **An action can be for a row** (`for: row`). Its inputs come from the row, by
  path, as the list declares:
  `detail: {action: thing_detail, args: {connection: group.environment_id, thingName: row.thing_name}}`.
  - Paths only, no templates: the server evaluates the same args for the agent.
  - The browser sends them as the action's inputs. The same endpoint, the same
    `requires`.
- **Expanding a row fetches its detail.** The detail is cached in the tab
  (D47's rule: fetched data that is only a view of AWS isn't session state).
  Which rows are expanded is a view key (D48), so another member's expand fetches
  the detail in their tab too.
- **"Include detail"** (`detail.include`, the checkbox's label) appears once rows
  are checked.
  - It fetches the checked rows' detail five at a time.
  - Export and attach then carry each row merged with its detail's `merge`
    fields, plus `detail_warnings`.
  - Loading and failure counts show as before.
- **Detail sections grow** to draw IoT's panels from data:
  - `table` (columns with tones);
  - `list`, nested and expandable (a thing's certificates, then their
    policies);
  - `json` side by side (`grid`, reported and desired);
  - `tags`;
  - `warnings`.
  - Titles take a count: `Shadows ({{ d.shadows | count }})`.
- **The agent's `inspect_row` uses the list's detail action.**
  - The registered `detail.iot` goes, and certificates gain their detail
    (attached things), which the agent couldn't see before.
  - Rows come from the manifest's lists generically (`rows.iot` goes), from
    whichever list output holds rows.

#### 16.4.3 IoT

- **Mode:** `searchMode` is drawn as the "Search for [Things] [Certificates]"
  buttons.
  - Its `resets` clear the outputs and expanded rows.
  - A choice can set other inputs (`choice_sets`), so a mode resets the query to
    its own default, as `switchMode` did.
- **Outputs:** `thingResults` and `certResults` (both move to `out.`, same shape),
  each in a Results card shown by `when` on the mode.
  - The selection domain is per output (`iot-things`, `iot-certificates`), as
    before.
- **One `search` action** dispatches on the mode server-side. It wraps today's
  two search routes.
  - Its handler raises the mode's own "Enter a search query (e.g. …)" sentence.
  - `thing_detail` and `cert_detail` are row actions.
- **Text by mode:** the help paragraph and the query placeholder use `By`
  (PR 1's text-by-input).
- **Examples:** an input can carry `examples` (by mode). A layout item
  `{examples: queryString}` is the Show/Hide examples toggle, and its list with
  Use buttons. Whether it is open is tab-local UI, not session state.
- **Max results:** a toolbar int, clamped server-side as before.
- **Saved searches move into saved inputs:** `{searchMode, queryString}`, once,
  behind a `Settings` marker. The Library's IoT tab goes.

#### 16.4.4 The HTTP client

- **Inputs:**
  - `targetId` joins the manifest, so the agent can set it: `type: connection`,
    `connection_type: http_api`, optional (**Any URL**). It is drawn only when
    the group has such a connection.
  - `method`, `url`, `headerRows` and `body` are unchanged.
  - `credentialId` uses the existing type.
  - The URL placeholder reads the chosen target's base URL (`sel.targetId` in
    the template scope).
- **New input renderers:** `headers` (the key/value rows with Remove and Add
  header) and `credential` (the Auth select, the hints, "A credential you can't
  use").
- **Send** (`effects: external`) is a person's action.
  - `run_pane` refuses it. It already did by its agent text; now the server
    does too.
  - Its handler wraps `/api/tools/http-request`: the SSRF guard, the credential's
    `inject` and the masking are all unchanged.
  - It returns the response and the exchange. The exchange is built server-side,
    with the joined URL, the auth said by name, and nothing secret.
- **The Body card** is shown by `when: {input: method, not_in: [GET, HEAD]}`.
- **Outputs:**
  - The **response viewer** (`render: http_response`): the status badge by
    range, time, truncated, the headers table, and the pretty body. It draws its
    own title row.
  - The **error card** (`when: {error: send}`).
  - The exchange, attached always (`attach: always`, no checkbox), as before.
- **Saved requests move into saved inputs**, once (`saved_sessions` page
  `tools-http`). The Library's HTTP tab goes.

#### 16.4.5 Removed, as D49 said

- The `/api/tables/*`, `/api/cognito/*` and `/api/buckets/*` routes. Their
  functions stay as the handlers' implementation.
- The agent's `list_dynamodb_tables`, `list_s3_buckets` and
  `list_cognito_user_pools`. They become one `list_options(session, pane, input)`
  that runs the input's loader through `run_handler`, so any picker a manifest
  declares is listable.
- `IotPage.tsx`, the IoT lists and panels, `iotDetails.ts`, `PolicyList.tsx`,
  `HttpClientTool.tsx`, and the IoT and HTTP Library tabs.
- The IoT and HTTP routes stay one release (D49), as 3b-1's did.

#### 16.4.6 Tests

- **Backend:**
  - the fan-out (one connection failing, one not reachable);
  - row actions and their args;
  - `inspect_row` on things and certificates;
  - `list_options`;
  - Send refused to the agent;
  - the HTTP exchange carries no secret;
  - both once-only migrations;
  - the old routes gone.
- **Browser:**
  - smoke suites driving IoT (mode, examples, expand-to-fetch, Include detail,
    target errors, a member's expand) and the HTTP client (headers, target,
    auth, body by method, response, error, attach);
  - each failing against the old frontend;
  - the existing IoT and HTTP suites moved to `mockPaneActions`;
  - pixel comparison with the old pages, card by card.

### 16.5 PRs 3b-3 to 3b-5, outlined

- **3b-3 Logs:**
  - the log list (merged targets, numeric-aware sort, the "most recent N of M" cap,
    group by);
  - `log_groups` and `opensearch_indices` drawn generically, as two-level lazy
    pickers;
  - a `time_range` input type;
  - sort options from the output's fields;
  - async actions: start returns handles kept in `out.`, poll every 2 s, Stop as an
    action. A reload resumes polling instead of losing the run, and the agent can
    Stop.
- **3b-4 Charts:**
  - outputs as data frames;
  - the chart spec of §4.3 (timeseries, bar, pie, stat) drawn by ECharts, loaded
    only when a chart is on screen;
  - chart outputs on the API table and over the log list.
- **3b-5 MQTT:** the subscription action and stream output of §4.4, over the existing
  event stream, with subscriptions closed after the last viewer leaves.

### 16.9 PR 3b-3 in detail: the logs (CloudWatch and OpenSearch)

_Detailed 2026-10-12, after 3b-2 merged, from an inventory of `InsightsPage.tsx`,
`ResultsView.tsx`, the log-group and index pickers, and the routes and agent runners
behind them. One question was asked: who polls a running query. Settled as D51._

#### 16.9.1 Runs the server polls (D51)

- **Presence.** Each browser's event stream (`/api/live-sessions/events`) records its
  tab in `tab_presence` (user, last seen), refreshed with its 20 s heartbeat and
  removed when it closes.
  - A session is **watched** while any participant has a tab seen in the last 50 s
    and the session open in their workspace, or while an agent turn waits on it.
  - The streams are spread over replicas, so this lives in the database.
- **A run** is a `pane_runs` row: the session, the pane, who started it, the handles,
  a status, and the replica holding it with a heartbeat.
  - The session's copy, `out.run` (`{id, status, startedAt, polledAt, by}`), is what
    the pane shows.
  - The results go where the pane draws them from (`out.results`).
- **Starting.** The manifest's async action (`run: {poll, stop}`) is called with the
  session and pane. It starts the queries as the caller, stores the run, and writes
  `out.run` and any target that failed at once.
  - A task on that replica then polls every 2 s while the session is watched. It
    writes only when something changed.
  - Unwatched, it checks every 10 s without calling AWS. After 10 minutes unwatched
    it stops the queries and ends as "stopped (no one had the session open)".
- **Stop** is an action anyone who can edit the session may run: the person, another
  member, or the agent (`stop_pane`).
  - It stops the queries and marks the run stopped.
  - The polling task, on whichever replica, sees that on its next tick and ends.
- **Replicas.** Every replica sweeps every 10 s for running runs whose heartbeat is
  older than 30 s, and claims one with a conditional update. A redeploy mid-query
  carries on.
- **Writes don't reopen a closed session** (`live_store.mutate(..., reopen=False)`):
  results arriving for a session someone closed must not put it back in their rail.
- **The agent** starts a run the same way, counts as watching while it waits (up to
  90 s), and answers from what has arrived.
  - A query still running is left running, and its results keep arriving in the
    pane. It used to be stopped at 90 s.
- **A viewer** can't start or stop a run: both write the shared session.

#### 16.9.2 The log list

- **A `logs` render.** Today's `ResultsView`, drawn from the output's groups (one per
  target, rows as `{field, value}` lists). It keeps:
  - the merged "most recent N of M" cap (`limit` from an input);
  - the numeric-aware sort;
  - group by environment or log group;
  - the timestamp, environment and log-group tags;
  - Target errors;
  - select, hide, export and attach.
- **Sort field, direction and group by are view keys** (D48). They stay where they
  are on screen: the sort in the Query card's toolbar, group by in the results
  toolbar. The sort field's choices come from the output's fields.
- **Expanded rows** become a view key too (D48).

#### 16.9.3 Pickers and the time range

- **Two-level pickers drawn generically:**
  - `log_groups`: per environment, after "Load log groups", with a filter and select
    all;
  - `opensearch_indices`: per environment its domains, per domain "Load indices",
    with doc counts.
- Their loaders are actions (`list_log_groups`, `list_domains`, `list_indices`), and
  their options live in the tab (D47). `list_options` runs them for the agent; its
  own `list_log_groups` and `list_opensearch_*` tools stay one release beside it, as
  the logs routes do (§16.10).
- **A `time_range` layout item** draws `preset`, `customStart` and `customEnd` as
  today's control. The three inputs keep their names, so the agent's and templates'
  keys are unchanged.

#### 16.9.4 The two panes

- **CloudWatch:**
  - `selectedEnvironmentIds` becomes `in.connections` (D40, alias kept for the
    agent);
  - `logGroupSelection`, `queryString`, `limit` and the time inputs move under
    `in.`;
  - `results` moves to `out.results`;
  - Run is the async action, with Stop beside it.
- **OpenSearch:** the same layout. Its search stays one request; the async machinery
  is CloudWatch's alone.
  - `osResults` moves to `out.results`.
  - **The limit is capped at 1000**, the backend's own maximum (§4.7).
- **Saved queries move into saved inputs** (`{queryString}` by pane type, once). The
  Library's Log Queries tab goes.
- **Removed:** `InsightsPage.tsx`, `ResultsView.tsx`, both pickers,
  `EnvironmentSelector.tsx`, and `rows.results` / `rows.osResults`. IoT's and the
  HTTP client's old routes go (D49). The logs routes stay one release.

#### 16.9.5 Tests

- **Backend:**
  - presence and watched;
  - a run polled while watched and paused while not;
  - stopped after 10 minutes unwatched;
  - claimed after its replica's heartbeat lapses;
  - Stop from another member and from the agent;
  - a viewer refused;
  - no reopening;
  - the agent leaving a long query running;
  - both migrations.
- **Browser:**
  - Run, results streaming in;
  - Stop;
  - a reload mid-run carrying on;
  - a second tab seeing the same stream;
  - sort, group by and the cap;
  - both pickers, and the time range;
  - each failing against the old frontend;
  - pixel comparison, card by card.

### 16.6 Settled for 3b-1

Asked 2026-10-11, all settled the same day:
- Split into five PRs (D45).
- Saved inputs as one store, separate from templates (D46), in a Settings section
  called **Library** (D50).
- Picker options in the tab's memory (D47).
- **View state stays in the session, synced (D48).** This reverses the draft's
  proposal: how a pane looks is something the agent and other members set to show
  you something.
- Old routes kept for one release (D49).
- Users and User groups become one tab (D50, §16.3.9).

### 16.7 3b-1 as built

Where the build departed from §16.2–16.3, and why:

- **Manifest additions, as named in the code:**
  - **On an input:** `options` (a loader action, its button text, its select's
    placeholder), `resets`, and `submit` (Enter runs an action).
  - **On an action:** `on_change`, `requires` (the sentence shown when an input is
    missing, the same for the pane and the agent), `page`, `resets`, and `main`.
  - **On the manifest:** `views` (view keys with their legacy key) and
    `legacy_drop` (what the migration drops: picker options).
  - **Layout items:** `error`, `restored`, `crumbs`, `button` + `sets` + `runs`
    (Clear search), `busy`, `flash`, `more`, and `secondary` on an action's
    button.
  - The bookkeeping keys `ranAt` and `resultsVersion` move to `out.` for every v2
    pane.
- **A template language for text from data** (`panes/template.ts`). Paths,
  `??`, `a ? b : c`, and the filters `bytes`, `time` and `encode_path`. It has no
  calls, so a manifest can only read what it's given. §16.3.2 assumed one without
  saying what it was; CEL replaces it with the builder.
- **The list's details are declared:** `detail: json`, or sections of `fields`
  and `entries`. DynamoDB's summary is a `keys` part: the row's values at the
  table's key fields, which are read from another output.
- **Where errors are shown is part of the layout.** A loader's error, and a
  table's describe error, go under the card's toolbar as before (`error:`).
  Otherwise an error sits beside its button.
- **Saved inputs are a Saved ▾ menu at the right of the pane's first card
  title.** It works in every layout, because tabs have no per-pane header. (It
  first shipped as a row of its own above the cards, which left an almost empty
  row between two full ones. It moved into the title row right after 3b-1.) The
  old "Saved tables" and "Saved buckets" cards are gone.
- **"Templates" and "Saved inputs"** are the Library's first two tabs. The other
  per-pane stores follow until their panes are ported.
- **Settings → Users:** the add form opens from the list's head ("Add user"), as
  New group and New credential do. With the list now first, it would otherwise
  have been below every user.
- **Payloads:** the new endpoint takes `connection`, and the old routes keep
  `environment_id` for the one release they remain (D49). So D40's "both names"
  needed nothing more for these panes.
- **Not built:** the generic "list a picker's options" agent tool. The agent keeps
  `list_dynamodb_tables`, `list_s3_buckets` and `list_cognito_user_pools`. It
  comes with 3b-2, when the routes and the old tools go.
- **New for the agent:** `inspect_row` works on these three panes (`rows.tables`,
  `rows.cognito`, `rows.buckets`). Its run summary includes what describing the
  table found.
- **Fixed in passing:**
  - The old S3 page called a browse it had just made "restored with this
    session". Its card mounted at the same moment the run's time landed.
  - Changing the table now clears the old table's scanned count too.
- **Checked:**
  - **Pixels:** every card of the three panes, across 24 states (empty, loaded,
    picked, run, expanded, Load more, a folder, a search), matches the old pages
    apart from anti-aliasing. The one exception is the S3 fix above.
  - **Suite changes:**
    - smoke13, 22 and 23 now mock the action endpoint (harness
      `mockPaneActions`) instead of the old routes;
    - smoke13's waits for the "Saved …" cards became waits for each pane's first
      card;
    - smoke23 addresses the environment select as the first one, because a
      restored table now shows as a second select before its list reloads (D47);
    - smoke35, 36 and 61 follow the renamed Settings tabs.
  - **New suites:** smoke65 (saved inputs, the Library, Users and Groups) and
    smoke66 (the file browser, row copy, Load more and the selection, an expanded
    row reaching another tab, tag tones). Both fail against the old frontend.

### 16.8 3b-2 as built

Where the build departed from §16.4, and why:

- **Schema additions, as named in the code:**
  - **On an input:** `choice_sets`, `optional`, `examples`, `grow`, `hint`, and `pairs`.
    `pairs` is the wording of a `headers` editor.
  - **On an action:** `args`, which makes it a row action.
  - **`when`:** `not_in` and `error`.
  - **Layout:** `line` and `examples`.
  - **Cards:** may be untitled. Such a card holds one output or error, which draws
    its own title or none.
  - **Renders:** `http_response` and `attach`.
- **The fan-out is a helper, not an endpoint feature.** `handlers.fan_out`
  returns the group shape every fan-out pane already stored. So IoT's migration
  is a key move, and an IoT session keeps its results.
- **The agent's rows and detail come from the manifest.** `_manifest_rows` and
  `_manifest_detail` read each list's `groups` and `detail`.
  - The registered `rows.tables`, `rows.cognito`, `rows.buckets`, `rows.iot` and
    `detail.iot` are gone.
  - Certificates gained their detail.
  - The run summary of a grouped list keeps its per-environment counts and errors.
    It leaves out the other mode's emptied list.
- **The agent accepts an input's old name.** `PaneKind.aliases` maps
  `selectedEnvironmentIds` to `connections`, because an earlier turn in the
  history may still use it.
- **Unset inputs take their defaults in `run_handler`.** A pane the agent made
  holds only what it was given, and IoT's search would otherwise refuse an empty
  query that the pane shows as `thingName:*`.
- **`run_handler` checks the group's flag itself.** The action endpoint already
  did, and so did the agent. With the per-service routes gone, the handlers have
  no other place that would.
- **Expanded IoT rows became session state.** IoT's old lists kept them in the
  tab. Under D48 they are a view key now, by row index. The mode and a fresh
  search reset it.
- **Layout items are keyed by their place in the manifest.** Keyed among those
  shown, IoT's things and certificates lists were one component, so a thing
  checked in one mode stayed checked in the other.
- **The detail cache resets only on a real change.** React's development mode
  runs mount effects twice, and the reset cleared what an expanded row had just
  requested, so the row was fetched twice.
- **Fixed in passing:**
  - smoke25 and smoke26 had timed out on main since the Members row arrived. Each
    picked the first select on screen, which is now the session card's member
    role. Both now address their select by name and pass.
  - Each inline label (Target, Auth) is now tied to its select.
- **Checked:**
  - **Pixels:** every IoT and HTTP client card, old page against ported, in 16
    states. They match apart from text sub-pixel rendering and one intended
    change: **the Saved ▾ menu**. It sits in IoT's first card and in Request,
    replacing "Load saved search…" and "Save search", and "Load saved request…"
    and "Save request". (The comparison caught one real difference, now fixed:
    the help paragraph between IoT's two toolbars had lost its bottom margin.)
  - **New suites:**
    - smoke67, for IoT: mode and examples, what Search sends, Target errors,
      expand-to-fetch, another tab opening the same row, Saved ▾ keeping mode and
      query, and an old session.
    - smoke68, for the HTTP client: Body by method, headers, what Send sends, the
      response, the exchange always attached, the error card, Saved ▾, and an old
      session.
    - Both fail against the old frontend.

### 16.10 3b-3 as built

Where the build departed from §16.9, and what it added:

- **Schema additions, as named in the code:**
  - **On an action:** `poll: {handler, stop}`, which makes it a background run.
  - **On an input's options:** `children` (a two-level picker's second loader) and
    `filter` (its filter box).
  - **Layout:** `stop` (a run's Stop button), `time_range` (`{preset, start, end}`)
    and `sort` (Sort by an output's fields, into its sort view keys).
  - **Renders:** `logs` and `run`.
- **What a run writes.** `out.run` is `{id, status, startedAt, by, polledAt,
  fingerprint, stoppedBy, note, error, trimmed}`; status is running, done, stopped or
  failed. A run writes only when its results' fingerprint changes, and a second Run
  stops and replaces the first. `run` renders what became of a run that didn't
  just finish: "Stopped by …", the unwatched note, or the error.
- **Run in the browser.** `ManifestPane` pushes the session first (`flushAll`), so a
  pane added a moment ago exists on the server, then posts the action with its
  session and pane. Nothing comes back but the run: the button stays busy from the
  click until the server's `out.run` arrives over the event stream (with a 10 s
  fallback), and from then on for as long as it says running, in every tab.
- **The time zone** is sent only by a pane whose layout has a `time_range`, and
  becomes the `_tz` input on the server. `panes/timewindow.py` turns the three
  time inputs into a window for the handlers and the agent alike.
- **The agent's `list_log_groups` and `list_opensearch_*` stay** one release beside
  `list_options`, like the logs routes and saved queries' routes. A model that
  learned them in an earlier turn still finds them.
- **The browser suites fake AWS on the server.** A run is polled by the backend, so a
  suite can't answer it in the page any more. `backend/dev/fake_aws.py` serves the
  app with Logs Insights and OpenSearch answered in place for any account starting
  "0000" (`#slow` keeps a query running, `#fail` fails it); every other account goes
  to AWS as before. It is never shipped: the image copies `app/` only.
- **Removed:** `InsightsPage.tsx`, `ResultsView.tsx`, `LogGroupSelector.tsx`,
  `OpenSearchIndexSelector.tsx`, `EnvironmentSelector.tsx`, `SavedItemsPanel.tsx`
  (the Library's Log Queries tab), and the API client's query, OpenSearch and saved
  query methods. On the server, IoT's router and `/api/tools/http-request`'s route
  went (D49); the function behind the latter is the HTTP client's handler.
- **Fixed in passing:** smoke44's "agent" write used the old `queryString` key. A
  legacy key never overrides a new one already present, so once the pane was ported
  it wrote nothing anyone saw; it writes `in.queryString` now.
- **Checked:**
  - **Pixels:** every CloudWatch and OpenSearch card, old page against ported, in 11
    states (fresh, picked and filtered, custom range, running, stopped, finished,
    grouped with a row open, capped; OpenSearch fresh, indices, results). The
    results and pickers match apart from sub-pixel text rendering. Two changes are
    intended: **the Saved ▾ menu** in the first card, replacing "Load saved query…"
    and "Save query", and **"Stopped by …"** beside a stopped run.
  - **New suite:** smoke69 covers the pickers and the filter's select-all, the
    custom range's default, what Run sends, rows streaming in, a second tab, a
    reload mid-run, Stop from the other tab, sort, group by, the cap, an expanded
    row in both tabs, Target errors, OpenSearch's domains, indices and search, and
    an old session. It fails against the old frontend.

### 16.11 PR 3b-4 in detail: charts

_Detailed 2026-10-14, after 3b-3 merged. Two questions were asked: where the
log-volume histogram's counts come from (D52), and who chooses what a table's chart
shows (D53)._

#### 16.11.1 Data frames and the chart spec (D11)

- **A data frame is worked out in the browser** from what an output already holds;
  nothing new is stored. It has fields (name, type: time, number, string) and rows.
  - A table's rows (the API table) are records.
  - A log list's rows are `{field, value}` lists, flattened, plus `environment`.
  - Types are inferred from the values: numbers, then times (ISO, epoch
    milliseconds or seconds, CloudWatch's `2026-01-01 00:05:00.000`), else strings.
- **The spec** is the view key `chart` (D48, D53):
  `{type, x, y, agg, series}`.
  - `type` is one of `timeseries`, `bar`, `pie`, `stat`.
  - `y` is a field name, or `count` to count the rows.
  - `agg` is one of `sum`, `avg`, `min`, `max` or `count`.
  - Rows are grouped by x (and series) and y is aggregated. A `stats ... by bin(5m)`
    result is already one row per bucket, so it is drawn as it is.
  - **Stat** is one number: y aggregated over all rows, with a sparkline when x is
    a time.
- **ECharts, loaded on demand.** The core is imported with only the line, bar and
  pie charts, the grid, tooltip and legend components, and the canvas renderer. A
  dynamic `import()` puts them in their own chunk, fetched the first time a chart
  is on screen.
  - Its colours are read from the theme's CSS tokens, so a chart follows the
    theme.

#### 16.11.2 The chart in a pane

- **A `chart` layout item** names the output it charts. It draws a "Chart" bar
  that folds; whether it is folded is the tab's, not the session's.
  - Unfolded, it shows the type, x, y, aggregate and series pickers, filled from
    the frame's fields, then the chart.
  - It is placed on the API table's rows and on both logs panes' results, where
    a CloudWatch `stats` query becomes a line chart.
- **The agent** sets it with `set_pane_view`, a new generic tool for any pane's
  view keys (sort, group by and expanded rows too, as D48 intended). It
  validates the keys against the manifest's views. A chart's field names
  can't be checked until the pane has run; a name with no column is shown in
  the pane as exactly that.

#### 16.11.3 The log-volume histogram (D52)

- **The `histogram` output** holds one group per target,
  `{environment_id, environment_name, buckets: [{t, count}], error}`. It is drawn
  above the results as bars stacked by environment.
- **The interval** is picked from the time window so there are about 60 bars,
  rounded to a readable step (1 s up to 1 d).
  - The handler picks it, `panes/timewindow.interval`, so the agent's run and the
    browser's agree.
- **OpenSearch:** the search adds a `date_histogram` aggregation on the timestamp
  field, with `min_doc_count: 0` over the window. It is one request, as before.
- **CloudWatch:** a `histogram` input, a "Histogram" checkbox in the Query toolbar,
  off by default.
  - On, the start handler starts a second query per environment: the user's query
    with its `fields`, `display`, `sort` and `limit` commands removed and
    `| stats count(*) as count by bin(<interval>)` appended. The commands are split
    on `|` outside quotes and `/regex/` literals.
  - A query that already has `stats` gets no histogram, and the pane says why.
  - Both queries are handles of the same background run (D51). They are polled,
    stopped and unwatched-stopped together.

#### 16.11.4 Tests

- **Backend:**
  - the count query built from a user's query, including quotes, regexes and
    `stats`;
  - the interval;
  - the OpenSearch aggregation and its buckets;
  - a CloudWatch run with the histogram on, both handles polled and stopped;
  - `set_pane_view` refusing a key the manifest doesn't declare.
- **Browser:**
  - the API table's chart: type, x, y and series, a stat tile, and the chart
    reaching another tab;
  - a CloudWatch `stats` result charted;
  - the histogram, on for CloudWatch (fake AWS answers the counting query) and
    always on for OpenSearch;
  - ECharts' chunk is not loaded until a chart is shown;
  - each failing against the old frontend.

### 16.12 3b-4 as built

Where the build departed from §16.11, and what it added:

- **The chart picker sits beside the card's title.** It is the `chart:` item
  placed in the card's `aside`, where it draws only the type ("Chart: None").
  The same item in the card draws the x, y, aggregate and series pickers and
  the chart, once a type is chosen. So a pane nobody charts gets no new row,
  avoiding the near-empty row that once sat under Saved inputs.
- **A new chart guesses its fields.**
  - x is the time column for a time series, else the first text column.
  - y is the first numeric column that isn't an id, summed; failing that, rows
    are counted.
  - A `stats count(*) by bin(1m)` result is one row per bar, so counting its
    rows would draw a flat 1. Summing `count(*)` draws the counts.
- **The histogram is the output `volume`.** The CloudWatch toggle is the input
  `histogram`, and an input and an output can't share a key.
  - Its value is `{start, end, interval, groups, note}`. The window and step
    give every target's bars one time axis.
  - Every bar of the window is there, at 0 where nothing matched (`_filled`).
    Neither Logs Insights' `bin()` nor a reader can tell a gap from a quiet
    spell otherwise.
  - Off, a CloudWatch run writes `volume: null`, so an earlier histogram
    doesn't sit over new rows.
- **The old routes went (D49).** `/api/log-groups`, `/api/queries/*`,
  `/api/opensearch/*` and `/api/saved-queries` are gone, and so are the agent's
  `list_log_groups` and `list_opensearch_*`. In their place, `list_options`
  learnt the logs pickers:
  - their groups per environment, each with its own error, and `contains` to
    filter;
  - `parent` for a two-level picker's second level (a domain's indices).

  Without that, `list_options` had returned nothing for them, which is why the
  old tools had stayed. The hit flattening the OpenSearch route did moved to
  `opensearch_client.hits_to_rows`. `models.SavedQuery` stays, read once by the
  3b-3 move into saved inputs.
- **The ECharts chunk** is 597 kB (204 kB gzipped), fetched the first time a
  chart is shown. The main bundle grew by 13 kB.
- **Checked:**
  - **New suite smoke71** covers:
    - the picker beside the title, and the library fetched only on the first
      chart;
    - the starter's fields;
    - a time series, a bar and a pie drawn (a non-blank canvas);
    - a stat tile's sum and max;
    - another tab;
    - a server-side write followed;
    - a missing column named;
    - CloudWatch's Histogram, off and on;
    - a `stats` query's note and its results charted;
    - OpenSearch's histogram.

    It fails against the frontend on main.

### 16.13 PR 3b-5 in detail: MQTT on the server

_Detailed 2026-10-14. It needed no new question: D51 already settled when the server
holds something open for a session (D54)._

#### 16.13.1 The connection is a background run (D54)

- **The server's MQTT client** (`mqtt_client.py`) is paho-mqtt over the same
  SigV4-presigned WebSocket URL the browser used (`iot_mqtt_signer`), as whoever
  connected.
  - Each connection keeps its newest messages in a buffer: at most 200, payloads cut
    at 8 KB.
  - It is held on the replica that opened it, keyed by its handle.
  - A replica that claims the run (its holder died) reconnects. A dropped connection
    reconnects with a fresh URL, since the presigned one expires.
- **Connect** is a background action (D51): `aws.iot.mqtt_connect` opens the
  connection and returns its handle. The run's poll, `aws.iot.mqtt_poll`, drains the
  buffer into `out.messages`.
- **What the poll config gains**, generic and in the manifest:
  - `every`: 1 s for MQTT; 2 s stays the default.
  - `unwatched_stop`: 120 s for MQTT; 600 s stays the default.
  - `append`: `{messages: 200}`. New items go in front of what the session holds,
    capped, instead of replacing it.
  - `agent_wait`: 8 s. The agent reads what has arrived instead of waiting 90 s
    on a stream that never ends.
- **What an action gains:**
  - `max_running`: at most 5 open connections per user, refused with a readable
    reason.
  - `stop_label`: "Disconnect".
  - `restart_on: [topics]`: changing the topics while connected starts a fresh run
    as whoever changed them, the messages kept. This applies to the browser's change
    and the agent's `set_pane_inputs` alike. A member's new topic is never
    subscribed with the starter's identity, which would be acting on their behalf.
- **Stop** closes the connection on the replica holding it. A stop handled
  elsewhere marks the run, and the holder closes it on its next tick. Closing the
  app closes them all.

#### 16.13.2 Publish

- `aws.iot.publish` sends one message through IoT's data plane
  (`iot-data:Publish`), as the person, on the chosen connection. It needs no open
  connection.
- It is `effects: external`: a person's action, never the agent's, until the
  approval step exists.

#### 16.13.3 The pane

- **Inputs:** `connection` (one AWS connection), `topics` (topic filters, a list
  edited as chips), `publishTopic`, `payload`.
- **Outputs:** `messages` (render `stream`, newest first), `status` ("Connected to
  … as …"), `published`, `run`.
- **Saved topics move into saved inputs** (`{topics, publishTopic}`, once), and the
  Library's MQTT Topics tab goes.
- **Removed:** `MqttTool.tsx` and the `mqtt` npm package. `paneTypes.tsx`'s list
  of panes drawn by hand is now empty: every pane is drawn from its manifest.
  `/api/tools/mqtt/presigned-url` stays one release (D49); see §16.14.

#### 16.13.4 Tests

- **Backend**, with the connection faked at its transport:
  - connect, poll and append, capped;
  - topics changed while connected (a new run, messages kept);
  - stop, including from another replica;
  - unwatched for 2 minutes;
  - the cap of five;
  - publish refused to the agent;
  - the saved-topics move.
- **Browser**, through `dev/fake_aws`, whose in-process broker delivers what is
  published to matching subscriptions:
  - connect, then messages streaming in;
  - a second tab on the same stream;
  - adding a topic while connected;
  - publish arriving;
  - disconnect;
  - a reload while connected;
  - Saved ▾.


### 16.14 3b-5 as built, and two chart fixes

Where the build departed from §16.13, and what came with it:

- **A connection is a run with no query.** A handle without `query_id` is live
  until it carries an error (`runs._live`); the poll never says done. Two
  things the poll's write learnt for it:
  - an `append` output with nothing new is dropped, and a poll that changed
    nothing writes nothing, so a quiet second doesn't move the session's
    version or wake every tab;
  - a stop handler may return outputs, which are written. Disconnect returns
    `status: null`, so "Connected to …" goes when it does.
- **A stop on another replica.** The holder sees the run marked stopped on its
  next tick and runs the stop handler there, closing the socket. Without that,
  the socket outlived the run on whichever replica held it.
- **The agent's summary.** `run_pane` on a connection answers after
  `agent_wait` (8 s) with what came, a note that it keeps running, and
  `stop_pane` to end it. The pane's own `status` output was renamed
  `connection` in that summary: it overwrote the run's status.
  `set_pane_inputs` on a running pane's `restart_on` input restarts it as the
  agent's user and says so.
- **A refused connect says what answered.** paho, like the browser, reports a
  refused WebSocket upgrade as "not upgraded" and nothing more. The server
  repeats the handshake with the probe the browser's pre-flight used
  (`iot_mqtt_signer.probe_presigned_url`) and adds its status and body to the
  error. No `x-amzn-` header means something other than AWS answered. The
  signed URL is never part of the sentence: it carries the session token.
- **`/api/tools/mqtt/presigned-url` stays one release** (D49) and goes with
  3c's first PR, with `schemas.MqttPresigned*` and their tests.
- **The fake.** `dev/fake_aws` answers accounts starting `0000` with an
  in-process broker: telemetry on `fake/robot-1/telemetry` every second, and
  what is published delivered to matching subscriptions.

**Two chart fixes and zoom**, from the user's first use of 3b-4:

- **Series offers few-valued columns only.** It is limited to string columns with
  at most 20 distinct values (`frame.groupable`). `@message` as series drew one
  series per log line and a legend of whole lines over the chart.
- **Raw rows over time are bucketed.** A time x with more than 60 distinct times
  is folded into bars of one width. The width is from a fixed ladder (1 s … 1 d),
  about 60 across the range. Every empty bucket is filled, and the chart says
  "Per 5m". Before, it drew a spike per row.
- **Zoom by dragging.** It works on the histogram and on a time series over
  time, in a pane with a `time_range` input. ECharts' `lineX` brush is armed
  as the cursor.
  - A drag sets the range to `custom` with what was dragged, to the second
    and at least 1 s, through `changeInputs`, and runs the main action.
  - "Undo zoom" pops a stack kept per pane in the tab only. The inputs are the
    shared truth; how one tab got there isn't.
  - A chart without a time range (the API table) doesn't offer it.
- **Checked:**
  - Backend: `test_mqtt.py`, 11 tests:
    - streaming, append and cap;
    - payload cut;
    - restart keeping messages;
    - disconnect, including from another replica;
    - unwatched for 2 minutes;
    - the cap of five;
    - publish;
    - the agent connecting, reading, restarting and stopping, but not
      publishing;
    - the saved-topics move;
    - topic matching;
    - a refused connect's diagnostic.

    `test_router_flags` also covers MQTT's actions.
  - Browser:
    - smoke72 (13 checks): connect, topics restarting with messages kept,
      publish echo, a second tab, reload, Disconnect from the other tab,
      Saved ▾.
    - smoke73 (10 checks): series without the per-row column, "Per 5m",
      no zoom without a time range, the histogram drag to a custom range and
      its re-run with narrower bars, Undo zoom.

    Both fail against the frontend on main.

## 17. Checking the agent's work (D55)

_Written 2026-10-15, after a conversation in which the agent said it had connected
the MQTT tester three turns running, and never had._

### 17.1 What went wrong, and the fixes that needed no judge

Traced turn by turn, each failure had a cause in what the agent could read or in how
a turn ends, not in the model alone:

- **"Connected and listening", from filling the topics in.** `set_pane_inputs`
  doesn't run anything, and its description says so. But neither its result nor
  `get_session` said whether the pane's run was going: a run's status and the "Connected
  to…" line weren't lists, so the description left them out. Now a background pane
  reports its `run` (running, stopped and by whom, or "not running: run_pane starts it
  (Connect)") and its short text `outputs`. `set_pane_inputs` says "Only the inputs
  changed; nothing ran."
- **`query: []`, refused, then silence.** `get_session` showed the API table's query as
  the rows its editor keeps, and the model sent that shape back. Inputs are now
  described in the shape `set_pane_inputs` takes (`agent_value`), and the stored rows and
  `[]` are accepted too. The nudge after a failed call quotes the failure. A turn that
  still stops there says what failed, not "ran the steps but didn't write an answer".
- **"Let me reconnect … again." and nothing.** The guard only caught an announced step
  ending on a colon. It now also catches a last sentence that says what the agent is
  about to do ("Let me…", "I'll…"), ending on a period, while the turn has called
  nothing.

### 17.2 The check (D55)

- **What it reads:**
  - the request in the user's words;
  - the turn's ledger (each call's arguments, cut to 300 characters, and what it
    returned, cut to 600);
  - the sessions the turn touched, read by the platform after the answer (6,000
    characters each, at most three);
  - the answer.

  The after-read is what lets "connected" be checked against the pane, not against the
  agent's memory.
- **What it says:** JSON, `{"verdict": "ok" | "not_done" | "unsupported", "problems":
  […]}`.
  - "Unsure" is ok.
  - Style is not its business.
  - An answer that says plainly it couldn't is ok.
- **What happens:**
  - A failed answer is taken back (the same retract the grounding check uses), and the
    agent is told what was found, once per turn. A turn the grounding check already
    redid isn't redone again.
  - A second miss stands, with the problems under it.
  - The check is a step of the platform's own in the chat ("Checked the answer against
    what ran"). It isn't sent back in the history.
- **It never blocks.**
  - A check that fails or can't be read leaves the answer as it is, logged.
  - It runs on its own HTTP client, made per turn.
- **Settings:**
  - `AGENT_CHECK` (on by default) and `AGENT_CHECK_MODEL` (the agent's model unless set);
    in Helm, `agent.check`.
  - It runs at temperature 0, not streamed, capped at 600 tokens.
- **Cost:** one model call per answered turn, and one more when an answer is redone.

### 17.3 Scenarios

`platform-agent/evals`: each scenario gives
- a session to start from;
- earlier turns, if any;
- the messages;
- what the session must hold afterwards: inputs, a run's status, view keys, and the
  check's verdict.

The runner:
- drives `/api/agent/chat` the way the browser does;
- runs as a user in an `evals` group, so with an ordinary user's access;
- repeats each scenario and reports a pass rate.

It is seeded from the conversation above. A `fake`-tagged scenario checks the runner on
the scripted model. It isn't in CI: it needs a model and costs money. It is for trying
a model or a prompt before users meet the failure again.

### 17.4 Not done, on purpose

- **A second, supervising agent.** It would double the cost and latency, and it would
  have had the same blind spot: the facts it needed weren't readable.
- **Checking only turns that changed something.** It misses the turn that should have
  acted and didn't.

## 18. Phase 3c in detail: sessions as live dashboards

_Detailed 2026-10-15. Three PRs (D56): **3c-1** results in their own store, and
auto-refresh; **3c-2** view mode and session variables; **3c-3** Home → a
session._

### 18.1 Why the store comes first

Today every result is a key in the session's state (`<pane>.out.<key>`). So:
- every write of one, whether a 1-second poll, a Load more, or a run, resends
  the whole session;
- every other tab then GETs the whole session and merges it key by key;
- a session over 4 MiB has *every* pane's results dropped by the browser's
  `capSession`.

Auto-refresh would turn each of those into a timer. Results also make the
session's version move, so a refresh landing while someone types a query
makes their save a 409 to merge.

### 18.2 The store (3c-1, D21)

- **`pane_outputs`**: one record per (session, pane). It holds the pane's output
  values (results, `run`, `ranAt`, `resultsVersion`), a version of its own, and
  `updated_at`. It is deleted with its session (cascade), and with its pane: a
  session write that drops a pane from `services` drops its record, since pane ids
  are reused.
- **One writer: the server.** `pane_outputs.write(db, row, pane, change, origin)`
  locks the record, edits a copy, checks the size and bumps the version. It
  announces `{kind: "outputs", client_id, pane, version, origin}` to every
  participant on commit. It never touches the session's own version. The writers:
  - **The action endpoint**, given `session` and `pane`, runs a `request` or
    `handler` action and stores its outputs itself. It applies the action's
    `resets` and `page` rules (append, sum), and `ranAt` and `resultsVersion` on a
    fresh run, as the browser used to. It returns them with the result. A caller
    who can't edit gets the result back and nothing stored, which is how a
    viewer's clicks already behaved.
  - **Background runs** (`runs._write`).
  - **The agent** (`run_pane`).
  - **Clears.** An input change's `resets` of `out.` keys go as `clear` on the
    first action they trigger, or alone (`POST …/outputs/{pane}/clear`). The
    agent's `set_pane_inputs` clears the same way.
- **Size.** Each pane may hold 4 MiB, the old whole-session budget, with the same
  halving of the longest list past it. The session state's 4 MiB now holds
  inputs, views and the chat only.
- **Reading.** Every session GET carries `outputs: {pane: {version, values}}`
  beside `state`, and `GET …/outputs?pane=` reads one pane. A tab fetches a
  pane's outputs on its event, and only when the version is newer than its own.
- **Migration.** `<pane>.out.*` keys found in stored state (old rows, an old tab's
  PUT, an IndexedDB copy) are moved into a pane's record if it has none, and
  dropped from the state otherwise: a record already there is newer. It happens on
  read and on every write, with no marker, like the v2 key migration.
- **The browser** keeps outputs in a store beside the workspace. It is not in
  IndexedDB, not in the sync fingerprint and not in templates, and is filled from
  GETs and events. A pane reads its outputs from there. It writes them only
  through the API, applying what comes back.

### 18.3 Auto-refresh (3c-1, R4)

- **Settings.**
  - Per pane: `<pane>.refresh`, in seconds; 0 is off; unset follows the session.
  - Per session: `refresh`. Both live in the session's state, so they sync,
    templates keep them, and the agent sets them (`set_refresh`).
- **Who can refresh.** A pane can refresh when its main action isn't
  `effects: external`, `live`, or a stream (a poll with `append`). That covers
  the API table, the AWS panes, CloudWatch and OpenSearch, but not Send, MQTT
  or the tools worked out as you type.
- **When a tab asks for a refresh.**
  - The timer runs only while the session is on screen and the tab is visible.
  - On return, a refresh that is overdue (by its `ranAt`) is asked for at once.
  - Each ask is jittered by up to 2 s, so tabs don't arrive together.
- **Coalesced on the server** (`POST /api/panes/{type}/refresh`).
  - Under the record's lock, a refresh is skipped when:
    - the results are fresher than 80% of the interval;
    - another refresh started less than an interval ago;
    - a run is going.
  - Otherwise the refresh marks `refreshing` and runs the main action with the
    session's stored inputs, as the caller. The result reaches every tab through
    the store's event.
  - Five tabs watching cause one run.
- **Floors** (D22):
  - 10 s by default, and 60 s for a pane type that declares `cost: per_run`
    (CloudWatch: Logs Insights bills each query by data scanned).
  - `REFRESH_FLOOR_SECONDS` and `REFRESH_FLOOR_COSTLY_SECONDS` raise them.
  - The picker offers nothing below the floor, and says what a per-run pane costs.
- **Failures** are counted on the record (`refresh: {failures, error}`), so every
  viewer sees why. The interval doubles per failure, up to an hour, and a success
  resets it.
- **Viewers.** A viewer can't refresh in 3c-1, the same as they can't run; view
  mode (3c-2) is where a viewer-watched dashboard is decided.

### 18.4 Tests

- **Backend:**
  - the store's write path, version and event;
  - migration of `out.*` from state;
  - a dropped pane's record going;
  - the action endpoint storing, and append and clear;
  - runs and agent writes;
  - refresh coalescing, floors and failures;
  - a viewer refused;
  - the session's version unmoved by results.
- **Browser:**
  - a results write reaches another tab without a session refetch;
  - an input typed while results arrive isn't lost;
  - auto-refresh runs once for two tabs, pauses while the session is hidden, and
    shows a failure;
  - the existing suites unchanged.

### 18.5 3c-1 as built

Where the build departed from §18.2–§18.4, and what it found:

- **No waiting for a save before each run.** A stored action for a pane the
  server doesn't have yet answers 409 *before running anything*; the browser saves
  and asks again. Saving before every action first made each one a round trip
  slower; S3's folder click was the one a suite caught.
- **Replies carry the stored outputs** (`__outputs` on an action, `outputs` on a
  refresh). A write's event carries the writer's origin, and the asking tab skips
  it as its own echo: a refresh that failed was stored, shown in every other tab,
  and missing from the tab that asked.
- **The agent reads outputs as before**, through `_full`, the state with each
  pane's record back under `out.`. Its writers go through the store, and an
  input's `out.` resets are cleared there.
- **The test helpers read the same way** (`_state`, `_row`), so the existing
  assertions keep checking the same values. New tests pin that the state holds
  none.
- **Suites can no longer fake a result in the page alone**: another tab never
  sees it. `dev/fake_aws` answers `.fake` HTTP hosts (`PUT /api/dev/fake-http`),
  and `harness.mockPaneActions` hands what it fakes to `/api/dev/store-result`,
  which stores it with the server's own `apply_outputs`.
- **The MQTT presign route is gone**, one release after the port, as D49 said.
  Its probe stays, for the server's own connect errors.
- **Checked:**
  - Backend: `test_pane_outputs.py` (6) and `test_pane_refresh.py` (7).
  - Browser: smoke75 (11 checks): two tabs, one run per interval; the other tab
    fetching only the pane's outputs; nothing off screen; the session default; a
    failure shown; typing through a refresh.
  - The cross-tab suites (smoke62, 66, 67, 69, 71) were updated for results
    beside the state.

### 18.6 After 3c-1: a pane's ⋮, Clear, and the agent seen working

Asked for after trying 3c-1 (2026-10-15), built before 3c-2:

- **A pane's settings are a ⋮ in its header** (D57), or in the selected tab in
  the tabs layout, where the tab is the header. It holds auto-refresh and saved
  inputs, which had been a select and a menu beside the first card's title.
  3c-2's "hide the inputs on a dashboard" goes in it too. The frame owns the
  header and the pane owns what the menu holds, so the frame leaves a spot
  (`components/paneMenuSlot.ts`) and the pane portals into it. A click there
  bubbles through the pane, not the header, so it neither folds the pane nor
  starts a drag. A pane that can't run again by itself (a live tool) offers no
  refresh. While a pane refreshes, "↻ 30s" shows beside its ⋮.
- **A results card has Clear** (D58) while it holds something. A card names
  what its Clear removes (`clear:` in the manifest, checked to be its own
  outputs and never `run`). It goes through the existing
  `POST …/outputs/{pane}/clear`, for everyone, with `ranAt` and
  `resultsVersion`. A viewer's Clear stays on their screen, as their clicks do.
  The live tools have none, since their outputs are worked out from the inputs.
- **The agent is seen working** (D59):
  - A running turn shows what it's doing and for how long, the whole time it
    runs. "Thinking…" used to show only until the first step.
  - The other chat's tab gets a dot.
  - The compose box says where the agent is busy and offers to go there.
  - The panel's toggle is marked while the panel is closed.
  - A session turn is stored when it's asked, so a member (or another tab)
    sees the question and "Answering <name>…", not nothing until the answer.
  - A turn its browser abandoned shows as unanswered after 10 minutes.
  - The chat merge keeps the answered copy of a turn over a "running" one.
- **Checked:**
  - Backend: `test_pane_manifests.py` checks the manifest's `clear` and what it
    serves.
  - Browser: smoke76 (26 checks). The progress and member checks fail against
    the old frontend.
  - The suites that used Saved ▾ or the ↻ select now go through the ⋮
    (`harness.openPaneMenu`).


### 18.7 3c-2: view mode and session variables

_Detailed 2026-10-15, with the user's two choices (D60, D62)._

**Session variables (D20, D60).**
- **Two kinds for now**, both generic by input type, so a plugin's pane follows
  them with nothing of its own:
  - **Environment**: an AWS connection. It binds every `connection` input of
    `connection_type: aws` (set to it) and every `connections` input of that type
    (set to just it).
  - **Time range**: preset, start and end. It binds the three inputs a layout's
    `time_range` item names.
- **Stored** in the session's state as `variables: {environment?, time?}`; a key
  present means the variable is defined. It syncs, templates keep it, and the
  agent sets it. Defined from the session card's Variables row; shown in a bar
  under the card, which stays in view mode.
- **Binding is automatic** (the user's choice, D60). Every pane with a matching
  input follows a defined variable unless it is unlinked (`<pane>.unlinked`, a
  list of variable names), from the pane's ⚙ or the note beside the input. A
  bound input is shown read-only, saying where its value comes from.
- **The value is copied into the pane's own inputs**, never resolved on read.
  Inputs stay the one truth (§16.3), so refresh, the agent's runs, templates and
  saved inputs need nothing new. A pane that doesn't hold the variable's value
  writes it (on adding a pane, or when another tab changed the variable).
- **Changing a variable re-runs the bound panes that had run**, in the tab that
  changed it: their inputs change the way a person's would (resets,
  `on_change`), then their main action runs. Only actions refresh would run, so
  no stream (MQTT), nothing `effects: external`. Other tabs follow the inputs and
  results as they arrive; they don't run anything themselves.
- **The agent**:
  - `set_variables` defines, changes or removes them and copies them into the
    bound inputs. Like `set_pane_inputs`, it runs nothing, and says which panes to
    `run_pane`.
  - `link_pane` follows or unlinks one.
  - `set_pane_inputs` on a bound input unlinks that pane from the variable, as a
    person choosing their own value would, and says so.
  - Descriptions report the variables, and which inputs each pane takes from
    them.

**View mode (R2, D61).**
- **Settings:**
  - The session: `viewMode` (true hides inputs), on the card's Layout row as
    Edit | View.
  - A pane: `<pane>.inputs`, `shown` or `hidden`, overrides the session, from
    its ⚙ ("Show inputs" / "Hide inputs").
- **A viewer member always sees view mode.**
- **What's hidden:** input and action items, help text, examples, the time range,
  Stop, and any card left with nothing to show.
- **What's kept:** outputs (charts, sort, copy and export with them), errors,
  and the restored note.
- **Each pane's first card** in view mode starts with "Updated 2 minutes ago ·
  Refresh". Refresh is the refresh route, so it coalesces like auto-refresh, and
  a viewer can use it (D62).

**A viewer's refresh (D62).** The user's choice: a viewer's tab refreshes as the
viewer, and only when they can reach every connection the pane's inputs name.
- Otherwise the answer is `unreachable`: nothing is written and no failure is
  counted, and the dashboard waits for someone who can.
- Nobody's access is lent. A run always acts as whoever asked it (D51).

**As built:**
- **Mode shares the card's Layout row**, so the card grew by one row
  (Variables), not two.
- **View mode draws a card only while one of its outputs or errors holds
  something.** A card left with only its Sort, or an empty table, was a frame
  around nothing.
- **Items stay keyed by their place in the manifest**: hidden, not removed.
- **Only the tab that changed a variable re-runs**
  (`announceVariableChange`, a 5-second window); the others write the same
  input values and run nothing.
- **A viewer's background run** (CloudWatch) starts through
  `runs.start(refreshing=True)`, which refresh lets through after its
  reachability check.
- **The header buttons are drawn icons** in one 24px square
  (`components/Icon.tsx`), asked for in the same round; the ⋮ is a ⚙.

**Tests:**
- Backend:
  - the binding twins;
  - `set_variables`, `link_pane`, `set_view_mode`;
  - unlinking on `set_pane_inputs`;
  - a viewer's refresh, reachable and not.
- Browser: smoke77, failing against the old frontend:
  - define the variables;
  - panes follow, are read-only, and re-run;
  - unlink;
  - a new pane follows;
  - view mode, session and per pane;
  - a viewer sees view mode, and refreshes.

### 18.8 After 3c-2: what a load does with this browser's copy

Found while chasing a session that "came back after a delete" (2026-10-15).

**What happened.** On load the panel shows the browser's local copy at once,
then takes the server's list -- unless anything had been written in between,
in which case the local copy stayed and was pushed with the version just
adopted. Every pane writes the value it opened with on mount, so something
always had been: the stale copy always won. The server accepted it (its version
matched), so a change made elsewhere since -- another browser, a member, the
agent -- was lost, and a session deleted elsewhere was created again.

**What a load does now.**
- A pane's first write is a seed, not a change (`useSessionState`, `seed`).
- Each open session is the server's copy merged with this browser's by
  `mergeSession` -- the merge a 409 uses -- against the server copy this
  browser last agreed with. That base is stored beside the workspace in
  IndexedDB (`StoredWorkspace.bases`), saved again whenever a push lands or a
  change is received. So a change made here and not pushed yet survives a
  reload, and one made elsewhere isn't undone. A browser from before has no
  base: only what was done since the load is laid over the server's copy
  (`SinceLoad`, `overlay`).
- A session on this browser but not on the server is kept only if it was
  opened since the load, or never seen on the server by this browser
  (`cwi-synced-<user>` in localStorage, fed by every adopt, push and received
  change). Without that record, only an empty server list counts as "never
  saved", as before.
- Nothing is pushed until the list is in: a push without a version overwrites
  whatever the server has.

**Not covered:** a change made in the last ~400 ms before a reload never
reached IndexedDB (an async write cut off by the unload), as before.

**Leave.** A member's ✕ and menu leave a shared session
(`DELETE …/members/<self>`); a delete or leave the server refuses puts the
session back with a notice (`SessionsApi.notice`).

### 18.9 3c-3: Home → a session (R3, D63)

**Asked for:** a session as a user's home page (R3): any session they can
reach, shared ones included; if it's deleted or they leave it, Home falls back
to the default page with a note saying why.

**Built:**
- **Stored per user** on `users` (`home_session_id`, the row's own id -- a
  `client_id` is only unique per owner -- and `home_session_title`, kept for
  the note once the row is gone). Not in `UserOut`: whether it's still
  reachable needs a query, and `user_out` serves every listing of users.
- **`/api/live-sessions/home`**: GET answers `{home: {client_id, title,
  closed}}`, `{missing: title}` when the session was deleted or isn't shared
  with them any more, or nothing set; `PUT /{client_id}/home` sets it to a
  session the caller can reach (404 otherwise); DELETE clears it.
- **Where it shows:**
  - The session's ⋮ offers "Set as my home page" or "Stop using as home
    page"; the home session's row in the side panel carries a small house.
  - The brand row goes there (reopening it if it was closed).
  - So does a load that would land on the default page -- sign-in, a fresh
    browser, a reload while on it.
  - "Start new session…" still shows the catalogue: it is what you start
    things from, whatever home is.
- **Gone:** the default page says "Your home page, "X", was deleted or isn't
  shared with you any more", and Dismiss clears the setting.

**Not done:** a group default set by an admin (R3's "later"), and the agent
setting it -- it's a preference of the person, not something a session's
conversation should change.

**Variables in the card (the user's report, same PR).** The bar under the
card read as a stray card and stayed behind when the card moved to the side
panel. The variables are set in the card's Variables row now, and the card
folds in the side panel too. (Their controls were kept in the folded card's
header for a round; the user found that clutter -- to change one, expand the
card -- and they went.)

## 19. Phase 3d in detail: access per pane type, the catalogue, a new kind of connection

_Detailed 2026-10-16. Three PRs (D64)._

### 19.1 3d-1: per-type permissions (D65)

**Today:** a group has one boolean per page (`logs_enabled`, `iot_enabled`,
`tools_enabled`, …); a manifest names the one it needs (`flag:`), and five
places read it (`/api/pane-types`, the action and request endpoints, the HTTP
client's Send, the agent's `available_kinds`). "Tools" is one switch for six
panes, and a plugin's pane would need a new column.

**Built:**
- **`group_pane_grants`** (group, pane type), unique per pair, deleted with the
  group. `pane_access.py` is the one place that answers "may this group use
  this pane type": the Admin group always, any other group when it has the
  row. Every check site calls it (`allowed`, `require`).
- **The booleans become shorthand.** `UserGroupOut`/`UserOut` still carry
  them, worked out from the grants (on when the group has any pane with that
  flag), and a create or update that sets one grants or revokes every pane
  that names it. `pane_types` is the exact list, on both, and wins when both
  are sent. `agent_enabled` stays a boolean: the agent isn't a pane.
- **Migrated once** (a `Settings` marker, `pane_grants_migrated`): each
  group gets a grant for every pane whose manifest flag it had on -- what it
  could use before, exactly.
- **A manifest's `flag` is optional now**, kept only to say which old switch
  covered it. A pane type with no flag (3d-3's Prometheus) is granted to no
  group until an admin does it.
- **Users → Groups**: the Pages section becomes **Panes**, a checkbox per
  pane type under Services and Tools (from the manifests' groups), and the
  Platform agent its own row. The Admin group says "Every pane".
- **`/api/auth/me`** gives `pane_types`; the catalogue offers exactly those.

**Not in 3d-1:** a group × pane-type grid across all groups at once (one
group's form is where access is edited today), per-action permissions (read
vs run), and grants per plugin -- a plugin's panes are granted one by one
until there are plugins.

### 19.2 3d-2: the catalogue with categories (§4.8, R6, D66)

**Today:** every pane type is a "Service" or a "Tool" (`group` in its
manifest), and five places group them that way: the default page, the side
panel's Add list, the strip's + menu, the session card's add rows and the
group form's Panes.

**Built:**
- **Categories are data** (`catalogue_categories`: name, a fixed `key`,
  position). A manifest suggests one (`category:`, else its `group`); a
  suggestion that no category has is created at startup, keyed by it. The
  key never changes, so renaming "Tools" to "Utilities" doesn't make the
  next start create "Tools" again.
- **An admin's placement pins a pane** (`catalogue_placements`: pane type,
  category, position). Unplaced, a pane goes by its suggestion, after the
  placed ones, in manifest order -- so a plugin upgrade never undoes where an
  admin put a pane. Arranging the catalogue (`PUT /api/catalogue/layout`, the
  whole arrangement) places every pane in it.
- **Deleting a category moves its panes** to another one, as placements.
- **Each person's layer** (`catalogue_preferences`): favourites, pinned at
  the top of every list as their own "Favourites", and hidden pane types,
  left out of the lists (the default page offers "Show hidden").
- **One read** (`GET /api/catalogue`): the categories in order, each with
  the pane types the caller may use (an empty one left out, except for an
  admin arranging them), and the caller's favourites and hidden. The five
  places above all draw from it (`useCatalogue`).
- **Settings → Catalogue** (admins): categories in order -- rename, move up
  and down, add, delete (choosing where its panes go) -- and each pane with
  up / down and a category to move it to. Up and down rather than drag and
  drop: one control per move, testable, and usable from a keyboard.
- **The agent:** `get_context` gives each kind its category. The prompt
  still names none.

**Not in 3d-2:** icons for categories, personal categories, tags and search,
and workflows in the catalogue (Phase 4).

### 19.3 3d-3: a new kind of connection, and a pane from a manifest alone (D67)

**Today:** connection types are rows (`connection_types`) but only the two
built-ins exist, AWS and HTTP API; a declarative `request` (the API table's
Fetch) reads its path and query from inputs and its rows from one list.

**Built:**
- **Admin-defined connection types** (Settings → Environments → Types, a
  switch as Credentials | Types is). Every one is HTTP: a **Base URL** first
  (always, checked like the HTTP API's), then the plain fields the admin
  adds (key, label, help, required -- never secret: secrets are
  credentials), and any credential type with an `inject` as a group's
  identity there. Built-ins stay locked; a type in use by a connection, or
  needed by a pane, can't be deleted.
- **A manifest can ship the type its pane needs** (`connection_types:` in
  the manifest), seeded at startup when missing, marked as the pane's, and
  then the admin's to rename or add fields to -- the way a plugin will
  arrive with what it reaches.
- **A request names more, declaratively** (still no code in a manifest):
  - the connection's type comes from its input's `connection_type` -- any
    HTTP type, not only `http_api`;
  - `fixed_path` beside the path input;
  - `params`: each query parameter from an input, a literal, or the pane's
    time window (`window: start | end | step`, worked out as the browser's
    zone says, the step about 240 points across);
  - `rows`: where the list is (`at`), an item's list to make one row per
    element (`explode`), columns read by position or path (`columns`,
    as text, number or time), and an object spread into a column per key,
    plus one text column naming the series (`labels`).
- **Prometheus**, `prometheus.yaml` and nothing else: a Prometheus connection
  type it ships, a PromQL query, a time range, a time-series chart over
  `query_range` and the table under it, auto-refresh, the agent's run. It
  suggests the **Observability** category, created by 3d-2's rule, and like
  any pane without a flag is granted to no group until an admin does
  (D65).

**Not in 3d-3:** instant queries, Prometheus' own label pickers (a loader
over `/api/v1/labels`), and types that aren't HTTP.

## 20. Direction after Phase 3 (agreed 2026-10-16, D68–D79)

Phase 3 done, the user asked whether the platform was becoming "Grafana with an
agent and live sessions", and set out where they want it to go: sessions anyone
can start -- teams, single users, people outside an enterprise -- holding panes
of any kind (tables, files, metrics, but also video, embedded pages, anything worth
sharing), shared with people and an agent; workflows generic enough to do
anything; and everything built inside the platform kept. This section is the
outcome of that discussion. It refines §1–§8 rather than replacing them.

### 20.1 What holds "anything" together: the pane contract (D68)

"Anything" is a principle, not a design. What makes it one is the contract every
pane already speaks: **inputs** (the shared truth, set by people and the agent),
**actions** (one endpoint for both), **outputs** (written by the server,
versioned, announced) and **views** (how it looks, also shared). Whatever fits it
gets the rest for nothing: live sharing, the agent driving it, templates,
variables, refresh, view mode, grants, and -- through its actions -- workflows.

- **That is the difference from Grafana.** Grafana's panels are read-only views of
  data sources; here metrics are one category of pane among panes that act
  (DynamoDB, S3, IoT, MQTT, HTTP), with an agent that is a participant rather than a
  sidebar.
- **Kinds of content, by how well they fit:**
  - *Media and documents* -- video, images, files, notes -- fit well and are cheap.
    A video's position and playing state are inputs, so everyone watches in step
    and the agent can say "02:14 is when it stopped" by setting it; a transcript as
    an output is what lets the agent read what it can't watch.
  - *An embedded page (iframe)* is opaque: no inputs or outputs, nothing for the
    agent, nothing synced but its URL, each viewer loading it with their own
    cookies, and many sites refuse to be framed. It is allowed, sandboxed and
    **marked as one the agent can't see** -- a way out, not the way in. If iframes
    became the usual way to bring things in, the platform would be a tab manager.
- **Three tiers of pane**, matching §7.4: declarative manifests (safe anywhere,
  fully legible to the agent); panes with code (Python in the isolated runner, or
  sandboxed browser code speaking the contract over postMessage, §4.5); opaque
  embeds.
- **Every pane is legible to the agent**: it says in text what it holds -- the
  describe and `inspect` panes already have, designed in for media and code panes
  rather than left out.
- **Panes that follow each other** (later): a row picked in one pane sets an input
  in another -- a device chosen in IoT moving the MQTT topic, the logs' filter and
  the camera's video. Session variables (§18.7) are the start of this.

### 20.2 Workflows are pipelines; sessions are where you look into them (D69)

§5 stands: a workflow is a **pipeline with stages**, run with parameters like a
Jenkins or Argo build, on its own page (parameters form, run history, a run drawn as
its stages with status, time and logs). It is never drawn as a session's panes.
What it shares with panes, and the doors between the two:

- **A step is an Action**, the same one a pane runs: "query CloudWatch", "scan a
  table", a Prometheus range query, a builder's or a plugin's action -- each is a
  step with no extra work.
- **A stage's outputs are drawn by the pane renderers**: its table, JSON or chart
  looks as it would in a pane. The run page resembles the stacked layout -- a card
  per stage, folded to its status -- but it is the run page, not a session.
- **Rerun** a run with the same or changed parameters, or **from a failed stage**.
- **The doors:**
  - *Run → session*: "Investigate this run" opens a session holding the stages'
    outputs as panes, for people and the agent to dig into (§5's "cloned into a
    session").
  - *Session → workflow*: "Make this repeatable" drafts a definition from what was
    done in a session, the inputs that were changed becoming its parameters; it is
    finished in the editor, by hand or with the agent.
  - *A workflow in a session*: one pane holding its parameters, Run, the last run's
    status and a link to the run page.
  - *The agent* starts, follows and reads runs, and helps write definitions (§20.3).
- **Editors** (D73): a form and the YAML first; a drag-and-drop graph later, as a
  third view of the same definition. A node's place on the canvas is kept apart
  from what the workflow means (a `ui:` block or file of its own), so moving a box
  is never a change to the workflow in a diff.

### 20.3 The builder, code, and the agent as a builder (D71, D72)

- **The Builder is a per-group grant**, like the agent (`agent_enabled`): whoever
  has it builds whatever they want -- pane types, steps, workflows, credential and
  connection types -- code and dependencies included (the user's call). §8.1's
  admin approval of dependencies is dropped; the lockfile (pinned, hashed) stays,
  and an admin may point installs at a package mirror.
- **Safety comes from where code runs, not from who may write it:**
  - Code runs in the isolated runner (Phase 6) **as the person running it** -- their
    group, their connections, their access -- so a pane someone built reaches
    nothing its user couldn't reach through the UI.
  - **Code doesn't receive raw secrets where that can be avoided.** An HTTP
    request goes out through the runner's egress proxy, which adds the
    connection's credential for that connection's own host; AWS gets short-lived
    STS credentials, egress limited to AWS. This is what stops the one real abuse:
    a pane built to send the token of whoever runs it somewhere else.
  - **Sharing is gated by the grants that already exist** (D65): a new pane type is
    no group's until an admin grants it, so a builder uses their own work at once
    and others get it when an admin says so. No new review mechanism.
  - Until the runner exists, the builder offers declarative actions and CEL only;
    code arrives with Phase 6.
- **Logic, cheapest first** (§4.5, §7.3): declarative requests (D67) → CEL
  expressions, evaluated alike in the browser and on the server → Python actions in
  the runner → sandboxed browser code. Dynamic inputs are loaders (an action that
  returns options, as log groups and indices already are); code on an input's
  change is `on_change` and `run: live`.
- **The agent builds through the same definition** (D72): the builder's form, the
  YAML and the agent are three editors of one file, the way the browser and the
  agent share one action endpoint. Its tools are generic -- read the manifest and
  workflow schema with existing definitions as examples; validate a draft (the
  strict schema's errors name the problem); preview it in a scratch session on a
  real connection, as the user, and read what came back; save, with the user
  confirming. No per-service hints (CLAUDE.md): if it can build Prometheus from the
  schema and an error message, it can build anything. Declarative first is what
  lets it check its own work mechanically and a person review it at a glance.

### 20.4 The store repo: what's built is kept as a plugin (D70)

Two uses of git, kept apart:

| | Plugin sources (§7.2) | The store repo |
|---|---|---|
| Written by | the plugin's authors | **the platform**, on every save |
| The platform | reads it, pinned to a tag or SHA | commits to it, and restores from it |
| For | installing what others made | what was built here outliving the deployment |

- **Only what a plugin can ship, in exactly a plugin repo's format** (§7.1): the
  repo *is* a plugin -- `plugin.yaml` at its root, `panes/`, `credential-types/`,
  `connection-types/`, `workflows/`, `steps/<id>/` with its code and
  `requirements.txt`. So exporting is a copy, another deployment can install the
  store as a plugin, and a builder's work moves between deployments by git.
- **Never** a deployment's values or state, which stay in Postgres: credential
  values, environments and connections, users and groups, grants, the catalogue's
  arrangement, sessions, runs, audit records. After a restore, credentials, for
  instance, are re-entered (or come from Vault or Secrets Manager once those exist).
  So the repo complements a Postgres backup; it doesn't replace one -- a deployment
  lost with its database gets its definitions back, not its sessions.
- **Which items:** those made or changed here (origin local). Built-ins and an
  installed plugin's items come from their own source and aren't written; a type a
  manifest seeded (D67) is written once an admin changes it.
- **Write-through:** the database is the working copy and what runs; every save
  writes it and then commits the one file, as the user who saved it, with a message
  saying what changed; a delete removes the file. Each item records the commit it
  was based on.
- **Never blocked by git:** unreachable, the save still lands, the item is marked
  "not pushed" and a queue retries; the store's status shows what is pending.
- **Restore on start:** anything in the repo the database lacks is loaded, and
  anything pending is pushed.
- **Configured** in Helm (`store.git`: url, branch, path, an `existingSecret` with a
  token or SSH key, the commit author) -- then shown locked in Settings, as the
  master key is -- or by an admin in Settings when Helm leaves it unset. Helm's is
  what restores a new cluster with no database; a repo set only in Settings is
  re-entered after a database loss, and then restores.
- **Later:** edits made in the repo pulled in by webhook or polling, a conflict
  found as session sync finds one (each item's base commit against the file's) and
  flagged, never merged silently; and a **read-only mode**, where the deployment
  takes its definitions from the repo and the UI can't edit them -- a dev
  deployment builds and commits, production reads. GitOps for the platform's own
  content, where it is wanted.

### 20.5 The phases, re-planned (D74)

The store decides how definitions are kept from the first one, so it comes before
workflows:

- **4a, the store repo** (detailed in §21): items tracked against the repo (the
  file each one is, the hash last written or read, pushed or not); the store repo's
  configuration (Helm and Settings); write-through through an outbox, restore on
  start, conflicts flagged; namespaced ids for what is made from now on (D78).
  What exists to store today is admin-defined credential and connection types, so
  4a is testable on its own: define a type, see the commit; drop the database,
  restart, it's back. Run on open (D77) rides with it -- small, independent, and
  something to try on a dashboard.
- **4b, workflows** as §5, §20.2 and §20.7: the blob store (§8.2), definitions in the
  store, recorded runs on the in-process runner, the Workflows page, a workflow's
  page and the live run page, rerun from a stage, the agent starting and reading
  runs, the approval step shared with the agent, and the doors between runs and
  sessions.
- **4c, published templates** (D76, §20.8): Publish, made portable by the
  Environment variable, into the store and the catalogue.
- **5, the builder:** the per-group grant, the pane and step builders over declarative
  actions and CEL, the form and YAML editors with live preview, and the agent's
  build tools (§20.3).
- **6, the runner and code**, as before, with the egress proxy injecting credentials.
- **7, plugins and the marketplace**, as before; the store repo is installable as one.
- **Later:** the drag-and-drop editor, media and document panes, embeds, panes that
  follow each other, pulling edits from the store repo, read-only mode, workflow
  triggers (cron, webhook), a team admin role.

### 20.6 Open

- ~~Who a scheduled or webhook run acts as~~ -- **the workflow's owner** (D81).
- The store's `plugin.yaml` version: commits don't change it; how a store is
  tagged as a release for another deployment to install is Phase 7's.

### 20.7 Workflow screens (D75)

- **The Workflows page** is a global page in the rail, like Home and Agent (the
  placeholder in `pages/pageTypes.tsx`), never a session. It lists the workflows
  the person may run: name, category (the catalogue's categories, §4.8), triggers,
  the last run's status and time, a ★, and Run; search; and a **Workflows | Runs**
  switch, Runs being recent runs across workflows (mine, running, failed).
- **Who sees one** is a grant per group, as a pane type is (D65); a run acts as
  whoever started it -- their environments in its pickers, every step through the
  same access check a pane's action goes through.
- **A workflow's page**: a header (name, description, **Run ▸**, ⋮); Run opens
  **Build with parameters**, a form drawn by the same input components panes use,
  dynamic pickers included; then run history (#, status, started by or which
  trigger, parameters, duration), the definition (form | YAML, the graph later),
  triggers and access.
- **A run's page**: its own URL, **live and shared as a session is** (the same event
  stream, so everyone watching sees it move) -- but not a session: no panes to add,
  no layouts. A header (workflow and number, status, who, when, the parameters;
  Cancel, Rerun ▾ with the same or changed parameters or from a failed stage,
  **Investigate in a session**); the stages as a list (later a graph) with status
  and time; the selected stage's resolved inputs, its outputs drawn by the pane
  renderers, its logs, and Approve / Deny on a waiting approval. The agent panel's
  Session tab is **This run** there: one conversation per run, that reads it.
- **A run nobody started** -- a schedule, a webhook -- **acts as the workflow's
  owner** (D81): their group, environments and identities, exactly as if they had
  pressed Run. The trigger names whose access it uses, and so does every run it
  starts; an owner who loses access to something makes the next run fail there,
  as it would for them.
- **Other ways in:** a workflow pane in a session (its parameters, Run, the last
  run, a link), a Workflows card on the default page, the agent listing and
  starting them; later, a mark in the rail while a run of yours is going.

### 20.8 Templates as plugin content, and run on open (D76, D77)

- **Templates** (D76). A person's saved templates stay theirs, in Postgres, as
  today -- mostly scratch, and nobody wants them in a repo. **Publish** makes one
  plugin content: written to the store, offered in the catalogue to whoever can
  use every pane type it holds -- ready-made dashboards ("IoT fleet overview",
  "Service health") are a good reason for a plugin to exist. Published, it must be
  **portable**: a template's state names connection ids, which mean nothing in
  another deployment, so Publish binds every connection input to the session's
  **Environment variable** (D60) -- whoever opens it picks their environment once
  and every pane follows -- and drops credential ids. Outputs are already left
  out of templates. Session variables are what make a dashboard portable.
- **Run on open** (D77). Refresh becomes a mode, per pane and as the session's
  default: **off**, **on open**, **every N**, or **on open and every N**. On open
  runs a pane once when someone opens the session or switches to it, **only if its
  outputs are older than a freshness window** (the pane's setting, a default of a
  few minutes) -- or every tab switch, and every member arriving together, would
  run it again. The server decides under the pane's lock as it does for refresh
  (§18.3): fresh, another refresh under way, a run going. Everything else carries
  over: a viewer runs it as themselves and only when they can reach every
  connection it names (D62), the per-run floor still applies, `effects: external`
  never runs, and it is session state the agent can set.

### 20.9 Namespaced ids (D78)

- Every id of plugin content -- pane types, credential and connection types,
  workflows, steps, templates -- is **`<namespace>:<name>`**. **Built-ins keep their
  bare ids** (`iot`, `prometheus`, `aws_role`) as the implicit core namespace, so
  nothing stored today changes; the types admins made before 4a keep theirs too
  (ids never change once something points at them), and are written to the store
  as they are.
- **A plugin's namespace is its id**, unique in its registry (the registry's PR
  review holds it to that). **The store's is set in its configuration** (`devops`,
  say): what is made from 4a on is `devops:fleet_health`, and another deployment
  installing this store gets it under that namespace, clear of its own store's.
- **The separator is `:`** -- a `.` already splits a pane id from its keys
  (`iot.in.query`), and pane types are path segments (`/api/panes/{type}/…`), so a
  `/` would break those. A namespace is `[a-z][a-z0-9_-]{0,23}`.
- Customising an installed item in the builder copies it into the store's
  namespace; the original stays. Installing a namespace that exists is an upgrade
  of the same plugin or refused, never an overwrite.
- People see labels, not ids; two of one label are told apart by where they come
  from ("Prometheus · acme-k8s").

### 20.10 Who it's for first (D79)

The user's DevOps team first, then backend, QA and embedded teams -- inside one
company, under team policies. So:

- **Teams are groups.** A team's workflows, templates and favourites come from
  grants; access stays per group (CLAUDE.md), and nothing per person -- personal
  connections, personal types, sign-up -- is built for now.
- **Later, a team admin**: someone who grants within their own group, so not every
  change goes through the platform's admins.
- The teams pull towards different panes (embedded: devices, MQTT, logs from a
  device; QA: HTTP, test runs, comparisons; backend: logs, databases) -- the
  builder's first real uses and the first templates to publish should follow them.

## 21. Phase 4a in detail: the store repo, and run on open

Planned 2026-10-16 (D80), from §20.4, §20.9 and §20.8. One PR, testable on its
own: what admins define today is written to git and comes back from it.

### 21.1 What you can try

- Point the platform at a repo (Helm, or Settings → Store when Helm leaves it
  unset), define a credential type or a connection type, and see a commit for it
  in the repo, as you, in a plugin repo's layout -- `plugin.yaml` listing it.
- Change it, delete it: a commit each.
- Make git unreachable, keep working: the type saves, shows "Not pushed", and goes
  out when git is back.
- Drop the database (or start a new deployment on the same repo), start: the
  types are back. Credentials aren't -- by design (D70) -- and say so.
- Edit a file in the repo by hand, then the same type in the platform: a conflict,
  shown in Settings → Store, resolved by choosing a side; never a silent overwrite.
- A pane set to **run on open** runs once when you open the session -- unless it
  ran a minute ago -- and a dashboard of them is current when you arrive.

### 21.2 The repo

```
<path>/
  plugin.yaml                         id: <namespace>, name, version, contributes: {…}
  credential-types/<name>.yaml
  connection-types/<name>.yaml
  # 4b on: workflows/, steps/<name>/; 4c: templates/; 5: panes/
```

- `plugin.yaml` is §7.1's: `id` is the store's namespace, `contributes` lists
  every item, regenerated on each commit. Its `version` is left alone (§20.6).
- A file is the item's definition and nothing else -- for a credential type its
  label, description, fields, `version`, output template, `inject` and `http_test`;
  for a connection type its label, description, fields and identity types. No
  ids of rows, no users, no timestamps: those are the deployment's.
- `<name>` is the id without its namespace; a pre-4a bare id (`grafana`) is its
  own file name. A colon never reaches a file name.

### 21.3 Namespaced ids, from now on (D78)

- Credential and connection type ids accept `<namespace>:<name>`; the API's id
  checks (`TYPE_ID_RE`, `_TYPE_ID_RE`) learn the prefix. Built-ins and existing
  ids are untouched.
- Creating one in Settings shows the store's namespace as a fixed prefix and asks
  for the name; with no store configured, ids stay bare as today (a store
  configured later writes them as they are).
- Nothing else changes: a connection's `type_id`, a credential's, a manifest's
  `connection_type` are ids like any other.

### 21.4 Tracking what's in the store

The items keep living in their own tables (`credential_types`,
`connection_types`, and later workflows'); the store only tracks them, so no
existing code changes how it reads a type.

- **`store_items`**: `kind`, `item_id`, `path`, `blob` (the git hash of the file as
  last written or read -- what conflicts are judged by), `state`
  (`synced | pending | conflict | error`), `error`, `updated_at`.
- **`store_outbox`**: one row per change, in order: `kind`, `item_id`, `op`
  (`write | delete`), the file's content as it was saved, the user, `created_at`.
  Written **in the same transaction as the change itself**, so a save and its
  pending commit can't come apart.
- **A registry of kinds** (`store.KINDS`): for each, its directory, `dump(row) ->
  dict` and `load(dict) -> row` -- the one place that knows a kind's file. A kind
  added later (workflows, templates, panes) is one entry.
- **What's tracked:** anything saved through the admin API from 4a on, and, the
  first time a store is configured, every non-built-in item that exists (one
  commit, "Add what this deployment already had"). A manifest-seeded connection
  type (D67) is tracked once an admin changes it -- from then on the repo's copy
  is the edited one, and wins over the seed on a restore.

### 21.5 Writing: one writer, through the outbox

- **Any replica, one at a time**: a background task holds a Postgres advisory
  lock while it works, the way background runs claim a lapsed heartbeat (D51), so
  two replicas never push at once and a dead one's work is picked up.
- **It works in a private clone** in the pod (an `emptyDir`; shallow, `--depth 1`),
  never authoritative: `fetch`, reset to the remote branch, then for each outbox
  row in order -- check for a conflict (below), write or remove the file,
  regenerate `plugin.yaml`, commit as the user who saved it (`username
  <username@{author domain}>`), the platform as committer -- then `push`. On a
  rejected push (someone pushed meanwhile) it fetches and replays; files are per
  item, so a replay only stops at a real conflict.
- **A conflict**: the file in the remote isn't the `blob` the item last had (it was
  edited in the repo since). The item turns `conflict`, its outbox rows wait, and
  nothing is written over the other edit. Settings → Store shows both sides;
  **Keep mine** writes ours, **Take theirs** loads the repo's into the database.
- **Unreachable or refused** (network, auth, a protected branch): rows stay,
  items say `pending` with the reason, the task retries with backoff, and
  "Sync now" tries at once. A save is never blocked or failed by git.
- **A new or empty repo or branch** gets a first commit with `plugin.yaml`.

### 21.6 Restoring on start

After `create_all` and the built-ins, before serving: fetch the branch and, for
every file whose item the database lacks, load it (`state: synced`, its blob
recorded) -- **unless an outbox `delete` for it is pending** (deleted here, not yet
pushed), which wins. Then push what is pending. An item present on both sides
with different content is left alone at 4a -- pulling the repo's edits in is
later (§20.4) -- but the next save of it meets the conflict check. A store that
can't be reached at start is reported (log and Settings), and the platform starts
anyway.

### 21.7 Configuration and secrets

- **Helm** `store.git`: `url`, `branch` (default `main`), `path` (default the
  root), `namespace`, `authorDomain`, and `existingSecret` holding either `token`
  (HTTPS) or `ssh-privatekey` with `known_hosts`. Mounted, never inline; the chart
  generates nothing (as with the master key, Argo CD renders without the cluster).
  Set by Helm, Settings shows it locked.
- **Settings → Store** (admins), when Helm leaves it unset: the same fields, the
  token or key chosen from the credential store (an `api_token` or `ssh_key`
  credential) -- through `credential_store.resolve()`, so checked, audited and
  masked like any. Kept in the database, so after losing the database it is
  entered again and then restores. Helm is the way to have a new cluster restore
  itself.
- **The token never touches a URL or an argument**: HTTPS goes through
  `GIT_ASKPASS`, SSH through `GIT_SSH_COMMAND` with the key in a 0600 file in the
  clone's directory; both registered with `masking.py`, and git's own messages
  pass through `mask()` before they're logged or shown. A URL with credentials in
  it (`https://user:token@…`) is refused.
- **Only `https://` and `ssh://` (or `git@host:`)** -- the server fetches what an
  admin types, so no `file://`, `http://` or `ext::`, and git runs with
  `protocol.allow` limited to those (`file` only under the test flag the suites
  and pytest set). The backend image gains `git` and `openssh-client`.

### 21.8 Run on open (D77)

- **`<pane>.refreshOnOpen`**: seconds of freshness, 0 off, unset following the
  session's `refreshOnOpen` -- a key beside `refresh`, so `refresh` keeps its
  meaning and nothing migrates. Session state, synced, kept by templates, set by
  the agent (`set_refresh` gains `on_open`).
- **The trigger is the tab's**: when the session comes on screen in a visible tab
  -- opened, switched to, or landed on -- each pane with it set asks once.
  **The decision is the server's**: the refresh route takes `fresh: seconds` for an
  open and answers "fresh" when the outputs ran within it, under the same lock and
  rules as an interval refresh (another under way, a run going, unreachable for a
  viewer, the floor, never `effects: external`, a live pane or a stream). A pane
  that never ran is stale; one whose required inputs are unset doesn't run.
- **The ⚙'s Auto-refresh section** gains "On open, if older than [5 min]"; the
  session card's Refresh row the same for its default. "↻ on open" shows beside a
  pane's ⚙ as "↻ 30s" does.

### 21.9 Tests and done

- **Backend** (`test_store.py`), against **real git**: a bare repo in a temp dir
  (`file://` under the test flag), no mocks of our own code --
  - a type saved → one commit, as the user, the right file and `plugin.yaml`;
    changed → a commit; deleted → the file gone;
  - the repo unreachable → saved, `pending`, pushed when it's back, in order;
  - the tables emptied → a restart restores them; a pending delete isn't
    restored; credentials are not in the repo at all (every file grepped for a
    secret the test set);
  - an edit pushed from another clone → the next save is a `conflict`, nothing
    overwritten; Keep mine and Take theirs each resolve it;
  - two writers at once → one push each, no lost commit;
  - the token never in a response, a log record, a commit, or `git remote -v`; a
    URL with credentials and a `file://` URL refused;
  - ids with and without a namespace; the existing types' ids unchanged;
  - run on open: fresh within the window answers "fresh", stale runs once, five
    asks at once run once, a viewer who can't reach it runs nothing.
- **Browser** `smoke83` (Settings → Store, a type committed and its state shown,
  Not pushed while the repo is away) and `smoke84` (run on open: a dashboard's
  panes run when the session opens, not again on switching back within the
  window), each failing against the old frontend. The dev stack serves a local
  bare repo for them.
- **Docs**: DEPLOYMENT.md (the repo, its secret, the namespace, what is and isn't
  in it, restoring), CLAUDE.md, PROGRESS.md, §21.10 as built.

### 21.10 As built (2026-10-16)

As planned, with these settled in the building:

- **Modules.** `store.py` holds the kinds (`Kind`: directory, `dump`, `load`,
  `remove`, `builtin`, `seeded`), the configuration, `record`, the writer
  (`flush`, `_apply`, `_settle`), `restore`/`startup`, `sides`/`resolve` and
  `status`; `gitrepo.py` the clone; `routers/store.py` the API (`GET/PUT/DELETE
  /api/store`, `POST /api/store/sync`, `GET /api/store/items/{kind}/{id}` and
  `POST …/resolve`), admins only. `connections.save_type`/`delete_type` take
  the actor and record; `TYPE_ID_RE`, `type_fields` and
  `check_removed_fields` became public for the store's `load`.
- **Keep mine** sets the item's expected blob to the repo's current one and
  queues a write (if none is queued): the next push writes over it, and a
  further edit there conflicts again. **Take theirs** loads the file (or
  deletes the item here if the repo deleted it, refused while something uses
  it) and drops the queued changes.
- **A batch is one commit**: the adoption of what a deployment already had
  ("Add what this deployment already had") is queued with a shared `batch`.
- **`plugin.yaml`** is regenerated from the files present on every commit;
  any other key in it (a name, a version, another kind's list) is kept.
- **The workdir** is `STORE_WORKDIR` (Helm: an emptyDir) or the temp dir, a
  folder per url/branch/path.
- **Status in the browser**: Settings → Store re-reads every 2 s while an item
  is still pending -- Sync now can find the background writer holding the lock
  and answer with how things stood a moment before.
- **Run on open** asks on each arrival -- the session on screen and the tab
  visible -- and the ask waits for the window to be known (a load's state can
  come after the pane is on screen); a pane whose required inputs aren't set
  answers `not_ready`, not a failure.
- **A pane's ⚙ never runs off the window**: its run-on-open row made the menu
  taller, and opened low on a page its last items (saved inputs, the variables
  it follows) sat below the window's edge, out of reach. `Popover` passes the
  room left under its button (`--popover-room`), which the pane menu caps its
  height to and scrolls within.
- `smoke20`'s add-buttons check compares the buttons before and after panes
  move, instead of a fixed list that went stale with Prometheus.
- **Not built**: pulling repo edits in by themselves, read-only mode, tagging a
  store as a release (§20.6).

## 22. Phase 4b in detail: workflows

Planned 2026-10-17 (D82–D86), from §5, §20.2 and §20.7. Workflows are pipelines
with stages, run with parameters on a page of their own (D69, D75); their steps
are the Actions panes already run, so a step needs no code of its own.

### 22.1 Three PRs, each with something to try (D82)

- **4b-1, define and run.** Workflows kept in the store (a `Kind`), granted per
  group, run by hand: parameters, steps of pane actions with `with`, `if`,
  `for_each` and `continue_on_error`, recorded runs. The Workflows page, a
  workflow's page (Build with parameters, history, the definition, access) and
  the run page (stages, their inputs and outputs, live while it runs, Cancel,
  Rerun). The agent lists, starts and reads runs.
- **4b-2, the harder steps.** Steps over a background run (CloudWatch's query),
  approvals -- the step that waits for a person, shared with the agent's
  `effects: external` actions, which then become steps -- `retry`/`timeout`,
  rerun from a failed stage, and the blob store (§8.2) for outputs too big for a
  row, and artifacts.
- **4b-3, the doors.** Investigate a run in a session (its stages' outputs as
  panes, drawn by the pane renderers), make a session repeatable, a workflow pane
  in a session, and the run's own chat ("This run").
- **Later**: triggers -- schedule and webhook, acting as the owner (D81) -- and the
  graph view and editor (D73).

### 22.2 The definition (4b-1)

YAML, written in the workflow's page or by the agent, kept verbatim (comments
and all) as the store's file `workflows/<name>.yaml`:

```yaml
label: Device table check
description: Scans a table and says how many items it holds.
parameters:
  - { key: env, type: connection, connection_type: aws, label: Environment }
  - { key: table, type: text, default: Devices }
steps:
  - id: scan
    pane: tables
    action: scan
    with: { connection: "{{ params.env }}", tableName: "{{ params.table }}", limit: 50 }
  - id: report
    if: "{{ size(steps.scan.outputs.items) > 0 }}"
    note: "{{ size(steps.scan.outputs.items) }} items in {{ params.table }}."
```

- **Parameters**: `key`, `type` (`text`, `int`, `bool`, `choice`,
  `connection`, `connections`), `label`, `help`, `default`, `required`,
  `choices`, `connection_type` -- the pane inputs' own vocabulary, drawn by the
  same kinds of control.
- **A step** is one of:
  - `pane` + `action`: a pane type's action, by its manifest -- a `request` or a
    `handler` (not yet a background run, nor `effects: external`: 4b-2). `with`
    gives its inputs; anything unset takes the input's default, as a pane would.
  - `note`: text, for a summary at the end.
- **On any step**: `id` (unique, what later steps refer to), `label`, `if`,
  `for_each` (a list: the step runs once per item, `item` and `index` in scope,
  its outputs a list of each run's), `continue_on_error`.
- **Expressions are CEL inside `{{ … }}`** (D8): a value that is one template is
  its typed result (a list stays a list); text around templates makes a string.
  In scope: `params`, `steps.<id>.outputs` / `.status`, `item`, `index`, `run`.
  Never a secret: a credential is passed by reference (a `credential` input),
  as panes do.
- **Checked on save** (D83): the schema (strict, like manifests), unique ids,
  every pane and action existing, every expression compiling, and every
  `steps.<id>` naming an earlier step -- so a broken workflow isn't saved, rather
  than failing half-way through a run.

### 22.3 Who may do what (D84)

- **Defining and editing** is an admin's until the Builder grant (Phase 5, D71).
- **Running** is a grant per group, as a pane type is (D65, D75): admins run
  everything. A run acts as whoever started it: every step goes through the
  pane's own access check and its connection's, as the person's own click would.
- **A run's inputs and outputs** are seen by the person who started it, their
  group and admins -- not by every group that may run the workflow: the outputs
  came from the starter's environments, which another group may not reach. The
  others see that a run happened (who, when, status), not what it found.

### 22.4 Running (D85)

- **In-process**, by a runner in every replica (`workflows.manager`): a started
  run is `queued`; a replica claims it (`FOR UPDATE SKIP LOCKED`), runs it on a
  thread, and records each step as it goes (`workflow_run_steps`: status, times,
  the resolved inputs, the outputs -- capped like a pane's (`pane_outputs.fit`) --
  and the error). A heartbeat on the run; one whose replica went away is marked
  failed ("interrupted"), not resumed -- rerunning it is one click.
- **Cancel** is checked between steps and items. **Rerun** starts a new run of
  the same parameters, or changed ones from the form.
- **Live**: the run page reads the run every second or so while it's going. Its
  address is `?run=<id>` on the app's own URL, so it can be sent to someone.

### 22.5 The pages (D86)

As §20.7, with what 4b-1 has:
- **Workflows**: Workflows | Runs. The list: name, the last run's status and
  time, Run. Runs: recent runs across workflows, mine first.
- **A workflow**: Run ▸ opens Build with parameters; run history; Definition
  (the YAML, Validate and Save for an admin, its errors by line); Access (the
  groups that may run it).
- **A run**: workflow and number, status, who and when, the parameters; Cancel,
  Rerun; the stages as a list with status and time; the selected stage's
  inputs, outputs (a table for rows, JSON otherwise -- the pane renderers come
  with 4b-3's sessions) and error.
- **The agent**: `list_workflows`, `run_workflow` (waits a little and answers
  with where it got to), `get_workflow_run`.

### 22.6 Tests

Backend `test_workflows.py`: validation (each refusal names the line's
problem), templating, `if`/`for_each`/`continue_on_error`, a step acting as the
starter (refused for a pane or connection their group lacks), cancel, an
interrupted run, who sees what, the store keeping the YAML verbatim, the agent's
tools. A browser suite: define, run with parameters, watch it finish, open a
stage's rows, rerun, a member's view.

### 22.7 4b-1 as built (2026-10-17)

As planned, with these settled in the building:
- **Where it is**: a **Workflows** row in the rail, under Add and shown whether
  or not the Add list is open, besides the home page's Platform card (moved to
  the top of the rail in 4b-2, D93).
- **Checks point at the field**, not the step: a wrong action at its `action:`
  line, an unknown input at its key under `with`.
- **A note is its own step kind** (`note:`): what a workflow says at the end
  ("3 points from up."), and the simplest step to write.
- **`if` is evaluated once, before `for_each`**; an item's failure under
  `continue_on_error` is kept as `{error}` in that item's place and the step
  still fails (the run carries on).
- **A rerun of someone else's run** needs your own parameters: theirs came from
  their environments and aren't yours to see (D84).
- **The run page's parameters** show by label, a connection by its name.
- **The Builder grant isn't here** (Phase 5): New workflow and the editor are
  an admin's; everyone granted sees the definition read-only.
- **The page draws nothing off screen.** Every page stays mounted; hidden, its
  Workflows | Runs switch sat in the DOM beside Settings' own and selectors
  found two (smoke65). Its place (list, a workflow, a run) is kept in state.
- **The suites' "open session" rows skip `.rail-row-page`**: the Workflows row
  is a rail row, not a session (smoke22, 27, 29, 44 counted it as one).

### 22.8 4b-2: the harder steps (planned and built 2026-10-17, D87–D93)

- **A background-run step** (D87): a pane action with `poll` (CloudWatch's Run)
  is a step like any other. The runner starts it, polls it every `poll.every`
  seconds as the starter until its poll says done -- outputs replaced, or added
  to for an `append` output -- and records what came back. A **stream** (a poll
  with `agent_wait`: MQTT's Connect) never finishes, so the step **listens** for
  `listen` seconds (the action's `agent_wait` unless given), then stops it and
  keeps what arrived. Cancel and `timeout` stop it with the action's own stop.
  A step's connection isn't a `pane_runs` row, so MQTT's `max_running` (five a
  person) doesn't count it; `listen` bounds it (an hour at most).
- **Approvals** (D88): one table, `approvals`, general enough for the agent's
  external actions next: what is asked (`message`), what it will do (`details`:
  the step's resolved inputs), who may decide, until when, and the decision
  (approved / denied / expired / cancelled, by whom, with a comment).
  - **A step waits on one** when it says `approval:` -- a bare gate is a step
    with only `approval:` -- or, always, when its action is `effects: external`
    (the HTTP client's Send, MQTT's Publish), which become steps this way.
  - `approval: { message, by, timeout }`: `by` is `anyone` who may read the run
    (the default: the starter, their group, admins), `others` (the same, not the
    starter: a second pair of eyes) or `admins`; `timeout` is how long it waits
    (default a day).
  - **Waiting holds no thread**: the step and the run are `waiting`; Approve
    queues the run again and the runner carries on from its records; Deny or
    expiry fails the step (`continue_on_error` carries on past it). Cancel while
    waiting cancels the approval.
  - Whoever may decide hears of it live (the event kind `approvals`): the rail's
    Workflows row counts what waits for you; the run page shows Approve / Deny
    with the details. The agent sees that a run waits; deciding is never its.
- **`retry` and `timeout`** (D89), on any pane step: `retry` (0–5) more attempts
  after `retry_delay` seconds (default 5) -- of the call alone, once its inputs
  are worked out, and not after a refusal (401, 403, 404). `timeout` bounds each
  attempt: a call (default 10 minutes) runs on a thread of its own and is
  abandoned past it; a background run (default an hour) is stopped. A step
  records how many attempts it took.
- **Rerun from a stage** (D90): from any finished run, by someone who may read
  it: a new run of the old run's *definition* and parameters, the stages before
  the chosen one copied as they were (marked as reused), the rest run anew.
  Resuming after an approval is the same: a run carries on from its records,
  reading earlier stages' outputs back.
- **The blob store** (D91, §8.2, D7): `blobs.py`, `filesystem` (a directory;
  the chart refuses ReadWriteOnce with more than one replica) or `s3` (any
  S3-compatible store, the platform's own AWS identity -- IRSA on EKS). Rows in
  `blobs` (key, size, sha256, content type, owner, group, what it belongs to,
  expiry); a download is the backend's, after the run's own read check
  (`GET /api/blobs/{id}`). A step's outputs over 1 MiB keep their cut-down copy
  in the row (what the page shows, `trimmed`) and the whole, up to 64 MiB, as a
  blob, which later steps and a resumed run read whole; "Download all".
- **Artifacts** (D92): `artifact: { name, value, format }` (`json`, `csv` for
  a list of rows, `text`), written to the blob store, listed on the run page
  and the step, downloaded by anyone who may read the run. Run blobs are kept
  `STORAGE_RETENTION_DAYS` (90), cleaned up hourly by the runner; a deleted
  workflow's runs take theirs with them.
- **The rail** (D93): the platform's own pages -- Workflows now -- sit under the
  brand, above Sessions.
- **After it, for the examples** (`examples/workflows/`, checked by the tests):
  templates have CEL's strings and math extensions (a summary of rows needs
  `join`), and a map or list given to a `text` input is sent as its JSON (an
  HTTP body written as a CEL map reached the API as Python's repr).

### 22.9 Parameters whose choices load (2026-10-19, D94)

Reported on trying the examples: the CloudWatch one asked for a log group by
name, while its pane lists them once an environment is picked.
- **`options_from: { pane, input, with }`** on a text parameter: `input` is a
  pane input with a loader (its manifest's `options.action`); `with` gives the
  loader's inputs as templates over the *other* parameters only (no `steps`,
  checked on save). `POST /api/workflows/{id}/parameters/{key}/options` runs it
  through `run_handler`/`run_request` as the caller -- their grant, their
  connections -- and flattens what comes back: `{options}` as it is, a
  two-level picker's `{groups}` (one per environment) into one list, a group
  that failed as an error. Until the parameters it reads are set it answers
  `needs`; a loader's failure is said, never raised.
- **The form** lists again a moment after a parameter it reads changes, shows
  "Choose Environment first" / "N to choose from" / the loader's error, and
  keeps the field typeable (a datalist): the list helps, it doesn't rule.
- **`multiple: true`** makes a text parameter a list of strings: chips, a pick
  from the list or Enter adds one; a lone value given (the agent, an old
  rerun) is a list of one.
- With it, from the same report: the form's rows have a gap of their own (a
  help line ran into the next row's field) and its controls are the row's
  28px, level with their labels; a stage's "Inputs" is the detail's 13px.

### 22.10 4b-3: the doors (planned and built 2026-10-19, D95–D98)

- **Investigate in a session** (D95): the run page's button, and the agent's
  `investigate_run`, for whoever may read the run. A new session of theirs,
  named after the run, stacked: a pane per stage that ran a pane action, its
  inputs as the step ran them (`_tz` and defaults left out; put in the shape
  the browser stores through the agent's own `convert` -- a tagged Set where
  the pane keeps one -- with what they imply: a step sets only CloudWatch's
  log groups, and the pane said "0 environment(s) selected"), its outputs
  written as the pane's own record (`pane_outputs.write`, `ranAt`), so the
  pane renderers draw them -- CloudWatch's rows as logs, a table as a table.
  A `for_each` stage gives a pane per item, the first ten. Notes, files and
  decisions go in the session's description. Nothing runs again: it is what
  the run found, to dig into.
- **Make repeatable** (D96): the session card's button, for admins (editing
  is theirs, D84). `POST /api/workflows/draft` turns the session into YAML: a
  step per pane whose kind has a main server action (handler, request or
  background run), its id from the pane's title, `with` its inputs that
  differ from their defaults; every connection-valued input becomes a
  parameter (one per distinct connection, defaulting to it), and a log-group
  or index selection keyed by that connection is written over the
  parameter; an input the others imply (the environments of the log groups)
  is left to the step. Several lines of text are a `|` block. The editor
  opens with it; nothing is saved until Create.
- **The workflow pane** (D97, `manifests/workflow.yaml`): `workflow` (its
  options listed by `platform.workflows.list`, the workflows the person may
  run -- a picker with no `load_label` now loads by itself once what its
  loader requires is set, as the manifest schema always said; it drew
  nothing before), `params` (name/value rows),
  Run (`workflows.start`, a background run: `workflows.poll` writes Summary
  and Stages every 2 s until the run finishes, `workflows.cancel` is Stop).
  A run started there acts as the person who pressed Run, like any run.
  Parameters arrive as text, so a connection may be named, not only
  numbered (`coerce_params` matches a reachable connection's label), and a
  list may be comma-separated.
- **This run** (D98): `workflow_runs.chat` (turns, the last 40), read and
  appended by the run's readers (`GET/POST /api/workflow-runs/{id}/chat`,
  merged by turn id, so two people's messages don't overwrite each other).
  The chat request's `scope: "run"` with `run_id`: checked readable, the
  turn reads the run first and the prompt keeps to it; its token is a
  Global turn's otherwise (it may open a session to investigate). The agent
  panel shows "This run" instead of "Session" while a run is on screen.

## 23. Phase 4c in detail: published templates (planned and built 2026-10-19, D99–D102)

From §20.8 (D76). One PR, with two fixes reported beside it.

- **Publish** (Settings → Library → Templates → a template → Publish…, admins):
  an id (namespaced with a store, `store.full_id`), a name and a description.
  `POST /api/templates {saved_session_id, id, label, description}` makes it
  portable (`templates.portable`, below), stores it in `published_templates`,
  records it with the store (`Kind` `template`, `templates/<name>.yaml`,
  `contributes: templates`) and answers with what it changed, which the form
  shows. Library's **Published** tab renames, re-describes and unpublishes.
- **Portable** (D100), by each pane's manifest: an AWS `connection`/
  `connections` input is removed and the pane relinked to the Environment
  variable, which is left defined and empty; `log_groups` are merged under
  `$environment`; non-AWS connections, `credential` inputs and
  `opensearch_indices` (their domains' endpoints) are removed; a `headers`
  row whose name matches auth/token/secret/password/cookie/api key/session/
  signature keeps its name with an empty value; a `workflow_params` input
  drops the workflow's connection parameters. `__savedStateVersion` goes.
- **Offered** (D101, D102) to whoever's group may use each of its panes:
  `GET /api/templates` (an admin gets every one, `usable` saying which are
  theirs to open), the default page's **Ready-made sessions** cards, and the
  Templates heading of Add and the strip's ＋ (published ones first).
- **Opened** (D101): `POST /api/templates/{id}/open {environment}`. A
  template whose panes follow the Environment variable needs one the opener
  can reach; the server sets the variable, runs `variables.apply` per pane,
  re-keys `$environment` log groups to it, and creates the session
  (`templates.instantiate`). The browser opens it (`openFromServer`). From
  Add with one environment it opens at once; with several, the default
  page's card asks (`sessions/published.ts`).
- **The agent**: `get_context.templates`, `open_template(template_id,
  environment)`; refused in a session chat, like `create_session`.
- Left for later: categories for templates in the catalogue (they are their
  own section for now), updating a published template's panes from a newer
  saved copy (unpublish and publish again), and templates in a plugin
  installed from elsewhere (Phase 7).

**Fixed beside it** (reported after 4b-3):
- **The workflow pane asks for its workflow's parameters**: a manifest input
  type `workflow_params` (`of:` the input holding the workflow) is drawn by
  the Workflows page's own fields (`components/WorkflowParamFields.tsx`):
  picking a workflow shows its parameters, an environment by name, choices
  listed where the workflow lists them. Name/value rows left a person to
  know the keys, and Run failed with "Fill in Environment.". The agent sets
  it as key -> value (`panes.convert`), rows from before accepted.
- **S3's filename search reaches the whole bucket**: it scans for up to 8 s
  (`SEARCH_SECONDS`) rather than 20 pages, matches the path below the
  folder, resumes after the last key it looked at (`after:<key>`, so Load
  more no longer skips the rest of a page), and says how many files it has
  searched while the bucket has more (`searched`, summed by Load more;
  `searchGoesOn`). A file past the first 20,000 keys was "Nothing here.".

**Fixed after it** (reported after #128):
- **The Workflow pane links to its run**: a `link` output render (`{label,
  href}`); a link into the app is shown in place (`followAppLink`), the
  Workflows page taking the screen it asks for (`openWorkflowScreen`).
- **The agent shows a workflow or a run** (`open_workflow`): it returns
  `show: {href}`, passed on by the agent service like `session_id` and
  followed by the browser; a run `run_workflow` waited on carries one too,
  followed with Follow on. It had said it couldn't.
- **S3: a path is a prefix, as `aws s3 ls` does it.** A search with a `/`
  (`POP/69/`) lists that prefix with the delimiter -- S3 finds it at once --
  and only when nothing is there falls back to the name scan. Scanning for it
  as a substring had gone through 33,000 keys of a real bucket without
  reaching `POP/`. The server says which it did (`searchNote`).
- **A published template is offered once**: its row keeps the saved template
  it came from (`saved_session_id`), and its publisher's Add lists offer the
  published one in that one's place (Library marks it "Published").

## 24. Phase 5 in detail: the Builder (planned 2026-10-19, D103–D108; 5-1 and 5-2's agent built)

Three PRs (D104), each with something to try:

- **5-1, pane types as YAML** (built): the Builder grant per group
  (`builder_enabled`; admins always), the Builder page (the rail's Builder
  row, for builders): a list of the pane types built here; an editor with an
  Id, the YAML (from a working starter or any bundled pane's own file as an
  example), **Check** (every problem with its line: the strict model's, and a
  built pane's own -- an unknown handler or live function, a `flag`,
  `connection_types`, a bundled id), **Create**/**Save**, **Delete** and
  **Open in a session**; and what a definition can name (the handlers and
  live functions there are). `builder.py`, `routers/builder.py`
  (`/api/builder/schema|examples|panes|check`), the store `Kind` `pane`, the
  registry's `set_built` (bundled stay cached; built merge in; the agent's
  `KINDS` rebuilt in place), the catalogue's categories, and Users → Groups'
  Builder switch.
- **5-2, the agent's build tools** (built, D107-D108): beside an open
  editor -- the Builder's, or a workflow's on the Workflows page -- the agent
  panel's second tab is **Building**, selected as the editor opens. A turn
  there is sent as `scope: "build"` with the editor's kind, id, title and
  text as it is now (unsaved); `routers/agent.py` lets only whoever may edit
  it ask (a Builder for a pane type, an admin for a workflow). It opens by
  reading `build_reference` (the models' own fields, the input types,
  renders, handlers and live functions there are, the panes and actions a
  step can run, and which examples exist), and the editor's text is attached
  to the message (`prompt.turn_reads`). Four generic MCP tools, each checking
  the same permission again: `build_reference`, `read_definition` (any
  example's YAML), `check_definition` (Check's own errors, with lines) and
  `propose_definition`, which checks the draft and, only if it has no
  problem, returns it as `propose` -- passed on by the agent service like
  `show`, and put in the editor by the browser (`agent/buildFocus.ts`) with
  a notice that it isn't saved. The agent never saves: the user's Check and
  Save do. Its conversations are per editor and in memory, like Global's.
- **5-2b, the form and the preview**: a form editor over the same definition
  (D73), and a preview that draws the draft beside the editor and runs its
  actions on a real connection as the builder -- a tool the agent gets too.
- **5-3, steps and workflows for builders**: workflows editable by a
  group's Builder, not only admins; declarative HTTP steps and composed
  steps (§20.3) reusable across workflows.

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
