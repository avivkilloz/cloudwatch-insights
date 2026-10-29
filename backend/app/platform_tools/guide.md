# Working with the platform through its MCP tools

This guide is for an MCP client working *as one user*: Claude Code in their
terminal with a personal access token, or the platform's own agent. Every tool
acts with that user's group: their environments, their identity on each
connection, the pane types they may use. Nothing here reaches further than
their own screen would.

The words the platform uses:

- **Session**: a named workspace holding panes side by side. Each user has
  their own sessions, and some are shared with others.
- **Pane**: one instance of a **pane type** in a session, such as a CloudWatch
  query, an S3 browser or an HTTP client. A pane has *inputs* (what the user
  sets), *actions* (what runs) and *outputs* (what came back). The user sees
  every change a tool makes to their panes, live.
- **Environment**: a named group of **connections**. An AWS account and region
  is one connection; an HTTP API's base URL is another.
- **Pane type**: a YAML *manifest* that describes a pane. A pane type built in
  the platform can have Python files beside it.
- **Workflow**: steps run the same way each time. A step is a pane's action,
  a **step type** or a note. Each run is kept.
- **Builder**: the page where pane types, step types and workflows are made.
  Whatever is being built and not yet saved is a **draft**, which belongs to
  its user.

## Looking and doing

1. `get_context` comes first. It returns the environments, the pane kinds
   with their inputs, and the open sessions. Answer from what it returns,
   never from memory.
   - Its `on_screen` lists what the user's browser tabs show, the one in
     front first: a session, or a Builder editor and its draft. "Here" and
     "this" mean the first one.
   - `viewing_session` is the session on screen, described in full.
2. To show something, put it in a pane:
   - `create_session`, or `add_pane` to the session the user is viewing.
   - `set_pane_inputs`, then `run_pane`. The rows land in the pane, and you
     get a sample back.
   - `inspect_row` shows one row in full, including its detail.
3. `list_options` lists the values a picker input can take: log groups,
   tables, buckets and so on.
4. When a run errors or returns nothing, look at the input first: the query,
   the filter, the environment. Try another form before you call a feature
   missing.
5. Some actions change something outside the platform, such as an HTTP send or
   an MQTT publish. Tools never run these. The user does, from the pane.
6. Workflows:
   - `list_workflows` lists them.
   - `run_workflow` runs one and waits up to `wait_seconds`.
   - `get_workflow_run` reads a run.
   - `investigate_run` opens a session holding what a run found.

## Building: pane types, step types, workflows

What you build is a **draft in the user's Builder**. You never save; the user
reviews the draft and presses Save. Saving is theirs because a saved pane type
is at once usable by their group.

### The loop

1. **Pick the draft.**
   - `list_drafts` lists the user's drafts.
   - `open_draft(kind, definition_id=…)` changes a saved pane type, step type
     or workflow.
   - `open_draft(kind, start_from="recipe:…")` starts a new one from the
     closest recipe, which is better than a blank page.
   - `open_draft(kind)` with neither starts from the starter.

   - `open_draft(on_screen=True)` takes the editor the user has open in the
     Builder (`on_screen` names it). If that editor already has a draft, you
     get that one; if not, one is made and their editor takes it.

   Each of these gives a `draft_id`. Pass it to every tool below. If the user
   has that draft open, their editor follows each change you make, live.
2. **Read before writing.**
   - `build_reference(kind)` lists every field and what it means, with the
     handlers, input types, renders, examples and rules. The same text is the
     resource `platform://reference/<kind>`.
   - Read the closest recipe in full, its files included:
     `read_definition("pane", "recipe:<name>")`. A recipe's comments explain
     why it is built the way it is.
   - `describe_aws_operation(service, operation)` returns botocore's model of
     an AWS call: what it takes, and where its lists and fields are in the
     reply. It makes no AWS call. Read it before naming any reply path.
3. **Change the draft by path, by line, or by file. Never send the whole
   definition again.** Use `change_definition(changes, draft_id=…)`.
   - **By path:**
     - `{"op": "set", "path": "actions/list/request/rows", "value": …}`
     - `{"op": "add", "path": "layout/Results/items", "value": …}`, with
       `before` if the order matters.
     - `{"op": "remove", "path": "…"}`

     A path part is a key, or a list item named by its id, key or title,
     `field=value`, or `[index]`.
   - **By line:** `{"op": "lines", "from": 10, "to": 12, "text": "…"}`, using
     the numbers `read_draft` shows.
   - **By file:**
     - `{"op": "file", "name": "jobs.py", "text": "…"}` writes a file, and
       `"remove": true` removes it.
     - `{"op": "lines", "file": "jobs.py", "from": …, "to": …, "text": …}`
       changes some of its lines.

   Add everything a part needs in one call: its action, its output, its card
   and its file. Then nothing names what isn't there yet. Each call checks the
   draft and returns every problem with its file and line.
