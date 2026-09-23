// One Sessions list holding open and closed alike, templates under Add, the
// strip as wide as the cards, and a Home icon that does not move.
import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
/** Add holds the way to the new-session card, the one-click services and
 * tools, and templates. */
const NEW_SESSION = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
const OPEN = ".rail-row:not(.rail-row-type):not(.rail-row-closed):not(.rail-row-home)";
const ROW = (l) => `${OPEN}:has(.rail-row-label:text-is("${l}"))`;
const CLOSED = (l) => `.rail-row-closed:has(.rail-row-label:text-is("${l}"))`;
const TAB = (l) => `.session-tab:has(.session-tab-label:text-is("${l}"))`;
// Unique per run: templates outlive a run, and an earlier one's leftover would
// make "exactly one of these exists" quietly wrong.
const TPL = `Template under Add ${Date.now()}`;

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 700 } })).newPage();
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
  await page.waitForSelector(".rail");

  // ---------- 1. the strip is as wide as the cards, scrollbar or not ----------
  await newSession(page, "CloudWatch");
  await page.waitForSelector(ROW("CloudWatch"));
  // Headless Chromium draws overlay scrollbars (0px), which is exactly why the
  // mismatch never showed up here. Reserve a real gutter and measure again.
  await page.addStyleTag({ content: ".content { scrollbar-gutter: stable; }" });
  await page.waitForTimeout(300);
  const geo = await page.evaluate(() => {
    const content = document.querySelector(".content");
    const bar = document.querySelector(".session-bar").getBoundingClientRect();
    // The session on screen: every session body stays mounted, so the first
    // .panel in .content can belong to a hidden one.
    const panel = document.querySelector(".session-body:not([hidden]) .panel").getBoundingClientRect();
    return {
      gutter: content.offsetWidth - content.clientWidth,
      barLeft: Math.round(bar.left), barRight: Math.round(bar.right),
      panelLeft: Math.round(panel.left), panelRight: Math.round(panel.right),
      // The dock around the strip is what sticks: the strip itself is a plain
      // card, so the gap below it belongs to the dock and stays with it.
      sticky: getComputedStyle(document.querySelector(".session-bar-dock")).position,
    };
  });
  check(geo.gutter > 0, "A scrollbar gutter is reserved, so this measures the real case", JSON.stringify(geo));
  check(geo.barRight === geo.panelRight, "The strip's right edge lands on the cards', scrollbar and all", JSON.stringify(geo));
  check(geo.barLeft === geo.panelLeft, "…and so does its left edge", JSON.stringify(geo));
  check(geo.sticky === "sticky", "…and its dock is what pins it to the top", JSON.stringify(geo));

  // ---------- 2. the Home icon does not move between states ----------
  const iconInset = () => page.evaluate(() => {
    const row = document.querySelector(".rail-row-home");
    const i = row.querySelector(".rail-row-icon").getBoundingClientRect();
    return Math.round(i.left - row.getBoundingClientRect().left);
  });
  const whileSession = await iconInset();
  await page.click(".rail-row-home");
  await page.waitForTimeout(250);
  const whileHome = await iconInset();
  check(whileSession === whileHome, "The Home icon sits at the same inset whether or not Home is selected",
    `${whileSession} vs ${whileHome}`);
  check(whileSession >= 6, "…and not jammed against the panel's edge", String(whileSession));
  // The rule that broke it also owned the active label's colour.
  const labelColour = await page.evaluate(() => {
    const row = document.querySelector(".rail-row-home");
    const icon = getComputedStyle(row.querySelector(".rail-row-icon")).color;
    return { label: getComputedStyle(row.querySelector(".rail-row-label")).color, icon };
  });
  check(labelColour.label === labelColour.icon, "The selected row's label and icon share the accent colour",
    JSON.stringify(labelColour));

  // ---------- 3. closing keeps the session in the panel ----------
  await newSession(page, "Base64");
  await page.waitForSelector(ROW("Base64"));
  await page.fill(".session-body:not([hidden]) textarea", "still here after closing");
  // A third session, so there is an open-but-not-active row to compare the
  // dimmed closed one against -- the active row has its own colour.
  await newSession(page, "Diff");
  await page.waitForSelector(ROW("Diff"));
  await page.waitForTimeout(2200);

  check((await page.locator(".rail-heading:text-is('Recently closed')").count()) === 0,
    "There is no separate Recently closed list");

  await page.click(`${TAB("Base64")} .session-tab-close`);
  await page.waitForTimeout(600);
  check((await page.locator(TAB("Base64")).count()) === 0, "Closing takes the tab off the strip");
  check((await page.locator(CLOSED("Base64")).count()) === 1, "…but the session stays in the panel, dimmed");
  const dim = await page.evaluate(() => {
    const closed = getComputedStyle(document.querySelector(".rail-row-closed .rail-row-label")).color;
    const open = getComputedStyle(document.querySelector(
      ".rail-row:not(.rail-row-type):not(.rail-row-closed):not(.rail-row-home):not(.active) .rail-row-label")).color;
    return { closed, open };
  });
  check(dim.closed !== dim.open, "…which is how you tell it from one that is open", JSON.stringify(dim));

  // ---------- reopening brings its state back ----------
  await page.click(`${CLOSED("Base64")} .rail-row-label`);
  await page.waitForTimeout(1200);
  check((await page.locator(TAB("Base64")).count()) === 1, "Clicking it puts it back on the strip");
  const text = await page.locator(".session-body:not([hidden]) textarea").first().inputValue();
  check(text === "still here after closing", "…with the state it had, fetched on demand", text);
  check((await page.locator(CLOSED("Base64")).count()) === 0, "…and it is no longer dimmed");

  // ---------- the closed listing carries no rows ----------
  await page.click(`${TAB("Base64")} .session-tab-close`);
  // Longer than the sync debounce: closing is queued behind any flush already
  // running, so give that chain time to drain before reading the server.
  await page.waitForTimeout(2200);
  const listing = await page.evaluate(async () =>
    await (await fetch("/api/live-sessions/closed", { credentials: "same-origin" })).json());
  check(listing.length === 1 && listing[0].title === "Base64", "The closed listing has the session",
    JSON.stringify(listing));
  check(!("state" in listing[0]), "…without its rows, so a long list costs nothing to load",
    JSON.stringify(Object.keys(listing[0])));

  // ---------- only Delete removes it ----------
  const confirmOnce = (d) => d.accept();
  page.on("dialog", confirmOnce);
  await page.click(`${CLOSED("Base64")} .rail-row-forget`);
  await page.waitForTimeout(600);
  check((await page.locator(CLOSED("Base64")).count()) === 0, "Delete takes it out of the panel for good");
  const after = await page.evaluate(async () =>
    await (await fetch("/api/live-sessions/closed", { credentials: "same-origin" })).json());
  check(after.length === 0, "…and off the server", JSON.stringify(after));

  // ---------- 4. templates live under Add ----------
  page.off("dialog", confirmOnce);
  page.once("dialog", (d) => d.accept(TPL));
  await page.click(`${ROW("CloudWatch")} .rail-row-more`);
  await page.click('.rail-row-menu button:text-is("Save as template…")');
  await page.waitForTimeout(1000);

  const headings = await page.locator(".rail-heading").allTextContents();
  check(headings.filter((h) => h === "Templates").length === 1, "Templates appear once in the panel",
    JSON.stringify(headings));
  check(headings.indexOf("Templates") > headings.indexOf("Tools"),
    "…inside the Add catalogue, after the session types", JSON.stringify(headings));
  const templateRow = `.rail-row-template:has(.rail-row-label:text-is("${TPL}"))`;
  check((await page.locator(templateRow).count()) === 1, "The template just saved is there");
  check((await page.locator(`${templateRow}.rail-row-type`).count()) === 1,
    "…as one of the things Add opens, not a session you have");

  // Folding Add away takes the templates with it -- they are part of it now.
  await page.click(".rail-add");
  await page.waitForTimeout(250);
  check((await page.locator(templateRow).count()) === 0, "Folding Add hides the templates with everything else");
  check((await page.locator(ROW("CloudWatch")).count()) === 1, "…and leaves your sessions alone");
  await page.click(".rail-add");
  await page.waitForTimeout(250);

  // Opening one starts a new session, exactly like any other Add entry.
  const before = (await page.locator(`${OPEN} .rail-row-label`).allTextContents()).length;
  await page.click(templateRow);
  await page.waitForTimeout(500);
  check((await page.locator(`${OPEN} .rail-row-label`).allTextContents()).length === before + 1,
    "Choosing a template opens a new session");
  check((await page.locator(TAB(TPL)).count()) === 1, "…on the strip, like anything else from Add");

  // ---------- and the strip's + offers them too ----------
  await page.click(".session-bar-add");
  await page.waitForSelector(".session-add-menu");
  const menuHeadings = await page.locator(".session-add-heading").allTextContents();
  check(JSON.stringify(menuHeadings) === JSON.stringify(["Services", "Tools", "Templates"]),
    "The strip's ＋ offers templates last, after the one-click services and tools", JSON.stringify(menuHeadings));
  check((await page.locator(`.session-add-template:has-text("${TPL}")`).count()) === 1,
    "…including the one just saved");
  await page.keyboard.press("Escape");

  // Templates outlive the run, so this one cleans up after itself.
  await page.evaluate(async (name) => {
    for (const page of ["logs", "iot", "aggregator", "tables", "buckets", "cognito", "logs-opensearch"]) {
      for (const t of await (await fetch(`/api/saved-sessions?page=${page}`, { credentials: "same-origin" })).json()) {
        if (t.name === name) await fetch(`/api/saved-sessions/${t.id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
  }, TPL);

  await page.screenshot({ path: `${SHOT}/31-final.png` });
  await browser.close();
  report();
})();
