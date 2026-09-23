import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
import fs from "fs";

const SCRATCH = `${SHOT}/downloads`;
fs.mkdirSync(SCRATCH, { recursive: true });

async function downloadCsv(page, exportButtonSelector) {
  await page.click(exportButtonSelector);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click('.icon-popover-item:has-text("CSV")'),
  ]);
  const path = `${SCRATCH}/${Date.now()}-${download.suggestedFilename()}`;
  await download.saveAs(path);
  return fs.readFileSync(path, "utf-8");
}

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

  await page.route("**/api/log-groups", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            log_groups: [{ name: "/demo/log-group", stored_bytes: 1024, creation_time: null }],
            error: null,
          },
        ],
      },
    })
  );
  await page.route("**/api/queries/start", (route) =>
    route.fulfill({
      json: {
        queries: [
          { environment_id: 1, environment_name: "Demo Env", account_id: "111122223333", region: "us-east-1", query_id: "q1", error: null },
        ],
      },
    })
  );
  await page.route("**/api/queries/results", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            query_id: "q1",
            status: "Complete",
            rows: [
              [
                { field: "@ptr", value: "ptr-1" },
                { field: "@timestamp", value: "2024-01-01 00:00:01.000" },
                { field: "@message", value: "alpha event" },
              ],
              [
                { field: "@ptr", value: "ptr-2" },
                { field: "@timestamp", value: "2024-01-01 00:00:02.000" },
                { field: "@message", value: "bravo event" },
              ],
            ],
            statistics: null,
            error: null,
          },
        ],
        all_done: true,
      },
    })
  );
  await page.route("**/api/buckets/list*", (route) => route.fulfill({ json: { buckets: [{ name: "demo-bucket", creation_date: null }] } }));
  await page.route("**/api/buckets/browse", (route) =>
    route.fulfill({
      json: {
        bucket: "demo-bucket",
        bucket_region: "us-east-1",
        prefix: "",
        folders: [],
        files: [
          { key: "alpha.txt", name: "alpha.txt", size: 42, last_modified: null, storage_class: null },
          { key: "bravo.txt", name: "bravo.txt", size: 43, last_modified: null, storage_class: null },
        ],
        continuation_token: null,
      },
    })
  );
  await page.route("**/api/tables/list*", (route) => route.fulfill({ json: { tables: ["DemoTable"] } }));
  await page.route("**/api/tables/describe", (route) =>
    route.fulfill({ json: { table_name: "DemoTable", status: "ACTIVE", item_count: 2, size_bytes: 100, partition_key: "id", sort_key: null } })
  );
  await page.route("**/api/tables/scan", (route) =>
    route.fulfill({
      json: { items: [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }], scanned_count: 2, count: 2, last_evaluated_key: null },
    })
  );
  await page.route("**/api/cognito/user-pools*", (route) => route.fulfill({ json: { user_pools: [{ id: "pool1", name: "MyPool" }] } }));
  await page.route("**/api/cognito/users", (route) =>
    route.fulfill({
      json: {
        users: [
          { username: "alice", status: "CONFIRMED", enabled: true, created: null, last_modified: null, attributes: { email: "alice@example.com" } },
          { username: "bob", status: "CONFIRMED", enabled: true, created: null, last_modified: null, attributes: { email: "bob@example.com" } },
        ],
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
              { thing_name: "thing-bravo", thing_id: null, thing_type_name: null, thing_group_names: [], attributes: {}, connected: false, connectivity_timestamp: null },
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
            certificates: [
              { certificate_id: "cert-alpha", certificate_arn: "arn:a", status: "ACTIVE", creation_date: null, policies: [] },
              { certificate_id: "cert-bravo", certificate_arn: "arn:b", status: "ACTIVE", creation_date: null, policies: [] },
            ],
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

  // ---------- Tables ----------
  await openSession(page, "DynamoDB");
  await page.waitForSelector("text=Saved tables");
  await page.selectOption('.panel:has-text("Choose environment and table") select', { label: "Demo Env (111122223333 · us-east-1)" });
  await page.click('button:has-text("Load tables")');
  await page.waitForSelector('option[value="DemoTable"]', { state: "attached" });
  await page.selectOption('.panel:has-text("Choose environment and table") select >> nth=1', "DemoTable");
  await page.waitForSelector("text=partition key: id");
  await page.click('button:has-text("Scan")');
  await page.waitForSelector("text=2 item(s) loaded");

  const tablesPanel = '.panel:has-text("2. Search items")';
  // Check the first row only, then export -- CSV should contain Alice but not Bob.
  await page.click(`${tablesPanel} .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.waitForSelector(`${tablesPanel} button:has-text("Export 1 selected")`);
  let csv = await downloadCsv(page, `${tablesPanel} button:has-text("Export 1 selected")`);
  check(csv.includes("Alice") && !csv.includes("Bob"), "Tables: export honours the checked row only", csv.replace(/\n/g, "\\n"));

  // Select all, then hide them -- the list should empty out and offer to restore.
  await page.click(`${tablesPanel} label.checkbox-item:has-text("Select all") input`);
  await page.waitForSelector(`${tablesPanel} button:has-text("Hide selected (2)")`);
  await page.click(`${tablesPanel} button:has-text("Hide selected (2)")`);
  await page.waitForSelector(`${tablesPanel} button:has-text("Show 2 hidden")`);
  check((await page.locator(`${tablesPanel} .result-row`).count()) === 0, "Tables: hiding the selected rows removes them from the list");
  await page.click(`${tablesPanel} button:has-text("Show 2 hidden")`);
  await page.waitForSelector(`${tablesPanel} .result-row >> nth=1`);
  check((await page.locator(`${tablesPanel} .result-row`).count()) === 2, "Tables: 'Show hidden' restores the rows");

  // Expanding a row must still work with the checkbox in the summary.
  await page.click(`${tablesPanel} .result-row >> nth=0 >> .result-row-summary .msg`);
  await page.waitForSelector(`${tablesPanel} .result-row-detail`);
  check(true, "Tables: clicking the row still expands it (checkbox doesn't swallow the click)");

  // ---------- Buckets ----------
  await openSession(page, "S3");
  await page.waitForSelector("text=Saved buckets");
  await page.selectOption('.panel:has-text("Choose environment and bucket") select', { label: "Demo Env (111122223333 · us-east-1)" });
  await page.click('button:has-text("Load buckets")');
  await page.waitForSelector('option[value="demo-bucket"]', { state: "attached" });
  await page.selectOption('.panel:has-text("Choose environment and bucket") select >> nth=1', "demo-bucket");
  await page.waitForSelector("text=alpha.txt");

  const bucketsPanel = '.panel:has-text("2. Browse")';
  await page.click(`${bucketsPanel} .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.waitForSelector(`${bucketsPanel} button:has-text("Export 1 selected")`);
  csv = await downloadCsv(page, `${bucketsPanel} button:has-text("Export 1 selected")`);
  check(csv.includes("alpha.txt") && !csv.includes("bravo.txt"), "Buckets: export honours the checked file only", csv.replace(/\n/g, "\\n"));

  // ---------- Cognito ----------
  await openSession(page, "Cognito");
  await page.waitForSelector("text=1. Choose environment and user pool");
  await page.selectOption('.panel:has-text("Choose environment and user pool") select', { label: "Demo Env (111122223333 · us-east-1)" });
  await page.click('button:has-text("Load user pools")');
  await page.waitForSelector('option[value="pool1"]', { state: "attached" });
  await page.selectOption('.panel:has-text("Choose environment and user pool") select >> nth=1', "pool1");
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=2 user(s) loaded");

  const cognitoPanel = '.panel:has-text("2. Search users")';
  await page.click(`${cognitoPanel} .result-row >> nth=1 >> input[type="checkbox"]`);
  await page.waitForSelector(`${cognitoPanel} button:has-text("Export 1 selected")`);
  csv = await downloadCsv(page, `${cognitoPanel} button:has-text("Export 1 selected")`);
  check(csv.includes("bob") && !csv.includes("alice"), "Cognito: export honours the checked user only", csv.replace(/\n/g, "\\n"));

  // ---------- IoT things ----------
  await openSession(page, "IoT");
  await page.waitForSelector('h2:text-is("1. Choose environments")');
  await page.click('label:has-text("Demo Env (111122223333 · us-east-1)") input[type="checkbox"]');
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=thing-alpha");

  const iotPanel = '.panel:has-text("3. Results")';
  await page.click(`${iotPanel} .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.waitForSelector(`${iotPanel} button:has-text("Export 1 selected")`);
  csv = await downloadCsv(page, `${iotPanel} button:has-text("Export 1 selected")`);
  check(csv.includes("thing-alpha") && !csv.includes("thing-bravo"), "IoT things: export honours the checked thing only", csv.replace(/\n/g, "\\n"));

  await page.click(`${iotPanel} label.checkbox-item:has-text("Select all") input`);
  await page.click(`${iotPanel} button:has-text("Hide selected (2)")`);
  await page.waitForSelector(`${iotPanel} button:has-text("Show 2 hidden")`);
  check((await page.locator(`${iotPanel} .result-row`).count()) === 0, "IoT things: hide selected empties the list");
  await page.click(`${iotPanel} button:has-text("Show 2 hidden")`);

  // ---------- IoT certificates ----------
  await page.click('button:text-is("Certificates")');
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=cert-alpha");
  await page.click(`${iotPanel} .result-row >> nth=1 >> input[type="checkbox"]`);
  await page.waitForSelector(`${iotPanel} button:has-text("Export 1 selected")`);
  csv = await downloadCsv(page, `${iotPanel} button:has-text("Export 1 selected")`);
  check(csv.includes("cert-bravo") && !csv.includes("cert-alpha"), "IoT certificates: export honours the checked certificate only", csv.replace(/\n/g, "\\n"));

  // ---------- Logs (regression: existing selection behaviour preserved) ----------
  await openSession(page, "CloudWatch");
  await page.waitForSelector("text=1. Choose environments");
  await page.click('label:has-text("Demo Env (111122223333 · us-east-1)") input[type="checkbox"]');
  await page.click('button:has-text("Load log groups")');
  await page.waitForSelector('label:has-text("/demo/log-group")', { timeout: 10000 });
  await page.click('label:has-text("/demo/log-group") input[type="checkbox"]');
  await page.click('button:has-text("Run query")');
  await page.waitForSelector("text=alpha event", { timeout: 10000 });

  const logsPanel = '.panel:has-text("4. Results")';
  await page.click(`${logsPanel} .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.waitForSelector(`${logsPanel} button:has-text("Export 1 selected")`);
  csv = await downloadCsv(page, `${logsPanel} button:has-text("Export 1 selected")`);
  const logsOk = csv.includes("bravo event") !== csv.includes("alpha event");
  check(logsOk, "Logs: export honours the checked row only", csv.replace(/\n/g, "\\n"));

  await page.click(`${logsPanel} button:has-text("Hide selected (1)")`);
  await page.waitForSelector(`${logsPanel} button:has-text("Show 1 hidden")`);
  check((await page.locator(`${logsPanel} .result-row`).count()) === 1, "Logs: hide selected removes just that row");

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
