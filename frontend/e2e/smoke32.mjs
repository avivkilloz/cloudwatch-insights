// The strip's ⋮ for the session on screen, and the page's title/description as
// a card under the side panel rather than above the body's first card.
import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
/** Add holds the way to the new-session card, the one-click services and
 * tools, and templates. */
const NEW_SESSION = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
const OPEN = ".rail-row:not(.rail-row-type):not(.rail-row-closed):not(.rail-row-home)";
const ROW = (l) => `${OPEN}:has(.rail-row-label:text-is("${l}"))`;
const TAB = (l) => `.session-tab:has(.session-tab-label:text-is("${l}"))`;

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
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

  // ---------- 2. the page's title moved out of the body ----------
  check((await page.locator(".page-intro").count()) === 0, "The title no longer sits above the body's first card");
  check((await page.locator(".page-info").count()) === 1, "It is a card of its own");

  const placed = await page.evaluate(() => {
    const info = document.querySelector(".page-info").getBoundingClientRect();
    const rail = document.querySelector(".rail").getBoundingClientRect();
    const panel = document.querySelector(".content .panel").getBoundingClientRect();
    return {
      below: info.top >= rail.bottom - 1,
      sameLeft: Math.round(info.left) === Math.round(rail.left),
      sameWidth: Math.round(info.width) === Math.round(rail.width),
      leftOfBody: info.right <= panel.left,
      onScreen: info.bottom <= window.innerHeight,
    };
  });
  check(placed.below, "…under the side panel", JSON.stringify(placed));
  check(placed.sameLeft && placed.sameWidth, "…lined up with it and the same width", JSON.stringify(placed));
  check(placed.leftOfBody, "…beside the body rather than above it", JSON.stringify(placed));
  check(placed.onScreen, "…and inside the window", JSON.stringify(placed));

  // It says what Home is, which no per-session control could have.
  check((await page.locator(".page-info-title").textContent()) === "Home", "On Home it says Home");
  check(((await page.locator(".page-info-help").textContent()) || "").length > 20, "…with a description");

  // ---------- it follows what is on screen ----------
  await newSession(page, "IoT");
  await page.waitForSelector(ROW("IoT"));
  check((await page.locator(".page-info-title").textContent()) === "IoT", "Opening a session retitles the card");
  // A session's description says what is in it -- its name is its own, and
  // there is no single type to draw a description from any more.
  const iotHelp = await page.locator(".page-info-help").textContent();
  check(iotHelp.includes("IoT"), "…and says which panes it holds", iotHelp.slice(0, 60));

  await newSession(page, "Base64");
  await page.waitForSelector(ROW("Base64"));
  check((await page.locator(".page-info-title").textContent()) === "Base64", "Switching sessions retitles it again");
  await page.click(`${TAB("IoT")} .session-tab-label`);
  await page.waitForTimeout(250);
  check((await page.locator(".page-info-title").textContent()) === "IoT", "…and it follows a click on a tab");

  // Settings has no session, and still gets one.
  await page.click(".user-menu-trigger");
  await page.click('.icon-popover-item:text-is("Settings")');
  await page.waitForTimeout(400);
  check((await page.locator(".page-info-title").textContent()) === "Settings", "Settings has one too");

  // ---------- it shows and hides with the panel ----------
  await page.click(".session-bar-rail");
  await page.waitForTimeout(250);
  check((await page.locator(".page-info").count()) === 0, "Hiding the side panel takes the card with it");
  check((await page.locator(".rail").count()) === 0, "…which is what hiding the panel means");
  await page.click(".session-bar-rail");
  await page.waitForSelector(".page-info");
  check(true, "…and showing it brings both back");

  // ---------- 1. the strip's ⋮ ----------
  await page.click(`${TAB("IoT")} .session-tab-label`);
  await page.waitForTimeout(250);
  check((await page.locator(".session-bar-more").count()) === 1, "The strip has a ⋮ at the end");
  const atEnd = await page.evaluate(() => {
    const bar = document.querySelector(".session-bar").getBoundingClientRect();
    const more = document.querySelector(".session-bar-more").getBoundingClientRect();
    const add = document.querySelector(".session-bar-add").getBoundingClientRect();
    return { rightmost: bar.right - more.right < 12, afterAdd: more.left > add.right };
  });
  check(atEnd.rightmost && atEnd.afterAdd, "…on the right, past the ＋", JSON.stringify(atEnd));

  await page.click(".session-bar-more");
  await page.waitForSelector(".rail-row-menu");
  const items = await page.locator(".rail-row-menu button").allTextContents();
  check(JSON.stringify(items) === JSON.stringify(["Rename", "Save as template…", "Delete"]),
    "…offering the same three as the panel's ⋮", JSON.stringify(items));
  await page.keyboard.press("Escape");
  check((await page.locator(".rail-row-menu").count()) === 0, "…and Escape closes it");

  // It acts on the session showing, not on the first tab.
  await page.click(`${TAB("Base64")} .session-tab-label`);
  await page.waitForTimeout(250);
  await page.click(".session-bar-more");
  await page.waitForSelector(".rail-row-menu");
  const label = await page.locator(".session-bar-more").getAttribute("aria-label");
  check(label === "More for Base64", "It acts on the session in display, not the first tab", label);

  // ---------- rename from it, in place on the tab ----------
  await page.click('.rail-row-menu button:text-is("Rename")');
  await page.waitForSelector(".session-tab-rename");
  check((await page.locator(".session-tab-rename").count()) === 1, "Rename turns the tab into a field");
  await page.fill(".session-tab-rename", "Renamed from the strip");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check((await page.locator(TAB("Renamed from the strip")).count()) === 1, "…committing on Enter");
  check((await page.locator(ROW("Renamed from the strip")).count()) === 1, "…and the panel follows the new name");

  await page.click(".session-bar-more");
  await page.click('.rail-row-menu button:text-is("Rename")');
  await page.waitForSelector(".session-tab-rename");
  await page.fill(".session-tab-rename", "Discarded");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator(TAB("Renamed from the strip")).count()) === 1, "Escape keeps the old name");
  check((await page.locator(TAB("Discarded")).count()) === 0, "…without writing the typed one");

  // ---------- there is nothing to act on with no session showing ----------
  await page.click(".rail-row-home");
  await page.waitForTimeout(250);
  check((await page.locator(".session-bar-more").count()) === 0, "On Home the ⋮ is gone: there is no session on screen");
  check((await page.locator(".session-bar-add").count()) === 1, "…while ＋ stays, since you can always open one");

  // ---------- delete from it ----------
  await page.click(`${TAB("Renamed from the strip")} .session-tab-label`);
  await page.waitForTimeout(250);
  page.on("dialog", (d) => d.accept());
  await page.click(".session-bar-more");
  await page.click('.rail-row-menu button:text-is("Delete")');
  await page.waitForTimeout(800);
  check((await page.locator(TAB("Renamed from the strip")).count()) === 0, "Delete from the strip closes the tab");
  check((await page.locator(ROW("Renamed from the strip")).count()) === 0, "…and takes it out of the panel");
  const left = await page.evaluate(async () =>
    (await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json()).map((s) => s.title));
  check(!left.includes("Renamed from the strip"), "…and off the server", JSON.stringify(left));

  await page.screenshot({ path: `${SHOT}/32-final.png` });
  await browser.close();
  report();
})();
