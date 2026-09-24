import { ADMIN_PASSWORD, ADMIN_USER, BASE, check, launch, newSession, report } from "./harness.mjs";

// Every /api/ai/assist body the page sends, newest last.
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

(async () => {
  const browser = await launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

  await page.route("**/api/ai/status", (route) => route.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    assistCalls.push(body);
    route.fulfill({
      json: {
        reply: "Here you go.\n```\nSUGGESTED-QUERY\n```",
        suggested_query: "SUGGESTED-QUERY",
      },
    });
  });

  await page.route("**/api/tables/list*", (route) => route.fulfill({ json: { tables: ["DemoTable"] } }));
  await page.route("**/api/tables/describe", (route) =>
    route.fulfill({ json: { table_name: "DemoTable", status: "ACTIVE", item_count: 2, size_bytes: 100, partition_key: "id", sort_key: null } })
  );
  await page.route("**/api/tables/scan", (route) =>
    route.fulfill({ json: { items: [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }], scanned_count: 2, count: 2, last_evaluated_key: null } })
  );
  await page.route("**/api/buckets/list*", (route) => route.fulfill({ json: { buckets: [{ name: "demo-bucket", creation_date: null }] } }));
  await page.route("**/api/buckets/browse", (route) =>
    route.fulfill({
      json: {
        bucket: "demo-bucket",
        bucket_region: "us-east-1",
        prefix: "",
        folders: [],
        files: [{ key: "alpha.txt", name: "alpha.txt", size: 42, last_modified: null, storage_class: null }],
        continuation_token: null,
      },
    })
  );
  await page.route("**/api/cognito/user-pools*", (route) => route.fulfill({ json: { user_pools: [{ id: "pool1", name: "MyPool" }] } }));
  await page.route("**/api/cognito/users", (route) =>
    route.fulfill({
      json: {
        users: [{ username: "alice", status: "CONFIRMED", enabled: true, created: null, last_modified: null, attributes: { email: "a@e.com" } }],
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
            things: [
              { thing_name: "thing-alpha", thing_id: null, thing_type_name: null, thing_group_names: [], attributes: {}, connected: true, connectivity_timestamp: null },
            ],
            error: null,
          },
        ],
      },
    })
  );
  await page.route("**/api/iot/certificates/search", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            certificates: [{ certificate_id: "cert-alpha", certificate_arn: "arn:a", status: "ACTIVE", creation_date: null, policies: [] }],
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

  // Create an environment
  await page.click(".user-menu-trigger");
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  await page.click('.content .tabs button:has-text("Environments")');
  await page.waitForSelector("text=Add environment");
  await page.fill('input[placeholder="Production us-east-1"]', "Demo Env");
  await page.fill('input[placeholder="111122223333"]', "111122223333");
  await page.click('button:has-text("Add environment")');
  await page.waitForSelector("text=Demo Env");

  async function ask(question) {
    const before = assistCalls.length;
    await page.fill(".ai-widget-textarea", question);
    await page.click('.ai-widget-panel button:has-text("Ask")');
    await page.waitForFunction((n) => true, before);
    for (let i = 0; i < 50 && assistCalls.length === before; i++) await page.waitForTimeout(100);
    return assistCalls[assistCalls.length - 1];
  }

  async function openWidget() {
    await page.click(".ai-widget-button");
    await page.waitForSelector(".ai-widget-panel");
  }
  async function closeWidget() {
    await page.click('.ai-widget-panel button[aria-label="Close"]');
  }

  // ---------- Tables ----------
  await openSession(page, "DynamoDB");
  await page.waitForSelector("text=Saved tables");
  check(await page.locator(".ai-widget-button").isVisible(), "Tables: AI assistant button is present");

  await page.selectOption('.panel:has-text("Choose environment and table") select', { label: "Demo Env (111122223333 · us-east-1)" });
  await page.click('button:has-text("Load tables")');
  await page.waitForSelector('option[value="DemoTable"]', { state: "attached" });
  await page.selectOption('.panel:has-text("Choose environment and table") select >> nth=1', "DemoTable");
  await page.waitForSelector("text=partition key: id");
  await page.click('button:has-text("Scan")');
  await page.waitForSelector("text=2 item(s) loaded");

  await openWidget();
  let call = await ask("items where status is active");
  check(call?.domain === "tables", "Tables: assist request carries domain=tables", JSON.stringify(call?.domain));
  check(call?.mode === "build_query", "Tables: defaults to the Build query mode");

  // "Use this query" must drop the suggestion into the page's own filter box.
  await page.click('.ai-widget-panel button:has-text("Use this query")');
  const tablesQuery = await page.inputValue('input[placeholder="field:value field2:value2"]');
  check(tablesQuery === "SUGGESTED-QUERY", "Tables: 'Use this query' fills the page's filter box", tablesQuery);

  // "About results" is now only ever about the checked rows, so it refuses to
  // ask anything until at least one is checked.
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  await page.fill(".ai-widget-textarea", "what is this?");
  check(
    await page.locator('.ai-widget-panel button:has-text("Ask")').isDisabled(),
    "Tables: 'About results' won't ask with nothing checked"
  );
  // Ticking a row is a click outside the panel, which now closes it -- so the
  // flow is close, tick, reopen. The thread is kept across that.
  await page.click('.panel:has-text("2. Search items") .result-row >> nth=0 >> input[type="checkbox"]');
  check(
    (await page.locator(".ai-widget-panel").count()) === 0,
    "Tables: ticking a row outside the panel closes it"
  );
  await openWidget();
  check(
    !(await page.locator('.ai-widget-panel button:has-text("Ask")').isDisabled()),
    "Tables: checking a row enables 'About results'"
  );
  call = await ask("what is this?");
  check(
    call?.mode === "ask_results" && call?.sample_rows?.length === 1 && call.sample_rows[0].name === "Alice",
    "Tables: asking about the selection sends only the checked row",
    JSON.stringify(call?.sample_rows)
  );
  await closeWidget();

  // ---------- Buckets: ask-only ----------
  await openSession(page, "S3");
  await page.waitForSelector("text=Saved buckets");
  await page.selectOption('.panel:has-text("Choose environment and bucket") select', { label: "Demo Env (111122223333 · us-east-1)" });
  await page.click('button:has-text("Load buckets")');
  await page.waitForSelector('option[value="demo-bucket"]', { state: "attached" });
  await page.selectOption('.panel:has-text("Choose environment and bucket") select >> nth=1', "demo-bucket");
  await page.waitForSelector("text=alpha.txt");

  await openWidget();
  check(
    (await page.locator('.ai-widget-panel .tab:has-text("Build query")').count()) === 0,
    "Buckets: no 'Build query' tab (its search is a literal substring)"
  );
  await page.click('.result-row >> nth=0 >> input[type="checkbox"]');
  await openWidget();
  call = await ask("which file is biggest?");
  // Every session is an Aggregator, so the assistant is the session's: it pools
  // rows across whatever panes are open and tags each with the service it came
  // from, which is why the domain is "aggregator" even with one pane.
  check(
    call?.domain === "aggregator" && call?.mode === "ask_results" && call?.sample_rows?.[0]?.service === "S3",
    "Buckets: the session's assistant asks about its rows, tagged with the service",
    JSON.stringify(call),
  );
  await closeWidget();

  // ---------- Cognito ----------
  await openSession(page, "Cognito");
  await page.waitForSelector("text=1. Choose environment and user pool");
  await page.selectOption('.panel:has-text("Choose environment and user pool") select', { label: "Demo Env (111122223333 · us-east-1)" });
  await page.click('button:has-text("Load user pools")');
  await page.waitForSelector('option[value="pool1"]', { state: "attached" });
  await page.selectOption('.panel:has-text("Choose environment and user pool") select >> nth=1', "pool1");
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=1 user(s) loaded");

  await openWidget();
  call = await ask("users whose email starts with a");
  check(call?.domain === "cognito", "Cognito: assist request carries domain=cognito", JSON.stringify(call?.domain));
  await page.click('.ai-widget-panel button:has-text("Use this query")');
  const cognitoQuery = await page.inputValue('input[placeholder="email:john"]');
  check(cognitoQuery === "SUGGESTED-QUERY", "Cognito: 'Use this query' fills the page's filter box", cognitoQuery);
  await closeWidget();

  // ---------- IoT: domain follows the things/certificates toggle ----------
  await openSession(page, "IoT");
  await page.waitForSelector('h2:text-is("1. Choose environments")');
  await page.click('label:has-text("Demo Env (111122223333 · us-east-1)") input[type="checkbox"]');
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=thing-alpha");

  await openWidget();
  call = await ask("disconnected prod things");
  check(call?.domain === "iot-things", "IoT things: assist request carries domain=iot-things", JSON.stringify(call?.domain));
  const messagesBefore = await page.locator(".ai-widget-messages .result-row").count();
  check(messagesBefore > 0, "IoT things: the thread shows the exchange");
  await closeWidget();

  await page.click('button:text-is("Certificates")');
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=cert-alpha");
  await openWidget();
  check(
    (await page.locator(".ai-widget-messages .result-row").count()) === 0,
    "IoT: switching things -> certificates starts a fresh thread"
  );
  call = await ask("only inactive certs");
  check(call?.domain === "iot-certificates", "IoT certificates: assist request carries domain=iot-certificates", JSON.stringify(call?.domain));
  check(
    (await page.locator('.ai-widget-panel .tab:has-text("Sampled")').count()) === 0 &&
      (await page.locator('.ai-widget-panel .tab:has-text("Selected")').count()) === 0,
    "The Sampled / Selected toggle is gone -- only checked rows are ever sent"
  );

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