4. **Check, then try.**
   - `check_definition(draft_id=…)` runs the same check as Check and Save.
   - `try_definition(environment=…, draft_id=…)` runs the main action as the
     user and opens the first row. It reports what came back empty and why.
     Ask the user which environment to try it on; `try_definition` without one
     lists the environments it could use.
   - `preview_definition(action, inputs, draft_id=…)` runs one action and
     shows its reply. Use it to see where the rows really are.
5. **Propose.** `propose_definition(summary, draft_id=…)`:
   - It checks the draft first. A draft with problems is refused, unless you
     pass `even_with_problems` because the user asked for it as it is.
   - It leaves the draft in their Builder with your summary in its Building
     chat, and answers with where to find it: Builder → Panes → the draft, or
     `/?draft=<id>` on the platform's address.
   - Tell the user to open it there, look at it, and Save.

If the user types in the open draft while you change it, both edits land
in one draft, in order. Their editor shows each of your changes as you make
it, and a save of theirs made on an older version is refused rather than
written over yours. Read the draft again (`read_draft`) before a change if
they may have typed since.

### Pane types: what works

- **An action is one of these:**
  - A **request**: an HTTP GET on a connection of an HTTP type, or, with
    `service` and `operation`, any AWS *read* API on an AWS connection.
  - A **handler** from the reference's list.
  - A **live function**.
  - **Code**: a Python file.

  A pane for an AWS service that no handler covers is an AWS request. It can
  always be built.
- **An AWS request's `rows.at` and columns are fields of the operation's
  reply.** Read them from `describe_aws_operation`; never guess.
- **Two requests in one pane each name their own `output`.** Otherwise both
  write `rows`, and running one clears the other.
- **A new list needs three things in one set of changes:** its action, its
  output (`render: table`) and a layout item showing it. That item's toolbar
  holds the action's button.
- **Modes.** For a choice input whose button does something different in each
  mode:
  - Write one action per mode, each with `main: {input: mode, equals: value}`.
  - Show each button with `when` for its mode.
  - Actions have no `when`; layout items do.
- **Rows that open** to show one row's detail:
  - The table's `config.detail` names a row action: an action whose `args`
    are read from the row. `config.expand` names a view key declared in
    `views`.
  - `args` read the row by its column names. Write `row.Job ID` when the
    columns say `Job ID: jobId`. A fan-out across environments has
    `row.Environment`.
  - A detail's templates read `d`, which is what the row action returned.
- **Per-row values.** If each row needs a value that only another call returns
  (a count from a Describe per row, say), the action that lists the rows
  becomes code. It lists the rows, makes the call for each one, and returns
  the rows with those columns. Another action can't add columns to rows that
  are already listed.
- **Export with detail is built in.** Set the table's `config.detail.include`
  to a label and `merge` to the detail's fields. Export then carries each
  selected row's detail. Never write an export action: code can't see which
  rows are selected.
- **Clear** is a card's `clear: [output keys]`, never an action.
- **Column paths are not JMESPath.** A list item is picked by a field, as in
  `Tags[Key=Name].Value`.
- **Keep what already works.** Change or add what's asked, and never replace a
  working action, input or card.

### Code

- **Where code lives.** Code is a Python file beside the YAML that defines
  `run(inputs, ctx)`, named by the action as `code: {file: jobs.py}`. Never put
  Python inside a YAML string.
- **Where it runs.** It runs in the platform's runner, as whoever uses the
  pane. It sees only its `inputs` and `ctx`. A row action's inputs are its
  `args`.
- **What `ctx` offers:**
  - `ctx.aws(connection, service, operation, params)` makes an AWS call.
  - `ctx.http(connection, path, …)` makes an HTTP call. It takes one of the
    user's connections, never a URL of its own.
  - `ctx.name(connection)` gives the environment's name.
  - `ctx.log(...)` writes to the run's log.
- **What it returns.** It returns the outputs the action declares.
- **Packages.** Third-party packages go in `requirements.txt`, one name a
  line. Check and Save lock that file into `requirements.lock`, which only the
  platform writes.

### Workflows and step types

- **Workflows.** A workflow's steps are:
  - pane actions, as `pane`, `action` and `with`;
  - step types, as `step` and `with`;
  - notes.

  Templates are CEL in `{{ … }}` over `params`, `steps.<id>.outputs` and
  `item`. Read `build_reference("workflow")` and the examples it names.
- **Step types.** A step type is one of these:
  - an HTTP request on a connection;
  - a chain of steps;
  - code, with `changes: true` when it changes something.

  Anything that changes something asks a person before it runs.

## Resources and prompts

- `platform://guide` is this guide. The `read_guide` tool returns the same
  text.
- `platform://reference/pane`, `/workflow` and `/step` are what
  `build_reference` returns, for this user.
- `platform://recipes` lists the recipes, and `platform://recipes/<name>` is
  one recipe with its files.
- The prompts `build_pane` and `build_workflow` start the building loop above
  from a description in plain words.
