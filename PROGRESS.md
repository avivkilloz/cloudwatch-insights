# PROGRESS.md

Where the work stands. Durable architecture/conventions are in `CLAUDE.md`.

_Last updated: 2026-09-29, grounding the platform agent's turns (after #96)._

## Platform plan

`PLATFORM_PLAN.md` (started 2026-10-04) organises the next stage: workflows, external
plugins and a marketplace, an internal builder, typed secrets, and environments that
mean something for any provider. It was agreed on 2026-10-04 (decisions D1–D28,
requirements R1–R6 in its §11). Phase 1 (credentials, its §13) is built, as one
PR at the user's request (D29): the store, user-definable types, API, audit log
and key rotation; the Settings screens; the master key in Helm, docker-compose
and DEPLOYMENT.md; and the HTTP client's Auth. Backend 252 tests (23 new);
browser suites smoke58 (screens) and smoke59 (Auth), both failing against the
old frontend. Next: Phase 2 (connections and generalised environments).

## Where things stand

**Branch:** `claude/multi-account-cloudwatch-insights-shyq4m` (the standing
feature branch — restarted from `main` each round, same name).

**Open:** only the PR carrying this round's work (below). Everything else is
merged.

**Merged before this session:** #63 (rail rename, portal menu, folded
catalogue), #64 (autosaved live sessions + session strip), #65 (one Sessions
list, templates under Add), #66 (strip ⋮ + page-title card), #67 (Aggregator
tabs layout), #68 (every session is an Aggregator), #69 (spacing, Create
button, Tabs first, saved-items rework, services/tools back under Add), #70
(CloudWatch and OpenSearch split into two group permissions; saved rows read
as their name).

**Merged this session:** #71 (moved these notes and the e2e suites into the
repo), #72 (session categories — Slack-style groups in the rail with
drag-to-file — and a freeform "Dashboard" layout for the Aggregator, panes
placed and resized by dragging), #73 (a closed session stays inside its
category, dimmed; the dashboard layout refuses to let panes overlap while
being dragged or resized, and snaps them to a grid and to their neighbours'
edges/gaps), #74 (dashboard panes resize from any corner instead of just
bottom-right; dragging toward the bottom edge auto-scrolls; moving/resizing
keeps a minimum gap, shown while dragging as a dashed "cut lines" preview;
the resize-handle corner glyphs were dropped in favour of the cursor
changing shape), #75 (resizing, not just dragging, is now blocked from
crossing the canvas's own edges — growing a pane's top edge could push it up
over the "Panes" card, growing or dragging its right edge could push it past
the canvas's width and force the page into horizontal scroll; resize
handles now cover the four edges as well as the four corners, each moving
only the one dimension it sits on), #76 (a first attempt at "new panes land
in the first free place" and a `scrollbar-gutter: stable` canvas edge — it
only held up for panes opened all at once into a fresh session, which is all
its suite, smoke41, exercised), #77 (the dashboard fixed for how it's
actually used — panes added one at a time, moved, closed and reopened,
sessions closed and reopened — each bug reproduced in the browser first):

- *Panes jumping / landing on each other.* A never-dragged pane had no stored
  place and was re-laid-out every render, so it jumped whenever a pane before
  it moved; a closed pane reopened on top of whatever had taken its spot.
  `resolveDashboard()` now keeps each non-colliding stored rect, gives the
  rest the first free spot in reading order (`firstAvailableRect()`, which
  searches the real gaps between panes), and an effect stores every new
  placement at once. Closing a pane forgets its spot; expanding a minimised
  pane that others moved under relocates *it*. Panes start flush with the
  "Panes" card; neighbour edges beat the 20px grid when snapping.
- *Can't drag after reopening a session.* The canvas width came from a
  page-wide `document.querySelector`, which with two sessions mounted found
  the hidden one's 0px canvas and clamped every drag/resize in the other.
  Now measured per session with a ref + `ResizeObserver`.
- *Closing a session lost its last changes* — and a session closed before
  its first save reopened empty — because closing removes it from the
  workspace before the 1.2 s sync debounce fires. `WorkspaceSync.close()`
  now pushes its state first, on the same request chain as the close.
- *Scrollbar at the window's edge*: `.shell`'s right padding moved inside
  `.content`, so every card is 16px clear of a scrollbar that now sits
  against the window.
- *From an audit:* dragging a minimised pane overwrote its height with the
  40px header's; Escape now cancels a dashboard move/resize; a
  browser-cancelled pointer no longer commits.

  Coverage: `smoke42.mjs`, confirmed to fail against the previous code
  before passing.

#78 recorded that session's decisions in CLAUDE.md, these notes and the e2e
README.

**#79: several panes of one kind, each named** (merged):

- *Home:* each card takes a − n + count (0 by default, 10 at most per card;
  the card itself also adds one) instead of a tick, so a session can start
  with two CloudWatch panes and an IoT one.
- *Panes card:* "+ CloudWatch" buttons that only ever add; a pane closes from
  its own ✕ (header, or tab in the tabs layout).
- *Model* (`sessions/panes.ts`): `services` lists pane ids, new `paneTypes` /
  `paneTitles` keys give each id its kind and name; a pane absent from them is
  one whose id is its type (every session/template saved before this — no
  migration). First pane of a kind keeps the type as id, then `type~2`...
  Closing a pane drops its `"<id>."` keys (`useDropSessionKeys` in
  `SessionContext.tsx`), since ids are reused.
- *Names:* "CloudWatch", "CloudWatch 2"... (the sessions' own `nextTitle`
  rule); rename with ✎ in the header or double-click a tab; Escape cancels, a
  blank name goes back to the default.
- *Assistant:* a pane's name reaches the shared widget (`PaneAiScope`) only
  when it adds something — two of a kind, or renamed — so the common case
  still reads "IoT things", not "IoT".

  Coverage: `smoke43.mjs` (checked to fail against the old code, and
  mutation-tested: without the key drop, a re-added pane resurrects the closed
  one's query). The Panes-card checkboxes and home-card ticks were replaced in
  the harness (`newSession`, new `addPane` / `closePane`) and in the eleven
  suites that clicked them; smoke25 now says "2 panes" rather than "2 pages".

**#80: two-way live sync, the agent's phase 1** (merged, deployed and tested
by the user): see the phase 1 notes below.

**#81: the agent's phase 2** (merged): the MCP server, the agent container,
streaming chat -- see the phase 2 notes below.

**#82 and #83 (merged): the agent panel replaces the assistant, and
the shell around it.** The user's six asks, in order:

