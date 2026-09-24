import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";

// How many distinct rows the panes occupy, and whether anything overflows the
// viewport horizontally -- the actual complaint being fixed.
async function layoutInfo(page) {
  return page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll(".aggregator-pane"));
    const tops = new Set(panes.map((p) => Math.round(p.getBoundingClientRect().top)));
    const grid = document.querySelector(".aggregator-columns") || document.querySelector(".aggregator-stack");
    return {
      paneCount: panes.length,
      rows: tops.size,
      widest: Math.max(...panes.map((p) => Math.round(p.getBoundingClientRect().width))),
      narrowest: Math.min(...panes.map((p) => Math.round(p.getBoundingClientRect().width))),
      overflowsRight: panes.some((p) => p.getBoundingClientRect().right > window.innerWidth + 1),
      gridScrollsSideways: grid ? grid.scrollWidth > grid.clientWidth + 1 : false,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

/** Services are sessions now: started from the + in the strip under the
 * header rather than tabs in the header. Any session already open is closed
 * first, so exactly one page is mounted and the unscoped selectors below still
 * address the one on screen -- every open session stays mounted otherwise. */
async function openSession(page, label) {
  // Closing is the ✕ on the tab in the strip above the body.
  while ((await page.locator(".session-tab-close").count()) > 0) {
    await page.locator(".session-tab-close").first().click();
    await page.waitForTimeout(120);
  }
  await newSession(page, label);
}

/** An empty session switched to the side-by-side layout. New sessions default
 * to tabs, which shows one pane at a time -- these suites are about how several
 * panes sit together, which is what side by side is for. */
async function newPanedSession(page) {
  await newSession(page);
  await page.click('.session-body:not([hidden]) button:text-is("Side by side")');
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await launch();
  // A typical laptop screen -- the size the report was about.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("401")) console.log("CONSOLE ERROR:", m.text());
  });

  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: true } }));
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
  await page.fill('input[placeholder="Production us-east-1"]', "Demo Env");
  await page.fill('input[placeholder="111122223333"]', "111122223333");
  await page.click('button:has-text("Add environment")');
  await page.waitForSelector("text=Demo Env");

  await newPanedSession(page);
  await page.waitForSelector("text=Choose one or more services");

  const sessionPanel = '.panel:has(h2:text-is("Panes"))';

  // ---------- Layout naming ----------
  check(
    (await page.locator(`${sessionPanel} button:text-is("Stacked")`).count()) === 1,
    'The second layout is called "Stacked"'
  );
  check(
    (await page.locator(`${sessionPanel} button:has-text("One at a time")`).count()) === 0,
    'The old "One at a time" label is gone'
  );

  // ---------- Side by side with all five services ----------
  for (const label of ["CloudWatch", "IoT", "DynamoDB", "S3", "Cognito"]) {
    await page.click(`${sessionPanel} label.checkbox-item:text-is("${label}") input`);
  }
  await page.waitForSelector(".aggregator-pane >> nth=4");

  let info = await layoutInfo(page);
  check(info.paneCount === 5, "Side by side: all five services open", JSON.stringify(info));
  check(info.rows > 1, "Side by side: five panes wrap onto more than one row", JSON.stringify(info));
  check(!info.overflowsRight, "Side by side: no pane hangs off the right of the viewport", JSON.stringify(info));
  check(!info.gridScrollsSideways, "Side by side: the pane grid no longer scrolls sideways", JSON.stringify(info));
  check(!info.pageScrollsSideways, "Side by side: the page has no horizontal scrollbar", JSON.stringify(info));
  check(info.narrowest >= 400, "Side by side: every pane stays a readable width", JSON.stringify(info));
  await page.screenshot({ path: `${SHOT}/agg-5-wrapped.png` });

  // Three services on this screen. The left rail takes 212px, and a pane's
  // minimum track is 420px, so at 1440 three no longer fit on one row -- they
  // wrap rather than shrink below a readable width, and collapsing the rail
  // from the app title gives the row back. Both halves are checked here so the
  // trade-off is recorded rather than assumed.
  await page.click(`${sessionPanel} label.checkbox-item:text-is("S3") input`);
  await page.click(`${sessionPanel} label.checkbox-item:text-is("Cognito") input`);
  await page.waitForFunction(() => document.querySelectorAll(".aggregator-pane").length === 3);
  info = await layoutInfo(page);
  check(info.rows === 2, "Side by side: with the rail open, three panes wrap onto two rows", JSON.stringify(info));
  check(info.narrowest >= 400 && !info.overflowsRight && !info.pageScrollsSideways,
    "…still readable, with nothing hanging off the right", JSON.stringify(info));

  await page.click(".session-bar-rail");
  await page.waitForTimeout(400);
  info = await layoutInfo(page);
  check(info.rows === 1, "Collapsing the rail puts three panes back on one row", JSON.stringify(info));
  await page.click(".session-bar-rail");
  await page.waitForSelector(".rail");

  // ---------- Minimise / expand ----------
  const iotPane = '.aggregator-pane:has(h3:text-is("IoT"))';
  check(
    (await page.locator(`${iotPane} button:has-text("Focus")`).count()) === 0,
    "The Focus / Show all buttons are gone"
  );

  await page.click(`${iotPane} button[aria-label="Minimise IoT"]`);
  await page.waitForSelector(`${iotPane} button[aria-label="Expand IoT"]`);
  check(
    !(await page.locator(`${iotPane} .aggregator-pane-body`).isVisible()),
    "Minimising a pane hides its body"
  );
  check(
    await page.locator('.aggregator-pane:has(h3:text-is("DynamoDB")) .aggregator-pane-body').isVisible(),
    "Minimising one pane leaves the others expanded (not a focus mode)"
  );

  // Minimise a second one -- they're independent, not mutually exclusive.
  await page.click('.aggregator-pane:has(h3:text-is("DynamoDB")) button[aria-label="Minimise DynamoDB"]');
  await page.waitForSelector('.aggregator-pane:has(h3:text-is("DynamoDB")) button[aria-label="Expand DynamoDB"]');
  check(
    (await page.locator('.aggregator-pane button[aria-label^="Expand"]').count()) === 2,
    "Two panes can be minimised at once"
  );

  await page.click(`${iotPane} button[aria-label="Expand IoT"]`);
  await page.waitForSelector(`${iotPane} button[aria-label="Minimise IoT"]`);
  check(
    await page.locator(`${iotPane} .aggregator-pane-body`).isVisible(),
    "Expanding restores the pane's body"
  );

  // ---------- Minimise survives a layout switch, and works in Stacked too ----------
  await page.click(`${sessionPanel} button:text-is("Stacked")`);
  await page.waitForSelector(".aggregator-stack");
  check(
    (await page.locator('.aggregator-pane:has(h3:text-is("DynamoDB")) button[aria-label="Expand DynamoDB"]').count()) === 1,
    "Stacked: a pane minimised in the other layout stays minimised"
  );
  await page.click('.aggregator-pane:has(h3:text-is("DynamoDB")) button[aria-label="Expand DynamoDB"]');
  check(
    await page.locator('.aggregator-pane:has(h3:text-is("DynamoDB")) .aggregator-pane-body').isVisible(),
    "Stacked: expand works here too"
  );
  await page.click(`${iotPane} button[aria-label="Minimise IoT"]`);
  await page.waitForSelector(`${iotPane} button[aria-label="Expand IoT"]`);
  await page.screenshot({ path: `${SHOT}/agg-stacked.png` });

  // A minimised pane stays mounted, so its results survive.
  const logsPane = '.aggregator-pane:has(h3:text-is("CloudWatch"))';
  check(
    (await page.locator(`${logsPane} >> text=1. Choose environments`).count()) > 0,
    "Stacked: the other panes are still fully mounted"
  );

  // The assistant still sees a minimised pane -- it's hidden, not unmounted.
  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  // The "Build for" picker -- which lists the panes -- lives in that mode only.
  await page.click('.ai-widget-panel .tab:has-text("Build query")');
  const targets = await page.locator(".ai-widget-panel select option").allTextContents();
  check(
    targets.some((t) => t.includes("IoT")),
    "A minimised pane is still an assistant target (hidden, not unmounted)",
    JSON.stringify(targets)
  );

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
