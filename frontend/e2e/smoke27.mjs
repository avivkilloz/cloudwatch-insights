import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
const V = ".session-body:not([hidden])";
const TYPE = (l) => `.rail-row-type:has(.rail-row-label:text-is("${l}"))`;
const ROW = (l) => `.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed):has(.rail-row-label:text-is("${l}"))`;

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
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

  await page.waitForSelector(".rail", { timeout: 15000 });

  // ---------- the strip is back, but only as tabs ----------
  // It was removed when the rail arrived and reinstated deliberately: the rail
  // is the whole workspace, the strip is what is in front of you, and closing
  // a session belongs on its tab.
  check((await page.locator(".session-bar").count()) === 1, "The session strip sits above the body");

  // ---------- the rail is a vertical card in the page background ----------
  // body carries a 0.15s background transition for theme switching, so reading
  // it too early gets a half-interpolated rgba() that matches nothing.
  await page.waitForTimeout(300);
  const rail = await page.evaluate(() => {
    const el = document.querySelector(".rail");
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      bg: cs.backgroundColor, border: cs.borderLeftWidth, radius: cs.borderTopLeftRadius,
      body: getComputedStyle(document.body).backgroundColor,
      panel: getComputedStyle(document.querySelector(".panel")).backgroundColor,
      left: Math.round(r.left), width: Math.round(r.width), tall: r.height > r.width,
    };
  });
  check(rail.bg === rail.body && rail.bg !== rail.panel, "The rail is filled with the page background, not the card colour", JSON.stringify(rail));
  check(rail.border !== "0px" && parseFloat(rail.radius) > 0, "…and is shaped like a card");
  check(rail.tall && rail.left < 40, "…standing vertically on the left", JSON.stringify(rail));

  // ---------- Home at the top ----------
  const firstRow = await page.locator(".rail-row").first().textContent();
  check(firstRow.trim() === "Home", "Home is the first entry", firstRow);
  // Against the heading element, not the rail's text: "Open" also matched
  // "OpenSearch" in the catalogue, which made this pass for the wrong reason.
  const headingBox = await page.locator('.rail-heading:text-is("Sessions")').boundingBox();
  const homeBox = await page.locator(".rail-row").first().boundingBox();
  check(homeBox.y < headingBox.y, "…above the open-sessions list");

  // ---------- what Add holds ----------
  // The way to the home page's card, then every service and tool as a
  // one-click session, then whatever templates you have. "Platform" is not
  // among them: those are pages rather than panes.
  const headings = await page.locator(".rail-heading").allTextContents();
  check(headings.includes("Services") && headings.includes("Tools") && !headings.includes("Platform"),
    "The catalogue offers services and tools, but not the platform's pages", JSON.stringify(headings));
  check((await page.locator('.rail-row-new:has(.rail-row-label:text-is("Start new session…"))').count()) === 1,
    "Add offers the way to start one");

  // ---------- making one from the home page ----------
  await newSession(page, "CloudWatch");
  await page.waitForSelector(".page-info-title", { timeout: 10000 });
  check((await page.locator(".page-info-title").textContent()) === "CloudWatch",
    "A session named after its one pane opens");
  check((await page.locator(ROW("CloudWatch")).count()) === 1, "…and it is listed under Sessions");

  await newSession(page, "IoT");
  await page.waitForTimeout(300);
  await newSession(page, "JWT");
  await page.waitForTimeout(300);
  // Home is a .rail-row too, so it has to come out of the open-sessions list.
  const openRows = (await page.locator('.rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed) .rail-row-label').allTextContents())
    .filter((t) => t !== "Home");
  check(JSON.stringify(openRows) === JSON.stringify(["CloudWatch", "IoT", "JWT"]),
    "Open sessions list in the order they were opened", JSON.stringify(openRows));

  // ---------- switching between them ----------
  await page.click(`${ROW("IoT")} .rail-row-label`);
  await page.waitForTimeout(300);
  check((await page.locator(".page-info-title").textContent()) === "IoT", "Clicking an open session switches to it");
  check((await page.locator(".rail-row.active .rail-row-label").textContent()) === "IoT", "…and the rail marks it active");

  // ---------- Home row ----------
  await page.click(ROW("Home"));
  await page.waitForSelector(".home-cards", { timeout: 5000 });
  check(true, "Home shows the home page");
  check((await page.locator(".rail-row.active .rail-row-label").count()) === 0 ||
        (await page.locator(".rail-row.active").first().textContent()).trim() === "Home",
    "…and Home is the active row");
  check((await page.locator(ROW("IoT")).count()) === 1, "Going home does not close the open sessions");

  // ---------- the ⋮ menu ----------
  await page.click(`${ROW("JWT")} .rail-row-more`);
  await page.waitForSelector(".rail-row-menu");
  const items = await page.locator(".rail-row-menu button").allTextContents();
  // Closing moved to the ✕ on the tab; the ⋮ is what you do to the session.
  check(items.includes("Rename") && items.includes("Delete") && !items.includes("Close"),
    "The ⋮ menu offers what you do to a session, not to a tab", JSON.stringify(items));
  await page.keyboard.press("Escape");
  await page.click('.session-tab:has(.session-tab-label:text-is("JWT")) .session-tab-close');
  await page.waitForTimeout(300);
  check((await page.locator(ROW("JWT")).count()) === 0, "Close removes the session");
  check((await page.locator(ROW("CloudWatch")).count()) === 1, "…and leaves the others alone");

  // A saveable session offers the template option; a tool without a saved page does not.
  await page.click(`${ROW("CloudWatch")} .rail-row-more`);
  await page.waitForSelector(".rail-row-menu");
  check((await page.locator('.rail-row-menu button:text-is("Save as template…")').count()) === 1,
    "A saveable session offers Save as template");
  await page.keyboard.press("Escape");
  await newSession(page, "Base64");
  await page.waitForTimeout(300);
  await page.click(`${ROW("Base64")} .rail-row-more`);
  await page.waitForSelector(".rail-row-menu");
  // Every session is an Aggregator, so there is one thing to save and one key
  // it goes under -- this no longer depends on the session's type.
  check((await page.locator('.rail-row-menu button:text-is("Save as template…")').count()) === 1,
    "Any session can be saved as a template");
  await page.keyboard.press("Escape");

  // ---------- + Add folds the catalogue ----------
  const NEW = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
  check((await page.locator(NEW).count()) === 1, "The catalogue starts open");
  await page.click(".rail-add");
  await page.waitForTimeout(250);
  check((await page.locator(NEW).count()) === 0, "+ Add folds the catalogue away");
  check((await page.locator(ROW("CloudWatch")).count()) === 1, "…leaving the open sessions listed");
  await page.click(".rail-add");
  await page.waitForTimeout(250);
  check((await page.locator(NEW).count()) === 1, "…and unfolds it again");

  // ---------- the strip's panel button collapses the rail ----------
  // The brand used to do this; it goes home now that the strip has a button
  // of its own for the panel.
  await page.click(".session-bar-rail");
  await page.waitForTimeout(300);
  check((await page.locator(".rail").count()) === 0, "The strip's panel button hides the rail entirely");
  const contentLeft = await page.evaluate(() => Math.round(document.querySelector(".content").getBoundingClientRect().left));
  check(contentLeft < 40, "…and the page takes the width back", `content left=${contentLeft}`);
  await page.screenshot({ path: `${SHOT}/31-collapsed.png` });
  await page.click(".session-bar-rail");
  await page.waitForSelector(".rail");
  check(true, "Clicking it again brings the rail back");

  // ---------- and the choice survives a reload ----------
  await page.click(".session-bar-rail");
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector(".content", { timeout: 15000 });
  await page.waitForTimeout(600);
  check((await page.locator(".rail").count()) === 0, "The collapsed rail stays collapsed across a reload");
  await page.click(".session-bar-rail");
  await page.waitForSelector(".rail");
  check((await page.locator(ROW("CloudWatch")).count()) === 1, "Sessions survive the reload", "");

  await page.screenshot({ path: `${SHOT}/31-rail.png` });
  await browser.close();
  report();
  process.exit(fail ? 1 : 0);
})();
