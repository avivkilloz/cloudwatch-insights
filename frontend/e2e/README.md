# Browser suites

Playwright scripts that drive the real app against a real backend. They are the
only test coverage the frontend has, and they are not part of `npm run build` or
CI — you run them yourself, against a dev stack, when you have changed the UI.

They are plain `.mjs` scripts rather than a test runner's files: each one logs
in, does a sequence of things a person would do, and prints `OK:` / `FAIL:` per
assertion. `harness.mjs` holds what they share.

## Running them

You need Postgres, the backend and the frontend up (see `PROGRESS.md` at the
repo root for the exact commands), with an admin account whose password matches
what the suites use.

```bash
cd frontend
node e2e/run-all.mjs          # every suite, one line each — about 25 minutes
node e2e/run-all.mjs 29 33    # just those two
node e2e/smoke33.mjs          # one suite, with all of its output
```

Configuration, all optional:

| variable | default | what it is |
| --- | --- | --- |
| `E2E_BASE_URL` | `http://127.0.0.1:5179` | where the frontend is served |
| `E2E_USER` / `E2E_PASSWORD` | `admin` / `SmokeTestPass123!` | the account they sign in as |
| `E2E_SHOT_DIR` | `e2e/screenshots` (git-ignored) | where screenshots land |
| `E2E_PLAYWRIGHT` | — | an installed Playwright to import, if `playwright` does not resolve |
| `E2E_CHROMIUM` | — | a Chromium executable to use instead of Playwright's own |

`smoke45`, `smoke46`, `smoke47`, `smoke56` and `smoke57` (the platform agent) also need the agent container running with the
scripted stand-in model, and the backend pointed at it -- a real model would
answer differently every time:

```bash
cd platform-agent
uvicorn dev.fake_llm:app --port 4010 &
LITELLM_BASE_URL=http://127.0.0.1:4010 LITELLM_API_KEY=x AGENT_MODEL=fake \
  PLATFORM_MCP_URL=http://127.0.0.1:8000/mcp uvicorn app.main:app --port 8100 &
# and start the backend with AGENT_URL=http://127.0.0.1:8100
```

