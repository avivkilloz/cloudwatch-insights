# Cloud Insights

A web app that mimics CloudWatch Logs Insights, browses IoT fleets, DynamoDB
tables, S3 buckets, and Cognito user pools, across **multiple AWS accounts and
regions** by assuming a role you configure in each target account.

## Sessions

The app is organised around **sessions** rather than a fixed set of tabs.

- There is **no header bar**. The platform's logo and name head the **side
  panel** (click them to go home); hide the panel and the logo starts the
  strip instead. Your **picture** ends the strip — or the docked agent panel's
  header — and opens Settings and Log out. Questions for the agent go in its
  panel's **Global** tab.
- **A session is one thing, and it holds as many pages as you like.** There is
  no separate "Aggregator" to open alongside single-service sessions — every
  session is one, which is what made working across services the normal case
  rather than a mode you had to choose up front.
- **Home** is where a session is made: name it, set how many of each
  **Service** and **Tool** it should hold (each card has a − n + count, 0 by
  default — two CloudWatch panes side by side is as easy as one), press
  **Create**. Choose nothing and you get an empty one to fill from inside.
  Leave the name blank and it is named after what is in it. Give it a
  **description** too if you like — what it's for (the agent reads it) — and
  file it in a **category** if you have any.
- **Each session has its own card**: its name and description (✎ edits
  either), what to add, and the layout. ⇤ moves the card into the side panel
  and ⇥ back; it stays where you put it, even while the side panel is hidden.
- **Inside a session, the card only adds** — "+ CloudWatch" opens
  another CloudWatch pane each time — and a pane is closed from its own ✕ (its
  tab's, in the tabs layout). Panes of one kind are named "CloudWatch",
  "CloudWatch 2"…, keep their own inputs and results, and can be renamed: ✎
  in the pane's header, or double-click its tab. A closed pane takes its
  inputs with it, so one added later starts empty.
- Below the new-session card, **Platform** holds the app's own pages — **Agent**,
  **Settings**, and **Dashboards**, **Workflows**, **Chat** and **Code**, which
  are named but not built. You go to one of these; you don't open copies of
  them, which is why they are not in the panel's list of sessions.
- **What you are looking at, and what it is for**, is a card under the side
  panel rather than a paragraph above the body's first card — so the body
  starts with the thing you came to use. It covers the home page and settings
  as well as sessions, which is why it hangs off the panel rather than off a
  session, and it shows and hides with the panel. For a session it carries the
  name you gave it and says which panes it holds.
- A **side panel** down the left holds everything you can reach, in one list:
  **Home** (with a house icon, so it reads as the way back rather than another
  session) at the top, then **Sessions** — *every* session you have, the ones
  on the strip at full strength and the ones you have closed dimmed — then **＋
  Add**, holding **Start new session…** (which takes you to the card on Home
  that makes one), every **service** and **tool** — clicking one opens a
  session named after it holding just that pane, which is the one-click way in
  when you don't need to pick several or name it yourself — and your saved
  **templates**, since opening one of those starts a session exactly like
  pressing Create does. The strip's **＋** offers the same three, for when the
  panel is hidden. A second session named the same is called "CloudWatch 2"
  rather than colliding. Click a
  session to switch to it (or, if it is closed, to open it again), drag it to
  reorder, and use the **⋮** beside it to **rename** it in place, save it as a
  template, or delete it.

  It's a vertical card in the page background rather than the panel colour, so
  it reads as part of the surface the body's cards sit on.
- A **session strip** sits above the body, in the same column as the cards and
  exactly as wide as them, holding the tabs you have in front of you: a button
  that hides and shows the side panel, then a tab per open session with a **✕**
  to close it, then **＋** for the same Add list as a menu, and at the far end
  a **⋮** for the session currently on screen — the same rename / save as
  template / delete the panel's rows offer, without going looking for the row.

  The two aren't a duplicate of each other. The panel is the whole workspace —
  what is open, what you closed, your templates, everything you could open —
  and a row of tabs runs out of width at about six. The strip is only what is
  in front of you, which is why **closing** lives on a tab there and the
  panel's **⋮** is for what you do to the session itself. Hiding the panel is
  remembered per browser; the app title in the top bar takes you **home**.
- Every open session **stays mounted**: switching between them never
  interrupts a running query or loses a scroll position.
- **A refresh puts you back where you were, and so does another machine.**
  Each open session's whole state — the inputs, the rows on screen, and its
  conversation with the agent — is **autosaved to the server** as you work. There is
  no save button: the session in front of you *is* the saved one. Sessions are
  per user, kept in Postgres, and mirrored in the browser (IndexedDB) so the
  panel is populated on the first paint and you keep working through an outage;
  whatever the browser has catches up once the server is back. Which session
  you were *looking at* stays local — that's what this browser is showing, not
  something to follow you elsewhere.
  Restored rows say **when they were fetched**, with a "Run again" button, so
  AWS data from yesterday is never shown as though it were current. A session
  too large to keep (past a 4 MB cap) drops its results, keeps its inputs, and
  says so rather than coming back looking empty.
- **Closing is not deleting.** A tab's **✕** takes that session off the
  strip; it stays in the panel, dimmed, and one click puts it back with its
  state. *Delete*, in the strip's **⋮** (for the session on screen) or the
  panel's, is the only thing that throws a session away, and it asks first —
  nothing is ever removed on your behalf. The same ⋮ renames a session and
  saves it as a template.
  A closed session's rows are not loaded until you actually reopen it, so the
  list costs nothing to carry however long it gets.
- **Saved sessions** are the other half, and deliberately different: they're
  named **templates** stored per user on the server, holding a session's
  *inputs* only. Saving takes the session's own state and strips its outputs —
  the rows, the fetched-at markers, the agent conversation — so what's kept is
  everything you chose, including each Aggregator pane's own inputs. Open one
  from **+** and it starts a fresh session seeded with those inputs; nothing
  you then do changes the saved copy. Manage them under **Library →
  Templates** in Settings.
- **Saved inputs** are smaller: one pane's inputs under a name. Every pane
  drawn from a manifest (DynamoDB, S3, Cognito, IoT, the HTTP client,
  Base64, Diff, JWT, the API table) has them in its **⚙** (in the pane's
  header, or its tab): your saved inputs for that kind of pane, then **Save
  these inputs as…**. Picking one
  fills the pane you're in — and runs what picking those inputs by hand
  would, so a saved table is described and a saved bucket opened. A pasted
  token or secret is never saved. They are listed, renamed and deleted under
  **Library → Saved inputs**.
- The **agent** has two conversations, a tab each in its panel: **Global**,
  about the platform as a whole, and **Session**, one per session, about that
  one — see [Platform agent](#platform-agent).

Settings (including Environments, Users and their groups, and the Library) is reached
from your picture's menu and is not a session; the strip stays above it.

- Define **environments** — each one an AWS account paired with a single
  region — once, under Settings' **Environments** section (Admin-group
  members only).
- **CloudWatch session**: pick one or more environments, browse/select their log
  groups, write a CloudWatch Logs Insights query (same syntax as the AWS
  console), and run it — the app fires one `StartQuery` per selected
  environment in parallel and the **server** polls until every target
  finishes, writing the rows into the session as they arrive. So everyone
  with the session open (another tab, another member, the agent) watches the
  same rows stream in, a reload mid-query carries on, and anyone who can edit
  the session can Stop it. The server only polls while someone has the
  session open; left unwatched for 10 minutes, the query is stopped in AWS.
  Results from all targets are merged into one list, shrunk to a single
  summary line per row by default; click a row to expand every field.
  Tick **Histogram** to also see every match counted over time above the
  list (a second, counting Logs Insights query over the same log groups,
  which CloudWatch bills like the first; OpenSearch's search always shows
  one, at no extra cost).
- **Charts.** The API table's rows and both logs panes' results can be
  charted: choose **Chart** beside the card's title (time series, bar, pie or
  a stat tile), then the x, y and series from the rows' own columns. A
  CloudWatch `stats … by bin(5m)` query charts as a time series of its
  counts. The chart is saved with the session, so everyone looking sees the
  same one, and the agent can set one up ("chart errors per environment over
  time"). **Series** offers only columns with a handful of values (a status,
  a log group) -- a column like `@message`, different on every row, would
  draw a line per row. Raw rows over time are counted into bars of one
  width, about 60 across the range, and the chart says which ("Per 5m").
