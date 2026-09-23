import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
const V = ".session-body:not([hidden])";

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.route("**/api/tools/http-request", (r) => r.fulfill({ json: {
    status_code: 200, status_text: "OK", elapsed_ms: 42, body_truncated: false,
    headers: [{ key: "content-type", value: "application/json" }], body: '{"ok":true}' } }));
  // The rail's catalogue folds shut by default now (smoke28 covers that);
  // these suites are about what it offers, so open it before the first paint.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("cwi-rail-catalogue", "open");
    } catch {}
  });

  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 15000 });
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

  await page.waitForSelector(".home-cards", { timeout: 15000 });

  // ---------- items 1 & 2: renamed labels ----------
  const cardTitles = await page.locator(".home-card-title").allTextContents();
  check(cardTitles.includes("DynamoDB") && !cardTitles.includes("Tables"), "Tables is now DynamoDB", JSON.stringify(cardTitles));
  check(cardTitles.includes("S3") && !cardTitles.includes("Buckets"), "Buckets is now S3");

  // ---------- item 3: the home page is "make a session", then the platform ----------
  // Platform used to be a group of session types holding the Aggregator and the
  // agent. The Aggregator is what a session *is* now, so the group holds pages
  // instead, and the card that makes a session comes first.
  const groups = await page.locator(".home > .panel > h2").allTextContents();
  check(JSON.stringify(groups) === JSON.stringify(["New session", "Platform"]),
    "Home leads with the new-session card, then the platform's pages", JSON.stringify(groups));
  const paneGroups = await page.locator('.home > .panel:has(> h2:text-is("New session")) h3').allTextContents();
  check(JSON.stringify(paneGroups) === JSON.stringify(["Services", "Tools"]),
    "…and what goes in a session is grouped into services and tools", JSON.stringify(paneGroups));
  const platformCards = await page.locator('.home > .panel:has(> h2:text-is("Platform")) .home-card-title').allTextContents();
  check(!platformCards.includes("Aggregator") && platformCards.includes("Agent"),
    "Platform holds pages -- the agent among them -- and no Aggregator", JSON.stringify(platformCards));
  const serviceCards = await page.locator('.home > .panel:has(> h2:text-is("New session")) .home-card-title').allTextContents();
  check(!serviceCards.includes("Aggregator"), "Aggregator is not something you put in a session either");
  await page.screenshot({ path: `${SHOT}/25-menu.png` });
  await page.keyboard.press("Escape");

  // ---------- item 4: Create, which is what the floating button became ----------
  check((await page.locator(".home-aggregate-fab").count()) === 0,
    "The floating Aggregate button is gone: Create is not conditional, it is the way in");
  // Scoped to the cards: a bare substring also matched the panel's own
  // description of the home page, which says "start a session".
  check((await page.locator('.home-card-title:text-is("Start a session")').count()) === 0,
    "The 'Start a session' card is gone");
  await page.locator('.home-card:has(.home-card-title:text-is("CloudWatch")) input[type=checkbox]').check();
  await page.locator('.home-card:has(.home-card-title:text-is("DynamoDB")) input[type=checkbox]').check();
  check((await page.locator(".home").textContent()).includes("2 pages"),
    "It says how many are ticked");
  check(!!(await page.locator(".home-create").getAttribute("title")),
    "Create has a tooltip explaining what it does");
  await page.screenshot({ path: `${SHOT}/25-home-fab.png` });

  await page.click(".home-create");
  await page.waitForSelector(`${V} .aggregator-tabs`, { timeout: 10000 });
  const panes = await page.locator(`${V} .aggregator-tab`).count();
  check(panes === 2, "It opens a session with exactly the ticked panes", `panes=${panes}`);

  // ---------- item 5: page title and description ----------
  // A session's title is its own name now, not a type's label, and the
  // description says what is in it.
  const aggIntro = await page.locator(".page-info-title").textContent();
  check(aggIntro === "CloudWatch +1", "A session's card carries the name it was given", aggIntro);
  const aggHelp = (await page.locator(".page-info-help").textContent()) || "";
  check(aggHelp.includes("CloudWatch") && aggHelp.includes("DynamoDB"), "…and says what is in it", aggHelp);
  check((await page.locator(`${V} .aggregator-pane .page-intro`).count()) === 0,
    "Panes inside the Aggregator do not each repeat a page header");

  for (const [label, title] of [["Cognito", "Cognito"], ["JWT", "JWT"], ["S3", "S3"]]) {
    await newSession(page, label);
    await page.waitForTimeout(400);
    // A session is named after its one pane, or "JWT 2" if that name is taken.
    const shown = await page.locator(".page-info-title").textContent();
    check(shown.startsWith(title), `${label} session is named after the pane in it`, shown);
    check(((await page.locator(".page-info-help").textContent()) || "").length > 40, `${label} page explains what it's for`);
  }

  // ---------- item 6: tools use cards ----------
  await newSession(page, "HTTP client");
  await page.waitForTimeout(400);
  // GET is bodyless, so there is no Body card yet and no Response until one comes back.
  // Every session leads with its own Panes card, so the tool's own cards are
  // what comes after it.
  const httpPanels = (await page.locator(`${V} .panel h2`).allTextContents()).filter((h) => h !== "Panes");
  check(JSON.stringify(httpPanels) === JSON.stringify(["Request", "Headers"]),
    "HTTP client is laid out as cards", JSON.stringify(httpPanels));
  await page.selectOption(`${V} select >> nth=0`, "POST");
  await page.waitForTimeout(200);
  check((await page.locator(`${V} .panel h2`).allTextContents()).includes("Body"),
    "…and a Body card appears for methods that take one");
  await page.fill(`${V} input[placeholder^="https://api"]`, "https://example.com/x");
  await page.click(`${V} button:text-is("Send")`);
  await page.waitForSelector(`${V} .panel:has(h2:text-is("Response"))`, { timeout: 8000 });
  check(true, "The response comes back in its own card");
  await page.screenshot({ path: `${SHOT}/25-http.png` });

  for (const tool of ["JWT", "Base64", "Diff", "MQTT tester"]) {
    await newSession(page, tool);
    await page.waitForTimeout(400);
    const n = (await page.locator(`${V} .panel h2`).allTextContents()).filter((h) => h !== "Panes").length;
    check(n >= 1, `${tool} is laid out as cards`, `panels=${n}`);
  }
  await page.screenshot({ path: `${SHOT}/25-mqtt.png` });

  await newSession(page, "Base64");
  await page.waitForTimeout(400);
  await page.fill(`${V} textarea`, "hello");
  await page.waitForTimeout(300);
  const out = await page.locator(`${V} textarea`).nth(1).inputValue();
  check(out === "aGVsbG8=", "Base64 still works after the relayout", out);
  await page.screenshot({ path: `${SHOT}/25-base64.png` });

  await browser.close();
  report();
  process.exit(fail ? 1 : 0);
})();