Without them, those five fail and every other suite is unaffected (22 and 23
only check that a question asked in the agent panel's Global tab reaches it).

`smoke58` and `smoke59` (credentials) need the backend started with a master key,
e.g. `PLATFORM_MASTER_KEYS="dev:$(python -m app.keys generate)"`; without one,
credentials are off and both fail on their first check, saying so.

`smoke85` (workflows) runs Prometheus steps against a `.fake` host, so it needs
the faked backend below too; so does `smoke86` (approvals, artifacts, rerun
from a stage), whose approved step sends HTTP to a `.fake` host. Its artifact
is written to the backend's `STORAGE_PATH` (default `/data/files`): start the
backend with a directory it can write, or the run fails at that step.
`smoke89` (the Workflow pane's parameter form; S3's search, its AWS part faked
in the page) and `smoke90` (published templates: publish, open for an
environment, run the CloudWatch pane it made) need the faked backend too.

`smoke92` (the Builder: a pane type made, checked and opened as a member of a
builder group) needs nothing beyond the backend.

`smoke93` (the agent panel's Building tab beside the Builder's and a
workflow's editor, through the fake model's `build <label>` script, run by the
Builder's loop) needs the agent and the fake model running.

`smoke97` (the Builder's form over the starter: edits back in the YAML as
only the lines changed) needs nothing beyond the backend.

`smoke100` (5-3, as a builder: a POST step type checked, tried and created
in the Builder's Steps, then used in a workflow of their own -- no
Access section -- approved and sent) needs the faked backend (a `.fake` host;
`/api/dev/fake-http/last` says what it was sent).

`smoke105` (the rail's pages: no Agent row or page, Workflows and Builder with
icons, the same icons on the strip while the rail is hidden, and a stored view
of the Agent page landing home) needs nothing beyond the backend.

`smoke115` (D159: a pane draft naming a missing connection type says so in
its Needs line and at Check's line, "Make it" opens Connections with that id,
and made, both say it's there; a credential type's editor keeps its draft;
Claude Code works on it on screen, live; and the Building tab beside it puts
its change in the form) needs the agent and the fake model.

`smoke114` (D158: as a member of a builder group, the Builder's Connections
and Credentials make a connection type and a credential type -- the latter
written as YAML, then seen in the form -- each the group's; an admin's type
opens read-only saying why; one a credential uses says it's an admin's now;
an admin sees them in Settings) needs only the stack.

`smoke113` (D157: with the session on screen, an access token's
`get_context` names it as on screen and "here", and a pane added there shows
at once; with a new pane's editor open, `open_draft(on_screen)` gives it a
draft the editor shows, each later change shows live with the user's typing
kept, and a proposal lands in its Building chat) needs only the stack.

`smoke112` (D156: an access token made in Settings, shown once with the
`claude mcp add` line; with it, JSON-RPC to `/api/mcp` opens a Builder draft,
changes and proposes it, and `/?draft=<id>` opens it with the proposal in its
chat; revoked, refused at once; a first `.py` brings `requirements.txt`) needs
only the stack -- admin must be in a group with the agent.

`smoke111` (D155: a new pane asked for in plain words starts from the
closest recipe -- picked by its words, the fake model naming none -- the
starter replaced by it, its files beside it, and a draft with work in it
never replaced) needs the agent and the fake model.

`smoke110` (D154: a built pane's table exports its checked rows with their
detail -- the Lambda recipe saved as is, "Include configuration" ticked, the
JSON export carrying the `merge` fields its row action fetched) needs the
backend as `dev.fake_aws:app` (Lambda faked for an account 0000…).

`smoke109` (the Builder tries its draft, D153: a clean draft with
connections offers the environments to try it on -- buttons, a dropdown past
six; a pick runs it there and says what came back, its first row opened; a
later turn is tried there without asking) needs the agent and the fake model,
and the backend as `dev.fake_aws:app` (Lambda faked for an account 0000…).

`smoke108` (the Building chat: a draft left with problems offers "Fix what's
left", which asks for them to be fixed; only on the last turn, not while one
runs) needs the agent and the fake model ("never clean").

`smoke107` (the Builder's editor: "+" the last of its tabs, a file named in a
tab of its own, Esc cancelling; the Preview card there only while Preview is
pressed, the editor otherwise full width, "Draw again" for a stale drawing)
needs nothing beyond the backend.

`smoke106` (6-2, as a builder: the + tab's requirements.txt, locked by Check
into a read-only requirements.lock with hashes, the preview's code importing
the package from the runner's venv; an option line refused by its line; the
lock gone with requirements.txt) needs the runner and the faked backend with
`RUNNER_URL` (as smoke103), and the backend reaching a package index: PyPI
(it locks `six==1.16.0`), or `DEPS_INDEX_URL` for a mirror.

`smoke104` (6-1b, as a builder: a pane started from code is a workspace --
pane.yaml and devices.py, the + tab's helpers.py imported by it and previewed;
Check's problem by file and line, its tab marked and clicked open; the draft's
files back after a reload; the fake model's `use code …` writing shaped.py and
fixing it by its line) needs the runner, the agent, the fake model and the
faked backend with `RUNNER_URL` (as smoke103).

`smoke103` (6-1, as a builder: a pane whose action is code, previewed --
reaching an API through `ctx.http`, its log under the preview -- code that
fails naming its line, created and run in a session; a step that's code,
tried) needs the faked backend started with `RUNNER_URL`, `RUNNER_TOKEN` and
`RUNNER_CALLBACK_URL`, and the runner itself (`cd runner && RUNNER_TOKEN=…
uvicorn app.main:app --port 8200`; as root, as its image runs, each job gets
a uid of its own).

`smoke102` (as a builder: the Builder's Panes / Workflows / Steps,
the Workflows page's New workflow opening the Builder's editor, line numbers
and Check's line marked, the editor as tall as the preview, the fake model's
`add a clear button` fixed by a change by line into a card's `clear`, and
pictures in a shared session's Members and chat) needs the agent, the fake
model and the faked backend.

`smoke101` (as a builder: a new pane type kept as a draft with its Building
chat -- across leaving the page and a reload -- created with its chat kept, a
saved one's change tagged and discarded, a workflow's draft; and an EC2 pane
whose Name column is a tag and whose table rows open to their own request)
needs the agent, the fake model and the faked backend (`/api/dev/fake-aws`).

`smoke99` (the IoT pane with Rules and Jobs as more choices of "Search for",
built through the fake model's `add modes for jobs and rules` -- changes in a
model's own shape, a stray `when` fixed -- then each mode's Search run) needs
the agent, the fake model and the faked backend.

`smoke98` (the Builder's loop: IoT's jobs and rules added beside the editor
through the fake model's `add jobs and rules`, a problem the check found sent
back and fixed, then both lists fetched into their own tables) needs the
agent, the fake model and the faked backend (`/api/dev/fake-aws` answers iot
`ListJobs`/`ListTopicRules`). Ids are `[a-z][a-z0-9_]*`: a suite's `-` in one
fails Create.

`smoke96` (the Builder's preview, as a builder without DynamoDB: an AWS
request run in it, a live function, a refused handler) needs the faked
backend too.

`smoke95` (a Lambda pane type made in the Builder from an AWS request, run
on two fake accounts) needs the faked backend (`dev.fake_aws`, its
`/api/dev/fake-aws`).

`smoke94` (the agent panel without a second tab when nothing is on screen,
and catalogue category descriptions) needs nothing beyond the backend; it
puts the catalogue back as it found it.

`smoke91` (the Workflow pane's link to its run, the agent's `open_workflow`
through the fake model's `show workflow <id>`, a published template offered
once) needs the agent and the fake model.

`smoke88` (investigate a run, make a session repeatable, the Workflow pane, a
run's chat) needs the same, and the agent with the fake model for the run's
chat (its `which run` script answers from the run the turn read).

`smoke83` (the store repo) makes a bare git repo on disk and points the store at
it by a `file://` URL, which the backend refuses unless it was started with
`STORE_GIT_ALLOW_FILE_URLS=1` (never in a real deployment); it needs `git` on
the machine, and removes the store when it ends -- a store left configured
would name every later suite's new types `<namespace>:…`. `smoke84` (run on
open) counts a `.fake` host's requests (`GET /api/dev/fake-http/hits`) and ages
a pane's results (`POST /api/dev/age-outputs`), so it needs the faked backend
below.

`smoke69` (CloudWatch and OpenSearch), `smoke71`'s logs half (the histograms),
`smoke72` (MQTT), `smoke73`'s zoom half, `smoke74` (the agent's answer check,
on an MQTT connect; it needs the agent and fake model too), `smoke75` (auto-refresh),
`smoke76` (a pane's ⚙, Clear across two tabs, and the agent seen working -- the agent and
fake model too; a question starting "slow " makes the fake take a few seconds a step),
`smoke77` (session variables, view mode, and a viewer's refresh of a `.fake` API)
and every suite that uses `mockPaneActions` across two tabs (`smoke62`, `smoke66`,
`smoke67`, `smoke71`) need the backend served with AWS faked:
a CloudWatch query runs on the server and is polled into the session there
(PLATFORM_PLAN.md D51), and an MQTT connection is held there (D54), so the page
has nothing to stand in for. The fake's broker sends `fake/robot-1/telemetry`
every second and delivers what is published. Start it as

```bash
cd backend
uvicorn dev.fake_aws:app --port 8000   # instead of app.main:app, same environment
```

A pane's results are stored by the server (PLATFORM_PLAN.md D21), so a reply
faked in the page alone never reaches the session's other tabs. Two things in
`dev/fake_aws.py` cover that: an HTTP API connection whose host ends in `.fake`
answers with what a suite put there (`PUT /api/dev/fake-http?path=…`), and
`mockPaneActions` hands what it fakes to `/api/dev/store-result`, which stores it
with the server's own code (retrying while a new pane's save lands). Served as
`app.main:app`, neither route exists and a faked reply stays in its own tab.

And an environment whose account id starts `0000` is answered by
`backend/dev/fake_aws.py` (the suite creates one, `e2e-fake-aws`, and a user whose
group reaches it); every other account still goes to AWS, so no other suite
notices. Served as `app.main:app`, smoke69 fails its second precondition.

`smoke62` (the API table) stands in for its Fetch reply with `page.route`: an HTTP
API connection has to be a public host (the SSRF guard), which a sandbox without
DNS can't reach. What the backend does with the request is pinned by
`backend/tests/test_pane_manifests.py`. `smoke63` also checks
`src/panes/live.ts` against `backend/tests/fixtures/live_functions.json` in Node,
bundling it with the esbuild that comes with vite. `smoke64` (the stale-tab
reload) stands in a newer `/version.json`, which the dev server otherwise answers
with its own build id.

A pane drawn from a manifest (DynamoDB, Cognito, S3, IoT, the HTTP client and
the tools) calls one endpoint, `POST /api/panes/{type}/actions/{action}`, not
routes of its own, so a suite stands in for AWS behind it with the harness's
`mockPaneActions(page, type, {action: outputs | (body) => outputs})`; a reply of
`{ __status: 400, detail }` stands in a failed action. Mocking `/api/iot/*`,
`/api/tools/http-request` and the like no longer reaches those panes. A row's
detail is an action too (IoT's `thing_detail`), whose `inputs` are what its
`args` read from the row.

The first `select` on a session's screen is the session card's member role,
not the pane's: address a pane's select by its name (`select[aria-label=
"method"]`) or its options. smoke25 and smoke26 had timed out on exactly this
since the Members row arrived.

Playwright is deliberately **not** a dependency of this package — it would add a
browser download to every `npm ci` in CI, which builds the app and never runs
these. Install it where you run them (`npm i -D playwright`), or point
`E2E_PLAYWRIGHT` at a copy.

Each suite clears the workspace first — both the server's live sessions and this
browser's IndexedDB — so running them against a database you care about will
throw away your open sessions. Point them at a scratch database — and not the
one backend pytest uses: its `conftest.py` drops the schema and re-creates the
admin with its own password, after which no suite can sign in.

## Writing one

Start from the newest suite; the shape is always: a comment saying what this
covers, `launch()`, sign in, clear the workspace, drive the app, `report()`.

What has actually gone wrong here before, and what the harness or a check has to
account for:

- **Every session body stays mounted.** A pane selector that is not scoped to
  `SHOWN` (`.session-body:not([hidden])`) sees every open session's tabs at
  once, and passes for the wrong reason. The same goes for `.panel` — the first
  one in the body can belong to a session you are not looking at.
- **Headless Chromium draws overlay scrollbars** (0px wide), so a bug where an
  element is wider than the cards by exactly one scrollbar is invisible here.
  `.content` now reserves a real gutter itself (`scrollbar-gutter: stable`),
  so its `offsetWidth - clientWidth` is the true scrollbar width — but for any
  other scroller, force one first: `page.addStyleTag({ content: ".x {
  scrollbar-gutter: stable; }" })`. Screenshots never paint the scrollbar
  either way: show anything about it with measured geometry (smoke42 §10).
- **A long drag auto-scrolls the page**, which moves every viewport coordinate
  without moving any pane. Compare dashboard positions relative to the canvas
  (`box - canvasBox`, see smoke42's `box`), not raw `boundingBox()` values.
- **Dashboard panes refuse to pass through each other**, correctly. A drag or
  resize that "didn't move" may just have aimed at an occupied spot, or (since
  panes start flush in the canvas's top-left) at the canvas edge — dump every
  pane's position before calling it a bug, and aim at space that is free.
- **`newSession()` always makes a *new* session**, one click of a home card's
  "One more X" per label — so `newSession(page, "CloudWatch", "CloudWatch")`
  is two CloudWatch panes, opened in the cards' order, not the arguments'. To
  change the session on screen use `addPane(page, "IoT")` (its Panes card only
  adds) and `closePane(page, "IoT")` (the pane's or tab's ✕). Both take the
  pane's *name*, which is its kind's label only until a second one of that kind
  ("CloudWatch 2") or a rename.
- **`.checkbox-item` is not only the old pane picker.** Pages inside panes
  (environment lists, "Select all") and Settings use it too, so a check that
  "there are no checkboxes" has to be scoped to the card it means.
- **A mid-suite `clearWorkspace()` can race the app's own autosave**: a PUT
  still pending from the gestures just before it can land after the DELETEs
  and resurrect the old session, leaving two sessions' panes mounted — one
  more reason every pane selector goes through `SHOWN`.
- **Prove a new suite catches the bug.** Run it once with the fix stashed
  (`git stash push -- frontend/src`, run, `git stash pop`); smoke41 passed
  against code that still had every bug the user reported, because it only
  drove the easy path.
- **`hidden` is not proof.** Check the computed `display`: an author
  `display: flex` beats the UA's `[hidden] { display: none }`, which is a bug
  this app has actually shipped.
- **Assert on elements, not on the page's text.** `indexOf("Open")` matched
  "OpenSearch"; `text=Start a session` matched a paragraph describing the home
  page. Use `:text-is(...)` against the element that should carry the string.
- **Clear IndexedDB as well as the server.** Clearing only the server leaves
  this browser's copy to be adopted and pushed straight back up — the adoption
  rule working correctly, and your suite failing for no reason.
- **Print what you found.** `check(ok, label, detail)` shows `detail` only on
  failure; a tally of what was actually on screen saves a whole rerun.
- **Leftovers break the next run.** A suite that creates a group, a user, a
  template or a category deletes it at the end *and* copes with finding one
  from a run that died half-way. A stray category is the quiet one: once any
  category exists, every session's ⋮ correctly grows a "Move to <category>"
  item, which breaks an older suite's hardcoded list of what the menu offers.
  `clearWorkspace()` clears categories along with sessions, but only for
  suites that call it.

`smoke21` occasionally fails on a click that times out under load; it passes on
a rerun. (`smoke29` used to fail the same way — a fresh profile read the
server's session list before it had landed — until it was made to wait for the
row instead. Prefer that fix to calling a suite flaky.)
