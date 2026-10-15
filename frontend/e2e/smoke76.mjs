// Three things asked for together, driven the way a user would:
//   - a pane's settings are its ⋮, in its header (or, in the tabs layout, the
//     selected tab): auto-refresh and saved inputs, out of its cards; a click
//     on it neither folds the pane nor starts a drag; a pane that can't run
//     again by itself (Base64) offers no refresh;
//   - a results card has a Clear while it holds results: it empties them for
//     every tab, and leaves what isn't a result (DynamoDB's table info);
//   - while the agent answers, the turn says what it's doing and for how long
//     the whole time -- not only before its first step -- the other chat's tab
//     and the panel's toggle say it's still going, and a member of a shared
//     session sees the question and that the agent is on it, not nothing until
//     the answer lands.
//
// Needs the agent and the fake model running, and the backend served as
// `uvicorn dev.fake_aws:app` (e2e/README.md): Clear's second tab sees results
// the server stored. The fake model takes a question starting "slow " a few
// seconds a step.
import { check, clearWorkspace, launch, mockPaneActions, newPage, newSession, openApp, openPaneMenu, report, ROW, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const DOCK = ".agent-dock";
const CARD = `${SHOWN} .session-card`;
const MEMBERS_ROW = `${CARD} .session-card-row:has(.session-card-label:text-is("Members"))`;
const ITEMS = `${SHOWN} .panel:has(h2:text-is("2. Search items"))`;

async function dockOpen(page) {
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(".rail");
  await page.waitForSelector(DOCK);
}

async function ask(page, text) {
  await page.fill(`${DOCK} .agent-compose-input`, text);
  await page.click(`${DOCK} button:text-is("Ask")`);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await mockPaneActions(page, "tables", {
    list_tables: { options: [{ value: "T", label: "T" }] },
    describe: { tableInfo: { table_name: "T", status: "ACTIVE", item_count: 2, size_bytes: 1, partition_key: "id", sort_key: null } },
    scan: { items: [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }], scannedCount: 2, lastEvaluatedKey: null },
  });
  await clearWorkspace(page);
  await dockOpen(page);

  // ---- 1. the pane's ⋮
  await newSession(page, "DynamoDB", "Base64");
  await page.waitForSelector(`${SHOWN} .aggregator-tab`);
  check((await page.locator(`${SHOWN} .aggregator-tab.active .pane-menu-button`).count()) === 1 &&
    (await page.locator(`${SHOWN} .aggregator-tab:not(.active) .pane-menu-button`).count()) === 0,
    "In tabs, the selected tab has the pane's ⋮, and only that one");
  await page.click(`${CARD} button:text-is("Stacked")`);
  await page.waitForSelector(`${SHOWN} .aggregator-pane-header .pane-menu-button`);
  check((await page.locator(`${SHOWN} .aggregator-pane-header .pane-menu-button`).count()) === 2, "Stacked, every pane's header has one");
  await openPaneMenu(page, "DynamoDB");
  const headings = await page.locator(".pane-menu-list .pane-menu-heading").allInnerTexts();
  check(JSON.stringify(headings) === JSON.stringify(["AUTO-REFRESH", "SAVED INPUTS"]) ||
    JSON.stringify(headings) === JSON.stringify(["Auto-refresh", "Saved inputs"]),
    "It holds auto-refresh and saved inputs", JSON.stringify(headings));
  await page.keyboard.press("Escape");
  check((await page.locator(`${SHOWN} .aggregator-pane.collapsed`).count()) === 0, "…and opening it didn't fold the pane");
  await openPaneMenu(page, "Base64");
  const base64 = await page.locator(".pane-menu-list .pane-menu-heading").allInnerTexts();
  await page.keyboard.press("Escape");
  check(base64.length === 1 && /saved inputs/i.test(base64[0]), "A pane that can't run again by itself offers no refresh",
    JSON.stringify(base64));
  check((await page.locator(`${SHOWN} .panel .row:has(h2) select`).count()) === 0, "No card title holds a setting any more");

  // ---- 2. Clear
  const table = `${SHOWN} .panel:has-text("Choose environment and table")`;
  await page.selectOption(`${table} select >> nth=0`, { index: 1 });
  await page.click(`${SHOWN} button:has-text("Load tables")`);
  await page.waitForSelector(`${SHOWN} option[value="T"]`, { state: "attached" });
  await page.selectOption(`${table} select >> nth=1`, "T");
  await page.waitForSelector(`${SHOWN} >> text=partition key: id`);
  check((await page.locator(`${ITEMS} button:text-is("Clear")`).count()) === 0, "An empty results card offers no Clear");
  await page.click(`${SHOWN} button:has-text("Scan")`);
  await page.waitForSelector(`${SHOWN} >> text=2 item(s) loaded`);
  const title = await page.locator(".rail-row.active .rail-row-label").innerText();

  const other = await newPage(browser);
  await signIn(other);
  await other.click(ROW(title));
  const followed = await other.waitForSelector(`${SHOWN} >> text=2 item(s) loaded`, { timeout: 10000 }).then(() => true, () => false);
  check(followed, "Precondition: a second tab shows the same items");

  await page.click(`${ITEMS} button:text-is("Clear")`);
  await page.waitForTimeout(300);
  check((await page.locator(`${SHOWN} >> text=2 item(s) loaded`).count()) === 0 &&
    (await page.locator(`${ITEMS} button:text-is("Clear")`).count()) === 0,
    "Clear empties the results card, and goes with them");
  check((await page.locator(`${SHOWN} >> text=partition key: id`).count()) === 1, "…leaving the table it described");
  const gone = await other
    .locator(`${SHOWN} >> text=2 item(s) loaded`)
    .waitFor({ state: "detached", timeout: 8000 })
    .then(() => true, () => false);
  check(gone, "…and the other tab's empties too");
  const [stored] = (await api(page, "GET", "/live-sessions")).body;
  const values = stored.outputs?.tables?.values ?? {};
  check(values.items === undefined && values.tableInfo?.table_name === "T", "The server holds no items, still the table's info",
    JSON.stringify(Object.keys(values)));
  await other.close();

  // ---- 3. the agent at work, in the Global chat
  await page.click(`${DOCK} .agent-tab:text-is("Global")`);
  await ask(page, "slow encode hello agent");
  await page.waitForSelector(`${DOCK} .agent-progress`, { timeout: 5000 });
  // Another chat while it runs: its tab says so, and the note says where.
  await page.click(`${DOCK} .agent-tab:text-is("Session")`);
  check((await page.locator(`${DOCK} .agent-tab:has-text("Global") .agent-tab-busy`).count()) === 1,
    "Looking at the other chat, the Global tab shows it's still answering there");
  const note = await page.locator(`${DOCK} .agent-busy-note`).innerText().catch(() => "");
  check(note.includes("still answering in the Global chat"), "…and the compose box says where", note);
  await page.click(`${DOCK} .agent-busy-note button:text-is("Show")`);
  check((await page.locator(`${DOCK} .agent-tab[aria-selected="true"]`).innerText()).startsWith("Global"), "…with a way back to it");
  // The panel put away: its toggle says so.
  await page.click(".session-bar-agent");
  check((await page.locator(".session-bar-agent.busy").count()) === 1, "With the panel put away, its toggle shows the agent is still at it");
  await page.click(".session-bar-agent");
  await page.waitForSelector(DOCK);

  // All along, a line under the turn: what it's doing, and a clock.
  const seen = new Set();
  let quiet = 0;
  let firstTime = null;
  let lastTime = null;
  for (let i = 0; i < 120; i++) {
    const state = await page.evaluate(() => {
      const dock = document.querySelector(".agent-dock");
      const stop = [...dock.querySelectorAll("button")].some((b) => b.textContent === "Stop");
      const line = dock.querySelector(".agent-progress");
      return { stop, text: line?.textContent ?? null, time: line?.querySelector(".agent-progress-time")?.textContent ?? null };
    });
    if (!state.stop) break;
    if (state.text === null) quiet++;
    else {
      seen.add(state.text.replace(state.time ?? "", ""));
      firstTime ??= state.time;
      lastTime = state.time;
    }
    await page.waitForTimeout(250);
  }
  check(quiet === 0, "Every moment it ran, the turn said it was still working", `${quiet} samples without`);
  check(seen.size >= 2, "…saying what it was doing, as that changed", JSON.stringify([...seen]));
  check(firstTime !== lastTime, "…and for how long", `${firstTime} → ${lastTime}`);
  await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 30000 });
  check((await page.locator(`${DOCK} .agent-progress`).count()) === 0 && (await page.locator(`${DOCK} .agent-answer`).last().innerText()).includes("aGVsbG8gYWdlbnQ="),
    "Answered, the line goes and the answer stays");

  // ---- 4. a shared session: the member sees the question being answered
  const member = `smoke76-${Date.now()}`;
  const group = (await api(page, "POST", "/user-groups", { name: `g-${member}`, role_name: "R", tools_enabled: true })).body;
  check((await api(page, "POST", "/users", { username: member, password: "pw-123456", group_id: group.id })).status === 201,
    "Precondition: a second user to share with");
  await newSession(page, "Diff");
  await page.waitForSelector(MEMBERS_ROW);
  await page.waitForTimeout(1500);
  const shared = await page.locator(".rail-row.active .rail-row-label").innerText();
  await page.fill(`${MEMBERS_ROW} [aria-label="Username to invite"]`, member);
  await page.selectOption(`${MEMBERS_ROW} [aria-label="Permission for the invited user"]`, "viewer");
  await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await page.waitForSelector(`${MEMBERS_ROW} .session-member`);

  const bob = await newPage(browser);
  await signIn(bob, { username: member, password: "pw-123456" });
  await dockOpen(bob);
  await bob.click(ROW(shared));
  await bob.waitForSelector(`${DOCK} .agent-tab[aria-selected="true"]:has-text("Session")`);

  await page.click(`${DOCK} .agent-tab:text-is("Session")`);
  await ask(page, "@platform-agent slow add diff");
  const asked = await bob
    .waitForSelector(`${DOCK} .agent-turn:has(.agent-question:has-text("slow add diff")) .agent-progress`, { timeout: 8000 })
    .then(() => true, () => false);
  check(asked, "While it's answered, the member sees the question, and that the agent is on it");
  const theirs = await bob.locator(`${DOCK} .agent-progress`).innerText().catch(() => "");
  check(theirs.startsWith("Answering admin"), "…for whom", theirs);
  check((await page.locator(`${DOCK} .agent-turn:has(.agent-question:has-text("slow add diff"))`).count()) === 1,
    "The asker's own chat shows the turn once, live, not its stored copy beside it");
  await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 30000 });
  const answered = await bob
    .waitForSelector(`${DOCK} .agent-turn:has(.agent-question:has-text("slow add diff")) .agent-answer:has-text("Added a")`, { timeout: 10000 })
    .then(() => true, () => false);
  check(answered && (await bob.locator(`${DOCK} .agent-progress`).count()) === 0,
    "…and then its answer, the line gone");
  // Stored "running" when asked, and replaced when answered, with the agent
  // writing the same session in between (it added a pane): the server ends
  // up with the answered one.
  await page.waitForTimeout(2500);
  const row = (await api(page, "GET", "/live-sessions")).body.find((x) => x.title === shared);
  const last = (row?.state?.agentChat ?? []).at(-1);
  check(last?.question?.includes("slow add diff") && last?.status === "done", "The server keeps the answered turn, not the running one",
    JSON.stringify({ status: last?.status, panes: row?.state?.services }));

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
