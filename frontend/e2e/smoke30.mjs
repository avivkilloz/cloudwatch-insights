// The session strip above the body, the rail's home icon, and the spacing that
// lines the strip up with the cards under it.
import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
/** Add holds the way to the new-session card, the one-click services and
 * tools, and templates. */
const NEW_SESSION = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
const OPEN = ".rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed)";
const ROW = (l) => `${OPEN}:has(.rail-row-label:text-is("${l}"))`;
const TAB = (l) => `.session-tab:has(.session-tab-label:text-is("${l}"))`;

(async () => {
  const browser = await launch();
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
    for (const url of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(url, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    await new Promise((r) => { const q = indexedDB.deleteDatabase("cloud-insights-sessions"); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  });
  await page.reload();
  await page.waitForSelector(".rail");

  // ---------- 1. the gap under the header is the gap between cards ----------
  await newSession(page, "CloudWatch");
  await page.waitForSelector(ROW("CloudWatch"));
  const geo = await page.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); return e && e.getBoundingClientRect(); };
    const header = box(".topbar"), bar = box(".session-bar"), rail = box(".rail");
    // Skipping the session's own Panes card: it and the pane's first card are
    // separated by the tab row as well as by the gap, so the pair to measure is
    // two of the pane's own cards.
    const panels = [...document.querySelectorAll(".session-body:not([hidden]) .panel")]
      .slice(1)
      .map((e) => e.getBoundingClientRect());
    return {
      headerToBar: Math.round(bar.top - header.bottom),
      headerToRail: Math.round(rail.top - header.bottom),
      panelGap: panels[1] ? Math.round(panels[1].top - panels[0].bottom) : null,
      barLeft: Math.round(bar.left), barRight: Math.round(bar.right),
      panelLeft: Math.round(panels[0].left), panelRight: Math.round(panels[0].right),
    };
  });
  check(geo.headerToBar === geo.panelGap, "The gap under the top header is the gap between two cards", JSON.stringify(geo));
  check(geo.headerToRail === geo.panelGap, "…and the side panel starts at the same distance", JSON.stringify(geo));
  check(geo.barLeft === geo.panelLeft && geo.barRight === geo.panelRight,
    "The strip is exactly as wide as the cards below it", JSON.stringify(geo));

  // ---------- 2. Home carries an icon ----------
  check((await page.locator(".rail-row-home .rail-row-icon").count()) === 1, "Home has an icon in the side panel");
  const iconGeo = await page.evaluate(() => {
    const row = document.querySelector(".rail-row-home");
    const icon = row.querySelector(".rail-row-icon").getBoundingClientRect();
    const label = row.querySelector(".rail-row-label").getBoundingClientRect();
    const other = document.querySelector('.rail-row-type').getBoundingClientRect();
    return { iconRight: icon.right, labelLeft: label.left, homeH: Math.round(row.getBoundingClientRect().height), otherH: Math.round(other.height) };
  });
  check(iconGeo.iconRight <= iconGeo.labelLeft, "…to the left of the word, in the same button", JSON.stringify(iconGeo));
  check(iconGeo.homeH === iconGeo.otherH, "…without making the row a different height", JSON.stringify(iconGeo));

  // ---------- 3. the strip: toggle, tabs, + ----------
  check((await page.locator(".session-bar").count()) === 1, "There is a session strip above the body");
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector(".session-bar").children];
    return kids.map((e) => e.className.split(" ")[0]);
  });
  check(order[0] === "session-bar-rail", "Its first button toggles the side panel", JSON.stringify(order));
  // The ⋮ for the session on screen comes after it, when there is one.
  check(order.includes("session-bar-add"), "…and it has a ＋ that adds a session", JSON.stringify(order));
  check(order[order.length - 1] === "session-bar-more", "…with the current session's ⋮ at the very end",
    JSON.stringify(order));

  check((await page.locator(".rail").count()) === 1, "The side panel is showing");
  await page.click(".session-bar-rail");
  await page.waitForTimeout(250);
  check((await page.locator(".rail").count()) === 0, "…the strip's first button hides it");
  await page.click(".session-bar-rail");
  await page.waitForTimeout(250);
  check((await page.locator(".rail").count()) === 1, "…and shows it again");

  // The strip stays put in the body's column, beside the rail rather than over it.
  const beside = await page.evaluate(() => {
    const bar = document.querySelector(".session-bar").getBoundingClientRect();
    const rail = document.querySelector(".rail").getBoundingClientRect();
    return { barLeft: Math.round(bar.left), railRight: Math.round(rail.right), sameTop: Math.abs(bar.top - rail.top) < 2 };
  });
  check(beside.barLeft >= beside.railRight, "The strip sits next to the side panel, not across it", JSON.stringify(beside));
  check(beside.sameTop, "…and starts level with it", JSON.stringify(beside));

  // ---------- the + opens the same catalogue ----------
  await page.click(".session-bar-add");
  await page.waitForSelector(".session-add-menu");
  const offered = await page.locator(".session-add-item").allTextContents();
  check(offered[0] === "Start new session…", "The ＋ offers the way to start one", JSON.stringify(offered.slice(0, 2)));
  // Then the same shortcuts the panel's Add list holds, and your templates.
  const groups = await page.locator(".session-add-heading").allTextContents();
  check(groups[0] === "Services" && groups[1] === "Tools" && groups.slice(2).every((g) => g === "Templates"),
    "…then services, tools and templates", JSON.stringify(groups));
  const portalled = await page.evaluate(() =>
    document.querySelector(".session-add-menu").parentElement === document.body);
  check(portalled, "…as a menu portalled out of the scrolling strip");
  await page.click('.session-add-item:text-is("Start new session…")');
  await page.waitForTimeout(300);
  check((await page.locator(".home-create").count()) === 1, "…and it takes you to the card that makes one");
  check((await page.locator(".session-add-menu").count()) === 0, "…closing the menu behind it");
  await newSession(page, "JWT");

  // ---------- closing lives on the tab, not in the panel ----------
  check((await page.locator(`${TAB("JWT")} .session-tab-close`).count()) === 1, "Each tab has its own ✕");
  await page.click(`${TAB("JWT")} .session-tab-close`);
  await page.waitForTimeout(400);
  check((await page.locator(TAB("JWT")).count()) === 0, "…which closes that session");
  check((await page.locator('.rail-row-closed .rail-row-label:text-is("JWT")').count()) === 1,
    "…into Recently closed, same as before");

  // ---------- the ⋮ is now rename / template / delete ----------
  await page.click(`${ROW("CloudWatch")} .rail-row-more`);
  await page.waitForSelector(".rail-row-menu");
  const items = await page.locator(".rail-row-menu button").allTextContents();
  check(JSON.stringify(items) === JSON.stringify(["Rename", "Save as template…", "Delete"]),
    "The ⋮ offers rename, save as template and delete", JSON.stringify(items));
  check(!items.includes("Close"), "…and no longer Close, which moved to the tab");

  // ---------- rename happens in the row ----------
  await page.click('.rail-row-menu button:text-is("Rename")');
  await page.waitForSelector(".rail-row-rename");
  check((await page.locator(".rail-row-rename").count()) === 1, "Rename edits the name in place");
  await page.fill(".rail-row-rename", "Renamed in place");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check((await page.locator(ROW("Renamed in place")).count()) === 1, "…committing on Enter");
  check((await page.locator(TAB("Renamed in place")).count()) === 1, "…and the tab follows the new name");

  await page.dblclick(`${ROW("Renamed in place")} .rail-row-label`);
  await page.waitForSelector(".rail-row-rename");
  await page.fill(".rail-row-rename", "Discarded");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator(ROW("Renamed in place")).count()) === 1, "Double-click renames too, and Escape keeps the old name");
  check((await page.locator(ROW("Discarded")).count()) === 0, "…without writing the typed one");

  // It reached the server like any other change.
  await page.waitForTimeout(2000);
  const titles = await page.evaluate(async () =>
    (await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json()).map((s) => s.title));
  check(titles.includes("Renamed in place"), "A rename from the panel autosaves", JSON.stringify(titles));

  // ---------- the brand goes home ----------
  await page.click(`${ROW("Renamed in place")} .rail-row-label`);
  await page.waitForTimeout(200);
  check((await page.locator(".rail-row-home.active").count()) === 0, "Not on Home to start with");
  await page.click(".brand");
  await page.waitForTimeout(250);
  check((await page.locator(".rail-row-home.active").count()) === 1, "Clicking the title goes home");
  check((await page.locator(".rail").count()) === 1, "…and leaves the side panel alone, which is the strip's job now");

  await page.screenshot({ path: `${SHOT}/30-final.png` });
  await browser.close();
  report();
})();
