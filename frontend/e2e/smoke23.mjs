import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";

const V = ".session-body:not([hidden])";

/** Saving is ⋮ → "Save as template…" in the rail now, not a button in the strip. */
async function saveActiveAsTemplate(page) {
  await page.locator(".rail-row.active .rail-row-more").click();
  await page.locator('.rail-row-menu button:text-is("Save as template…")').click();
}

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/saved-sessions") && r.method() === "POST") {
      const body = JSON.parse(r.postData() || "{}");
      console.log("SAVEDEBUG", body.page, JSON.stringify(Object.keys(body.state || {})));
    }
  });
  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (r) => r.fulfill({ json: { reply: "ok", suggested_query: null } }));
  await page.route("**/api/tables/list*", (r) => r.fulfill({ json: { tables: ["DemoTable"] } }));
  await page.route("**/api/tables/describe", (r) => r.fulfill({ json: { table_name: "DemoTable", status: "ACTIVE", item_count: 2, size_bytes: 1, partition_key: "id", sort_key: null } }));
  await page.route("**/api/tables/scan", (r) => r.fulfill({ json: { items: [{ id: "1", name: "Alice" }], scanned_count: 1, count: 1, last_evaluated_key: null } }));
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
  await page.click('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("Home"))');
  await page.waitForSelector(".home-cards");

  // ---------- 1. Strip is a card in the page background colour ----------
  // It used to be transparent and ruleless; it is now shaped like a card but
  // filled with the page background rather than the panel colour.
  const strip = await page.evaluate(() => {
    const el = document.querySelector(".rail");
    const cs = getComputedStyle(el);
    return {
      bg: cs.backgroundColor,
      borderBottom: cs.borderBottomWidth,
      radius: cs.borderTopLeftRadius,
      body: getComputedStyle(document.body).backgroundColor,
      panel: getComputedStyle(document.querySelector(".panel")).backgroundColor,
    };
  });
  check(
    strip.bg === strip.body && strip.bg !== strip.panel && strip.borderBottom !== "0px" && parseFloat(strip.radius) > 0,
    "The session strip is a card in the page background colour",
    JSON.stringify(strip)
  );

  // ---------- 2. The rail's own popover floats above the body ----------
  // The portalled + menu is gone with the strip -- the catalogue is in the
  // rail itself. The only popover left is a session's ⋮, and the original
  // concern still applies to it: it must paint above the page, not behind it.
  await newSession(page, "CloudWatch");
  await page.waitForTimeout(400);
  await page.click('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("CloudWatch")) .rail-row-more');
  await page.waitForSelector(".rail-row-menu");
  const clipping = await page.evaluate(() => {
    const menu = document.querySelector(".rail-row-menu");
    const r = menu.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(r.height - 4, 20);
    return { onTop: menu.contains(document.elementFromPoint(x, y)), inViewport: r.right <= window.innerWidth + 1 };
  });
  check(clipping.onTop, "A session's ⋮ menu paints above the body rather than behind it");
  check(clipping.inViewport, "…and stays inside the viewport");
  await page.keyboard.press("Escape");
  // That opened a session; the checks below expect the home page.
  await page.click('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("Home"))');
  await page.waitForSelector(".home-cards");

  // ---------- 7. Tools are panes of their own, there is no Tools page ----------
  const offered = await page.locator(".home-card-title").allTextContents();
  check(!offered.includes("Tools"), "There is no catch-all Tools pane any more", JSON.stringify(offered));
  for (const t of ["HTTP client", "MQTT tester", "JWT", "Base64", "Diff"]) {
    check(offered.includes(t), `"${t}" is its own pane to put in a session`);
  }
  // ---------- 5. The agent is a page of the platform ----------
  check(
    (await page.locator('.panel:has(h2:text-is("Platform")) .home-card-title:text-is("Agent")').count()) === 1,
    "The agent is offered as a page rather than a session",
  );
  await page.keyboard.press("Escape");

  // ---------- 6. Home cards open sessions ----------
  await newSession(page, "JWT");
  await page.waitForSelector('.rail-row-label:text-is("JWT")');
  check((await page.locator(`${V} textarea[placeholder^="Paste a JWT"]`).count()) === 1, "A home card opens that session");

  // ---------- 6b. Multi-select opens an Aggregator with those panes ----------
  await page.click('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("Home"))');
  await page.waitForSelector(".home-cards");
  await page.click('.home-card:has(.home-card-title:text-is("CloudWatch")) input[type="checkbox"]');
  await page.click('.home-card:has(.home-card-title:text-is("IoT")) input[type="checkbox"]');
  // Create is what the floating "Aggregate N" button became: every session is
  // an Aggregator, so this is simply how one is made.
  await page.click(".home-create");
  await page.waitForSelector(`${V} .aggregator-tabs`, { timeout: 15000 });
  const paneTitles = await page.locator(`${V} .aggregator-tab-label`).allTextContents();
  check(
    JSON.stringify(paneTitles) === JSON.stringify(["CloudWatch", "IoT"]),
    "Ticking cards and pressing Create opens a session with exactly those panes",
    JSON.stringify(paneTitles)
  );
  await page.click(`${V} .aggregator-tab:has(.aggregator-tab-label:text-is("IoT")) .aggregator-tab-close`);
  await page.waitForTimeout(400);
  check((await page.locator(`${V} .aggregator-tab-label`).allTextContents()).length === 1,
    "Panes can still be removed inside the session");

  // ---------- 5b. The header prompt goes to the agent page ----------
  await page.fill(".agent-input", "what is open?");
  await page.press(".agent-input", "Enter");
  await page.waitForSelector('.page-info-title:text-is("Agent")');
  check((await page.locator(".agent-session >> text=what is open?").count()) === 1,
    "A header question goes to the agent page holding it");
  check(
    (await page.locator(".agent-session >> text=I'm not connected to a model yet").count()) === 1,
    "The agent answers that it can't answer yet"
  );

  // ---------- 4. Clicking outside closes the AI assistant ----------
  await newSession(page, "DynamoDB");
  await page.click(`${V} .ai-widget-button`);
  await page.waitForSelector(`${V} .ai-widget-panel`);
  await page.mouse.click(700, 400);
  await page.waitForSelector(`${V} .ai-widget-panel`, { state: "detached" });
  check(true, "Clicking outside the assistant closes it");
  await page.click(`${V} .ai-widget-button`);
  await page.waitForSelector(`${V} .ai-widget-panel`);
  await page.click(`${V} .ai-widget-textarea`);
  check(await page.locator(`${V} .ai-widget-panel`).isVisible(), "Clicking inside it does not close it");
  await page.click(`${V} .ai-widget-panel button[aria-label="Close"]`);

  // ---------- 8. Saving a session captures its real inputs ----------
  await page.selectOption(`${V} .panel:has-text("Choose environment and table") select`, { index: 1 });
  await page.click(`${V} button:has-text("Load tables")`);
  await page.waitForSelector(`${V} option[value="DemoTable"]`, { state: "attached" });
  await page.selectOption(`${V} .panel:has-text("Choose environment and table") select >> nth=1`, "DemoTable");
  await page.waitForSelector(`${V} >> text=partition key: id`);
  await page.fill(`${V} input[placeholder="field:value field2:value2"]`, "status:ACTIVE");
  await page.click(`${V} button:has-text("Scan")`);
  await page.waitForSelector(`${V} >> text=1 item(s) loaded`);

  const savedName = `Tables save ${Date.now()}`;
  page.once("dialog", (d) => d.accept(savedName));
  await saveActiveAsTemplate(page);
  await page.waitForTimeout(700);

  await page.click(`.rail-row-template:has(.rail-row-label:text-is("${savedName}"))`);
  await page.waitForSelector(`.rail-row-label:text-is("${savedName}")`);
  check(
    (await page.inputValue(`${V} input[placeholder="field:value field2:value2"]`)) === "status:ACTIVE",
    "A saved session restores the filter that was typed"
  );
  // The environment list is refetched on mount, so the restored id only shows
  // as the select's value once its options exist.
  const envSelect = `${V} .panel:has-text("Choose environment and table") select`;
  for (let i = 0; i < 60 && (await page.locator(envSelect).inputValue()) === ""; i++) {
    await page.waitForTimeout(100);
  }
  check(
    (await page.locator(`${V} .panel:has-text("Choose environment and table") select`).inputValue()) !== "",
    "...and the environment that was chosen"
  );
  check(
    (await page.locator(`${V} >> text=1 item(s) loaded`).count()) === 0,
    "...but not its results — a saved session is a template, not a snapshot"
  );

  // Same for a session holding several panes, which used to save almost nothing.
  await newSession(page);
  await page.click(`${V} .panel:has(h2:text-is("Panes")) label.checkbox-item:text-is("CloudWatch") input`);
  await page.click(`${V} .panel:has(h2:text-is("Panes")) label.checkbox-item:text-is("Cognito") input`);
  await page.click(`${V} button:text-is("Stacked")`);
  await page.waitForTimeout(200);
  await page.fill(`${V} .aggregator-pane:has(h3:text-is("CloudWatch")) textarea`, "fields @timestamp | filter saved");
  await page.waitForTimeout(700);

  const aggName = `Agg save ${Date.now()}`;
  page.once("dialog", (d) => d.accept(aggName));
  await saveActiveAsTemplate(page);
  await page.waitForTimeout(700);

  await page.click(`.rail-row-template:has(.rail-row-label:text-is("${aggName}"))`);
  await page.waitForSelector(`${V} .aggregator-stack`, { timeout: 15000 });
  const restoredPanes = await page.locator(`${V} .aggregator-pane h3`).allTextContents();
  check(
    JSON.stringify(restoredPanes) === JSON.stringify(["CloudWatch", "Cognito"]),
    "A saved session restores its panes",
    JSON.stringify(restoredPanes)
  );
  check(
    (await page.locator(`${V} .aggregator-stack`).count()) === 1,
    "...and its layout"
  );
  check(
    (await page.inputValue(`${V} .aggregator-pane:has(h3:text-is("CloudWatch")) textarea`)) === "fields @timestamp | filter saved",
    "...and each pane's own inputs, which is what used not to be saved"
  );
  await page.screenshot({ path: `${SHOT}/saved-aggregator.png` });

  await browser.close();
  report();
})().catch((e) => { console.error("SMOKE TEST FAILED:", e); process.exit(1); });
