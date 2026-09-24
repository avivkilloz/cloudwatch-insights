import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
const V = ".session-body:not([hidden])";

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
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

  // ---------- item 3: CloudWatch and OpenSearch are separate services ----------
  const titles = await page.locator(".home-card-title").allTextContents();
  check(titles.includes("CloudWatch") && titles.includes("OpenSearch"), "CloudWatch and OpenSearch are separate cards", JSON.stringify(titles));
  check(!titles.includes("Logs"), "There is no Logs card any more");

  for (const [label, heading] of [["CloudWatch", "log groups"], ["OpenSearch", "indices"]]) {
    await newSession(page, label);
    await page.waitForSelector(".page-info-title", { timeout: 10000 });
    check((await page.locator(".page-info-title").textContent()) === label, `${label} opens its own session`);
    check((await page.locator(`${V} .panel h2`).allTextContents()).every((h) => h !== "Backend"),
      `${label} has no Backend section`);
    // Every session leads with its own Panes card, so the page's own steps
    // start after it.
    const steps = (await page.locator(`${V} .panel h2`).allTextContents()).filter((h) => h !== "Panes");
    const step2 = steps[1];
    check(step2.includes(heading), `${label} step 2 chooses ${heading}`, step2);
  }
  await page.screenshot({ path: `${SHOT}/26-opensearch.png` });

  // ---------- item 6: the strip is a card in the page background colour ----------
  const strip = await page.evaluate(() => {
    const el = document.querySelector(".rail");
    const cs = getComputedStyle(el);
    const body = getComputedStyle(document.body).backgroundColor;
    const panel = getComputedStyle(document.querySelector(".panel")).backgroundColor;
    return { bg: cs.backgroundColor, border: cs.borderBottomWidth, radius: cs.borderTopLeftRadius, body, panel };
  });
  check(strip.bg === strip.body, "The strip is filled with the page background", JSON.stringify(strip));
  check(strip.bg !== strip.panel, "…not the colour the body's cards use");
  check(strip.border !== "0px" && parseFloat(strip.radius) > 0, "…but shaped like a card", JSON.stringify(strip));
  await page.screenshot({ path: `${SHOT}/26-strip.png`, clip: { x: 0, y: 50, width: 900, height: 80 } });

  // ---------- item 4: Settings has a title and description ----------
  await page.click(".user-menu-trigger");
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  check((await page.locator(".page-info-title").textContent()) === "Settings", "Settings has a page title");
  check(((await page.locator(".page-info-help").textContent()) || "").length > 50, "Settings has a description");
  // The service toggle now covers both logs pages.
  await page.click('.content .tabs button:has-text("User Groups")').catch(() => {});
  await page.screenshot({ path: `${SHOT}/26-settings.png` });

  // ---------- item 5: corner checkbox, text-only FAB ----------
  await page.click('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("Home"))');
  await page.waitForSelector(".home-cards");
  const pick = await page.evaluate(() => {
    const card = document.querySelector(".home-card:has(.home-card-pick)");
    if (!card) return null;
    const cb = card.querySelector(".home-card-pick");
    const t = card.querySelector(".home-card-title");
    const c = card.getBoundingClientRect(), b = cb.getBoundingClientRect(), tt = t.getBoundingClientRect();
    return { tag: cb.tagName, text: cb.textContent.trim(), fromRight: Math.round(c.right - b.right),
             fromTop: Math.round(b.top - c.top), titleTop: Math.round(tt.top - c.top) };
  });
  check(pick && pick.tag === "INPUT" && pick.text === "", "The card tick is a bare checkbox with no label", JSON.stringify(pick));
  check(pick && pick.fromRight <= 16 && Math.abs(pick.fromTop - pick.titleTop) < 14,
    "…in the card's top-right, level with the title", JSON.stringify(pick));

  await page.locator('.home-card:has(.home-card-title:text-is("CloudWatch")) .home-card-pick').check();
  // Create replaced the floating "Aggregate N" button: making a session is not
  // a thing that appears once you have ticked something, it is the card.
  check((await page.locator(".home-aggregate-fab").count()) === 0, "There is no floating button any more");
  const createText = (await page.locator(".home-create").textContent()).trim();
  check(!/[⊞]/.test(createText) && createText === "Create", "The button that makes one is text only", createText);
  await page.screenshot({ path: `${SHOT}/26-home.png` });

  // ---------- item 2: the session's card is "Panes" ----------
  await page.locator('.home-card:has(.home-card-title:text-is("IoT")) .home-card-pick').check();
  await page.click(".home-create");
  await page.waitForSelector(`${V} .aggregator-pane`, { timeout: 10000 });
  const aggHeads = await page.locator(`${V} > .panel h2`).allTextContents();
  check(aggHeads[0] === "Panes", "The session's controls card is called Panes", JSON.stringify(aggHeads));
  check((await page.locator(`${V} > .panel`).first().locator("p.muted").count()) === 0,
    "…and no longer repeats the description the page header gives");
  const paneTitles = await page.locator(`${V} .aggregator-tab-label`).allTextContents();
  check(paneTitles.length === 2 && paneTitles.some((t) => t.includes("CloudWatch")),
    "CloudWatch works as a pane", JSON.stringify(paneTitles));
  await page.screenshot({ path: `${SHOT}/26-aggregator.png` });

  // ---------- item 1: Compact really does differ, and says so ----------
  await newSession(page, "Diff");
  await page.waitForSelector(`${V} textarea`);
  const L = ["START", ...Array.from({ length: 30 }, (_, i) => `same ${i}`), "END-OLD"].join("\n");
  const R = ["START", ...Array.from({ length: 30 }, (_, i) => `same ${i}`), "END-NEW"].join("\n");
  await page.fill(`${V} textarea >> nth=0`, L);
  await page.fill(`${V} textarea >> nth=1`, R);
  await page.waitForTimeout(300);
  const opt = await page.locator(`${V} select option[value="compact"]`).textContent();
  check(opt.toLowerCase().includes("unchanged"), "The Compact option says what it does", opt);
  await page.selectOption(`${V} select`, "unified");
  await page.waitForTimeout(200);
  const uni = await page.locator(`${V} .diff-output`).innerText();
  await page.selectOption(`${V} select`, "compact");
  await page.waitForTimeout(200);
  const comp = await page.locator(`${V} .diff-output`).innerText();
  check(uni !== comp && comp.includes("unchanged lines"), "Compact folds long unchanged runs, Unified does not",
    `unified=${uni.split("\n").length} rows, compact=${comp.split("\n").length} rows`);

  // ---------- migration: an old "logs" session still opens ----------
  await page.evaluate(async () => {
    // Write a pre-split workspace straight into IndexedDB, the way a browser
    // that had one open before this change would already have it.
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("cloud-insights-sessions");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      r.onupgradeneeded = () => r.result.createObjectStore("workspaces");
    });
    const keys = await new Promise((res) => {
      const t = db.transaction("workspaces", "readonly").objectStore("workspaces").getAllKeys();
      t.onsuccess = () => res(t.result);
    });
    const key = keys[0];
    if (key === undefined) throw new Error("no workspace stored yet");
    const existing = await new Promise((res) => {
      const t = db.transaction("workspaces", "readonly").objectStore("workspaces").get(key);
      t.onsuccess = () => res(t.result);
    });
    const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
    parsed.sessions = [{ id: "legacy1", type: "logs", title: "Old OpenSearch", state: { backend: "opensearch", queryString: "level:ERROR" } }];
    parsed.activeId = "legacy1";
    parsed.view = "session";
    await new Promise((res) => {
      const t = db.transaction("workspaces", "readwrite").objectStore("workspaces")
        .put(typeof existing === "string" ? JSON.stringify(parsed) : parsed, key);
      t.onsuccess = () => res();
    });
  }).catch((e) => console.log("(migration seed skipped:", e.message + ")"));
  await page.reload();
  await page.waitForSelector(".rail-row", { timeout: 15000 });
  const tabs = await page.locator(".rail-row-label").allTextContents();
  if (tabs.includes("Old OpenSearch")) {
    await page.click('.rail-row-label:text-is("Old OpenSearch")');
    await page.waitForTimeout(500);
    // The card carries the session's own name now, so what says the split was
    // honoured is which pane it came back holding.
    const panes = await page.locator(`${V} .aggregator-tab-label`).allTextContents();
    check(JSON.stringify(panes) === JSON.stringify(["OpenSearch"]),
      "A session saved before the split reopens holding the right pane", JSON.stringify(panes));
    const q = await page.locator(`${V} textarea`).first().inputValue().catch(() => "");
    check(q.includes("level:ERROR"), "…keeping the query it had", q);
  } else {
    check(false, "A session saved before the split reopens", JSON.stringify(tabs));
  }

  await browser.close();
  report();
  process.exit(fail ? 1 : 0);
})();