- **Zoom by dragging.** On the histogram, or a time-series chart in
  CloudWatch or OpenSearch, drag across the stretch you want: the pane's time
  range becomes exactly that (a custom range, to the second) and the query
  runs again over it. **Undo zoom** goes back one step at a time.
- **Auto-refresh.** A pane that searches or fetches (CloudWatch, OpenSearch,
  IoT, DynamoDB, S3, Cognito, the API table) can run again by itself: pick
  an interval under **Auto-refresh** in the pane's **⚙** ("↻ 30s" then shows
  beside it), or give the whole session one under **Refresh** in its card (a
  pane on "As the session" follows it). It runs only while the session is open on someone's screen, and once
  for everyone watching -- five tabs on one dashboard cause one run, whose
  results reach them all. CloudWatch refreshes at most once a minute (each
  query is billed by the data it scans); the others every 10 seconds. A
  refresh that keeps failing says why above the pane and tries less often.
  The agent can set it too ("refresh this every 5 minutes").
- **Run on open.** For a dashboard that should be current when you arrive
  rather than tick all day: under the same **⚙** (or the session card's
  **Refresh** row), "On open, if older than 5m" runs the pane once whenever
  someone opens the session or switches to it -- unless what it shows is
  newer than that, so switching back and forth, or a team arriving together,
  runs it once. "↻ on open" shows beside the ⚙. The agent can set it too
  ("run these on open").