1. *Global and Session conversations* in the agent panel. Global is the old
   one (the platform; the header input; the Agent page). Session is one chat
   per session, stored in its state (`agentChat`, excluded from templates),
   about that session: the backend takes `scope: "session"`, checks the
   session is the user's, and the agent adds a prompt keeping it there. The
   rows checked in the session's panes are attached to the question
   (`PaneSelectionShare` in each pane → the Aggregator pools them →
   `agent/selection.ts` → the composer's "Attach N checked rows").
   **The ✦ Ask AI assistant is removed** everywhere: the floating widget,
   `/api/ai`, `ai_assistant.py` and its tests, its CSS, the HTTP tool's
   "Use this request". `backend.ai` in Helm is now only the agent's, and the
   backend no longer gets `LITELLM_*`. (A side effect fixed: the saved-
   template filter dropped any key whose leaf was `mode`, which included
   Base64's own encode/decode input.)
2. *Two layouts*: docked beside the page, or floating over it from a corner
   button (the assistant's old spot). An icon in the panel's header switches;
   the old "Full page" button is gone (the Agent page is still on Home).
3. *Per-tab ⋮* with Rename, Save as template, Close, Delete, replacing the ✕;
   the strip's end ⋮ became the agent panel's show/hide toggle, mirroring
   the rail's at the start.
4. *Spacing*: cards now end exactly 16px from the dock (and from the window):
   `.content`'s right padding is `16px - --scrollbar-size` with the scrollbar
   inside it, and the dock cancels `.shell`'s gap.
5. *Scrollbars*: one 6px thumb-only style for every scrollbar, set once at
   the end of `styles.css`; the three `scrollbar-width: thin` rules are gone
   (in Chrome they override the styled bar).
6. *Resizable columns*: `ColumnResizer` in the gap beside the rail and the
   dock, a dashed cut line on hover, double-click to reset, arrow keys to
   nudge, widths per browser.

Coverage: new `smoke46` (the panel, the session chat with attached rows and
a query written into the pane, float/dock, the tab menu, gap and scrollbar
measurements, resizing); smoke45 reaches the Agent page from Home; the four
assistant-only suites (14, 15, 18, 19) retired, the assistant parts of 16,
17, 20, 22, 23 removed, and every suite that closed a tab with its ✕ now uses
the harness's `closeTab`/`tabMenu`. Backend 171 (the assistant's tests gone,
three relay tests for session scope added), agent 6. Full run: all 30
browser suites green; smoke46 fails at its first step against the previous
frontend. smoke41 and smoke42 now measure the scrollbar (6px, inside the
16px gap) instead of reading `scrollbar-width`.

**Follow-ups from the user trying it (#83):**

1. *A pane ran on behind the dock.* Reproduced at 1280px: a wide dock (and
   rail) squeezed the body to ~100-300px, the side-by-side layout's 420px
   minimum track overflowed, and the body scrolled sideways under the dock.
   The dashboard itself refits correctly (checked through several drag and
   resize sequences). Fix: `BODY_MIN_WIDTH` (440) in App.tsx caps each
   resizer at what the window leaves and draws a stored width narrower when
   the window shrinks; the columns track is `minmax(min(420px, 100%), 1fr)`.
2. *"I meant the MQTT tester"*: the agent answered that no such tool existed,
   because browser-only kinds weren't in `KINDS`. MQTT tester and JWT are
   now there with no inputs: addable, nameable, and a run or an input says
   what the user has to do in them. Fake model gains `add <kind>`.
3. *Floating panel*: restyled after the old assistant's (header bar with a
   rule, edge-to-edge conversation, ruled compose band, the 16px box with a
   four-dot grip, the old corner button size). The dock keeps its card.
4. *Scrollbar and cut line*: the dock's dashed line is now drawn in the
   middle of the 16px gap (it was centred in the 10px left of the scrollbar,
   3px off); the thumb is a lighter 4px pill inset in its 6px track. A
   hover-only body scrollbar was tried and dropped: Chrome doesn't repaint a
   styled scrollbar on :hover changes.

Coverage: new `smoke47` (laptop width with the dock and rail dragged to
their max, window narrowed and widened; both cut lines centred; the float
panel's look; the agent adding an MQTT tester) -- 8 of its 12 checks fail
against the previous frontend. Backend 172 (a test that browser-only tools
can be added but not filled in; the one pinning their absence updated),
agent 6. Full run: all 31 browser suites green.

**#84 (merged): no header bar, and the session's own card in
the side panel.** The user's five asks:

1. *Agent panel header*: docked or floating, the panel has a header bar
   padded like the strip (5px 6px), so docked its Global/Session tabs sit
   level with the session tabs (measured equal). The dock's ✕ is gone -- the
   strip's toggle hides it; floating keeps one.
2. *Tabs*: the per-tab ⋮ from #82 is reverted: a ✕ on each tab again, and
   one ⋮ (Rename, Save as template, Delete) for the session on screen, in a
   `.session-bar-end` group just before the agent panel's toggle.
3. *No header bar*: the brand (`Brand.tsx`: logo, or the title's initial on
   a tile) heads the rail as its first row, replacing Home (same
   `.rail-row-home` class), and starts the strip while the rail is hidden.
   The account is a card at the rail column's foot (`UserMenu
   variant="card"`, menu opens upwards); with the rail hidden, an avatar on
   the strip after the logo (not asked for -- otherwise there'd be no way to
   Settings or Log out). The header's question box went too: the Global tab
   is the same conversation. Heights that allowed for the 53px header were
   given it back.
4. *Descriptions*: `description`, a top-level state key: optional on the
   home page's start form, shown in PageInfo (full strength; the generated
   "X in one session" line only when there's none), ✎ to edit (Enter saves,
   Escape cancels -- the blur that follows is skipped). Templates keep it;
   the agent's `_describe_session` reports it.
5. *Panes card in the rail*: ⇤ on the card moves it under PageInfo, ⇥ back,
   per browser (`railSlot.ts`). Only the session on screen portals it; with
   the rail hidden it's back in the body.

Coverage: new `smoke48` (the lot); against the previous frontend it fails
at its first check. Eighteen suites migrated (account menu selector, the
Global tab instead of the header box, the brand row instead of Home, tab ✕
and the strip ⋮ back). Backend 173 (the agent reads a session's
description). Full run: 32 of 32 browser suites green, after smoke35's page
colour check was made to compare colours rather than strings (read during
the body's background transition, the same colour serialises as rgba).

**#85 (merged): one Session card, and the shell's edges.**
The user's seven points:

1. *Rail brand*: a header bar (`.rail-head`, sticky, ruled) padded like the
   strip, 26px row, so the brand is level with the session tabs (measured
   22-48, like the tabs) and the bar ends where the strip does.
2. *Account picture*: the rail's foot card is gone. The picture ends the
   strip, or -- with the agent panel docked -- that panel's header after its
   layout switch; floating, it stays on the strip.
3. *Category on a new session*: a select on the home form (None by default,
   only when categories exist); `start()` files it after `open()`.
4. *One Session card* (`SessionCard.tsx`) replaces the Panes card and the
   rail's title/description card: name and description edited in place, adds,
   layout. Body or rail (railSlot, same key), and in the rail it stays there
   while the rail is hidden. PageInfo is for non-session pages only.
5. *Reorder cut line*: `outline-offset: -3px` (inside the pane). Outside, the
   body's scroll box clipped its left edge and the strip's sticky backing
   painted over its top.
6. *Tokens* (the user asked why so many): answered -- mostly subagent
   migrations reading and running many suites, whole-file reads, and a
   163-entry task list re-sent many times; the list was cleared and this
   round's suites were migrated by targeted replacement instead.
7. *Scrollbar at the window's edge with the dock open*: the dock is
   `position: fixed` over the body's right (pointer-events off on its gap) and
   `.content` pads by `--dock-width`, so the scroll box runs to the window.

Coverage: `smoke48` rewritten for this round (fails at its first check on
the previous frontend); 13 suites updated by replacement (`.session-card`
for the Panes card, the session card's title for a session's page-info
title, the rail's header bar). Full run: 27 of 32; the five failures were
fixed and each re-run on its own green -- smoke30/32 now expect the picture
after the agent toggle, smoke26 compares the card's title with the tab (the
home form's leftover count decides the default name), and smoke35/30's
category-dependent checks and smoke44's closed row passed once a category
leaked by an aborted smoke48 run was gone.

**#86 (merged): follow-ups to #85.**

1. *Dashboard pane under the dock*: `resolveDashboard` checked overflow with
   the already-clamped width, so a pane at x 0 wider than a narrowed canvas
   was drawn at full width. Checked with the stored width now; the stored
   width is kept, so it grows back.
2. *A more dynamic dashboard*: suggestions given to the user, nothing built
   yet (see below).
3. *Double-click a session tab* to rename it.
4. *Picture spacing*: 8px clear of the toggle before it, strip and dock.
5. *Session card as one form*: `CardRow`/`CardSection`, a 96px label column
   (labels over values in the rail), three ruled sections, the move button
   absolutely in the corner, one `.session-card-input` style for both
   editors, the layout as a segmented control (2×2 in the rail).

**Dashboard ideas offered, not started** (the user's call): push the panes
in the way down (Grafana-style) instead of stopping the drag at the nearest
free spot; drop on a free spot anywhere; drop between two panes to insert;
shrink a neighbour to its minimum before refusing; and an optional
"tidy up" (compact upwards). Preview each as the ghost outline before it's
committed, so nothing moves until release.

Coverage: new `smoke49` (the fit, double-click rename, picture spacing, the
card's alignment and editors); with only the fit fix reverted it fails the
two fit checks. smoke20/33/35/43 point at the card rows and the segmented
control. Full run: 32 of 33; smoke29's "several sessions autosave in panel
order" failed once (server order JWT, IoT, Diff) and passed on its re-run.

**#87 (merged): card and picture touch-ups.** A rule under the Session
card's header; in the body the card folds to its header and name
(`cardCollapsed`, per session); the account picture sits 6px further in from
the end of its bar. smoke49 extended to 21 checks. Full run: 31 of 33, then
green -- smoke32's "picture at the far end" allowance widened for its new
inset, and smoke44 now waits for the closed row as it already waited for the
tab to go.

**#88 (PR opened, not yet merged): rail brand and Session card, pane-styled.**

1. *Rail brand*: closer to the left edge; hover/active now highlight only
   the text (`.rail-brand-title`), no background pill -- as the old
   top-header logo did.
2. *Rail-head rule*: lowered (padding-bottom 5px → 10px) without moving the
   brand row itself, so it now lines up with the docked agent panel's own
   header rule instead of the session strip's bottom.
3. *Session card, restyled like a pane card*: a clickable header bar
   (`.session-card-head`, `panel-alt`) that folds/expands the card (the
   fold and move buttons stop their click bubbling, the same trap the pane
   header comment already names), and each section (`CardSection`) is now
   its own bordered inner card instead of being ruled off by a line.

Coverage: `tsc --noEmit` clean; smoke48 (rail-head alignment check retargeted
at the agent panel's header rule) 22/22; smoke49 (move-button corner
tolerance widened, 8px 12px header padding instead of an absolute corner)
21/21. Full `run-all.mjs` not run this round, per the user's explicit
time/token constraint -- targeted verification only.

**#89 (merged): follow-ups to #88**, before the dynamic dashboard (still on
hold -- see below). #88 had already merged when that round started, so the
branch was restarted from `main` and the round's commit rebased onto it --
the first time this engagement hit "the PR you're pushing to already
merged," which is now a standing rule (see CLAUDE.md/this file's header).

1. *Session card header buttons*: fold now shares a pane header button's own
   `.secondary` look and glyph (`+`/`−`), not a bespoke circular icon
   button; the body's side padding matches a pane body's (16px → 12px), so
   the inner section cards don't sit further in than a pane's own do.
2. *Tabs layout, joined and evenly divided*: `.aggregator-tab` is
   `flex: 1 1 0` and the tabs are joined edge to edge (like the session
   card's segmented Layout control), always as wide as a pane in the
   stacked layout since it's the same container. The Settings page's own
   section tabs get the same treatment (`.settings-tabs`); other `.tabs`
   uses (Saved items) are untouched.
3. *The agent can set a session's description and category*: two new MCP
   tools, `set_description` and `set_category` (plus `list_categories`) --
   `set_category` finds or creates the named `SessionCategory` and sets it
   directly on the row inside `mutate`, the same way `rename` sets
   `row.title`. `_describe_session` now reports `category` too.

Coverage: `tsc --noEmit` clean; smoke33 (tabs layout) 21/21; smoke48 22/22;
smoke49 21/21; new backend test
`test_the_agent_can_set_a_sessions_description_and_category`, full backend
suite 174/174.

**#90 (merged): a lone session tab's left corner wasn't rounding.**
`:first-child`/`:last-child` are equal specificity, so with exactly one tab
both matched and whichever came later in the sheet won outright, squaring
off the other corner. Fixed with a combined `:first-child:last-child` rule.

**#91 (merged): the agent panel's Global/Session tabs joined the same way**
as the session tabs layout (#89) and the Layout control -- one shared
button, not two separate bordered ones with a gap. Carries the same
defensive `:first-child:last-child` fix as #90.

## Sharing a session — agreed design and phases

The user wants sessions shared with other users: invited when the session
is created, or afterward; different permission tiers; and the session-tab
agent chat turned into a multi-user conversation the agent only joins when
`@`-mentioned, managed from the session card. Given how much of the existing
architecture assumes one owner (`LiveSession.user_id`, the per-user
`pg_notify` fan-out, per-group IAM/environments, the agent's per-user
token), this is a multi-PR project agreed up front rather than one PR:

1. **Data model + membership API (done, PR pending).** `SessionMember`
   (session_id, user_id, permission) -- additive only, `LiveSession.user_id`
   stays the owner. Two tiers: *viewer* (read-only) and *editor* (edit
   inputs, add/remove panes, run tools -- everything except managing
   membership itself). `routers/live_sessions.py` gets `/members`
   (list/invite/change permission/remove), owner-only. **Inviting someone
   does not yet let them reach the session** -- every existing route still
   checks ownership alone; that's phase 3.
2. **Session card UI to manage members (done, PR pending).** A fourth
   section on the card, `CardRow label="Members"`: each invited user on its
   own line (name, a permission `<select>`, a ✕ to remove), then the invite
   form (username + permission picker + Invite). Fetched from the API on
   the session's own mount (`api.listSessionMembers`), not session state --
   it's the owner's roster, not something that syncs. Errors (no such
   user, already a member, inviting yourself) show inline as `.error-text`,
   the same `withActionError`-style pattern Settings uses. A brand-new
   session's row doesn't exist on the server until the debounced autosave
   lands, so an invite made in the first ~1.2s of a new session 404s --
   the same window every other write into a new session already has, not
   a new failure mode this introduces.
3. **Actually letting a member in (done, PR pending).** `_reachable()`
   replaces `_owned()` for every route except delete and the roster itself
   (both stay owner-only): the row, plus the caller's own `SessionMember`
   if they're not the owner. `state`/`title`/`type`/`version` are the one
   shared document -- an editor can write them (a viewer gets 403);
   `position`/`category_id`/`closed_at` are never shared, each member (and
   the owner) has their own copy of all three, since a session held open by
   several people needs an independent panel position, category and closed
   state per person, decided explicitly (not the simpler "shared with you"
   list originally floated). `live_store.commit_write` now fans an
   "upsert" out to every participant (owner + members) instead of just the
   owner, so an editor's write reaches every other open browser live,
   through the existing per-user `pg_notify`/SSE plumbing unchanged, just
   called once per participant. A member always acts under **their own
   group's** environments and IAM role, never the owner's -- no per-session
   access grant, "access control is per group, never per user" intact. A
   member leaves via `DELETE /{client_id}/members/{their_own_user_id}`
   (self-removal, allowed even though managing anyone else's membership
   stays the owner's); deleting the session outright stays owner-only.
   One necessary frontend change rides along: `LiveSessionOut`/`Summary`
   gained a `role` field, and `sync.ts`'s autosave skips the PUT outright
   for a viewer -- without it, merely *receiving* someone else's live edit
   would queue a save that 403s on every flush. Nothing else in the
   frontend is gated on role yet (a viewer can still click a control that
   fails server-side) -- that's deliberately left to a later phase, not
   bundled into this one.
4. **Multi-user chat (done, PR pending).** Needed almost no new plumbing:
   `agentChat` is a key in the same `state` phase 3 already made the one
   shared document, so it was already syncing live to every member the
   moment a session had any. What this phase adds: `AgentTurn` gains
   `author`/`agentInvoked`; gating (does a message need `@platform-agent`
   to get a reply) is client-side and keyed on whether the session is
   *actually* shared (an unshared session's chat is untouched -- every
   message still goes to the agent, exactly as before); `routers/agent.py`
   uses the new `live_store.reachable()` so a member can start a session
   turn at all; `sync.ts`'s merge treats the chat log as append-only
   (union by turn id) instead of "one side's whole array wins", so two
   people's messages in the same debounce window don't clobber each other.
   **Known gap, confirmed not just anticipated**: the agent's own tools
   (`get_context`'s `viewing_session`, everything built on
   `live_store.get`/`mutate`) stay strictly owner-scoped, so a member who
   mentions the agent can talk to it but can't get it to act on the
   session -- it says "You aren't looking at a session, so there's nowhere
   to put it." Fixing that means auditing every `platform_tools` function
   that writes owner-only row fields directly (the same care phase 3 put
   into the browser's own routes) -- a further phase, not part of this one.

Coverage for phase 1: `test_session_members.py` (invite, list, change
permission, remove, owner-only, scoped per session), full backend suite
183/183.

Coverage for phase 2: `smoke50.mjs` (new, 12 checks -- the Members row
exists; the three invite errors; invite at a chosen permission; the field
clears after; duplicate invite; change permission in place; survives a
reload, proving it's server-backed and not session state; remove), fails
against the pre-phase-2 frontend as expected. `smoke49`'s card-shape
checks updated for the new row/section (six rows, four sections). `tsc
--noEmit` clean.

Coverage for phase 3: new `test_session_sharing.py` (13 tests -- a member
can GET/PUT per their permission, 403 for a viewer, 409 for a stale editor
write, the shared state is genuinely one document, position/category/closed
state are each participant's own and never leak to another, reorder moves
the right row for whoever asks, delete stays owner-only and cascades to
members, leaving works and doesn't touch the owner's copy); 9 of the 13
fail against the pre-phase-3 backend, confirming the suite exercises real
new behavior. `test_session_members.py`'s owner-only test updated (a
member removing themselves is now 204, not 404 -- the deliberate new
"leave" rule). Full backend suite 196/196. Manually verified live in the
browser with two real logged-in users (an owner and an invited editor):
the editor's shared session shows up automatically in their own panel
purely from the existing frontend's generic sync code (no rail/UI changes
needed for that); the owner's rename of the session reached the editor's
already-open tab **live**, with no reload, through the unmodified SSE
stream; an invited viewer's browser made zero PUT attempts for the shared
session over several autosave cycles, confirming the sync.ts guard.
`tsc --noEmit` clean; smoke29/33/34/35/44/48/49/50 (164 checks across the
suites most likely to touch position/category/closed/reorder for an
*owned* session) all still green, unchanged.

Coverage for phase 4: new `smoke51.mjs` (7 checks, two real logged-in
users -- a plain message never reaches the agent once shared; it shows
who sent it; a member sees the owner's message live, labelled and on the
left; mentioning the agent (and only that message) gets a reply; neither
side's message is lost); fails against the pre-phase-4 frontend (4 of 7,
then errors out on the diverged flow) confirming real new behavior.
`test_agent_chat.py` gained a test that an invited member's session-scope
chat reaches `focus` instead of 404ing. Full backend suite still green;
`tsc --noEmit` clean; smoke22/23/45/46/47 (110 checks, the suites that
touch the agent chat directly) all still green, unchanged -- an unshared
session's chat behaves exactly as it did before this phase.

5. **The agent's own tools, on a shared session (done, PR pending).**
   Closes the gap phase 4 confirmed: an invited member could chat but
   couldn't get the agent to act on the session, since every tool went
   through `live_store.get`/`mutate`, strictly owner-scoped. Backend-only
   -- no frontend change needed, since the gap was in the platform-agent's
   own reach, not in what reached it. `live_store.get` stays owner-only on
   purpose (it's what one caller still wants); every tool now goes through
   `live_store.reachable()` (or the new `reachable_sessions()` for
   `list_sessions`, sorted by *the caller's own* position on a shared row)
   the same as the browser's own routes since phase 3. `mutate()` hands its
   callback the caller's own `SessionMember` (`None` for the owner),
   refuses a viewer outright with a sentence naming why, and reopens the
   *caller's own* closed-state on write. `set_category` is the one tool
   that needed real branching (writes `member.category_id`, not
   `row.category_id`, for a non-owner) -- everything else's callback picked
   up the new parameter unused, since `state`/`title` are the one shared
   document. `_describe_session` gained a required caller id and now
   reports that caller's own role/category/closed-state instead of always
   the owner's.

Coverage for phase 5: 5 new tests in `test_platform_tools.py` -- a member
reaches `get_session`/`list_sessions` and sees their own role; a viewer's
`add_pane` is refused ("read-only access") and the state is untouched; an
editor's `add_pane` succeeds and the owner's own read sees it; `set_category`
sets the member's own category, never the owner's row; `get_context`'s
`viewing_session` reports an invited editor's role. All 5 fail against the
pre-phase-5 `live_store.py`/`platform_tools/server.py`, confirming they
exercise real new behavior. Full backend suite 202/202. `tsc --noEmit`
clean (no frontend files touched this phase).
`platform-agent/tests` needs no changes: it drives the real LangChain agent
against its own hand-rolled stub MCP server, never the real
`platform_tools/server.py`, so nothing in this phase reaches it.

**Invite-field username suggestions (done).** A follow-up to phase 2's UI,
requested afterward: as you type in the invite field, matching usernames
suggest, narrowing with every character (asked for as "g" suggests two
users, "ga" still both, "gab" narrows to one). New `GET
/api/users/suggest?prefix=` -- open to any authenticated user (unlike the
admin-only `GET /api/users`), capped at 8 minimal `{id, username}` rows,
excluding the caller, on the reasoning that the invite endpoint it feeds
was already an open, cross-group, exact-username invite -- this just makes
that reach discoverable. Frontend debounces 150ms, filters out existing
members, supports arrow keys/Enter/Escape, and a click (`onMouseDown` +
`preventDefault`, so the input's own blur-close doesn't beat the click).

Coverage: 3 new tests in `test_users.py` (prefix match, case-insensitive,
narrows correctly; excludes self and returns `[]` for an empty prefix or
none at all; reachable by a non-admin, unlike `list_users`). New
`smoke52.mjs` (8 checks, three real users -- narrows "g" -> "ga" -> "gab"
exactly as asked for; picking a suggestion fills the field and the normal
invite still works; an already-invited user drops out of future
suggestions); fails against the pre-feature code (times out waiting for
the dropdown), confirming real new behavior. Full backend suite 205/205;
`tsc --noEmit` clean.

**Four follow-up fixes/features, reported after using the feature for real
(done).** (1) The invite dropdown was as wide as the whole row, not the
input -- its wrapper had no `max-width` cap to match the input's own 560px;
fixed. (2) Picking a suggestion reopened the dropdown right back up once the
debounced fetch effect re-ran for that exact (now-matching) name; fixed with
a ref that suppresses exactly that one re-run. (3) Inviting someone updated
the agent panel's own "is this shared" gating only on the next view (a
reload, or switching away and back); `AgentContext` now exposes
`refreshShared(sessionId)`, called by the session card's invite/remove
handlers on success, so it's immediate. (4) The session chat's compose box
now suggests "@" mentions -- every current participant plus the agent's own
handle, narrowing as you type, fetched fresh per mention (not cached) so an
invite made moments earlier is never stale. New `GET
/{client_id}/participants` (owner + members, reachable by any of them,
read-only -- unlike the owner-only `/members`) backs this and also closes a
real gap: `_describe_session` (what `get_context`/`get_session`/
`list_sessions` report to the agent) never listed members at all, so an
owner asking the agent "are there other members here?" was told no even
when there were; it now reports a `members` list whenever a session has more
than just its owner.

Coverage: 3 new backend tests in `test_session_sharing.py` (a member can
list participants where `/members` still 404s them; the owner sees the same
list; someone not invited gets 404 from `/participants` too) and 2 new in
`test_platform_tools.py` (a shared session's `get_session`/`list_sessions`
report `members` for both the owner and an invited member; an unshared
session carries no `members` key at all). `smoke52.mjs` gained 2 checks
(dropdown width matches the input; the dropdown stays closed once the
suppressed debounced fetch would otherwise have fired) -- both confirmed to
fail against the pre-fix code by temporarily stashing just the two fixes.
New `smoke53.mjs` (7 checks, the agent container running against the
scripted fake model -- inviting updates the chat's gating with no reload;
"@" alone suggests the invited member and the agent; typing narrows to just
the agent; picking splices the mention into the compose text); fails
against the pre-feature code (four of seven fail: the intro never updates,
"@" suggests nothing at all). Full backend suite green; `tsc --noEmit`
clean.

**A real sharing bug, found using it for real (done): a viewer's chat was
one-way.** The member could see the owner's messages and the agent's
replies; the owner never saw anything the member (invited as a viewer) sent
-- not their plain messages, not their `@platform-agent` questions, not the
agent's answers to them. Root cause: `sync.ts`'s `pushOne` skipped a
viewer's PUT unconditionally, and `agentChat` is just one more key in the
same `state` blob that guard was written to protect (the panes/layout a
viewer genuinely can't edit) -- so a viewer's own chat writes never reached
the server at all, while their own screen still showed them optimistically.
Fixed with a chat-only carve-out on both sides: `sync.ts`'s new
`chatOnlyChange` lets a viewer's PUT through when nothing but `agentChat`
differs from the last-agreed server copy; `upsert_live_session` enforces
the identical rule independently, server-side, refusing (403) the instant
anything else would change too.

Coverage: 3 new tests in `test_session_sharing.py` (a chat-only viewer PUT
succeeds and the owner sees it; a viewer bundling a chat change with any
other key is still refused, and nothing lands, not even the chat part; a
viewer changing just the title is still refused too) -- 1 of 3 fails against
the pre-fix backend, confirming real new behavior (the other 2 pass either
way, since they assert existing refusal behavior). New `smoke54.mjs` (7
checks, an owner and an invited viewer, the agent running against the
scripted fake model): the owner sees the viewer's plain message and it
survives a reload; the viewer's `@platform-agent` question and the agent's
actual reply both reach the owner; a viewer still can't push a non-chat
change. 3 of 7 fail against the pre-fix code. Full backend suite green
(`test_session_sharing.py`, `smoke50`/`51`/`52`/`53`/`54` all still green
together, no regressions); `tsc --noEmit` clean.

**Two smaller fixes alongside it (done), unrelated to sharing's own access
model:**
- The agent panel now defaults to the Session tab when a session is opened
  (previously always started on Global, no matter what was on screen, until
  manually switched). Verified live: opening a session lands on Session; the
  Global tab is left alone if you'd deliberately switched to it while
  browsing between two already-open sessions.
- A pane tab's rename box (double-click a tab to rename it, in the tabs
  layout) could overflow its own tab and drag the ✕ beside it out of place,
  once several panes made each tab narrower than the box's old fixed
  150px. Fixed by sizing it the same way the label it replaces already is
  (fills its own tab's share of the row, whatever that turns out to be).
  Verified with 4 panes open at a narrow viewport, where the old fixed width
  reliably overflowed and the fix reliably didn't.

**A shared session's chat no longer needs agent access to use at all
(done).** The compose box was disabled outright for anyone whose group
lacks `agent_enabled`, blocking plain people-to-people chat too, not just
`@mentioning` the agent. Now that only applies to the Global tab and an
unshared session; a shared session's chat stays usable, and a mention from
such a user still gets refused (the backend already 403s "not turned on for
your group", unchanged) rather than silently reaching the agent. New
`smoke55.mjs` (4 checks): the compose box isn't disabled; a plain message
still works; an `@mention` still shows the question, with the existing
403's own message as the reply rather than a real answer. Fails against the
pre-fix code (the box is disabled, nothing can be typed at all); `tsc
--noEmit` clean; smoke51/53/54 unaffected.

**Two reports about the agent's answers themselves (done/mitigated).**
`MarkdownLite.tsx` only recognized a heading or table when a blank line
sat around it -- a real model's output often doesn't, so one landed as a
literal `<p>`, "|" and "###" shown as plain text. Rewritten to scan a
block's lines and catch a heading/table/list wherever it starts, not just
at `lines[0]` of a whole blank-line-delimited block. New `smoke56.mjs` (6
checks, `dev/fake_llm.py`'s new `"markdown"` script -- a table with no
blank line before it, a heading with none after); fails against the
pre-fix renderer (table doesn't render, heading text shows literally).
Also reported: the agent sometimes answers from an earlier run instead of
running the tool again for a new request, and answers about a session
without re-reading it first -- worse once a session has other members.
Checked the orchestration code (`agent.py`, `routers/agent.py`) for an
actual bug first: `focus`/`viewing_session_id` are already passed on every
session-scope turn, nothing skips a tool call on its own account -- this
is the underlying model's own instruction-following, not something fixable
with certainty here. Mitigated the one lever this codebase has:
`prompt.py`'s wording is now more emphatic about running the tool for
*this* turn's request and never answering from an earlier run, and about
calling `get_session` again before answering about a session's current
state. No test asserts on this (the fake model doesn't read the prompt);
`tsc --noEmit` and `platform-agent/tests` (6/6) both clean.

**Investigated a report that the agent could be tricked into reaching a
service/environment/role the user's group doesn't allow (done: one real gap
found and closed, though not the one reported).** Traced every path that
can introduce a pane, write pane inputs, or run one, end to end: `kind_for`
gates every pane-creation and pane-interaction tool (`create_session`,
`add_pane`, `set_pane_inputs`, `run_pane`, all via the shared
`_apply_inputs`/`kind_for` chain), environment inputs are validated by
`_visible_environment` at write time *and independently re-validated* by
`resolve_environment` in the actual per-service router at execution time,
and `resolve_role_name` takes no parameter but the token-bound caller --
nothing in any tool's arguments reaches it. Checked the two combinations
existing tests didn't cover directly (code inspection said they'd hold,
but weren't exercised): `add_pane` with a kind the group lacks, and the
shared-session cross-group case (a member whose own group lacks a flag,
touching a pane the *owner's* differently-flagged group already added) --
both now covered in `test_platform_tools.py`, both hold. Did not reproduce
the reported bypass by static trace; it may be a UI-level confusion, or a
real behavior not yet pinned to an exact reproduction.

What the investigation did surface, independent of whether the original
report pans out: **the per-service HTTP routers never re-checked the
per-page group flags** (`logs_enabled`, `opensearch_enabled`, etc.) --
only environment visibility and the group's IAM role, which CLAUDE.md's
own "closing that gap in the routers is worth doing" already flagged as
outstanding. A raw request to a page a group's UI never offers would still
go through, given an environment and a role. Closed with
`resolve.require_flag`, called at the top of every AWS-calling endpoint in
`queries.py`, `tables.py`, `buckets.py`, `cognito.py`, `opensearch.py`,
`iot.py`, `log_groups.py` and `tools.py` (both endpoints: the HTTP client
tool and the MQTT presigned-URL one, both gated by `tools_enabled`), right
alongside the `resolve_environment`/`resolve_role_name` calls already
there. New `test_router_flags.py` (7 tests, one representative endpoint
per flag): a disabled flag is refused before any AWS call is attempted (no
real credentials in this test run, so the refusal has to come from the
flag check itself, not an AWS error); an enabled flag reaches the AWS call
instead (and fails differently, proving the flag check let it through).
All 7 fail against the pre-fix routers. Full backend suite green
afterward, including every pre-existing test that exercises these routers
with a real (enabled) group.

**Three reports of the agent misbehaving with a real reasoning model (done).**
(1) A turn wrote the same four sentences of plan until it ran out of
tokens; (2) a table of thing names no search returned, claimed to be "in
the iot pane", with the one-column table itself left as literal pipes; (3)
in a shared chat, an admin told there was no IoT Prod -- an earlier member
without it had asked first -- even after asking it to refresh, with
literal `</think>` tags throughout. Causes and fixes (details in CLAUDE.md,
"The agent's turn is grounded in code"): temperature was pinned to 0
(greedy decoding loops reasoning models; now unset by default,
`AGENT_TEMPERATURE`/`AGENT_MAX_TOKENS`, plus a loop guard in `text.py`);
reasoning in `content` behind a template-supplied `<think>` was passed
through raw (now split off and folded); the history carried only answers'
words (now their tool steps too); nothing read the asker's context each
turn (now `agent.py` does, before the model runs); nothing checked an
answer against what the tools returned (`grounding.py` notice); the table
regex wanted two columns. Also: Follow in a Global turn flipped the panel
to the Session tab and hid the turn. The access boundary itself held --
pinned by a new test either way. Coverage: `platform-agent/tests` 18 (6
turn tests fail on the old `app/`), backend 225, `smoke57` (22, fails on
the old `frontend/src`), smoke45 updated for the opening read.

Still for the user to check on their deployment: the real model with a
recommended temperature (its model card's; often 0.6).

After #98, from a shared-chat transcript (an admin and a member without
IoT Prod; a reasoning model behind LiteLLM on Bedrock): turns that stopped
short, answers from the other person's access, and a Bedrock 400 on a tool
name at the end. Traced to our own invented history ids (the model copied
`h25_0` as a tool name), reads parked in the system prompt far from the
question, and a bare "not configured" for a shared pane's environment.
Fixed in `repair.py` (tool-call repair, one nudge for an empty or
announce-and-stop step), `conversation()` (provider ids only), reads
attached after the latest message, and `run_pane`'s up-front environment
check (see CLAUDE.md). Tests: 5 new turn tests plus 2 updated, all failing
on the old `app/` (the garbled-name one with the transcript's exact 400);
backend 227; smoke45 and smoke57 22/22 each.

Then the two items that commit left open, still with no per-service
tuning. First, an answer whose details nothing this turn returned is now
taken back and redone once (`TurnGuard`, `grounding`); only a second one
still like that keeps the warning. Second, `inspect_row` shows one row of
a pane's last run in full, with a kind's own second look-up (IoT: shadows,
certificates, jobs), plus a generic prompt rule to treat an error as
feedback on the input. Tests: agent 25 (the redo test fails on the old
`app/`), backend 229 (2 new inspect tests), smoke57 24/24 (with the retract
checked in the browser), smoke45 22/22.

Follow-up in #98, after the user's two questions:
- The IoT shadow tips added to `panes.py` came back out. The user's rule:
  no per-service tuning of the agent, since plugins will add services
  without anyone tuning the agent for them. The system prompt no longer
  names services either; they come from `get_context`. (See CLAUDE.md.)
- A session chat's turn can only change its own session. The server
  enforces it (`AgentToken.session_scope_id`, `server._mutate`), and
  `create_session` is refused there too. Filling or running a pane now
  unfolds it if it was minimised. The tab switch was already in place.
  Tests: 3 new or extended ones fail on the old `backend/app`. Backend
  227 passed, `platform-agent/tests` 19 passed.

## The platform agent — agreed design and phases

The user asked for an agent that acts on the platform: it creates sessions,
fills in inputs, runs services and tools, and lays out the results. It runs
in its own container and uses LangChain. These are the decisions agreed with
them, so the next round starts from these rather than re-deciding them:

- **Container:** `platform-agent`, Python, **LangGraph** (LangChain's agent
  runtime: streaming, Postgres checkpoints for conversations, interrupts for
  approvals) -- used through LangChain 1.x's `create_agent`, which builds a
  LangGraph agent. It loads its tools from the backend over MCP with
  `langchain-mcp-adapters`.
- **Model:** the **existing LiteLLM proxy** (the same `LITELLM_*` settings as
  the ✦ assistant). The model behind it must support tool calling.
- **Tools:** an **MCP server inside the backend** (`/mcp`, official `mcp`
  Python SDK). It wraps the backend functions that already exist: environments,
  create a session, add a pane, set inputs, choose the layout and dashboard
  placement, and run each service and tool.
- **Rights:** it acts **as the asking user**, with a short-lived delegated
  token. That user's group permissions, visible environments and IAM role apply
  exactly as in the UI. A new per-group `agent_enabled` flag gates it.
- **Execution:** runs happen **on the server**, and the agent reads the
  results. Results are written into the panes' own state keys, so they appear
  in the normal service and tool panes. The agent chooses the layout (tabs,
  side by side, stacked or dashboard) and places panes itself.
- **Approval:** session edits and read-only searches run freely. Side effects
  outside the app (HTTP-client requests, MQTT publishes, anything that changes
  something) wait for the user's OK in the chat.
- **Frontend:** the Agent page gets streaming chat, a live activity feed
  linking to what it touched, and approval prompts. Sessions show when the
  agent is changing them.
- **Deploy:** an agent Dockerfile and a compose service. Helm gets an agent
  Deployment and Service, `agent.enabled`, the reused LiteLLM secret and the
  backend's MCP URL. `DEPLOYMENT.md` and the README are updated. (Done in
  phase 2 rather than 3, so the user can deploy and try it.)

**Phases, one PR each:**
1. *Two-way sync.* #80, merged. It is the foundation, because until then the
   browser only ever pushed and would have overwritten anything the agent
   wrote.
2. *MCP server plus the agent container.* **This round** (below): session
   tools and read-only runs, streaming chat, the `agent_enabled` flag, and
   Helm/compose/docs.
3. *Side-effect tools with approval* (HTTP send, MQTT publish, closing or
   deleting sessions), persisted conversations (LangGraph Postgres
   checkpointer), and an activity feed of what the agent did.

**In this round (not yet merged): phase 2, the MCP server and the agent.**

- *How a turn flows:* browser → `POST /api/agent/chat` (cookie; checks
  `agent_enabled`; mints a per-turn token, hashed in `agent_tokens`, with the
  asker's time zone and the session on screen) → agent container `POST /chat`
  (`X-Platform-Token`, optional `AGENT_SERVICE_KEY`) → LangChain `create_agent`
  with the tools `langchain-mcp-adapters` loads from `/mcp` using the token →
  events streamed back (`text`, `tool_call`, `tool_result` with the
  `session_id` it touched, `error`, `done`; heartbeats every 15 s) → relayed
  unchanged to the browser → token revoked when the stream ends, however it
  ends.
- *Backend:* `platform_tools/` -- `tokens.py`, `panes.py` (the registry of
  pane kinds: flag, inputs and their stored shapes, runners reusing the
  routers), `server.py` (FastMCP tools, stateless streamable HTTP, a bearer
  check in front, a fresh session manager per lifespan). `live_store.py` is
  the server-side write path the PUT now shares (`commit_write`).
  `routers/agent.py` is the relay. `UserGroup.agent_enabled` (off; on for
  Admin via bootstrap and a one-shot backfill). Deps: `mcp==1.30.0` (1.x,
  because the adapter needs it), pydantic 2.11, uvicorn 0.34.
- *Tools (17):* `get_context`, `list_sessions`, `get_session`, name lookups
  (log groups, OpenSearch domains/indices, tables, buckets, user pools),
  `create_session`, `add_pane`, `remove_pane`, `rename`, `set_layout`,
  `arrange_dashboard`, `set_pane_inputs`, `run_pane`. Runs: CloudWatch
  (start + poll, 90 s cap, then stopped), OpenSearch, IoT things/certs,
  DynamoDB, S3, Cognito, Base64 (computed so the agent can read it). HTTP can
  be filled in but not sent (needs approval); MQTT and JWT are not offered.
- *Agent:* `platform-agent/` -- `app/` (config, prompt, `agent.py` turn
  runner, `main.py` FastAPI), `dev/fake_llm.py` (a scripted OpenAI-compatible
  stand-in: `encode <text>`, `dashboard`, `here`, `break`), Dockerfile,
  `agent-ci.yml`, compose service (+ `fake-model` profile), Helm Deployment +
  Service (`agent.enabled`, no service-account token, fails to render without
  `backend.ai.baseUrl`).
- *Frontend:* `agent/AgentContext.tsx` (one conversation; follow; dock),
  `components/AgentChat.tsx` (steps in words with ✓/✕ and Open, streamed
  answer, Stop, Follow), `AgentDock.tsx` (beside the body, the header's "Ask
  the agent…" opens it), the Agent page now the same chat. ✦ marks a session
  in the rail and strip for 4 s after each agent write (`useAgentActivity`,
  from events with origin "agent"). `dashboardPlan` → rects in
  AggregatorPage. "Platform agent" toggle in Settings → User groups.
- *Coverage:* backend +23 (`test_platform_tools.py`: token/flag/environment
  limits, the browser's own state shapes, versioned + announced writes, runs
  with AWS stubbed, trimming to fit; `test_agent_chat.py`: the relay against a
  stub agent, token revoked on every ending); agent 5 (real `create_agent` +
  adapter against a stub MCP server and the fake model over HTTP); browser
  `smoke45` (21 checks, fails against the old frontend). smoke22/23 updated:
  the header now opens the dock instead of the placeholder page.

**Phase 1, two-way live sync (#80, merged).**

- *Backend:*
  - `live_sessions.version`, bumped on every write. A PUT carries its
    `base_version`; a stale one gets a 409.
  - The version check runs under a row lock. smoke44 caught two concurrent
    writes both passing without it, about one run in three.
  - Every write, close and delete runs `pg_notify` inside its transaction, so
    it is announced on commit and dropped on rollback.
  - `live_events.py` holds one `LISTEN` connection per replica and fans events
    out per user to `GET /api/live-sessions/events` (server-sent events). The
    stream sends a 20 s heartbeat and `X-Accel-Buffering: no`, and releases its
    database session at once.
  - Events carry kind, id, version and the writer's `X-Sync-Origin`, never
    state.
- *Frontend:*
  - Every request sends `X-Sync-Origin` (a per-tab id).
  - `WorkspaceSync` tracks the version each session is based on and the
    server's copy at that version. On a 409 it fetches the row and merges it
    (`mergeSession`: three-way per key, the server wins a true conflict).
  - `liveEvents.ts` subscribes to the stream. Upserts are fetched and merged,
    and new sessions are added without switching to them. Closes and deletes
    come off the strip.
  - A reconnect, a failed fetch or the browser coming back online all trigger
    a catch-up re-read of the list.
  - A mounted `useSessionState` now follows remote changes to its key.
- *Coverage:*
  - Backend: +9 tests. Among them are a concurrency test (it fails without the
    lock, `[200, 200]`), `LISTEN`-based announcement tests, and per-user
    fan-out.
  - `smoke44.mjs`: two browsers covering:
    - a session appearing live;
    - typed input crossing over;
    - simultaneous edits to different panes both surviving;
    - a server-side write as the agent will make it;
    - a stale write refused;
    - a close propagating;
    - catch-up after going offline;
    - a reorder made elsewhere followed live, and not undone by a later save.

    It fails against the old frontend and passes 14 of 14, three runs in a row.
- *Order belongs to `/reorder`.* A PUT sets `position` only when it creates a
  session, and `position` is out of the sync fingerprint. Before this, a
  second tab still holding the old order pushed it straight back with its
  next save, and the two tabs ping-ponged (smoke29 caught it). A reorder is
  announced with its new id order, and every tab re-sorts its strip to match
  (`followOrder`); an order too long for a NOTIFY payload is left out and the
  tab re-reads the list instead.

## Done and working

Everything below is merged and verified against the running app.

- **Sessions.** One session type (Aggregator) holding panes; tabs / side-by-side
  / stacked / dashboard layouts, tabs default and offered first. In tabs/
  side-by-side/stacked, panes reorder by dragging (pointer events, with edge
  auto-scroll) and minimise individually. In **dashboard**, panes get a
  freeform pixel position and size instead (`dashboardRects` in session
  state; a pane with no place yet, or whose place is taken, gets the first
  free spot in reading order, stored at once so it never moves by itself;
  the canvas width is measured per session, never with a page-wide
  selector): dragging
  a header moves a pane, a handle on any corner or edge resizes it (an edge
  handle moves only that one dimension), both snap to a 20px grid and to
  neighbouring panes' edges/gaps, and neither a drag nor a resize is allowed
  to end with two panes closer than the standard 16px gap — it slides along
  whichever axis is still free, or holds at the last position that kept the
  gap. Neither can cross the canvas's own edges either: not left/top (where
  the "Panes" card is) or right (the canvas's measured width, the same as
  the Panes card's, which `scrollbar-gutter: stable` keeps from shifting
  when a vertical scrollbar appears or disappears); there's no ceiling on the bottom edge,
  which the canvas grows and auto-scrolls to reach instead. While dragging or
  resizing, the pane itself follows the raw pointer and a dashed "cut lines"
  outline shows the snapped, gap- and boundary-respecting spot it will
  actually land in on release; Escape cancels. Sessions autosave to
  `live_sessions` (1.2 s debounce, and a close pushes its latest state first),
  survive a reload, follow you to a fresh browser profile, and split Close
  (kept, dimmed in the panel, still inside its category if it had one) from
  Delete (gone, and it asks first).
- **Shell.** Left rail: Home, every session grouped into named categories you
  drag sessions into and out of (Slack-style, collapsible, with a count badge;
  uncategorized sessions sit above them) — open sessions at full strength,
  closed ones dimmed in place rather than pulled into a separate list — then
  ＋ Add — "Start new session…", every service and tool as a one-click session
  named after it, then saved templates. The strip above the body carries the
  open tabs, a ＋ mirroring Add, and a ⋮ for the session on screen; it sits in
  a sticky dock so it is exactly as wide as the cards. A page-title/description
  card sits under the rail. All gaps are 16px; the body's scrollbar sits at
  the window's edge, with the cards 16px clear of it.
- **Panes:** CloudWatch Logs Insights, OpenSearch, IoT (things + certificates
  with detail panels), DynamoDB, S3, Cognito; tools: HTTP client, MQTT tester,
  JWT, Base64, diff; any number of each per session, each renamable.
- **Agent:** the platform agent (phase 2) with a Global chat and a chat per
  session that can be sent the session's checked rows; it replaced the ✦
  assistant.
- **Admin:** environments, user groups (IAM role, visible environments, one
  flag per page — CloudWatch and OpenSearch now separate), users, app title and
  logo, themes, and one **Saved items** panel (Session Templates first, then Log
  Queries, IoT Searches, S3, DynamoDB, HTTP Requests, MQTT Topics).
- **Tests:** 173 backend, 6 agent, 33 Playwright suites (this round's full
  run is recorded above).

## In progress / where I left off

This round's UI changes are built and verified against the running stack
(with the fake model) and await their PR; nothing is half-written. After it
merges, restart the branch from `main` (`git fetch origin main && git
checkout -B <branch> origin/main`) for phase 3.

Not verified here, for the user to check on their deployment: a real model
through their LiteLLM choosing tools sensibly (the prompt is in
`platform-agent/app/prompt.py`), the agent image building in CI (no Docker
daemon here), and the chat stream through their ingress.

**Dashboard ideas offered to the user, not started** (their call which, if
any): a "Tidy up" action that re-packs every pane; maximise a pane to fill
the canvas (and back); moving and resizing from the keyboard; and — the one
with the most reach — storing x/width as fractions of a column grid rather
than pixels (Grafana-style). Sessions sync across browsers and templates are
shared, so a dashboard built on a wide monitor currently gets slid in or
re-placed on a laptop (`resolveDashboard`), and a re-placement is stored.

## Known issues

- **smoke29's panel-order check failed once** in a full run (the server had
  the three new sessions as JWT, IoT, Diff instead of JWT, Diff, IoT) and
  passed on re-run. Position is set from the list index on a session's first
  push, pushes are sequential, and a reorder follows when the order differs;
  the suspect is the second browser in that suite, whose order announcement
  can land between the first's creates. Not reproduced yet; worth a look
  before it's written off.

- **smoke21 occasionally fails** on a click that times out under load; it
  passes on a re-run. smoke29 used to fail the same way — a fresh profile read
  the server's session list before it had landed — and was fixed by waiting for
  the row rather than reading the rail the instant it renders. Prefer that fix
  to calling a suite flaky. smoke35 has the same class of flake now: a strict
  string compare of the sticky dock's background against the page's ends up
  `rgba(…, 0.992)` on one side once in a while — a paint that hadn't quite
  settled, not the colours actually differing — and passes standalone.
  Separately, smoke35 once (in one full run of 31) found smoke34's two seeded
  sessions still open: its own login deletes the server's sessions and then
  IndexedDB, but that delete resolves on `onblocked` while the page is still
  open, so the page can write its in-memory workspace back. Passed on three
  reruns of 34→35; the harness's `clearWorkspace()` has the same shape, so if
  it recurs, the fix is to clear from a fresh context (or wait for the
  delete's `onsuccess`) rather than to rerun.
- **A category left in the dev database changes every session's ⋮.** Once any
  category exists, `SessionMenuItems` (correctly) adds "Move to <category>" to
  the menu — which broke smoke30's old hardcoded three-item list the one time
  a "Prod" category from manual testing was still sitting in the database when
  the suite ran. `clearWorkspace()` in `harness.mjs` now clears categories too,
  and any suite that creates one deletes it at the end (see smoke37) — but a
  suite that seeds a category outside that helper and forgets to clean up will
  reintroduce this for whatever runs after it.
- **Templates accumulate.** Nothing prunes saved templates, and the dev database
  has ~20 junk ones from test runs ("Agg save 17899…", "Legacy CloudWatch
  template"). Harmless, but it makes the Add list and the Session Templates tab
  long in screenshots.
- **Deleting a template in Settings doesn't refresh the Add list** until
  something else reloads the templates context. Minor, unreported by the user.
- **Dashboard positions are pixels.** See the column-grid idea above: on a
  narrower window than the one a dashboard was laid out in, panes past the
  right edge are shown slid back inside, and one that would then collide is
  re-placed in the first free spot — permanently, since placements are stored.
- The `user_groups.aggregator_enabled` column is dead — every session is an
  Aggregator, so nothing reads it. Left in place deliberately (dropping it is a
  schema change for no gain); there is no toggle for it in Settings.

## Working agreements from this session

- The user reports UI issues in batches, numbered. Work the whole batch, then
  one commit and (when asked) one PR per batch.
- **Verify in the browser, not in the diff.** Every real bug this session was
  found by driving the running app — instrumented probes for a menu that closed
  itself, computed-style checks for `hidden`, forced scrollbar gutters for a
  width mismatch. Reading the diff would have missed all three.
- **Reproduce the user's actual sequence before fixing, and prove the new
  suite fails on the old code.** #76 shipped a placement fix whose suite only
  opened panes all at once into a fresh session; the user's flow (one at a
  time, moving in between, closing and reopening) failed in three separate
  ways it never touched. #77 started from a scratch script driving exactly
  that flow, and checked smoke42 against the old code with
  `git stash push -- frontend/src` before trusting it.
- Screenshots are welcome in the reply when the change is visual — but
  headless Chromium doesn't paint scrollbars in them, so anything about the
  scrollbar has to be shown with measured geometry, not a picture.
- Keep the user's own wording for features ("session", "pane", "template") —
  they are precise about it.

## Dev environment

Postgres, backend and frontend, from the repo root:

```bash
# 1. Postgres (the container has a local cluster; docker-compose.yml also works)
pg_ctlcluster 16 main start
# first time only:
sudo -u postgres psql -c "CREATE USER cloudwatch_insights WITH PASSWORD 'cloudwatch_insights' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE cloudwatch_insights_smoke OWNER cloudwatch_insights;"
sudo -u postgres psql -c "CREATE DATABASE cloudwatch_insights_test OWNER cloudwatch_insights;"

# 2. Backend (port 8000)
cd backend
DATABASE_URL="postgresql+psycopg2://cloudwatch_insights:cloudwatch_insights@127.0.0.1:5432/cloudwatch_insights_smoke" \
ADMIN_PASSWORD='SmokeTestPass123!' \
python3 -m uvicorn app.main:app --port 8000

# 3. Frontend (Vite proxies /api to 127.0.0.1:8000)
cd frontend && npx vite --port 5179
```

Log in as `admin` / the `ADMIN_PASSWORD` you started the backend with.

The agent needs Python 3.12 venvs (the system Python here is 3.11 and lacks
`mcp`): the backend's `requirements.txt` in one, `platform-agent`'s in
another. Then, with `AGENT_URL=http://127.0.0.1:8100` added to the backend's
environment:

```bash
cd platform-agent
FAKE_LLM_STEP_DELAY=0.3 uvicorn dev.fake_llm:app --port 4010 &
LITELLM_BASE_URL=http://127.0.0.1:4010 LITELLM_API_KEY=dev AGENT_MODEL=fake \
  PLATFORM_MCP_URL=http://127.0.0.1:8000/mcp uvicorn app.main:app --port 8100 &
```

`helm` isn't installed and its downloads are blocked; `go install
helm.sh/helm/v3/cmd/helm@v3.16.2` through the Go proxy works.

**Env vars:** `DATABASE_URL` (or `POSTGRES_HOST` + friends) · `ADMIN_PASSWORD`
(bootstraps the admin user) · `COOKIE_SECURE=false` for plain-HTTP local use ·
`LITELLM_API_KEY` / `LITELLM_BASE_URL` / `LITELLM_MODEL` to enable the assistant
(all three, or it stays hidden).

**Checks:**

```bash
cd backend && DATABASE_URL="postgresql+psycopg2://cloudwatch_insights:cloudwatch_insights@127.0.0.1:5432/cloudwatch_insights_test" python3 -m pytest tests -q
cd frontend && npx tsc --noEmit && npm run build
```

pytest **must** get the `_test` database, never `_smoke`: `conftest.py` drops
and recreates the schema with its own admin password, after which the browser
suites can't sign in and every environment is gone. (It happened once this
session; recovery was `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` on
`_smoke` and restarting the backend, which re-bootstraps the admin.)

**Browser suites** live in the repo at `frontend/e2e/`. `node e2e/run-all.mjs`
from `frontend/` runs all 33 — about 25 minutes, one line per suite — and
`node e2e/run-all.mjs 29 33` or `node e2e/smokeNN.mjs` runs a subset. They need
the dev stack up and they clear the workspace first, so point them at a scratch
database. `frontend/e2e/README.md` has the configuration (`E2E_BASE_URL`,
`E2E_USER`/`E2E_PASSWORD`, `E2E_PLAYWRIGHT`, `E2E_CHROMIUM`) and, more usefully,
the list of traps that have already cost a release. Playwright is deliberately
not a dependency of the package; in this container:
`E2E_PLAYWRIGHT=/opt/node22/lib/node_modules/playwright/index.mjs`.
Each suite's header comment says what it covers; 35 covers the spacing/Add
round, 36 the permission split and saved-row naming, 37 a closed session
staying inside its category, 38 the dashboard layout's collision prevention
and snapping, 39 its multi-corner resize, auto-scroll and minimum-gap
follow-ups, 40 its canvas-boundary fixes and edge resize handles, 41 panes
opened together packing into the canvas and the stable scrollbar gutter, and
42 the real-use flows from #77 (one-at-a-time placement, reopen, two
sessions, close-then-reopen, minimised drag, Escape, scrollbar geometry), 43
several panes of one kind (home counts, add-only Panes card, per-pane state,
rename, fresh state after close, an old-shape session still opening), and 44
two-way live sync across two browsers (see phase 1 above), 45 the
platform agent end to end, and 46 the agent panel's Global/Session chats,
layouts, the tab ⋮, gaps, scrollbars and column resizing (45 and 46 need
the agent and the fake model running). 14, 15, 18 and 19 were the retired
assistant's and are gone.

## Next steps, in order

1. Restart the branch from `main` once this round's PR merges.
2. **Platform agent, phase 3.**
   - Approval for side effects: LangGraph interrupts, surfaced as an
     approve/deny prompt in the chat; then `send_http_request`, MQTT publish,
     closing and deleting sessions as tools behind it.
   - Persisted conversations: the LangGraph Postgres checkpointer keyed by a
     conversation id, instead of the browser sending the history each turn;
     a list of past conversations on the Agent page.
   - An activity feed: what the agent did, when, in which session.
   - Worth doing alongside: the per-service routers checking the page flags
     themselves (CLAUDE.md, "Access control"), and a real-model evaluation
     of the prompt once the user has one wired.
3. Between phases, pick up the user's batches of UI issues — that has been
   the rhythm of every round.
3. If the user picks one of the dashboard ideas above, the column grid is a
   stored-shape change: `dashboardRects` would need a migration (CLAUDE.md,
   "Old state shapes are migrated on load").
4. Optional, only if the user wants them: prune the junk templates from the dev
   database; refresh the templates context after a delete in Settings; decide
   whether CI should run the browser suites (it does not — they need a backend,
   a seeded Postgres and an admin login, which is its own piece of work).
