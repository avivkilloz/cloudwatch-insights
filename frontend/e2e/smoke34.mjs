// Every session is an Aggregator: started from the home page, old ones wrapped,
// Platform is pages rather than session types.
import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
const CARD = (l) => `.home-card:has(.home-card-title:text-is("${l}"))`;
const ROW = (l) => `.rail-row:not(.rail-row-type):not(.rail-row-closed):not(.rail-row-home):has(.rail-row-label:text-is("${l}"))`;
const TAB = (l) => `.session-tab:has(.session-tab-label:text-is("${l}"))`;
// Session bodies all stay mounted, so pane selectors have to be scoped to the
// one on screen or they see every session's tabs at once.
const SHOWN = ".session-body:not([hidden])";

async function login(browser, seed) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.addInitScript(() => { try { localStorage.setItem("cwi-rail-catalogue", "open"); } catch {} });
  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 15000 });
  await page.fill('input[autocomplete="username"]', ADMIN_USER);
  await page.fill('input[autocomplete="current-password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".rail", { timeout: 15000 });
  await page.evaluate(async (rows) => {
    for (const u of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(u, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    await new Promise((r) => { const q = indexedDB.deleteDatabase("cloud-insights-sessions"); q.onsuccess = q.onerror = q.onblocked = () => r(); });
    // Sessions in the shape a previous version stored them, straight onto the
    // server: the only honest way to test the migration is to have it read
    // rows this version would never write.
    for (const row of rows || []) {
      await fetch(`/api/live-sessions/${row.client_id}`, {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
    }
  }, seed);
  await page.reload();
  await page.waitForSelector(".rail");
  return page;
}

(async () => {
  const browser = await launch();

  // ---------- 3. Platform is pages, not session types ----------
  let page = await login(browser);
  const platform = await page.locator('.panel:has(h2:text-is("Platform")) .home-card-title').allTextContents();
  check(JSON.stringify(platform) === JSON.stringify(["Agent", "Workflows", "Chat", "Code", "Settings"]),
    "Platform offers pages: Agent, the placeholders and Settings", JSON.stringify(platform));
  check(!platform.includes("Aggregator"), "…and no Aggregator, because every session is one");
  check(!platform.includes("Dashboards"), "…and no Dashboards, folded into the session's own dashboard layout");

  await page.click(`${CARD("Workflows")} .home-card-open`);
  await page.waitForTimeout(300);
  check((await page.locator(".page-info-title").textContent()) === "Workflows", "A Platform card goes to that page");
  check((await page.locator(TAB("Workflows")).count()) === 0, "…without opening a session for it");
  check((await page.locator(".content").textContent()).includes("isn't built yet"),
    "…and a placeholder says plainly that it is not built");

  await page.click(`${CARD("Agent")} .home-card-open`.replace(".home-card-open", ".home-card-open")).catch(() => {});
  await page.click(".rail-row-home");
  await page.waitForTimeout(200);
  await page.click(`${CARD("Agent")} .home-card-open`);
  await page.waitForTimeout(300);
  check((await page.locator(".page-info-title").textContent()) === "Agent", "The agent is a page now");
  check((await page.locator(TAB("Agent")).count()) === 0, "…not a session you have copies of");

  // The header bar hands its question to that page rather than opening one.
  await page.fill(".agent-input", "what broke last night?");
  await page.press(".agent-input", "Enter");
  await page.waitForTimeout(400);
  check((await page.locator(".page-info-title").textContent()) === "Agent", "Asking in the header goes to the agent");
  check((await page.locator(".content").textContent()).includes("what broke last night?"),
    "…and the question arrives as its message");
  check((await page.locator(".session-tab").count()) === 0, "…still without opening a session");

  // ---------- 2. a session is made on the home page ----------
  await page.click(".rail-row-home");
  await page.waitForSelector(".home-create");
  await page.locator(`${CARD("CloudWatch")} input[type=checkbox]`).check();
  await page.locator(`${CARD("Base64")} input[type=checkbox]`).check();
  await page.fill('input[aria-label="Name for the new session"]', "Prod incident");
  await page.click(".home-create");
  await page.waitForTimeout(600);

  check((await page.locator(TAB("Prod incident")).count()) === 1, "Create opens a session under the name you chose");
  check((await page.locator(ROW("Prod incident")).count()) === 1, "…listed in the panel by that name");
  const tabs = await page.locator(`${SHOWN} .aggregator-tab-label`).allTextContents();
  check(JSON.stringify(tabs) === JSON.stringify(["CloudWatch", "Base64"]),
    "…holding exactly what was ticked, as panes", JSON.stringify(tabs));
  check((await page.locator(`${SHOWN} .aggregator-tabs`).count()) === 1,
    "…in the tabs layout, so one pane reads like a page");

  // Unnamed sessions still get something better than "Session 3".
  await page.click(".rail-row-home");
  await page.locator(`${CARD("IoT")} input[type=checkbox]`).check();
  await page.click(".home-create");
  await page.waitForTimeout(500);
  check((await page.locator(TAB("IoT")).count()) === 1, "An unnamed session is named after what is in it");

  // ---------- Add is the card, the one-click panes, and templates ----------
  const addRows = await page.locator(".rail-row-type .rail-row-label").allTextContents();
  check(addRows[0] === "Start new session…", "Add leads with the way to the new-session card", JSON.stringify(addRows.slice(0, 3)));
  check(addRows.includes("CloudWatch") && addRows.includes("Base64"),
    "…then every service and tool, each a session holding just that pane", JSON.stringify(addRows.slice(0, 4)));
  await page.click('.rail-row-new');
  await page.waitForTimeout(300);
  check((await page.locator(".home-create").count()) === 1, "…and it takes you there");

  await page.click(".session-bar-add");
  await page.waitForSelector(".session-add-menu");
  const menu = await page.locator(".session-add-item").allTextContents();
  check(menu[0] === "Start new session…", "The strip's ＋ says the same", JSON.stringify(menu.slice(0, 3)));
  await page.keyboard.press("Escape");
  await page.context().close();

  // ---------- 2b. sessions stored the old way are wrapped ----------
  page = await login(browser, [
    { client_id: "old-iot", type: "iot", title: "Fleet check", position: 0,
      state: { queryString: "thingName:sensor-*", searchMode: "things" }, truncated: false },
    { client_id: "old-logs", type: "logs", title: "Old logs", position: 1,
      state: { backend: "opensearch", queryString: "level:ERROR" }, truncated: false },
    { client_id: "old-agent", type: "agent", title: "Agent 2", position: 2,
      state: { "agent.messages": [] }, truncated: false },
  ]);

  // The server's list arrives after the first paint, so wait for it rather
  // than reading an empty strip.
  await page.waitForSelector(TAB("Fleet check"), { timeout: 15000 });
  const titles = await page.locator(".session-tab-label").allTextContents();
  check(titles.includes("Fleet check") && titles.includes("Old logs"), "Sessions from before the change are still there",
    JSON.stringify(titles));
  check(!titles.includes("Agent 2"), "…except agent ones, which have nowhere to go now", JSON.stringify(titles));

  await page.click(`${TAB("Fleet check")} .session-tab-label`);
  await page.waitForTimeout(400);
  const wrapped = await page.locator(`${SHOWN} .aggregator-tab-label`).allTextContents();
  check(JSON.stringify(wrapped) === JSON.stringify(["IoT"]), "An IoT session became a session holding an IoT pane",
    JSON.stringify(wrapped));
  const q = await page.locator(`${SHOWN} .aggregator-pane:not([hidden]) input[type=text]`).first().inputValue();
  check(q === "thingName:sensor-*", "…with the query it had, moved under the pane", q);

  await page.click(`${TAB("Old logs")} .session-tab-label`);
  await page.waitForTimeout(400);
  const logs = await page.locator(`${SHOWN} .aggregator-tab-label`).allTextContents();
  check(JSON.stringify(logs) === JSON.stringify(["OpenSearch"]),
    "A pre-split logs session becomes the backend its own state said", JSON.stringify(logs));

  // And the wrap is written back, so the next load has nothing to do.
  await page.waitForTimeout(2500);
  const stored = await page.evaluate(async () =>
    (await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json())
      .map((s) => ({ t: s.type, n: s.title })));
  check(stored.every((s) => s.t === "aggregator"), "The migrated shape is saved back, not redone every load",
    JSON.stringify(stored));
  check(!stored.some((s) => s.n === "Agent 2"), "…and the dropped agent session is gone from the server too",
    JSON.stringify(stored));

  await page.screenshot({ path: `${SHOT}/34-final.png` });
  await browser.close();
  report();
})();
