import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";

const TABLE_ITEMS = [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }];

async function mock(page) {
  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (r) =>
    r.fulfill({ json: { reply: "an answer about your rows", suggested_query: null } }));
  await page.route("**/api/tables/list*", (r) => r.fulfill({ json: { tables: ["DemoTable"] } }));
  await page.route("**/api/tables/describe", (r) =>
    r.fulfill({ json: { table_name: "DemoTable", status: "ACTIVE", item_count: 2, size_bytes: 1, partition_key: "id", sort_key: null } }));
  await page.route("**/api/tables/scan", (r) =>
    r.fulfill({ json: { items: TABLE_ITEMS, scanned_count: 2, count: 2, last_evaluated_key: null } }));
}

async function login(page) {
  // The rail's catalogue folds shut by default now (smoke28 covers that);
  // these suites are about what it offers, so open it before the first paint.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("cwi-rail-catalogue", "open");
    } catch {}
  });
  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', ADMIN_USER);
  await page.fill('input[autocomplete="current-password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');

  // Sessions live on the server now, so they outlast a browser profile as well
  // as a reload. Start from a clean slate rather than inheriting whatever an
  // earlier suite left open.
  await page.waitForSelector(".rail, .user-menu-trigger", { timeout: 15000 });
  await page.evaluate(async () => {
    for (const url of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(url, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    // The local copy too. Emptying only the server is not enough: a browser
    // holding sessions the server does not is exactly the case the app treats
    // as "this browser has work the backend hasn't heard about yet", so it
    // would push them straight back up.
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase("cloud-insights-sessions");
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  });
  await page.reload();

  await page.waitForSelector(".user-menu-trigger", { timeout: 10000 });
}

const tabTitles = async (page) =>
  (await page.locator(".rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed) .rail-row-label").allTextContents()).filter((t) => t !== "Home");

/** Scoped to the session on screen: every open session stays mounted, so an
 * unscoped selector matches the hidden ones too. */
const VISIBLE = ".session-body:not([hidden])";

(async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await mock(page);
  await login(page);

  // Settings is no longer a header tab -- it's a view reached from the user
  // menu, with the session strip still visible above it.
  await page.click(".user-menu-trigger");
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  check((await page.locator(".rail").count()) === 1, "Settings keeps the session strip visible above it");
  await page.click('.content .tabs button:has-text("Environments")');
  await page.waitForSelector("text=Add environment");
  await page.fill('input[placeholder="Production us-east-1"]', "Demo Env");
  await page.fill('input[placeholder="111122223333"]', "111122223333");
  await page.click('button:has-text("Add environment")');
  await page.waitForSelector("text=Demo Env");
  await page.click('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("Home"))');
  await page.waitForSelector(".home");

  // ---------- Header ----------
  check((await page.locator("nav.tabs").count()) === 0, "The service tabs are gone from the header");
  check((await page.locator(".agent-input").count()) === 1, "The header has the agent search bar instead");
  check(await page.locator(".home").isVisible(), "The app lands on the home page");
  check(
    (await page.locator(".home-card").count()) > 0,
    "Home is a card per session type rather than a chat"
  );

  // ---------- The + button and session tabs ----------
  check((await tabTitles(page)).length === 0, "No sessions open to start with");
  const addBox = await page.locator(".rail-add").boundingBox();
  const barBox = await page.locator(".rail").boundingBox();
  check(addBox.x - barBox.x < 40, "With no sessions the + sits at the left of the bar", String(addBox.x - barBox.x));
  // Services and tools are panes now, offered on the home page when you make a
  // session. What Add holds is the way there, plus your templates.
  const offered = await page.locator(".rail-row-type .rail-row-label").allTextContents();
  check(offered[0] === "Start new session…", "Add leads with the way to start one", JSON.stringify(offered.slice(0, 2)));
  const cards = await page.locator(".home-card-title").allTextContents();
  check(
    ["CloudWatch", "OpenSearch", "IoT", "DynamoDB", "S3", "Cognito", "HTTP client", "MQTT tester", "JWT", "Base64", "Diff"]
      .every((t) => cards.includes(t)),
    "The home page offers every service and tool to put in one",
    JSON.stringify(cards)
  );
  await newSession(page, "CloudWatch");
  await page.waitForSelector('.rail-row-label:text-is("CloudWatch")');
  check(JSON.stringify(await tabTitles(page)) === JSON.stringify(["CloudWatch"]), "Choosing a type opens a session tab");
  check(
    (await page.locator('.page-info-title:text-is("CloudWatch")').count()) > 0,
    "The body switches to that session"
  );

  // The rail is a column, so "+ Add" sits below the open sessions rather than
  // after the last tab.
  const addAfter = await page.locator(".rail-add").boundingBox();
  const tabBox = await page.locator('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("CloudWatch"))').boundingBox();
  check(addAfter.y > tabBox.y + tabBox.height - 2, "＋ Add sits below the open sessions", `${addAfter.y} vs ${tabBox.y + tabBox.height}`);

  // Several sessions of one type, told apart by name.
  for (const type of ["CloudWatch", "DynamoDB"]) {
    await newSession(page, type);
    await page.waitForTimeout(150);
  }
  check(
    JSON.stringify(await tabTitles(page)) === JSON.stringify(["CloudWatch", "CloudWatch 2", "DynamoDB"]),
    "A second session of the same type is numbered, not a duplicate name",
    JSON.stringify(await tabTitles(page))
  );

  // ---------- State is per session, and switching keeps it ----------
  await page.click('.rail-row-label:text-is("CloudWatch")');
  await page.fill(`${VISIBLE} textarea`, "fields @timestamp | filter one");
  await page.click('.rail-row-label:text-is("CloudWatch 2")');
  await page.fill(`${VISIBLE} textarea`, "fields @timestamp | filter two");
  await page.click('.rail-row-label:text-is("CloudWatch")');
  check(
    (await page.inputValue(`${VISIBLE} textarea`)) === "fields @timestamp | filter one",
    "Each session keeps its own state; switching tabs doesn't bleed"
  );

  // ---------- Real results in a Tables session ----------
  await page.click('.rail-row-label:text-is("DynamoDB")');
  await page.selectOption(`${VISIBLE} .panel:has-text("Choose environment and table") select`, { index: 1 });
  await page.click(`${VISIBLE} button:has-text("Load tables")`);
  await page.waitForSelector('option[value="DemoTable"]', { state: "attached" });
  await page.selectOption(`${VISIBLE} .panel:has-text("Choose environment and table") select >> nth=1`, "DemoTable");
  await page.waitForSelector(`${VISIBLE} >> text=partition key: id`);
  await page.click(`${VISIBLE} button:has-text("Scan")`);
  await page.waitForSelector(`${VISIBLE} >> text=2 item(s) loaded`);

  // ...and an assistant conversation about them.
  await page.click(`${VISIBLE} .panel:has-text("2. Search items") .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.click(`${VISIBLE} .ai-widget-button`);
  await page.waitForSelector(`${VISIBLE} .ai-widget-panel`);
  await page.click(`${VISIBLE} .ai-widget-panel .tab:has-text("About results")`);
  await page.fill(`${VISIBLE} .ai-widget-textarea`, "what is this row?");
  await page.click(`${VISIBLE} .ai-widget-panel button:has-text("Ask")`);
  await page.waitForSelector(`${VISIBLE} .ai-widget-messages >> text=an answer about your rows`);
  await page.click(`${VISIBLE} .ai-widget-panel button[aria-label="Close"]`);
  await page.screenshot({ path: `${SHOT}/sessions-before-reload.png` });

  // Give the debounced write time to land.
  await page.waitForTimeout(900);

  // ---------- The reload: the whole point ----------
  await page.reload();
  await page.waitForSelector(".rail", { timeout: 10000 });
  check(
    JSON.stringify(await tabTitles(page)) === JSON.stringify(["CloudWatch", "CloudWatch 2", "DynamoDB"]),
    "Every open session comes back after a refresh",
    JSON.stringify(await tabTitles(page))
  );
  check(
    (await page.locator('.rail-row.active .rail-row-label').textContent()) === "DynamoDB",
    "The session you were looking at is still the active one"
  );
  check((await page.locator(`${VISIBLE} >> text=2 item(s) loaded`).count()) > 0, "Its results came back, not just its inputs");
  check(
    (await page.locator(`${VISIBLE} >> text=Showing results fetched`).count()) === 1,
    "Restored results say when they were fetched rather than posing as current"
  );

  await page.click(`${VISIBLE} .ai-widget-button`);
  await page.waitForSelector(`${VISIBLE} .ai-widget-panel`);
  check(
    (await page.locator(`${VISIBLE} .ai-widget-messages >> text=an answer about your rows`).count()) === 1,
    "The assistant conversation about those rows came back too"
  );
  await page.click(`${VISIBLE} .ai-widget-panel button[aria-label="Close"]`);

  await page.click('.rail-row-label:text-is("CloudWatch 2")');
  check(
    (await page.inputValue(`${VISIBLE} textarea`)) === "fields @timestamp | filter two",
    "Each restored session kept its own inputs"
  );

  // ---------- Closing ----------
  // Closing is the ✕ on that session's tab in the strip; the rail's row count
  // also takes in Home, the templates and the catalogue, so wait on the open
  // sessions themselves.
  await page.click('.session-tab:has(.session-tab-label:text-is("CloudWatch 2")) .session-tab-close');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed) .rail-row-label")]
        .filter((e) => e.textContent !== "Home").length === 2,
  );
  check(
    JSON.stringify(await tabTitles(page)) === JSON.stringify(["CloudWatch", "DynamoDB"]),
    "Closing a session removes just that tab",
    JSON.stringify(await tabTitles(page))
  );
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector(".rail");
  check(
    JSON.stringify(await tabTitles(page)) === JSON.stringify(["CloudWatch", "DynamoDB"]),
    "A closed session stays closed after a refresh"
  );

  // ---------- The header prompt goes to the agent page ----------
  // The agent is a page now rather than a session you have copies of, so the
  // question is a handoff to it rather than something that opens a tab.
  await page.fill(".agent-input", "which sessions do I have open?");
  await page.press(".agent-input", "Enter");
  await page.waitForSelector('.page-info-title:text-is("Agent")');
  const AGENT = ".agent-session";
  check(
    (await page.locator(`${AGENT} >> text=which sessions do I have open?`).count()) === 1,
    "The header bar takes the question to the agent page"
  );
  check(
    (await page.locator(`${AGENT} >> text=I'm not connected to a model yet`).count()) === 1,
    "The agent answers that it can't answer yet"
  );
  const seen = await page.locator(`${AGENT} table tbody tr td:first-child`).allTextContents();
  check(
    JSON.stringify(seen) === JSON.stringify(["CloudWatch", "DynamoDB"]),
    "The agent page lists the sessions it will be given",
    JSON.stringify(seen)
  );
  await page.screenshot({ path: `${SHOT}/sessions-home.png` });

  // Clicking the brand returns home from a session.
  await page.click('.rail-row-label:text-is("CloudWatch")');
  // The page's title moved to the card under the panel, so that is what says
  // which session is showing.
  await page.waitForSelector('.page-info-title:text-is("CloudWatch")');
  await page.click('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("Home"))');
  check(await page.locator(".home").isVisible(), "Clicking the title goes home");

  await browser.close();
  report();
})().catch((e) => { console.error("SMOKE TEST FAILED:", e); process.exit(1); });
