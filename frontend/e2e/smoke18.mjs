import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";

const assistCalls = [];

/** Services are sessions now: started from the + in the strip under the
 * header rather than tabs in the header. Any session already open is closed
 * first, so exactly one page is mounted and the unscoped selectors below still
 * address the one on screen -- every open session stays mounted otherwise. */
async function openSession(page, label) {
  // Closing is the ✕ on the tab in the strip above the body.
  while ((await page.locator(".session-tab-close").count()) > 0) {
    await page.locator(".session-tab-close").first().click();
    await page.waitForTimeout(120);
  }
  await newSession(page, label);
}

/** An empty session switched to the side-by-side layout. New sessions default
 * to tabs, which shows one pane at a time -- these suites are about how several
 * panes sit together, which is what side by side is for. */
async function newPanedSession(page) {
  await newSession(page);
  await page.click('.session-body:not([hidden]) button:text-is("Side by side")');
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (r) => {
    assistCalls.push(JSON.parse(r.request().postData() || "{}"));
    r.fulfill({ json: { reply: "ok\n```\nQ\n```", suggested_query: "Q" } });
  });
  await page.route("**/api/tables/list*", (r) => r.fulfill({ json: { tables: ["DemoTable"] } }));
  await page.route("**/api/tables/describe", (r) =>
    r.fulfill({
      json: { table_name: "DemoTable", status: "ACTIVE", item_count: 2, size_bytes: 1, partition_key: "id", sort_key: null },
    })
  );
  await page.route("**/api/tables/scan", (r) =>
    r.fulfill({
      json: {
        items: [
          { id: "1", name: "Alice" },
          { id: "2", name: "Bob" },
        ],
        scanned_count: 2,
        count: 2,
        last_evaluated_key: null,
      },
    })
  );
  await page.route("**/api/iot/search", (r) =>
    r.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            things: [
              {
                thing_name: "thing-alpha",
                thing_id: null,
                thing_type_name: null,
                thing_group_names: [],
                attributes: {},
                connected: true,
                connectivity_timestamp: null,
              },
            ],
            error: null,
          },
        ],
      },
    })
  );
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

  await page.click(".user-menu-trigger");
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  await page.click('.content .tabs button:has-text("Environments")');
  await page.waitForSelector("text=Add environment");
  if ((await page.locator("text=Demo Env").count()) === 0) {
    await page.fill('input[placeholder="Production us-east-1"]', "Demo Env");
    await page.fill('input[placeholder="111122223333"]', "111122223333");
    await page.click('button:has-text("Add environment")');
    await page.waitForSelector("text=Demo Env");
  }

  // ================= 1. Clicking a pane's title bar minimises/expands it =====
  await newPanedSession(page);
  await page.waitForSelector("text=Choose one or more services");
  const sessionPanel = '.panel:has(h2:text-is("Panes"))';
  for (const label of ["IoT", "DynamoDB"]) {
    await page.click(`${sessionPanel} label.checkbox-item:text-is("${label}") input`);
  }
  await page.waitForSelector(".aggregator-pane >> nth=1");

  const iotPane = '.aggregator-pane:has(h3:text-is("IoT"))';
  const tablesPane = '.aggregator-pane:has(h3:text-is("DynamoDB"))';

  // Clicking the title itself (not the button) is the whole point of the change.
  await page.click(`${iotPane} .aggregator-pane-header h3`);
  await page.waitForSelector(`${iotPane} button[aria-label="Expand IoT"]`);
  check(!(await page.locator(`${iotPane} .aggregator-pane-body`).isVisible()), "Clicking a pane's title minimises it");
  check(
    await page.locator(`${tablesPane} .aggregator-pane-body`).isVisible(),
    "Clicking one pane's title leaves the others alone"
  );

  await page.click(`${iotPane} .aggregator-pane-header h3`);
  await page.waitForSelector(`${iotPane} button[aria-label="Minimise IoT"]`);
  check(await page.locator(`${iotPane} .aggregator-pane-body`).isVisible(), "Clicking the title again expands it");

  // Empty space on the header bar counts too, not just the text.
  const box = await page.locator(`${iotPane} .aggregator-pane-header`).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector(`${iotPane} button[aria-label="Expand IoT"]`);
  check(true, "Clicking blank space on the title bar toggles too");

  // The -/+ button still works, and must not double-fire through the header.
  await page.click(`${iotPane} button[aria-label="Expand IoT"]`);
  await page.waitForSelector(`${iotPane} button[aria-label="Minimise IoT"]`);
  check(
    await page.locator(`${iotPane} .aggregator-pane-body`).isVisible(),
    "The +/- button still toggles exactly once (its click doesn't bubble to the header)"
  );

  // Closing a pane must close it, not toggle the header on the way out.
  await page.click(`${tablesPane} button[aria-label="Close DynamoDB"]`);
  await page.waitForFunction(() => document.querySelectorAll(".aggregator-pane").length === 1);
  check(
    (await page.locator(tablesPane).count()) === 0 &&
      (await page.locator(`${iotPane} .aggregator-pane-body`).isVisible()),
    "Closing a pane closes it without minimising anything"
  );
  await page.screenshot({ path: `${SHOT}/agg-header-click.png` });

  // ============ 2. "Build for" is a Build-query-only control ================
  await page.click(`${sessionPanel} label.checkbox-item:text-is("DynamoDB") input`);
  await page.waitForSelector(".aggregator-pane >> nth=1");
  await page.click(`${iotPane} label:has-text("Demo Env (111122223333 · us-east-1)") input[type="checkbox"]`);
  await page.click(`${iotPane} button:text-is("Search")`);
  await page.waitForSelector(`${iotPane} >> text=thing-alpha`);
  await page.click(`${iotPane} .result-row >> nth=0 >> input[type="checkbox"]`);

  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  await page.click('.ai-widget-panel .tab:has-text("Build query")');
  check(
    (await page.locator('.ai-widget-panel label:has-text("Build for")').count()) === 1,
    "'Build for' is offered in Build query"
  );
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  check(
    (await page.locator('.ai-widget-panel label:has-text("Build for")').count()) === 0,
    "'Build for' is not offered in About results (it spans every service)"
  );
  check(
    (await page.locator(".ai-widget-panel >> text=Across IoT things.").count()) === 1,
    "About results names which services the checked rows came from"
  );

  // ======= 3. About results sends only the checked rows, and needs some =====
  await page.click('.ai-widget-panel button[aria-label="Close"]');
  await openSession(page, "DynamoDB");
  await page.waitForSelector("text=Saved tables");
  await page.selectOption('.panel:has-text("Choose environment and table") select', {
    label: "Demo Env (111122223333 · us-east-1)",
  });
  await page.click('button:has-text("Load tables")');
  await page.waitForSelector('option[value="DemoTable"]', { state: "attached" });
  await page.selectOption('.panel:has-text("Choose environment and table") select >> nth=1', "DemoTable");
  await page.waitForSelector("text=partition key: id");
  await page.click('button:has-text("Scan")');
  await page.waitForSelector("text=2 item(s) loaded");

  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  check(
    (await page.locator(".ai-widget-panel >> text=only checked rows are sent").count()) === 1,
    "About results says up front that only checked rows are sent"
  );

  // Enter-to-send bypasses the disabled button, so it has to be guarded too.
  const beforeEnter = assistCalls.length;
  await page.fill(".ai-widget-textarea", "anything?");
  await page.press(".ai-widget-textarea", "Enter");
  await page.waitForTimeout(500);
  check(assistCalls.length === beforeEnter, "Pressing Enter with nothing checked sends nothing");

  // Ticking a row is a click outside the panel, which closes it -- so reopen
  // it to read the count back.
  await page.click('.panel:has-text("2. Search items") .result-row >> nth=1 >> input[type="checkbox"]');
  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel >> text=Asking about the 1 checked row(s).");
  const before = assistCalls.length;
  await page.fill(".ai-widget-textarea", "who is this?");
  await page.click('.ai-widget-panel button:has-text("Ask")');
  for (let i = 0; i < 50 && assistCalls.length === before; i++) await page.waitForTimeout(100);
  const call = assistCalls[assistCalls.length - 1];
  check(
    call?.mode === "ask_results" && call?.sample_rows?.length === 1 && call.sample_rows[0].name === "Bob",
    "Only the checked row goes to the assistant -- no sample of the rest",
    JSON.stringify(call?.sample_rows)
  );
  check(call?.row_count === 1, "row_count matches what was actually sent", JSON.stringify(call?.row_count));

  // Build query, by contrast, still works with nothing checked.
  await page.click('.ai-widget-panel .tab:has-text("Build query")');
  const before2 = assistCalls.length;
  await page.fill(".ai-widget-textarea", "active items");
  await page.click('.ai-widget-panel button:has-text("Ask")');
  for (let i = 0; i < 50 && assistCalls.length === before2; i++) await page.waitForTimeout(100);
  const buildCall = assistCalls[assistCalls.length - 1];
  check(
    buildCall?.mode === "build_query" && buildCall?.sample_rows === undefined,
    "Build query doesn't attach the selection unless the examples box is ticked",
    JSON.stringify(buildCall)
  );
  check(
    (await page.locator('.ai-widget-panel label:has-text("as examples")').count()) === 1,
    "Build query still offers the checked rows as optional examples"
  );

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