- **Session variables.** A session can hold an **Environment** and a **Time
  range**, added and set in the session card's **Variables** row. Every pane with an environment picker or a time range follows
  them, like a Grafana dashboard's variables: its own input shows the value,
  greyed, saying "From the session's Environment", and changing the variable
  runs again every pane that had run. **Unlink** beside the input gives a
  pane its own value again; its **⚙ → Follow the session's Environment**
  takes the variable back. A pane added later follows from the start. The
  agent can set them too ("show the whole dashboard for IoT Prod, last 6
  hours").
- **View mode.** The session card's **Mode → View** turns the session into a
  dashboard: every pane shows only its results, with when they were fetched
  and **Refresh**; inputs and buttons are hidden. A pane's **⚙ → Inputs**
  shows or hides its own regardless. Someone you share a session with as a
  viewer always sees view mode, and an auto-refreshing dashboard refreshes
  for them too -- run as them, when they can reach its environments; when
  they can't, it says so and waits for someone who can.
- **The catalogue.** Panes are offered under categories -- Services and
  Tools to start with -- on the default page, in the side panel's Add list,
  the strip's + and a session's card. An admin arranges them in **Settings →
  Catalogue**: new categories, renaming, ordering, and moving each pane up,
  down or to another category (deleting a category asks where its panes go).
  Each person can **star** a pane type (the ☆ on its card on the default page)
  to put it first in their lists, under Favourites, or **hide** one they never
  use; **Show hidden** brings the hidden ones back to the default page.
- **A session as your home page.** A session's **⋮ → Set as my home page**
  makes the brand at the top of the side panel open it -- and signing in, or
  reloading on the default page, lands there too (a closed one is reopened).
  Its row carries a small house. Any session you can reach can be your home,
  shared ones included; **Start new session…** still shows the default page.
  If it's deleted, or you leave it, the default page says so; **Dismiss**
  clears it. **⋮ → Stop using as home page** goes back to the default page.
- **Clear.** A results card (CloudWatch's and OpenSearch's Results, IoT's,
  DynamoDB's items, S3's listing, Cognito's users, the API table's rows, the
  HTTP response, MQTT's messages) has **Clear** while it holds something: it
  empties those results for everyone on the session, leaving the rest (the
  table DynamoDB described, MQTT's connection).
- **Results are each pane's own.** A run's results are stored per pane on
  the server, apart from the session's inputs and layout: a refresh or a
  stream updates only that pane in every open tab, a session can hold
  several large result sets at once, and typing a query while results arrive
  never collides with them.
- **IoT session**: pick one or more environments, then search either **Things**
  (the same "Advanced search" syntax as the AWS console — by name,
  attributes, connectivity, shadow values, group membership, and more) or
  **Certificates** (by status or certificate ID — see below). Expand a thing
  to see its attributes, named/classic shadows (reported vs. desired, last
  updated, version), attached certificates (with status and their attached
  policies, document included), and job execution history (with status).
  Expand a certificate to see its attached policies (document included) and
  which things use it. Read-only — nothing in this tab creates, updates, or
  deletes anything in your AWS accounts. **Show examples** lists sample
  queries for the mode, each with **Use**; the pane's **⚙** keeps a search (its
  mode and query) under a name. An environment whose search failed is its
  own line under **Target errors**, above the others' results. Which rows
  are expanded is part of the session, so another member (or the agent)
  opening one opens it for you too.

  That detail normally only exists for rows you've expanded, because it costs
  one AWS call each. Once you check some rows, an **Include shadows,
  certificates & jobs** option appears (on the certificates side, **Include
  attached things**) — turn it on and the app fetches the detail for exactly
  the checked rows, then carries it into the export *and* into what the agent
  is sent when you ask it about them, so you can export a full fleet snapshot or ask "what
  firmware are these actually on?" rather than being limited to the search
  summary. Fetching is bounded to a few requests at a time and shares the
  same cache as expanding a row, so a row you already opened is free and a
  row fetched for an export is already there when you open it. Rows whose
  detail can't be fetched are called out and fall back to their summary.
- **DynamoDB page**: pick one environment (DynamoDB tables are inherently
  single-account/region, so unlike CloudWatch/IoT this page doesn't fan out
  across several at once), load its table list, and pick a table to see
  its key schema, status, and item count. Search/filter with
  `field:value` tokens (exact match, ANDed) — this runs a `Scan` with a
  `FilterExpression`, since there's no generic way to query an arbitrary,
  schemaless table other than scanning; leave the query blank to browse
  it unfiltered. Expand an item to see its full attributes as JSON. "Load
  more" pages through the table via DynamoDB's own `LastEvaluatedKey`.
  **⋮ → Save these inputs as…** bookmarks the environment, table and filter,
  and the same menu jumps straight back (see Saved inputs above).
- **S3 page**: pick one environment and a bucket (its actual region is
  resolved automatically, which can differ from the environment's own
  region), then navigate it like a file explorer — folders and files at
  the current level, breadcrumbs to jump back up. The search box takes a
  **path** or a **name**. A path (anything with a `/`, like `POP/69/`) is
  listed at once the way `aws s3 ls s3://bucket/POP/69/` lists it -- S3 finds
  a prefix itself, however big the bucket -- and is case-sensitive, as S3 is.
  A name is looked for in every file under the current folder, a few seconds
  at a time: it says how many files it has looked through, and **Load more**
  searches on from there. Read-only: no file content is ever fetched or previewed, only
  metadata (size, last modified, storage class). Each file has "Copy S3
  URI" (`s3://bucket/key`) and "Copy object URL" (the virtual-hosted-style
  HTTPS URL) buttons. The pane's **⚙** bookmarks an environment, bucket and
  folder, as on DynamoDB.
- **Cognito tab**: pick one environment and a user pool, then search users
  with a single `attribute:value` token (starts-with match, e.g.
  `email:john`) — Cognito's `ListUsers` only supports filtering by one
  attribute per call, unlike the DynamoDB/IoT search boxes. Leave it blank
  to list all users. Expand a user to see every attribute Cognito
  returned for them, plus status/enabled/created/last-modified.
- **Aggregator session**: pick what you're actually
  debugging across — say CloudWatch, IoT and Cognito — and work with them in one
  place instead of losing each page's state every time you switch tabs. Each
  pane is the *real* page, not a cut-down copy: the same environment pickers,
  search boxes, saved sessions, result rows and expandable details. **Individual
  tools** can be opened as panes too — the HTTP client, JWT, Base64, diff or
  MQTT, each its own pane rather than the whole Tools page as one — which is
  usually the point of a session rather than a bonus: replay the call that
  produced the log line you're reading, or decode the JWT it came in with,
  without losing either side. The picker keeps them in their own row, so
  "a search page" and "a tool" stay distinguishable. Three
  layouts, offered in that order: **Tabs** (what a new session starts in) shows
  one pane at a time behind a row of tabs — a pane then fills the session and
  reads like a page of its own, since the tab is its name and its ✕ and it
  needs no title bar of its own; **Side by side** lays them out in columns that
  wrap onto as many rows as your screen needs (so a fourth and fifth service
  move down rather than off the side); and **Stacked** puts them one above the
  other full width.

  In the latter two, each pane minimises to just its title bar and expands
  again — click anywhere on its title bar, or the **−/+** button on it —
  independently, so minimising one says nothing about the others. Every pane
  stays mounted throughout, in every layout: the pane behind an unselected
  tab is hidden, not unmounted, so switching layout or tab never discards its
  results or interrupts a running query. Which tab you were on is part of the
  session, so it comes back with it.

  Panes can be **reordered**: drag one by its title bar onto another to drop
  it into that slot, or use the arrows on the title bar to nudge it one place
  at a time. The arrows follow the layout, so they read **◀ ▶** side by side
  and **▲ ▼** stacked, and grey out at the ends. Dragging is built on pointer
  events rather than the browser's own drag-and-drop, so it behaves the same
  everywhere and can't leave the page wedged: holding near the top or bottom
  edge scrolls so you can reach a pane that started off-screen, Escape
  cancels, and releasing anywhere that isn't a pane just does nothing. A short
  press is still a click, so the title bar keeps minimising/expanding and the
  drag's own release never collapses the pane it just moved. The order is part
  of a saved session.

  The agent's **Session** tab is the session's own chat: ask it about the
  rows you've checked *across every open pane* — they go with the question,
  each tagged with the pane it came from, so you can ask whether those log
  errors line up with the devices that went offline — or have it write a
  pane's query, add or arrange panes. A
  session (which panes, in which order, and which layout) can be saved as a
  template from its **⋮**, and those are managed under **Library →
  Templates**.
- **Result row selection**, on every tab that returns a list of results —
  CloudWatch, OpenSearch, IoT (things and certificates), DynamoDB, S3 and
  Cognito. Every row has a checkbox, plus a "Select all" checkbox above the
  list that selects/deselects every currently-shown row. Selecting rows:
  - enables **Hide selected**, which removes them from view so you can whittle
    a noisy result set down to what matters (a "Show N hidden" button brings
    them all back). On the CloudWatch page, hiding also makes room for the
    next-best row within the current Limit rather than just leaving a gap;
  - narrows **export** — the button becomes "Export N selected" and writes
    only the checked rows, instead of everything on screen;
  - goes with a question to the **agent** — its Session tab attaches the rows
    checked across every open pane in the session.

  A fresh search clears the selection; loading another page of results
  (the "Load more" buttons on DynamoDB, S3 and Cognito) keeps it, since
  those append rather than replace. Checking a row never expands it, so you
  can select and inspect independently.
- **Grouping and the `@log` field** (CloudWatch page): the
  default query includes `@log` alongside `@timestamp`/`@message`, so when
  a query spans multiple log groups, each row shows a tag naming which one
  it came from (CloudWatch returns this as `<account_id>:<log_group_name>`;
  the account id — redundant with the environment tag right next to it —
  is stripped for display). The results view's **Group by** control (was a
  plain "Group by environment" checkbox) is now a dropdown: **None**,
  **Environment**, or **Log group** — the last one buckets rows under a
  header per log group instead of per environment, useful once a query
  spans several. Removing `@log` from a query (or switching to OpenSearch,
  which has no equivalent field) just makes "Log group" grouping and the
  per-row tag a no-op.
