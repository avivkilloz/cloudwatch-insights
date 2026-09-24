// This round's UI work: one spacing everywhere, Create beside the Name box,
// Tabs first among the layouts, the saved-items tabs reworked, and services
// and tools back in the Add lists as one-click sessions.
import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, report } from "./harness.mjs";
const SHOWN = ".session-body:not([hidden])";
const CARD = (l) => `.home-card:has(.home-card-title:text-is("${l}"))`;

async function login(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.addInitScript(() => { try { localStorage.setItem("cwi-rail-catalogue", "open"); } catch {} });
  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 15000 });
  await page.fill('input[autocomplete="username"]', ADMIN_USER);
  await page.fill('input[autocomplete="current-password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".rail", { timeout: 15000 });
  await page.evaluate(async () => {
    for (const u of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(u, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    await new Promise((r) => { const q = indexedDB.deleteDatabase("cloud-insights-sessions"); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  });
  await page.reload();
  await page.waitForSelector(".rail", { timeout: 15000 });
  return page;
}

/** A gap measured the way the eye sees it: between two boxes on screen. */
async function gapBetween(page, a, b, axis) {
  return page.evaluate(([a, b, axis]) => {
    const ra = document.querySelector(a).getBoundingClientRect();
    const rb = document.querySelector(b).getBoundingClientRect();
    return axis === "x" ? Math.round(rb.left - ra.right) : Math.round(rb.top - ra.bottom);
  }, [a, b, axis]);
}

const run = async () => {
  const browser = await launch();
  const page = await login(browser);

  // ---- 1. one spacing everywhere -------------------------------------
  // A classic scrollbar, so the measurements are the ones a real browser
  // makes rather than the overlay-scrollbar ones headless Chromium prefers.
  await page.addStyleTag({ content: "*{scrollbar-width:auto!important} .content{scrollbar-gutter:stable}" });
  const left = await page.evaluate(() => Math.round(document.querySelector(".rail").getBoundingClientRect().left));
  check(left === 16, "The panel sits a card's gap from the window's edge", `${left}px`);
  const railToInfo = await gapBetween(page, ".rail", ".page-info", "y");
  check(railToInfo === 16, "The panel and the page-title card are a card's gap apart", `${railToInfo}px`);
  const railToBody = await gapBetween(page, ".rail", ".session-bar", "x");
  check(railToBody === 16, "The panel and the body are a card's gap apart", `${railToBody}px`);
  const barToCard = await gapBetween(page, ".session-bar", ".home .panel", "y");
  check(barToCard === 16, "The strip and the first card are a card's gap apart", `${barToCard}px`);
  const cardGap = await page.evaluate(() => {
    const [a, b] = document.querySelectorAll(".home .panel");
    return Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
  });
  check(cardGap === 16, "…which is the gap between two body cards", `${cardGap}px`);
  const flush = await page.evaluate(() => {
    const bar = document.querySelector(".session-bar").getBoundingClientRect();
    const card = document.querySelector(".home .panel").getBoundingClientRect();
    return [Math.round(bar.left - card.left), Math.round(bar.right - card.right)];
  });
  check(flush[0] === 0 && flush[1] === 0, "The strip is exactly as wide as the cards", JSON.stringify(flush));

  // The strip still hides what scrolls under it: the dock behind it carries
  // the page background rather than a ring of box-shadow.
  const dockBg = await page.evaluate(() => {
    const dock = document.querySelector(".session-bar-dock");
    return [getComputedStyle(dock).position, getComputedStyle(dock).backgroundColor,
            getComputedStyle(document.body).backgroundColor];
  });
  check(dockBg[0] === "sticky" && dockBg[1] === dockBg[2], "The strip's dock is sticky and painted in the page colour", JSON.stringify(dockBg));

  // ---- 2. Create sits beside the Name box ----------------------------
  const createGap = await gapBetween(page, ".home-new-row .field input", ".home-create", "x");
  check(createGap <= 10, "Create sits beside the Name box, not at the end of an empty label", `${createGap}px`);
  await page.screenshot({ path: `${SHOT}/35-home.png` });

  // ---- 5. services and tools are back in Add -------------------------
  // Uppercased by CSS, so compare on the words rather than the rendering.
  const railHeadings = (await page.locator(".rail .rail-heading").allInnerTexts()).map((t) => t.toLowerCase());
  check(railHeadings.indexOf("services") === 1 && railHeadings.indexOf("tools") === 2,
    "The panel's Add list offers Services and Tools again", JSON.stringify(railHeadings));
  const RAIL_TYPE = (l) => `.rail-row-type:has(.rail-row-label:text-is("${l}"))`;
  await page.click(RAIL_TYPE("CloudWatch"));
  await page.waitForSelector(`${SHOWN} .aggregator-tab-label:text-is("CloudWatch")`, { timeout: 15000 });
  const titles = await page.locator(".session-tab-label").allInnerTexts();
  check(titles.includes("CloudWatch"), "Clicking a service opens a session named after it", JSON.stringify(titles));
  const paneCount = await page.locator(`${SHOWN} .aggregator-tab`).count();
  check(paneCount === 1, "…holding only that service", `${paneCount} panes`);
  const ticked = await page.locator(`${SHOWN} .toolbar input[type=checkbox]:checked`).count();
  check(ticked === 1, "…and only its box is ticked in the picker", `${ticked} ticked`);

  // ---- 3. Tabs is the first layout option ----------------------------
  const layoutButtons = await page.locator(`${SHOWN} .toolbar:has(span:text-is("Layout")) button`).allInnerTexts();
  check(JSON.stringify(layoutButtons) === JSON.stringify(["Tabs", "Side by side", "Stacked", "Dashboard"]),
    "Tabs is the first layout offered", JSON.stringify(layoutButtons));
  const active = await page.locator(`${SHOWN} .toolbar:has(span:text-is("Layout")) button:not(.secondary)`).innerText();
  check(active === "Tabs", "…and the one a new session starts in", active);

  // A second service from Add is its own session, not a second pane.
  await page.click(RAIL_TYPE("IoT"));
  await page.waitForSelector(`${SHOWN} .aggregator-tab-label:text-is("IoT")`, { timeout: 15000 });
  const tabTitles = await page.locator(".session-tab-label").allInnerTexts();
  check(tabTitles.length === 2 && tabTitles.includes("IoT"), "A second service opens a second session", JSON.stringify(tabTitles));
  const iotPanes = await page.locator(`${SHOWN} .aggregator-tab`).count();
  check(iotPanes === 1, "…holding only itself", `${iotPanes} panes`);
  await page.screenshot({ path: `${SHOT}/35-session.png` });

  // The tabs row is a card's gap above the pane under it.
  const tabsGap = await page.evaluate(() => {
    const body = document.querySelector(".session-body:not([hidden])");
    const tabs = body.querySelector(".aggregator-tabs").getBoundingClientRect();
    const pane = body.querySelector(".aggregator-pane").getBoundingClientRect();
    return Math.round(pane.top - tabs.bottom);
  });
  check(tabsGap === 16, "The pane tabs are a card's gap above the pane", `${tabsGap}px`);

  // ---- the strip's ＋ offers the same shortcuts -----------------------
  await page.click(".session-bar-add");
  await page.waitForSelector(".session-add-menu");
  const menuHeadings = (await page.locator(".session-add-menu .session-add-heading").allInnerTexts()).map((t) => t.toLowerCase());
  check(menuHeadings[0] === "services" && menuHeadings[1] === "tools",
    "The ＋ menu offers them too", JSON.stringify(menuHeadings));
  await page.screenshot({ path: `${SHOT}/35-addmenu.png` });
  await page.click(`.session-add-menu .session-add-item:has(.session-add-name:text-is("Base64"))`);
  await page.waitForSelector(`${SHOWN} .aggregator-tab-label:text-is("Base64")`, { timeout: 15000 });
  const afterMenu = await page.locator(".session-tab-label").allInnerTexts();
  check(afterMenu.length === 3 && afterMenu.includes("Base64"), "…and opens one the same way", JSON.stringify(afterMenu));

  // Starting the same service twice does not collide on the name.
  await page.click(RAIL_TYPE("CloudWatch"));
  await page.waitForTimeout(400);
  const twice = await page.locator(".session-tab-label").allInnerTexts();
  check(twice.filter((t) => t.startsWith("CloudWatch")).length === 2 && twice.includes("CloudWatch 2"),
    "A second CloudWatch session is numbered, not a duplicate name", JSON.stringify(twice));

  // ---- 4. the saved-items tabs ---------------------------------------
  await page.click(".rail-row-home");
  await page.click('.home-card:has(.home-card-title:text-is("Settings")) .home-card-open');
  await page.waitForSelector(".settings-nav, .panel", { timeout: 15000 });
  await page.click('button:text-is("Saved")');
  // The hub is not there while its items are being fetched.
  await page.waitForSelector('.panel:has(h2:text-is("Saved items")) .tab', { timeout: 15000 });
  const savedTabs = await page.locator(".panel:has(h2:text-is(\"Saved items\")) .tabs .tab").allInnerTexts();
  check(savedTabs[0] === "Session Templates", "Session Templates is the first saved-items tab", JSON.stringify(savedTabs));
  check(!savedTabs.some((t) => /Aggregator/.test(t)), "…and nothing is called Aggregator any more", JSON.stringify(savedTabs));
  check(!savedTabs.some((t) => ["CloudWatch Sessions", "OpenSearch Sessions", "IoT Sessions"].includes(t)),
    "The per-service saved-session tabs are gone", JSON.stringify(savedTabs));
  check(savedTabs.includes("Log Queries") && savedTabs.includes("IoT Searches") && savedTabs.includes("S3"),
    "The saved items that are still written are all still there", JSON.stringify(savedTabs));
  const openTab = await page.locator(".panel:has(h2:text-is(\"Saved items\")) .tab.active").innerText();
  check(openTab === "Session Templates", "…and it is the one open on arrival", openTab);
  await page.screenshot({ path: `${SHOT}/35-saved.png` });

  // A template saved from a session lands in that tab, and old per-service
  // templates are listed beside it rather than orphaned.
  await page.evaluate(async () => {
    await fetch("/api/saved-sessions", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: "logs", name: "Legacy CloudWatch template", state: { environment_ids: [], query_string: "fields @message" } }),
    });
  });
  await page.reload();
  await page.waitForSelector(".rail", { timeout: 15000 });
  await page.click(".rail-row-home");
  await page.click('.home-card:has(.home-card-title:text-is("Settings")) .home-card-open');
  await page.click('button:text-is("Saved")');
  await page.waitForSelector('.panel:has(h2:text-is("Saved items")) .tab', { timeout: 15000 });
  const listed = await page.locator('.panel:has(h2:text-is("Saved items")) .result-row-summary .msg').allInnerTexts();
  check(listed.some((t) => t.includes("Legacy CloudWatch template")),
    "A template saved when a service was a session is listed under Session Templates", JSON.stringify(listed).slice(0, 200));

  await browser.close();
  report();
};
run().catch((e) => { console.log("SMOKE TEST FAILED:", e.message); process.exit(1); });
