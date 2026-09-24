import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
const V = ".session-body:not([hidden])";

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
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

  // ---------- item 4: home fills the width ----------
  const homeW = await page.evaluate(() => {
    const home = document.querySelector(".session-body:not([hidden]) .home") || document.querySelector(".home");
    const content = document.querySelector(".content");
    const cs = getComputedStyle(home);
    // Each side separately: .content pads only its right (the gap between the
    // cards and its scrollbar), not both.
    const pad = getComputedStyle(content);
    return { maxWidth: cs.maxWidth, home: home.getBoundingClientRect().width,
             avail: content.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) };
  });
  check(homeW.maxWidth === "none" && Math.abs(homeW.home - homeW.avail) < 2,
    "Home fills the content width like every other page", JSON.stringify(homeW));

  await page.screenshot({ path: `${SHOT}/24-home-fullwidth.png` });

  // Open Logs + a tool so the strip has tabs of differing case/length.
  await newSession(page, "CloudWatch");
  await page.waitForSelector(`${V} h2:text-is("3. Query")`, { timeout: 10000 });
  await newSession(page, "JWT");
  await page.waitForSelector(".rail-row", { timeout: 5000 });
  await newSession(page, "HTTP client");
  await page.waitForTimeout(300);
  // Back to Logs: it is a session type that can be saved, so the Save button
  // is in the strip to be measured alongside the tabs.
  await page.click('.rail-row-label:text-is("CloudWatch")');
  await page.waitForSelector(`${V} h2:text-is("3. Query")`, { timeout: 10000 });

  // ---------- item 2: one height for every row ----------
  // The strip's tabs/+/Save-session trio is gone. Its point -- that the
  // controls line up rather than each taking its own text metrics -- now
  // applies to the rail's rows.
  const heights = await page.evaluate(() => {
    const h = (el) => Math.round(el.getBoundingClientRect().height * 100) / 100;
    return {
      rows: [...document.querySelectorAll(".rail-row")].map((e) => [e.textContent.replace("⋮", "").trim(), h(e)]),
    };
  });
  const rowHeights = new Set(heights.rows.map((r) => r[1]));
  check(rowHeights.size === 1, "Every row in the rail is the same height", JSON.stringify([...rowHeights]));
  check(heights.rows.length > 3, "…across sessions and the catalogue alike", String(heights.rows.length));

  await page.screenshot({ path: `${SHOT}/24-rail.png`, clip: { x: 0, y: 40, width: 420, height: 420 } });

  // ---------- item 3: the rail sits clear of the page ----------
  const gap = await page.evaluate(() => {
    const rail = document.querySelector(".rail").getBoundingClientRect();
    const content = document.querySelector(".content").getBoundingClientRect();
    return Math.round(content.left - rail.right);
  });
  check(gap >= 4, "There is real separation between the rail and the body", `gap=${gap}px`);

  // ---------- item 1: no native drag starts from page chrome ----------
  await page.evaluate(() => {
    window.__drags = 0;
    document.addEventListener("dragstart", () => window.__drags++, true);
  });
  const chrome = [
    ["a panel heading", `${V} .panel:has(h2:text-is("3. Query")) h2`],
    ["a session tab", `.rail-row-label`],
  ];
  for (const [name, sel] of chrome) {
    const b = await page.locator(sel).first().boundingBox();
    await page.mouse.move(b.x + 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width / 2 + i * 30, b.y + b.height / 2 + i * 18, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    check((await page.evaluate(() => window.__drags)) === 0, `Dragging ${name} starts no native browser drag`);
    await page.evaluate(() => { window.__drags = 0; });
  }

  // Page still responds after all that dragging. Probed on an IoT session:
  // its Things/Certificates buttons toggle a class on a real click, which the
  // CloudWatch page no longer has anywhere now that the Backend switch is gone.
  await newSession(page, "IoT");
  await page.waitForSelector(`${V} h2:text-is("2. Search")`, { timeout: 10000 });
  const sel = `${V} .panel:has(h2:text-is("2. Search")) button:text-is("Certificates")`;
  const before = await page.locator(sel).getAttribute("class");
  await page.locator(sel).click({ timeout: 3000 });
  check(before !== (await page.locator(sel).getAttribute("class")),
    "The page is still clickable after dragging chrome");
  await page.locator(sel).nth(0).click();

  // ---------- results text is still selectable ----------
  const selectable = await page.evaluate(() => {
    const el = document.querySelector(".session-body:not([hidden]) input[type='text'], .session-body:not([hidden]) textarea");
    return el ? getComputedStyle(el).userSelect : "none";
  });
  check(selectable !== "none", "Inputs are still selectable (chrome-only rule)", selectable);

  // ---------- session reordering still works, by pointer ----------
  // The rail is a column, so the drag is vertical; only the Open rows move,
  // so Home, the templates and the catalogue are excluded from the comparison.
  const OPEN = ".rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed)";
  const openTitles = async () =>
    (await page.locator(`${OPEN} .rail-row-label`).allTextContents()).filter((t) => t !== "Home");
  const titlesBefore = await openTitles();
  check(titlesBefore.length >= 3, "Three sessions are open to reorder", JSON.stringify(titlesBefore));
  const rows = page.locator(`${OPEN}:not(:has(.rail-row-label:text-is("Home")))`);
  // The rail scrolls: clicking a catalogue row near its bottom focus-scrolls
  // it into view, which leaves the open-sessions list above the fold. Bring
  // the rows back before measuring -- page.mouse does not scroll for you.
  await rows.nth(0).scrollIntoViewIfNeeded();
  await rows.nth(2).scrollIntoViewIfNeeded();
  await rows.nth(0).scrollIntoViewIfNeeded();
  const t0 = await rows.nth(0).boundingBox();
  const t2 = await rows.nth(2).boundingBox();
  await page.mouse.move(t0.x + t0.width / 2, t0.y + t0.height / 2);
  await page.mouse.down();
  await page.mouse.move(t2.x + t2.width / 2, t2.y + t2.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const titlesAfter = await openTitles();
  check(JSON.stringify(titlesBefore) !== JSON.stringify(titlesAfter),
    "Sessions still reorder by dragging (now vertical, pointer-driven)",
    `${JSON.stringify(titlesBefore)} -> ${JSON.stringify(titlesAfter)}`);
  check(titlesAfter.length === titlesBefore.length, "Reordering loses no sessions");

  // A plain click still activates (the drag threshold isn't swallowing clicks).
  // Addressed by name rather than index: Home shares the row class.
  await page.click(`${OPEN} .rail-row-label:text-is("${titlesAfter[1]}")`);
  await page.waitForTimeout(250);
  check((await page.locator(".rail-row.active .rail-row-label").textContent()) === titlesAfter[1],
    "A plain click on a session still activates it");

  await page.screenshot({ path: `${SHOT}/24-final.png` });
  await browser.close();
  report();
  process.exit(fail ? 1 : 0);
})();