- Everything saved anywhere in the app — session templates and saved
  inputs — is **per user** (each user only
  ever sees and manages their own) and is managed from the **Library**
  section of Settings, with a tab for each kind (Templates, Saved inputs). Saved tables and buckets became saved inputs, once, when
  DynamoDB and S3 moved to manifests, IoT's saved searches and the HTTP
  client's saved requests did when they moved, and saved log queries did
  when CloudWatch and OpenSearch moved, and saved MQTT topics did when MQTT
  moved (each pane's **⚙**). The per-service session tabs
  (CloudWatch/OpenSearch/IoT Sessions) are gone: a service is a pane rather
  than a session now, so nothing writes one, and the ones saved back then are
  listed under Templates — which is also where Add offers them.
  Saved inputs are renamed and deleted there, and saved and loaded from the
  pane's own ⚙; session templates edit their JSON state directly.
- **Templates**, distinct from saved inputs: **⋮ → Save as
  template** on any session in the side panel keeps that session's *inputs* —
  selected environments, log groups, query text, time range, limit, sort,
  search mode, and so on, including each Aggregator pane's — but not its
  results. Opening one from the panel's **Templates** list starts a fresh
  session seeded with them; nothing about the saved copy changes as you work. Any
  future page can plug into the same mechanism — a saved session is just a
  page name plus an opaque JSON blob that page defines for itself, which
  is also what the Tools page's saved HTTP requests and saved MQTT topics,
  the S3/DynamoDB pages' saved bucket/table shortcuts, and the Aggregator's
  saved sessions are all built on (each just its own page name under the same
  mechanism). (Cognito doesn't have this yet.)
- **Published templates** (ready-made sessions): an admin can publish one of
  their templates (**Library → Templates → Publish…**) for everyone. It's made
  to work in any environment -- its AWS panes follow the session's
  **Environment** variable, and what names this platform's own connections,
  credentials or secrets is left out (you're told what) -- and is offered on
  the default page under **Ready-made sessions**, and under Templates in Add,
  to every group that has each of its panes (in place of the template it was
  published from, in its publisher's own lists). Opening one asks which
  environment it's for (with only one, it doesn't ask). With a store repo set
  up, each is kept there; **Library → Published** renames or unpublishes them.
  The agent can open one too ("open the fleet errors template for Prod").
- **Export results** to CSV, Excel (`.xlsx`), or JSON: an "Export ▾" button
  next to the result count on the CloudWatch and OpenSearch pages (both
  backends), IoT page (Things and Certificates), DynamoDB, S3, and Cognito
  exports exactly the rows currently on screen — after any sort, hide, or
  search/filter you've applied, not a raw re-fetch — or, when you have rows
  checked, just those. Entirely client-side, no
  backend involved: the file is built from data already loaded into the page
  and downloaded straight from the browser. CSV/JSON are generated inline;
  the `.xlsx` writer is loaded on demand so its bundle cost is only paid by
  users who actually click "Excel (.xlsx)".
- **Settings**, under the **App settings** section (Admin-group members
  only), lets you set a custom app title (shown in the top bar and browser
  tab, in place of the default "Cloud Insights") and upload a logo shown
  right before that title — the same logo also becomes the browser tab's
  favicon, updating immediately without a reload. An uploaded logo is
  capped at 300 KB and stored inline (as a data URL) alongside the
  rest of the app's settings — no separate file storage needed — so keep it
  small; for a larger image, host it yourself and note that this app has no
  URL field for that today (only file upload).
- Pick a theme (Dark, Light, Dracula, Nord, Solarized Light, or one of the
  four [Catppuccin](https://catppuccin.com/) flavors — Latte, Frappé,
  Macchiato, Mocha) from Settings' **Theme** section — each one is a card
  with a live preview using that theme's actual colors, not just a name.
  Remembered per browser via `localStorage`.

## Platform agent

Type a request into the agent panel's **Global** tab and the agent does the
work in your workspace, as you: it creates a session (or uses the one you're
looking at), adds the panes it needs, fills in their inputs, runs them, and
lays them out -- tabs, side by side, stacked, or a dashboard it arranges --
then answers from what they found. It lists each step as it happens; with
**Follow** on, the app takes you to each session as the agent gets to it, and
every change appears in the panes as it's made. A session the agent is
working on is marked ✦ in the panel and on the strip. Until it answers, a
line under your question says what it's doing and for how long; a dot on the
other tab, and on the panel's button while the panel is put away, says it's
still at it. In a shared session, everyone on it sees the question and
"Answering <name>…" while the agent works, then the answer.

The agent panel has two tabs. **Global** is the conversation about the
platform (the **Agent** page shows it too).
**Session** is the chat of the session on screen -- each session has its own,
kept in the session, so it syncs to your other browsers and survives a
reload. Ask it to write or change a pane's query, add or arrange panes, or
check some rows in the session's panes and ask about them: the checked rows
go with the question. This replaced the old ✦ Ask AI assistant, which could
only suggest a query or talk about rows; the agent does both, and acts on the
session as well.

The panel docks beside the page or floats over it (the icon in its header
switches), and the button at the far end of the tab strip shows or hides it.
Drag the gap beside the side panel or the docked agent panel to resize it;
double-click to reset. Neither grows so far that the page between them has no
room for a pane: on a smaller window they stop sooner, and draw narrower
until the window is wide enough again.

It can add any pane your group has to a session. The JWT tool it can add but
not fill in: a pasted token stays in your browser, so it tells you what to do
there instead. The MQTT tester it can connect and read, but not publish from.

It can do what your group can and nothing more -- the same environments, the
same pages, the same IAM role -- and only if an admin has turned **Platform
agent** on for your group (Settings → User groups; on for Admin, off for any
other group until then). Runs are read-only searches, made on the server.
Anything that reaches outside the platform, like sending an HTTP request, it
fills in for you to send yourself; asking before doing such things is the
next step. The Global conversation isn't kept across a reload yet.

Every answer is checked before it's left standing: the platform compares
it with what the turn actually ran -- the calls the agent made, what came
back, and the sessions it touched as they are afterwards -- and shows that
as a step ("Checked the answer against what ran"). An answer that claims
something nothing did ("connected" when the pane isn't running), or doesn't
do what was asked, is taken back and redone once; if the redo still doesn't
hold up, it stays with a warning under it saying what the check found. It
costs one more model call per answer (`agent.check` in Helm turns it off or
gives it a model of its own).

It needs a LiteLLM proxy (or anything OpenAI-compatible) and a model that is
good at tool calling (`AGENT_MODEL`, or `agent.model` in Helm) -- see
[DEPLOYMENT.md](./DEPLOYMENT.md#the-platform-agent-optional). To try a model
or a prompt change against conversations it has got wrong before, run the
scenarios in `platform-agent/evals` (its README).

## Users, groups & login

The app requires logging in — there's no anonymous/shared access. Every user
belongs to exactly **one group**, and the group is the sole unit of access
control:

- **Who the user's requests run as** where they connect: the group's
  **identities**. For AWS, that is the IAM role the group assumes in every
  AWS connection it can see (its default AWS identity), optionally a
  different role for one connection (an override), or stored access keys.
- **Which environments** are visible to the user (an explicit allow-list per
  group — except the built-in **Admin** group, which always sees every
  environment, so admins can't accidentally lock themselves out of one they
  forgot to self-grant).
- **Which panes** it can use: a checkbox per pane type, under **Services**
  and **Tools** (with **All** / **None** for each), in **Settings → Users →
  Groups → Panes**. Each tool is its own permission now -- "Tools" used to be
  one switch for all six -- and a pane a group hasn't been given isn't
  offered to its members, can't be run by them, and isn't a kind the agent
  can use for them. An existing group keeps exactly the panes it had. The
  **Platform agent** is a checkbox of its own there too, off for a new group.
  Settings itself is handled separately, see below.

Everything about the current user lives behind their **picture** (or their
initials), at the end of the strip — or of the docked agent panel's header:
clicking it shows their username and group, a **Settings** link, and **Log
out**. Settings itself is one page with a row of section tabs: **My
account** (change your own password, upload/remove your avatar), **Theme**
(see below), and **Library** (your own templates, saved inputs, queries and
searches) are open to every user. Admin-group members additionally get **App
settings**, **Environments**, **Users** (with a *Users | Groups* switch for
the user groups), and **Credentials** — everyone else
can't add or
edit users/groups, change app settings, or add/remove environments; those
sections simply aren't there for them.

A default **Admin** group and an **admin** user in it are created
automatically the first time the app starts with no users yet. Set the
admin user's initial password via the `ADMIN_PASSWORD` environment variable
(see `DEPLOYMENT.md` for wiring this up via Helm); if it's left unset, the
backend generates a random password itself and logs it once, so check the
backend's startup logs (`docker compose logs backend`, or `kubectl logs` for
the backend pod) if you didn't set one. Sign in as `admin` with that
password, then create real users/groups and change the admin password
(via the login/change-password flow) from there.

## Architecture

```
backend/   FastAPI app. Holds ambient AWS credentials (the server's own
           identity) and uses sts:AssumeRole to reach into each configured
           environment (account+region pair), impersonating whichever role
           the logged-in user's group specifies. Postgres persists
           environments, users/groups/sessions, and per-user saved queries/
           searches/sessions.
frontend/  React + Vite SPA. Talks to the backend over /api/*, gated behind
           a login page backed by an httpOnly session cookie.
platform-agent/
           Optional. The platform agent: LangChain's agent (on LangGraph)
           calling the model through LiteLLM, with its tools loaded from the
           backend's MCP endpoint (/mcp). Reachable only by the backend,
           which relays chat turns to it with a per-turn token standing for
           the user who asked. No AWS identity of its own.
```

No AWS keys are ever entered into or stored by the browser. The backend is
the only thing that touches AWS credentials, using whatever ambient identity
it's given (env vars, an EC2/ECS/Lambda instance role, or `~/.aws/credentials`).

## Running locally

The backend needs a Postgres database. Either use the provided Compose file
for everything (see [Run with Docker Compose](#run-with-docker-compose)
below), or start just Postgres and run the app processes yourself for a
faster edit loop:

```bash
docker run --rm -d --name cw-postgres \
  -e POSTGRES_USER=cloudwatch_insights \
  -e POSTGRES_PASSWORD=cloudwatch_insights \
  -e POSTGRES_DB=cloudwatch_insights \
  -p 5432:5432 postgres:16-alpine
```

### 1. Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Provide the server's own AWS identity (must be allowed to assume the
# target role in every account you configure — see IAM setup below):
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
# or AWS_PROFILE=..., or just run this on an instance/task with an IAM role.

export DATABASE_URL=postgresql+psycopg2://cloudwatch_insights:cloudwatch_insights@localhost:5432/cloudwatch_insights
uvicorn app.main:app --reload --port 8000
```

Tables are created automatically on first run. Instead of `DATABASE_URL`
you can set `POSTGRES_HOST` (plus optionally `POSTGRES_PORT`, `POSTGRES_DB`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_SSLMODE`) and the backend
builds the connection string for you — see `backend/app/db.py`.

Run the test suite with:
```bash
pip install -r requirements-dev.txt
docker run --rm -d --name cw-postgres-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=cloudwatch_insights_test -p 5432:5432 postgres:16-alpine
python -m pytest tests/ -v
```
(`tests/conftest.py` defaults `DATABASE_URL` to that same test database if
it isn't already set in the environment.)

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to
`http://127.0.0.1:8000` (override with `BACKEND_URL`).

### Production build

```bash
cd frontend && npm run build
```

Serve the resulting `frontend/dist` as static files from anything (nginx,
S3+CloudFront, or FastAPI's `StaticFiles`) and point it at the backend's
`/api` — put both behind the same origin/reverse proxy so the frontend's
relative `/api/*` calls reach the backend.

### Run with Docker Compose

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...   # or AWS_PROFILE, see IAM setup below
docker compose up --build
```

This starts Postgres, the backend (http://localhost:8000), the platform
agent, and the frontend (http://localhost:8080) together, with the backend
already pointed at Postgres. AWS env vars are forwarded from your shell into
the backend container so it can assume roles, and the `LITELLM_*` ones into
both the backend and the agent. To try the agent without a real model, start
the scripted stand-in too and point the agent at it:

```bash
LITELLM_BASE_URL=http://fake-model:4010 LITELLM_API_KEY=x AGENT_MODEL=fake \
  docker compose --profile fake-model up --build
```

It answers a handful of fixed prompts (`encode <text>`, `dashboard`, `here`,
`break`) by really driving the tools -- see `platform-agent/dev/fake_llm.py`.

### Containers & Kubernetes

- `backend/Dockerfile`, `frontend/Dockerfile` and `platform-agent/Dockerfile`
  build each part as its own image; `.github/workflows/{backend,frontend,agent}-ci.yml`
  typecheck/test each on every push and, on `main`, build and push images to
  `ghcr.io/<owner>/cloudwatch-insights-{backend,frontend,agent}`.
- `helm/cloudwatch-insights/` is a Helm chart for all three (the agent off
  unless `agent.enabled`), including a ServiceAccount meant for IRSA. `argocd/application.yaml` is an example
  Argo CD `Application` for the chart.
- See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full Kubernetes/IRSA
  walkthrough: OIDC provider setup, creating the hub IAM role the backend
  runs as, wiring per-target-account trust policies, and deploying with
  Helm or Argo CD.

## IAM setup

The app needs two things:

1. **The server's own identity** (whatever `AWS_ACCESS_KEY_ID`/instance
   role/profile it runs with) must be allowed to call `sts:AssumeRole` on
   the role you'll configure in each target account:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "sts:AssumeRole",
         "Resource": "arn:aws:iam::*:role/CloudWatchInsightsReadRole"
       }
     ]
   }
   ```

   (Scope the `Resource` down to the specific account ARNs you use in
   practice instead of `*` where possible.)

2. **A role with that same name** (e.g. `CloudWatchInsightsReadRole`) must
   exist in *every* target account, trusting the server's identity, with
   permissions to read logs:

   Trust policy (replace with the server's actual identity/account):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": "arn:aws:iam::<SERVER_ACCOUNT_ID>:role/<server-identity>" },
         "Action": "sts:AssumeRole"
       }
     ]
   }
   ```

   Permissions policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "logs:DescribeLogGroups",
           "logs:StartQuery",
           "logs:GetQueryResults",
           "logs:StopQuery",
           "iot:SearchIndex",
           "iot:DescribeThing",
           "iot:DescribeEndpoint",
           "iot:ListThingPrincipals",
           "iot:DescribeCertificate",
           "iot:ListNamedShadowsForThing",
           "iot:GetThingShadow",
           "iot:ListJobExecutionsForThing",
           "iot:ListAttachedPolicies",
           "iot:GetPolicy",
           "iot:ListCertificates",
           "iot:ListPrincipalThings",
           "iot:Connect",
           "iot:Publish",
           "iot:Subscribe",
           "iot:Receive",
           "dynamodb:ListTables",
           "dynamodb:DescribeTable",
           "dynamodb:Scan",
           "s3:ListAllMyBuckets",
           "s3:GetBucketLocation",
           "s3:ListBucket",
           "cognito-idp:ListUserPools",
           "cognito-idp:ListUsers",
           "es:ListDomainNames",
           "es:DescribeDomains",
           "es:ESHttpGet",
           "es:ESHttpPost"
         ],
         "Resource": "*"
       }
     ]
   }
   ```
   (Drop whichever service's actions you don't need — `logs:*` for CloudWatch
   (CloudWatch backend), `iot:*` for IoT, `dynamodb:*` for Tables, `s3:*`
   for S3, `cognito-idp:*` for Cognito, `es:*` for OpenSearch (
   backend). `s3:ListBucket` is normally scoped to specific bucket ARNs
   rather than `*`; this simplified example grants it account-wide the same
   way the rest of this policy does.)

In the app's **Settings** (from your picture's menu, at the end of the strip — Admin-group
members only see the sections below), add an environment under **Environments** — a name ("Prod") — and give it
a connection for each AWS account/region in it (the 12-digit account ID
and a region). One environment can hold several, e.g. *iot* and *eks* in
two accounts; panes then offer them as "Prod · iot" and "Prod · eks".
Then, under **Users → Groups**, give each group its AWS identity in
**Identities** — "A new AWS role…" with the role name (e.g.
`CloudWatchInsightsReadRole`) — the role that group's members assume in
every AWS connection it can see, unless an override names another for one
connection. **Test as…** on a connection checks that a group really
reaches it.

### IoT tab prerequisite: Fleet Indexing

The IoT tab's search is powered by [AWS IoT Fleet
Indexing](https://docs.aws.amazon.com/iot/latest/developerguide/iot-indexing.html)
(`iot:SearchIndex`) — the same mechanism behind the "Advanced search" box in
the AWS IoT console. It must be enabled per account/region before searching
will work there; if it isn't, the app surfaces a clear per-environment error
rather than failing silently. Enable it once per target account/region:

```bash
aws iot update-indexing-configuration \
  --thing-indexing-configuration '{"thingIndexingMode":"REGISTRY_AND_SHADOW","thingConnectivityIndexingMode":"STATUS"}' \
  --region us-east-1
```
`REGISTRY_AND_SHADOW` makes attributes and shadow state searchable/visible
in results; `thingConnectivityIndexingMode: STATUS` is what populates the
Connected/Disconnected badge. Certificates and job executions are read
directly (not via the index) and don't need this.

### IoT tab: Certificate search

Fleet Indexing doesn't cover certificates, so **Certificates** mode doesn't
use `iot:SearchIndex` at all — it's a small homegrown query parser against
`iot:ListCertificates`/`iot:DescribeCertificate` instead, so it needs no
indexing setup, but is more limited than Things search:
- `status:ACTIVE` / `status:INACTIVE` / etc. filters by certificate status.
- `certid:<certificate-id>` does an exact-match lookup via
  `DescribeCertificate` (fast, works even with a huge number of
  certificates).
- Any other free text is matched as a substring against certificate IDs
  only (not against metadata) client-side, after paginating through
  `ListCertificates` — so it can be slow and the certificate ID is the only
  thing you can free-text search on.

### OpenSearch

**CloudWatch** and **OpenSearch** are two separate session types rather than
one page with a switch on it. They share the same environment picker, results
table and agent support; what differs is the second step (log groups against
indices) and the query syntax — Lucene `query_string`, e.g.
`level:ERROR AND service:checkout`, instead of CloudWatch's pipe syntax.

Sessions and saved sessions created before the split still open: which of the
two they were using was already recorded in their own state, so they are
routed to the matching page rather than guessed at.

Two things need to line up for the OpenSearch backend to reach a domain:

1. **IAM permissions** — the assumed role needs `es:ListDomainNames` and
   `es:DescribeDomains` to discover domains, plus `es:ESHttpGet`/
   `es:ESHttpPost` to actually search them (see the permissions policy
   above). Listing indices and running searches go straight to the domain's
   own REST endpoint (`_cat/indices`, `_search`) with a SigV4-signed
   request using the same assumed-role credentials as every other call in
   this app — there's no query API for OpenSearch in the AWS SDK itself.
2. **The domain's own access policy** must separately allow that same role
   — an OpenSearch domain's resource-based access policy is checked in
   addition to the caller's IAM permissions, so `es:ESHttpGet`/
   `es:ESHttpPost` in the IAM policy alone isn't enough if the domain's
   access policy denies or doesn't mention the role.
3. **Network reachability** — this backend makes plain HTTPS requests to
   the domain's endpoint from wherever the app's backend runs, so a
   VPC-only domain needs to be reachable from there (e.g. via VPC
   peering/routing), while a public-endpoint domain works with just the
   IAM/access-policy setup above.

If you get a `403 Forbidden` when listing indices or searching despite 1 and
2 above looking right, the domain almost certainly has **fine-grained
access control (FGAC)** enabled. FGAC adds a second, independent
authorization layer on top of the domain's IAM access policy: even a role
the access policy explicitly allows still gets `403` unless that same role
is also mapped to an internal OpenSearch role with the needed index
permissions (in OpenSearch Dashboards: **Security → Roles** → pick a role
with the access you need, e.g. `all_access`, → **Mapped users** → **Manage
mapping** → add the assumed role's ARN under **Backend roles**). The error
message surfaced by the app includes AWS's response body, which for an FGAC
domain typically names the missing mapping explicitly — check that before
assuming it's an IAM/access-policy problem.

There's no async query concept for OpenSearch the way CloudWatch Logs
Insights has `StartQuery`/`GetQueryResults` — a search is a single
synchronous request, so there's no "Stop" button or polling for that
backend.

## Prometheus

A **Prometheus** pane runs a PromQL range query against a Prometheus
connection over a time range (or the session's Time range variable) and shows
every series on a time-series chart -- drag across it to zoom -- and in a
table under it, one row per series and point (time, value, the series' name
and its labels). It auto-refreshes like any pane and the agent can run it.

It's built from its manifest alone: the Prometheus connection type comes with
it (Settings → Environments → **Types**, "From the Prometheus pane"), and it's
listed under its own **Observability** category. Like any pane type added
later, no group has it until an admin ticks it in **Users → Groups → Panes**.
Add a Prometheus connection to an environment (its Base URL, e.g.
`https://prometheus.example.com`), and a credential if it needs signing.

**Settings → Environments → Types** is where admins define kinds of
connection of their own: each is an HTTP API with a Base URL and the plain
fields you add (a secret belongs in a credential). Built-in types can't be
changed, and a type that connections use or a pane reaches can't be deleted.

## Workflows

**Workflows** (the row at the top of the side panel) are steps you run more
than once, the same way each time: parameters, then a list of steps, each one
an action a pane already has -- a DynamoDB scan, a Prometheus query, a
CloudWatch query, an HTTP request -- or a note summing up, or a file to hand on. Steps can depend on earlier ones (`{{ steps.scan.outputs.items }}`),
run only `if` something holds, run once per item with `for_each`, and carry on
past a failure with `continue_on_error`.

- **Running one**: open it, **Run ▸**, fill in its parameters (an environment
  picked by name; a parameter can list its choices the way a pane's picker
  does -- the chosen environment's log groups, say), Run. The run page shows each stage as it finishes; click
  one to see what it ran with and what came back -- rows as a table. **Rerun**
  runs it again; **Copy link** gives the run's own address to send someone.
- **As you**: a run acts as whoever starts it, so it reaches only what your
  group can. Its parameters and results are seen by you, your group and
  admins; others who may run the workflow see only that a run happened.
- **Writing one** is an admin's (for now), in YAML on the workflow's page:
  **Check** points at the line of any mistake before saving. **Access** says
  which groups may run it. With a store repo set up, each workflow is kept
  there as written, comments and all.
- **Approvals**: a step can wait for a person (`approval:`), and one that
  reaches outside the platform -- the HTTP client's Send, MQTT's Publish --
  always does. Whoever may decide sees it on the run page, with what the step
  will do and **Approve** / **Deny**; the Workflows row counts what waits for
  you. `by: others` asks for someone other than whoever started the run,
  `by: admins` for an admin. Nobody deciding within a day fails the step.
- **Long-running steps**: a CloudWatch query is waited for until it finishes;
  an MQTT connection is listened to for `listen` seconds, then closed.
  `timeout` bounds a step, and `retry` tries a failed one again (not one that
  was refused).
- **Rerun from here**: on a finished run, any stage reruns the workflow from
  there, the stages before it copied as they were.
- **Files**: an `artifact:` step writes a file -- JSON, CSV from rows, or
  text -- that the run page offers to download. A step whose outputs are too
  big to show whole keeps them all for later steps and for "Download all".
  Run files are kept 90 days.
- The agent can list, run and read workflows too ("run the table check on
  Prod"), and show you one or a run on this page ("open the table check");
  a step needing approval waits for you, never the agent.
- **Investigate in a session**: on a run's page, opens what it found as a new
  session -- a pane per stage that ran a pane's action, holding the query it
  ran and what came back, to sort, chart, look into and run again by hand;
  its notes and files in the session's description.
- **Make repeatable** (an admin's, on a session's card): drafts a workflow
  from the session -- a step per pane, its environments as parameters -- and
  opens it in the editor to check and save.
- **The Workflow pane** (Platform, granted to a group like any pane): runs a
  workflow from inside a session -- pick it, fill in its parameters (the same
  fields as **Run ▸** on the Workflows page), Run -- and follows it there,
  with a link that opens the whole run on the Workflows page.
- **This run**: while a run is on screen, the agent panel's second tab is a
  conversation about that run ("why did the scan fail?"), kept with the run
  for everyone who may see it.
- **Examples** to paste in and run are in `examples/workflows/` (one needs
  nothing at all: `01-try-me.yaml`).

## The Builder

Groups with the **Builder** turned on (Users → Groups; admins always) get a
**Builder** row at the top of the side panel, for making pane types of their
own. A pane type is written as the same definition every pane is -- its
inputs, the actions that fill its outputs (a request to an HTTP connection,
an action the platform already has, or a function worked out as you type) and
its layout -- starting from a working starter or from any of the platform's
own panes as an example. **Check** points at the line of any mistake;
**Create** makes it, for your group to use at once (**Open in a session**);
other groups get it when an admin grants it in Users → Groups → Panes. With a
store repo set up, each pane type is kept there as written.

**Any AWS service**: an action can call any AWS API that reads, as data --
a `request` naming the `service` and `operation` (Lambda's `ListFunctions`,
ECS's `DescribeServices`…), on the environments the pane's user picks, as
their group's AWS identity. With several environments it's one table with an
Environment column, and an environment that fails says so beside it.
Operations that change something, or hand out credentials or secret values,
are refused. The agent's Building tab knows the shape, with a Lambda example.

**Form**: Edit as YAML or Form -- the form shows what a pane is made of (its
inputs, the actions that fill its outputs, the outputs and the cards they're
laid out in) and changes the YAML in place: switch back and only what you
changed is different, comments included. Renaming an input renames it wherever
the pane uses it. Anything the form doesn't cover stays in the YAML.

**Preview**: beside the editor, Preview draws the definition as the pane it
makes -- its inputs, its buttons, its tables -- and its actions run as you, on
your real connections, so you see what a request really answers before
shaping its rows. Nothing is saved and no session holds it; change the text and
the preview says it's of an older version until you preview again. A pane can
use the platform's own handlers only where your group may use the panes that
run them (DynamoDB's, say, once your group has DynamoDB).

**Building with the agent**: while a pane type's editor -- or a workflow's, on
the Workflows page -- is open, the agent panel's second tab is **Building**.
Say what it should do or what to change ("add a status filter", "show this
pane's jobs and rules too"): the Builder works out what to change, looks up
any AWS operation it needs (what it takes and where its reply keeps its
list), changes the definition, checks it and fixes whatever the check finds
-- a few rounds if it must -- and puts it in the editor for you to look over.
You see each of those steps in the chat. It never saves -- **Check** and
**Save** are yours. If it can't get the definition to check clean, it still
puts its work in the editor and says what's left; ask it to carry on.

A pane can hold several requests: give each its own `output` (`output: jobs`)
and they fill their own tables, each keeping its rows when the other is
fetched.

A pane can have modes: a choice input ("Search for": Things, Certificates,
Rules, Jobs) where each mode runs its own action. Mark each mode's action
`main: {input: searchMode, equals: rules}` and show its button only in that
mode (`when:` on the layout item); the agent, auto-refresh and Enter then run
whatever the mode picks, as the button does.

## The store repo

Admins can point the platform at a git repo (**Settings → Store**, or the
deployment's Helm values -- DEPLOYMENT.md) to keep what they build in it:
credential and connection types today, workflows and panes as they arrive.
Each save is committed to the repo as whoever saved it, in a plugin repo's
layout, so the definitions outlive the database and can move to another
deployment. Credential values, connections, users and sessions never go there.

New types are named under the store's namespace (`devops:grafana`). If the
repo can't be reached, saving still works: the type shows **Not pushed** until
it can. If someone edits a file in the repo and the same type here, the store
shows a **Conflict** with both versions side by side, and you keep one.

## Tools

Small, independent developer utilities. Each one is its own **session type**:
open it from **+** or a home card, beside whatever you're debugging, and it
keeps its state like any other session. Any of them can also be an Aggregator
pane. Each tool's page is laid out in cards, the same as a service page, so its
inputs and its output stay visibly separate.

- **JWT Decoder / Encoder** — decode any JWT's header and payload, or build
  and sign a new one. Runs entirely in your browser (via the Web Crypto
  API) — the token, secret, and payload never reach the backend. Only
  symmetric algorithms (HS256/384/512) are supported for signing and
  verification; RS/ES-signed tokens can still be decoded, just not verified.
- **Base64 Encode / Decode** — plain and URL-safe, UTF-8 safe. Client-side
  only.
- **Diff Checker** — character-level comparison of two blocks of text
  (word- and line-level boundaries alone wouldn't highlight, say, a couple
  of changed characters inside one long unbroken token), with a view-mode
  selector: **Unified** (inline, one line under the other), **Split**
  (side-by-side columns), and **Compact — fold unchanged runs** (unified, but
  collapsing long runs of unchanged lines into a clickable "N unchanged lines"
  placeholder so a small change in a large text doesn't require scrolling past
  pages of context). Compact only folds runs of more than nine consecutive
  unchanged lines, so on a short diff it is identical to Unified by design —
  which is why the option says what it does rather than just "Compact".
  Client-side only.
- **API table** — read a JSON list from an environment's **HTTP API**
  connection (Settings → Environments) as a table: pick the connection, give a
  path, any query parameters, and where the list is in the reply (`data.items`;
  empty if the reply is the list), then **Fetch**. The request is a GET sent
  from the backend with your group's identity on that connection (or the
  connection's own), through the same address checks as the HTTP client, and
  any secret echoed back is masked. Check rows to copy or export them, or to
  attach them to a question for the agent; the rows stay in the session. The
  agent can fill it in and fetch too. It is the first pane described entirely
  by a manifest (`backend/app/panes/manifests/api-table.yaml`), with no code of
  its own.
- **HTTP Client** — a small Postman-like tool: pick a method, enter a URL,
  set headers/body, and see the status, headers, and body that come back.
  Requests can be saved and reloaded by name from the pane's **⚙** (headers and
  body included), and renamed or deleted under **Library → Saved inputs**.
  The last request and its response are always offered to the agent's
  session chat, to ask why it came back the way it did; the agent can fill a
  request in (target and auth included) but only you can press **Send**.
  Requests are
  sent **from the backend**, not the
  browser, so they aren't
  subject to CORS — but for that same reason, the backend refuses to reach
  loopback, private, and link-local address ranges (which also covers
  every major cloud's instance metadata endpoint, e.g. `169.254.169.254`),
  so this can't be turned into a way to probe internal infrastructure or
  steal the backend's own AWS credentials. This check resolves the
  hostname once before connecting; it isn't proof against a DNS answer
  that changes between that check and the actual connection (DNS
  rebinding). Redirects are returned as-is rather than followed
  automatically, so a redirect can't be used to reach a blocked address
  either.

  The agent can fill the request in for you (ask in the session's chat), but
  not send it: sending reaches outside the platform, and waits for the
  approval step. The last exchange -- the request you sent *and* the response
  that came back -- is what the session's chat attaches, which is what makes
  "why is this a 403?" answerable.
- **MQTT Tester** — pick one of your configured environments, then
  subscribe and publish to topics on that account's AWS IoT Core endpoint,
  the same way the AWS IoT console's own "MQTT test client" works. The
  connection is held by the **server**, as you (your group's role), over a
  SigV4-signed WebSocket: **Connect** opens it, messages stream into the
  pane newest first (the last 200 kept, payloads past 8 KB cut, JSON
  indented), and every tab and member with the session open sees the same
  stream -- a reload finds it still connected. Topic filters are chips
  (Enter or **Add**, ✕ to remove); changing them while connected
  reconnects with them, as whoever changed them, keeping the messages
  already shown. **Disconnect** ends it for everyone; so does nobody having
  the session open for two minutes; one person can hold five at once.
  **Publish** sends one message through IoT's data plane and needs no open
  connection. Topics are kept with the pane's **⚙** (topics you
  saved before this moved there by themselves). The role needs
  `iot:DescribeEndpoint`, `iot:Connect`, `iot:Publish`, `iot:Subscribe` and
  `iot:Receive` (see the permissions policy above), and the IoT Core
  endpoint must be reachable from the backend over HTTPS/WSS. The platform
  agent can set the topics, connect, read what arrives and disconnect --
  as you -- but not publish.

  If connecting fails, the error says what answered the WebSocket
  handshake: when it's refused, the server tries the handshake once more on
  its own, which reads AWS's actual response (paho, like a browser, only
  reports "not upgraded"):
  - "the WebSocket handshake itself was accepted" means the URL and
    signature are valid and it was MQTT that refused -- usually an IoT
    policy limiting the client id (`cloudwatch-insights-<random>`, shown in
    the status once connected).
  - `HTTP 403`/`401` means AWS rejected the connection, but the generic
    `Forbidden` body it returns doesn't say why -- and **this action doesn't
    show up in CloudTrail**, since it's an MQTT-level decision inside the IoT
    device gateway, a separate system with its own logging. To see the
    actual reason: enable AWS IoT Core's own logging (IoT Console → Settings
    → Logs → set the default log level to `DEBUG` or `INFO`), reconnect, and
    look in the CloudWatch Logs group it writes to (`AWSIotLogsV2` by
    default) for the entry matching the client ID shown under the connection
    status.
    - **If nothing shows up there even with logging enabled**, check for a
      *per-event-type* override before assuming the request never arrived:
      `aws iot get-v2-logging-options` returns an `eventConfigurations` list
      that can override specific event types (e.g. `Connection.AuthNError`)
      to `DISABLED` independently of `defaultLogLevel` -- easy to miss since
      the console's basic log-level toggle doesn't surface it. Clear that
      override (or set it explicitly to `INFO`) and reconnect.
    - Once you can see the actual log entry, its `reason` field gives the
      real cause. A `reason` of `SECURITY_TOKEN_SIGNATURE_MISMATCH`
      specifically does *not* mean an IAM/policy problem (IAM Policy
      Simulator will report the action as allowed) -- it means the signature
      itself doesn't match what IoT Core recomputes. This app used to have
      exactly that bug: AWS IoT Core's device gateway recomputes the
      expected signature *excluding* the session token, unlike normal
      SigV4Query behavior (e.g. for S3 presigned URLs) which signs the token
      along with everything else -- signing it in, which botocore's
      `SigV4QueryAuth` does by default when given a token-bearing
      credentials object, produces a URL IoT Core always rejects this way.
      It's fixed now (the token is appended after signing, unsigned), but if
      you're running a fork or an older build, this is the first thing to
      check.
    - For any other `reason` (an actual authorization denial), check the
      identity-based policy first -- the MQTT client ID isn't sent until
      *after* a successful WebSocket upgrade, so a client-ID-scoped policy
      condition can't be the cause of a rejection this early. If the role's
      own policy already grants `iot:Connect`/`iot:Publish`/`iot:Subscribe`/
      `iot:Receive` on `Resource: "*"` and it's still denied, run IAM Policy
      Simulator against the exact assumed-role ARN
      (`aws iam simulate-principal-policy --policy-source-arn <role-arn>
      --action-names iot:Connect --resource-arns
      "arn:aws:iot:<region>:<account-id>:client/*"`) -- unlike CloudTrail,
      it accounts for SCPs and permissions boundaries and tells you which
      one is the source of a deny, if any. If the simulator says the action
      is allowed, and DNS for the IoT endpoint resolves to a public IP (not
      a private VPC-endpoint address), also check whether an IoT Core
      custom/default authorizer is configured on the account (IoT Console →
      Security → Authorizers) -- one intercepts even SigV4-authenticated
      connections independently of IAM.
    - Separately, the backend's system clock can also produce a genuine
      signature failure (SigV4 signatures are time-bound) -- compare
      `date -u` in the pod against a trusted clock if the above doesn't
      explain it.
  - "from something that isn't AWS (no x-amzn headers: a proxy or
    firewall?)" means the response carried none of the headers a real AWS
    answer has (`x-amzn-RequestId`, `x-amzn-ErrorType`) -- something in the
    network path between the backend and IoT Core answered first, which is
    also why nothing would ever appear in IoT Core's own logging.
  - `HTTP 404` means the endpoint itself doesn't recognize `/mqtt` as a
    route at all — double check the discovered endpoint is actually this
    account's ATS IoT data endpoint.
  - "the handshake failed" with no status (a connection/timeout error)
    means the endpoint wasn't reachable from the backend — check network path and security groups if
    the domain uses a VPC endpoint.

## Notes

- Log group listing and query execution both fan out across every selected
  environment concurrently; a failure in one (bad role, missing
  permissions, wrong region) is shown inline next to that environment
  without blocking the others.
- CloudWatch Logs Insights only supports querying log groups that live in
  the same account/region as each other, which is exactly what an
  environment pins down — so under the hood the app issues one `StartQuery`
  per selected environment (using whichever log groups you selected within
  it) and merges the results client-side.
- The **Limit** field in the Query section is applied per environment via
  CloudWatch's own `StartQuery` `limit` parameter — with N environments
  selected, up to `N × limit` rows can come back from AWS in total. The
  merged view re-sorts everything (see **Sort by**, next) and caps the
  *displayed* total to the same limit, so what you see always matches what
  you asked for regardless of how many environments you selected. A
  `| limit` command inside the query text itself is left untouched and
  applies on top of this, same as in the AWS console.
- The **Sort by** field/direction, in the results' toolbar, control how the
  *merged* results from every environment are ordered and displayed — it
  sorts the rows on screen without running the query again — pick any
  field present in the results (it's populated from your actual query
  output after running it), or "Original order" to leave the merge order
  alone. This is separate from a `sort` command inside the query text
  itself: that one still runs on AWS's side per environment and determines
  *which* rows survive that environment's `limit` before they ever reach
  the merge step, so the default query keeps `| sort @timestamp desc` for
  that reason even though the UI's Sort control also defaults to the same
  thing for display.
- The IoT tab's **Max results** is a per-environment cap on a single
  `SearchIndex` call, like Insights' Limit — but unlike Insights there's no
  client-side re-merge/truncation step, since fleet search results aren't
  naturally comparable/sortable across environments the way log rows are by
  timestamp. There's also no "load more"/pagination yet: raise Max results
  (up to 500) if you need more than the default 50 per environment, or
  narrow the query.
- The IoT tab is entirely read-only: it never creates, updates, or deletes
  a thing, certificate, shadow document, or job. A missing permission on
  one part of a thing's detail (e.g. `iot:ListJobExecutionsForThing`)
  shows a warning for just that section rather than hiding the rest of
  the thing's detail.
