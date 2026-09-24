import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
/** Add holds the way to the new-session card, the one-click services and
 * tools, and templates. */
const NEW_SESSION = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
const ROW = (l) => `.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("${l}"))`;

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
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

  await page.waitForSelector(".rail", { timeout: 15000 });

  // ---------- 3. the catalogue starts folded ----------
  check((await page.locator(".rail-row-type").count()) === 0, "The catalogue starts folded");
  check((await page.locator(".rail-add").count()) === 1, "…with ＋ Add there to open it");
  await page.click(".rail-add");
  await page.waitForSelector(NEW_SESSION);
  check(true, "＋ Add unfolds it");
  // …and the choice sticks.
  await page.reload();
  await page.waitForSelector(".rail", { timeout: 15000 });
  await page.waitForTimeout(400);
  check((await page.locator(NEW_SESSION).count()) === 1, "Unfolding is remembered across a reload");
  await page.click(".rail-add");
  await page.waitForTimeout(200);
  await page.reload();
  await page.waitForSelector(".rail", { timeout: 15000 });
  await page.waitForTimeout(400);
  check((await page.locator(".rail-row-type").count()) === 0, "…and so is folding it again");
  await page.click(".rail-add");
  await page.waitForSelector(NEW_SESSION);

  // ---------- 1. the heading reads Sessions ----------
  const headings = await page.locator(".rail-heading").allTextContents();
  check(headings.includes("Sessions") && !headings.includes("Open"),
    'The open-sessions heading reads "Sessions"', JSON.stringify(headings));

  // ---------- 2. the ⋮ menu escapes the rail ----------
  await newSession(page, "CloudWatch");
  await page.waitForTimeout(400);
  await page.click(`${ROW("CloudWatch")} .rail-row-more`);
  await page.waitForSelector(".rail-row-menu");
  const menu = await page.evaluate(() => {
    const m = document.querySelector(".rail-row-menu");
    const rail = document.querySelector(".rail");
    const mr = m.getBoundingClientRect(), rr = rail.getBoundingClientRect();
    const x = mr.left + mr.width / 2, y = mr.top + 8;
    return {
      parentIsBody: m.parentElement === document.body,
      position: getComputedStyle(m).position,
      widerThanRail: mr.width > rr.width,
      escapesRight: mr.right > rr.right,
      inViewport: mr.right <= window.innerWidth + 1 && mr.bottom <= window.innerHeight + 1,
      onTop: m.contains(document.elementFromPoint(x, y)),
      clippedByRail: mr.right > rr.right && getComputedStyle(rail).overflowY === "auto" && m.closest(".rail") !== null,
    };
  });
  check(menu.parentIsBody, "The ⋮ menu is portalled out of the rail", JSON.stringify(menu));
  check(menu.position === "fixed", "…positioned against the viewport", menu.position);
  check(!menu.clippedByRail, "…so the scrolling rail can no longer clip it");
  check(menu.onTop, "…and it paints above whatever is beneath it");
  check(menu.inViewport, "…while staying inside the window", JSON.stringify(menu));
  await page.screenshot({ path: `${SHOT}/32-menu.png`, clip: { x: 0, y: 40, width: 520, height: 320 } });

  // It still does what it says.
  check((await page.locator('.rail-row-menu button:text-is("Save as template…")').count()) === 1,
    "It still offers Save as template");
  await page.keyboard.press("Escape");
  check((await page.locator(".rail-row-menu").count()) === 0, "…and Escape leaves no menu behind");
  // Closing is the tab's ✕ now, not an item in this menu.
  await page.click('.session-tab:has(.session-tab-label:text-is("CloudWatch")) .session-tab-close');
  await page.waitForTimeout(300);
  check((await page.locator(ROW("CloudWatch")).count()) === 0, "…and the tab's ✕ still closes the session");

  // A narrow rail is exactly the case that was broken: the menu is wider than
  // the rail and simply overhangs it now.
  await newSession(page, "Base64");
  await page.waitForTimeout(300);
  await page.click(`${ROW("Base64")} .rail-row-more`);
  await page.waitForSelector(".rail-row-menu");
  // The portal can re-render right after it mounts; settle before measuring.
  await page.waitForTimeout(250);
  const narrow = await page.evaluate(() => {
    const m = document.querySelector(".rail-row-menu").getBoundingClientRect();
    const r = document.querySelector(".rail").getBoundingClientRect();
    return { menuRight: Math.round(m.right), railRight: Math.round(r.right), menuWidth: Math.round(m.width) };
  });
  check(narrow.menuRight > narrow.railRight - 1, "A menu wider than the rail overhangs it rather than being cut off",
    JSON.stringify(narrow));
  await page.screenshot({ path: `${SHOT}/32-menu-overhang.png`, clip: { x: 0, y: 40, width: 520, height: 320 } });

  await browser.close();
  report();
  process.exit(fail ? 1 : 0);
})();
