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

_Started 2026-10-04. Status: **proposal, partly decided.** D1–D5 are settled (§11); the
rest is a proposal until it reaches the Decision log._

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

So "copy S3 URL" is *server: presign → client: copy*, and "copy S3 URI" is just
*client: copy* with a template. Both are configurable in the builder with no code: pick
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
  §4.4).

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
4. **State compatibility:** a ported pane must read the same session-state keys as
   before, or migrate them on load (CLAUDE.md: "assume any stored shape you invent
   will need a migration"). Saved sessions and templates must open unchanged.

Panes that need more than "run an Action, draw its output":

- **MQTT** keeps a live browser connection today. As a manifest pane it becomes:
  - a server-side **subscription Action**, which holds the MQTT client with the
    connection's credentials;
  - a **stream** output fed over the existing event-stream plumbing;
  - a **publish** Action.

  This moves the live connection to the server. It is more work, but it makes MQTT
  usable by the agent and by workflows, which today it can't be (CLAUDE.md: "MQTT and
  JWT aren't agent-drivable on purpose"). Publishing stays behind the approval step.
- **Base64, JWT, Diff** compute purely in the browser today. They become tiny server
  Actions; the latency is negligible and they gain agent and workflow use. A pasted
  JWT is a secret, so its input is marked `sensitive`: kept out of session state and
  the agent's history.
- **HTTP client:** its request is already a server Action (SSRF-guarded). Sending
  stays behind the approval step.

_Inventory of today's panes (inputs, dynamic lists, outputs, output actions): see
§4.5._

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
- **Expressions:** one language for templates and conditions, `{{ … }}` with filters.
  Recommendation: **Jinja2 in its sandboxed environment**.
  - It is Python-native and well known (Ansible uses it).
  - Conditions and data selection fit in it.
  - Expressions are evaluated server-side with time and size limits, and can't reach
    secrets: only parameters and outputs.
  - Credentials are passed by reference (`credential` inputs), never interpolated
    into a string.

  Alternative: CEL, which is safer by design but unfamiliar. See open questions.
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
- **Marketplace page:** reads one or more **registry repos**. Each registry is a repo
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
| UI renderer | plugin | a **sandboxed iframe** (`sandbox`, no same-origin), postMessage protocol | draw what it is handed; never the session cookie |

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

## 9. Roadmap (proposed order)

Each phase ships something usable on its own. Order chosen so each phase builds the
foundation the next one needs.

- [ ] **Phase 0: this plan.** Discuss, settle the open questions, and record
  decisions.
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
    - No visible change.
  - **3b, the generic renderer and components:**
    - Input cards and dynamic options.
    - The output components and output actions (§4.3), extracted from today's panes.
    - Panes ported in the order of §4.4, each passing its own browser suite
      unchanged. MQTT moves its connection server-side.
  - **3c, permissions and a first new pane:**
    - Per-type permissions replace the boolean flags.
    - One new non-AWS pane built only from a manifest (e.g. a generic HTTP/JSON API
      pane), to prove the model on something that isn't a port.
- [ ] **Phase 4: Workflows.**
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
  `platform_sdk` package.
- [ ] **Phase 7: Plugins and the marketplace.** `plugin.yaml`, install from git (tag,
  SHA and checksum pinned; private repos through credentials), a registry repo
  format, the Marketplace page, upgrade and rollback, permission review on install.
- [ ] **Later:** pluggable secret backends (Vault, AWS Secrets Manager), personal
  credentials, workflow triggers (cron, webhook), graph workflows, dashboards (saved
  views), more providers as first-party plugins (Kubernetes, GCP, GitHub…).

## 10. Open questions (to discuss)

Settled questions move to the Decision log (§11).

1. **Where runs execute at first:** in the backend process (simplest; fine for
   built-ins and declarative steps) until the runner exists in Phase 6?
2. **Registry:** one public registry repo owned by this project, plus private ones per
   organisation? Who reviews PRs to the public one?
3. **Master key:** a Kubernetes Secret to start (Helm value), with KMS later?
4. **Global credentials:** may non-admin groups use them? Only by explicit grant?
5. **Naming:** "connection" vs "resource" vs "integration"; "Action" vs "step" vs
   "operation"; "Builder" vs "Studio"; "effect" for client-side output actions. This
   vocabulary will be in the UI and in plugin manifests, so it is worth settling
   early.
6. **Expression language for workflows** (§5.1): Jinja2, sandboxed (familiar, as
   in Ansible), or CEL (safer by design, less familiar)?
7. **MQTT on the server** (§4.4): the live connection moves from the browser to the
   backend or runner, making it usable by the agent and workflows. Acceptable? It
   costs one server-side subscription per open MQTT pane.
8. **Where files live:** exports, workflow artifacts and large outputs need storage.
   Postgres (simple, size-capped) or an object store the platform owns (an S3 bucket
   or MinIO in the Helm chart)?
9. **Effects from plugin iframes** (§4.3): which effects can a sandboxed plugin
   component ask for without the user confirming? `copy` and `toast` probably can;
   `open_link` and `download` perhaps should ask.
10. **Session state for ported panes** (§4.4): keep each pane's current state keys
    forever (no migration), or move all panes to one shape (`<pane>.in.<key>` /
    `<pane>.out.<key>`) with a one-time migration on load?
11. **Run history retention:** how long are workflow runs, logs and artifacts kept,
    and per workflow or globally?

## 11. Decision log

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-10-04 | **An environment is a named group of connections** (§3.1). It stays the unit of group access; today's environments become one AWS connection each, keeping their ids. | "Do this in Prod" keeps meaning one thing for any provider. |
| D2 | 2026-10-04 | **Handlers are Python only.** Each plugin or builder step can bring its own dependencies, locked and installed into an isolated venv per plugin version (§8.1). | Matches the backend and keeps one runtime to secure. Per-plugin venvs keep dependency conflicts away from the platform and from other plugins. |
| D3 | 2026-10-04 | **Output components are rich and configurable in the builder**, including output actions (copy, export, open link, attach to the agent, drill-down…). Each is an optional server Action plus a client effect from a fixed vocabulary (§4.3). | Today's panes already do this by hand; built panes must be able to do the same. A fixed effect set keeps browser-side code ours. |
| D4 | 2026-10-04 | **Workflows are a list of steps** with dependencies (by reference), conditions (`if`), loops (`for_each`) and nested groups (§5.1). Not a graph to start. | Easy to author and read; covers dependencies, conditions and loops. Parallelism can come later without a format change. |
| D5 | 2026-10-04 | **All panes behave the same:** every pane, built-in included, is a manifest drawn by one renderer with one component set. Today's panes are ported (§4.4). | Gives the builder and plugins everything today's panes can do, and lets the agent drive every pane the same way. |

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
- Backstage plugin architecture (frontend/backend plugins, extension points):
  [Backstage: architecture overview](https://backstage.io/docs/overview/architecture-overview),
  [Backstage: extension points](https://backstage.io/docs/backend-system/architecture/extension-points)
