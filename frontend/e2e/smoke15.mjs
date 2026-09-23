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
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE ERROR:", m.text());
  });

  await page.route("**/api/ai/status", (route) => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (route) => {
    assistCalls.push(JSON.parse(route.request().postData() || "{}"));
    route.fulfill({ json: { reply: "Sure.\n```\nAGG-QUERY\n```", suggested_query: "AGG-QUERY" } });
  });
  await page.route("**/api/tables/list*", (route) => route.fulfill({ json: { tables: ["DemoTable"] } }));
  await page.route("**/api/tables/describe", (route) =>
    route.fulfill({ json: { table_name: "DemoTable", status: "ACTIVE", item_count: 2, size_bytes: 100, partition_key: "id", sort_key: null } })
  );
  await page.route("**/api/tables/scan", (route) =>
    route.fulfill({ json: { items: [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }], scanned_count: 2, count: 2, last_evaluated_key: null } })
  );
  await page.route("**/api/cognito/user-pools*", (route) => route.fulfill({ json: { user_pools: [{ id: "pool1", name: "MyPool" }] } }));
  await page.route("**/api/cognito/users", (route) =>
    route.fulfill({
      json: {
        users: [{ username: "carol", status: "CONFIRMED", enabled: true, created: null, last_modified: null, attributes: { email: "c@e.com" } }],
        pagination_token: null,
      },
    })
  );
  await page.route("**/api/iot/search", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            things: [{ thing_name: "thing-alpha", thing_id: null, thing_type_name: null, thing_group_names: [], attributes: {}, connected: false, connectivity_timestamp: null }],
            error: null,
          },
        ],
      },
    })
  );

  // Login
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
  // There is no Aggregator to offer any more: a session is one. What the panel
  // offers is the way to the card that makes one.
  check(
    await page.locator('.rail-row-new:has(.rail-row-label:text-is("Start new session…"))').isVisible(),
    "The panel offers the way to start a session"
  );
  await page.keyboard.press("Escape");

  // Environment (may already exist from an earlier run on this DB)
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

  // A session's own saved kind must be manageable in Settings. It is called
  // Session Templates now: a service is a pane rather than a session, so
  // "Aggregator Sessions" named something that no longer exists.
  await page.click('.content .tabs button:text-is("Saved")');
  await page.waitForSelector('button:has-text("Log Queries")');
  check(
    (await page.locator('button:has-text("Session Templates")').count()) > 0,
    "Settings: 'Session Templates' tab exists in Saved items"
  );

  // ---------- Aggregator ----------
  await newPanedSession(page);
  await page.waitForSelector("text=Choose one or more services");
  check(
    (await page.locator(".ai-widget-button").count()) === 0,
    "Aggregator: no AI button until a service is open"
  );

  // Open three services side by side.
  await page.click('.panel:has(h2:text-is("Panes")) label.checkbox-item:has-text("IoT") input');
  await page.click('.panel:has(h2:text-is("Panes")) label.checkbox-item:has-text("DynamoDB") input');
  await page.click('.panel:has(h2:text-is("Panes")) label.checkbox-item:has-text("Cognito") input');
  await page.waitForSelector(".aggregator-pane");
  const paneCount = await page.locator(".aggregator-pane").count();
  check(paneCount === 3, `Aggregator: three panes open side by side`, `got ${paneCount}`);

  // Exactly ONE floating assistant, despite three embedded pages each
  // normally rendering their own.
  const buttons = await page.locator(".ai-widget-button").count();
  check(buttons === 1, "Aggregator: exactly one shared AI button for all panes", `got ${buttons}`);

  // Each pane really is the full page UI.
  check(
    (await page.locator('.aggregator-pane:has(h3:text-is("IoT")) >> text=2. Search').count()) > 0,
    "Aggregator: the IoT pane renders the real IoT page UI"
  );

  await page.screenshot({ path: `${SHOT}/aggregator-columns.png`, fullPage: false });

  // Run a search in two different panes.
  const iotPane = '.aggregator-pane:has(h3:text-is("IoT"))';
  await page.click(`${iotPane} label:has-text("Demo Env (111122223333 · us-east-1)") input[type="checkbox"]`);
  await page.click(`${iotPane} button:text-is("Search")`);
  await page.waitForSelector(`${iotPane} >> text=thing-alpha`);

  const tablesPane = '.aggregator-pane:has(h3:text-is("DynamoDB"))';
  await page.selectOption(`${tablesPane} .panel:has-text("Choose environment and table") select`, { label: "Demo Env (111122223333 · us-east-1)" });
  await page.click(`${tablesPane} button:has-text("Load tables")`);
  await page.waitForSelector(`${tablesPane} option[value="DemoTable"]`, { state: "attached" });
  await page.selectOption(`${tablesPane} .panel:has-text("Choose environment and table") select >> nth=1`, "DemoTable");
  await page.waitForSelector(`${tablesPane} >> text=partition key: id`);
  await page.click(`${tablesPane} button:has-text("Scan")`);
  await page.waitForSelector(`${tablesPane} >> text=2 item(s) loaded`);

  // Check one row in each of the two panes.
  await page.click(`${iotPane} .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.click(`${tablesPane} .result-row >> nth=0 >> input[type="checkbox"]`);

  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");

  // "Build for" targets one service, so it belongs to "Build query" alone --
  // "About results" pools every open pane and has nothing to target.
  await page.click('.ai-widget-panel .tab:has-text("Build query")');
  check(
    (await page.locator('.ai-widget-panel label:has-text("Build for")').count()) === 1,
    "Aggregator: 'Build query' offers the 'Build for' picker"
  );

  // Ask about the combined selection.
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  check(
    (await page.locator('.ai-widget-panel label:has-text("Build for")').count()) === 0,
    "Aggregator: 'About results' drops the 'Build for' picker"
  );
  await page.waitForSelector('.ai-widget-panel >> text=Across IoT things, DynamoDB.');
  check(true, "Aggregator: 'About results' names the services the checked rows came from");
  await page.waitForSelector('.ai-widget-panel >> text=Asking about the 2 checked row(s).');
  check(true, "Aggregator: the shared widget counts selections pooled across panes");

  const before = assistCalls.length;
  await page.fill(".ai-widget-textarea", "do these line up?");
  await page.click('.ai-widget-panel button:has-text("Ask")');
  for (let i = 0; i < 50 && assistCalls.length === before; i++) await page.waitForTimeout(100);
  const askCall = assistCalls[assistCalls.length - 1];
  check(askCall?.domain === "aggregator", "Aggregator: 'About results' asks on domain=aggregator", JSON.stringify(askCall?.domain));
  const services = (askCall?.sample_rows ?? []).map((r) => r.service);
  check(
    askCall?.sample_rows?.length === 2 && services.includes("IoT things") && services.includes("DynamoDB"),
    "Aggregator: pooled rows carry a `service` tag from each pane",
    JSON.stringify(askCall?.sample_rows)
  );

  // Build a query for one specific service, using the cross-service selection.
  await page.click('.ai-widget-panel .tab:has-text("Build query")');
  await page.selectOption('.ai-widget-panel select', { label: "DynamoDB" });
  const before2 = assistCalls.length;
  await page.fill(".ai-widget-textarea", "find the matching items");
  await page.click('.ai-widget-panel button:has-text("Ask")');
  for (let i = 0; i < 50 && assistCalls.length === before2; i++) await page.waitForTimeout(100);
  const buildCall = assistCalls[assistCalls.length - 1];
  check(buildCall?.domain === "tables", "Aggregator: 'Build query' targets the chosen service's own syntax", JSON.stringify(buildCall?.domain));

  await page.click('.ai-widget-panel button:has-text("Use this query")');
  const applied = await page.inputValue(`${tablesPane} input[placeholder="field:value field2:value2"]`);
  check(applied === "AGG-QUERY", "Aggregator: 'Use this query' lands in the targeted pane's own search box", applied);
  await page.click('.ai-widget-panel button[aria-label="Close"]');

  // ---------- Layout: stacked ----------
  await page.click('button:text-is("Stacked")');
  await page.waitForSelector(".aggregator-stack");
  await page.click(`${iotPane} button[aria-label="Minimise IoT"]`);
  await page.waitForSelector(`${iotPane} button[aria-label="Expand IoT"]`);
  check(
    !(await page.locator(`${iotPane} .aggregator-pane-body`).isVisible()) &&
      (await page.locator(`${tablesPane} .aggregator-pane-body`).isVisible()),
    "Aggregator: minimising one pane collapses only that one"
  );

  // Minimising must not unmount it -- the other panes' results have to survive.
  await page.click(`${iotPane} button[aria-label="Expand IoT"]`);
  check(
    (await page.locator(`${tablesPane} >> text=2 item(s) loaded`).count()) > 0,
    "Aggregator: collapsing a pane keeps its results (panes stay mounted)"
  );
  await page.screenshot({ path: `${SHOT}/aggregator-stack.png`, fullPage: false });

  // ---------- Closing a pane deregisters it ----------
  await page.click('button:has-text("Side by side")');
  await page.click(`${tablesPane} .aggregator-pane-header button[title="Close DynamoDB"]`);
  await page.waitForFunction(() => document.querySelectorAll(".aggregator-pane").length === 2);
  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  const optionLabels = await page.locator(".ai-widget-panel select option").allTextContents();
  check(!optionLabels.includes("DynamoDB"), "Aggregator: closing a pane removes it from the assistant's targets", JSON.stringify(optionLabels));
  await page.click('.ai-widget-panel button[aria-label="Close"]');

  // Logs is the most complex page to embed -- two backends and a polling loop.
  await page.click('.panel:has(h2:text-is("Panes")) label.checkbox-item:has-text("CloudWatch") input');
  await page.waitForSelector('.aggregator-pane:has(h3:text-is("CloudWatch"))');
  check(
    (await page.locator('.aggregator-pane:has(h3:text-is("CloudWatch")) >> text=1. Choose environments').count()) > 0,
    "Aggregator: the Logs page embeds as a pane too"
  );
  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  const withLogs = await page.locator(".ai-widget-panel select option").allTextContents();
  check(
    withLogs.includes("Logs (CloudWatch)"),
    "Aggregator: the Logs pane registers itself as an assistant target",
    JSON.stringify(withLogs)
  );

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
