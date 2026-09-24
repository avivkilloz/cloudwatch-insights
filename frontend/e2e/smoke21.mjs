import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";

const SESSION = '.panel:has(h2:text-is("Panes"))';

/** What "drop `id` into the slot `over` holds" should produce. */
function expectedOrder(order, id, over) {
  const next = [...order];
  next.splice(next.indexOf(over), 0, next.splice(next.indexOf(id), 1)[0]);
  return next;
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: false } }));

  /** Pane ids in laid-out order -- data-pane-id is already in `services` order. */
  const order = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-pane-id]")).map((e) => e.dataset.paneId));
  const headerBox = (id) => page.locator(`[data-pane-id="${id}"] .aggregator-pane-header`).boundingBox();
  const stuck = () => page.locator(".aggregator-pane.dragging, .aggregator-pane.drop-target").count();

  /** A real mouse gesture. `steps: 1` jumps straight there -- the case that
   * outran React's re-render and broke the previous HTML5-drag version. */
  async function dragPane(from, to, { steps = 10, release = true } = {}) {
    const a = await headerBox(from);
    const b = await headerBox(to);
    const [x0, y0] = [a.x + 60, a.y + a.height / 2];
    const [x1, y1] = [b.x + 60, b.y + b.height / 2];
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    }
    if (release) await page.mouse.up();
  }

  /** The symptom that started this: is the page still usable afterwards? */
  async function pageStillWorks() {
    try {
      await page.click(`${SESSION} button:text-is("Stacked")`, { timeout: 3000 });
      await page.click(`${SESSION} button:text-is("Side by side")`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
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

  await newPanedSession(page);
  // This drives the Aggregator with absolute mouse coordinates, which do not
  // auto-scroll. The rail costs 212px, which wraps three panes onto two rows
  // and pushes some off screen, so collapse it now that the session is open
  // and give the page its full width -- exactly what the strip's panel button is for.
  await page.click(".session-bar-rail");
  await page.waitForTimeout(300);
  await page.waitForSelector("text=Choose one or more services");
  // All six open: the heaviest re-render, which is what the old version
  // couldn't survive. At this width they wrap onto two rows.
  for (const label of ["CloudWatch", "IoT", "DynamoDB", "S3", "Cognito", "HTTP client"]) {
    await page.click(`${SESSION} label.checkbox-item:text-is("${label}") input`);
  }
  await page.waitForSelector(".aggregator-pane >> nth=5");

  // ---------- A smooth drag ----------
  let before = await order();
  await dragPane("logs-cloudwatch", "tables");
  check(
    JSON.stringify(await order()) === JSON.stringify(expectedOrder(before, "logs-cloudwatch", "tables")),
    "Dragging a pane onto another drops it into that slot",
    JSON.stringify(await order())
  );
  check((await stuck()) === 0, "No pane is left dimmed or highlighted");
  check(await pageStillWorks(), "The page is still clickable after a drag");

  // ---------- A gesture that outruns React ----------
  // One pointer move from source to target, with six embedded pages to
  // re-render in between. The old version read the dragged pane out of React
  // state here and silently refused the drop.
  before = await order();
  await dragPane("tables", "iot", { steps: 1 });
  check(
    JSON.stringify(await order()) === JSON.stringify(expectedOrder(before, "tables", "iot")),
    "A single-jump drag still lands (no handler waits on a re-render)",
    JSON.stringify(await order())
  );
  check((await stuck()) === 0, "A fast drag leaves nothing stuck");
  check(await pageStillWorks(), "The page is still clickable after a fast drag");

  // ---------- Releasing outside any pane ----------
  before = await order();
  let src = await headerBox(before[0]);
  await page.mouse.move(src.x + 60, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 60, 90); // up over the Session panel
  await page.mouse.up();
  check(
    JSON.stringify(await order()) === JSON.stringify(before),
    "Releasing outside any pane leaves the order alone",
    JSON.stringify(await order())
  );
  check((await stuck()) === 0, "Releasing outside any pane leaves nothing stuck");
  check(await pageStillWorks(), "The page is still clickable after releasing outside a pane");

  // ---------- Escape mid-drag ----------
  before = await order();
  await dragPane(before[0], before[1], { release: false });
  check((await stuck()) > 0, "Mid-drag, the panes show as dragging / drop target");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check(
    JSON.stringify(await order()) === JSON.stringify(before),
    "Escape cancels the drag without moving anything",
    JSON.stringify(await order())
  );
  check((await stuck()) === 0, "Escape clears the drag state");
  check(await pageStillWorks(), "The page is still clickable after cancelling with Escape");

  // ---------- Click vs drag on the same title bar ----------
  before = await order();
  const first = before[0];
  await page.click(`[data-pane-id="${first}"] .aggregator-pane-header h3`);
  await page.waitForSelector(`[data-pane-id="${first}"] button[aria-label^="Expand"]`);
  check(true, "A plain click on the title bar still minimises");
  await page.click(`[data-pane-id="${first}"] .aggregator-pane-header h3`);
  await page.waitForSelector(`[data-pane-id="${first}"] button[aria-label^="Minimise"]`);

  await dragPane(first, before[2]);
  check(
    JSON.stringify(await order()) === JSON.stringify(expectedOrder(before, first, before[2])),
    "A drag from the title bar reorders",
    JSON.stringify(await order())
  );
  check(
    await page.locator(`[data-pane-id="${first}"] .aggregator-pane-body`).isVisible(),
    "The drag's closing click doesn't also minimise the pane it moved"
  );
  // ...and the suppression doesn't leak into the NEXT click, even though that
  // drag ended over a different pane and so never delivered a click at all.
  await page.click(`[data-pane-id="${first}"] .aggregator-pane-header h3`);
  await page.waitForSelector(`[data-pane-id="${first}"] button[aria-label^="Expand"]`);
  check(true, "The click after a drag still minimises (suppression doesn't leak)");
  await page.click(`[data-pane-id="${first}"] button[aria-label^="Expand"]`);

  // A wobble under the threshold is a click, not a drag.
  before = await order();
  const wob = await headerBox(before[1]);
  await page.mouse.move(wob.x + 60, wob.y + wob.height / 2);
  await page.mouse.down();
  await page.mouse.move(wob.x + 62, wob.y + wob.height / 2);
  await page.mouse.up();
  check(
    JSON.stringify(await order()) === JSON.stringify(before),
    "A 2px wobble doesn't reorder anything",
    JSON.stringify(await order())
  );
  await page.waitForSelector(`[data-pane-id="${before[1]}"] button[aria-label^="Expand"]`);
  check(true, "A 2px wobble still counts as a click and minimises");
  await page.click(`[data-pane-id="${before[1]}"] button[aria-label^="Expand"]`);

  // ---------- Pressing a title-bar button never starts a drag ----------
  before = await order();
  const btn = await page.locator(`[data-pane-id="${before[1]}"] button[aria-label^="Move"]`).first().boundingBox();
  const dst = await headerBox(before[0]);
  await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await page.mouse.down();
  await page.mouse.move(dst.x + 60, dst.y + dst.height / 2);
  await page.mouse.up();
  check((await stuck()) === 0, "Pressing a title-bar button never starts a drag");
  check(await pageStillWorks(), "The page is still clickable after that");

  // ---------- Auto-scroll reaches a pane that started off-screen ----------
  await page.evaluate(() => document.querySelector(".content").scrollTo(0, 0));
  before = await order();
  const offScreen = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("[data-pane-id]")).filter(
        (e) => e.getBoundingClientRect().top > window.innerHeight
      ).length
  );
  check(offScreen > 0, "With six panes, some start below the fold", String(offScreen));

  // The last pane is below the fold; reaching it means the drag has to scroll.
  const landing = before[before.length - 1];
  const onScreen = (id) =>
    page.evaluate((paneId) => {
      const r = document.querySelector(`[data-pane-id="${paneId}"]`).getBoundingClientRect();
      return r.top < window.innerHeight - 120;
    }, id);
  check(!(await onScreen(landing)), `The last pane (${landing}) starts off-screen`);

  src = await headerBox(before[0]);
  await page.mouse.move(src.x + 60, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 60, src.y + src.height / 2 + 30);
  await page.mouse.move(src.x + 60, 860); // hold near the bottom edge
  const scrollBefore = await page.evaluate(() => document.querySelector(".content").scrollTop);
  // Hold until the target has scrolled into view, the way a person would.
  for (let i = 0; i < 40 && !(await onScreen(landing)); i++) await page.waitForTimeout(50);
  const scrollAfter = await page.evaluate(() => document.querySelector(".content").scrollTop);
  check(scrollAfter > scrollBefore, "Holding a drag at the bottom edge scrolls the page", `${scrollBefore} -> ${scrollAfter}`);
  check(await onScreen(landing), "Auto-scroll brings the off-screen pane into view mid-drag");

  const target = await headerBox(landing);
  await page.mouse.move(target.x + 60, target.y + target.height / 2);
  check(
    (await page.evaluate(() => document.querySelector(".aggregator-pane.drop-target")?.dataset.paneId ?? null)) === landing,
    "Moving onto it makes it the drop target"
  );
  await page.mouse.up();
  check(
    JSON.stringify(await order()) === JSON.stringify(expectedOrder(before, before[0], landing)),
    "Releasing there drops the pane into that slot",
    JSON.stringify(await order())
  );
  check((await stuck()) === 0, "Nothing is left stuck after an auto-scrolled drag");
  check(await pageStillWorks(), "The page is still clickable after an auto-scrolled drag");

  // ---------- Stacked works the same ----------
  await page.evaluate(() => document.querySelector(".content").scrollTo(0, 0));
  await page.click(`${SESSION} button:text-is("Stacked")`);
  await page.waitForSelector(".aggregator-stack");
  // Minimise everything so the stack fits on screen and the panes are adjacent.
  for (const id of await order()) {
    const b = page.locator(`[data-pane-id="${id}"] button[aria-label^="Minimise"]`);
    if ((await b.count()) > 0) await b.click();
  }
  before = await order();
  await dragPane(before[0], before[2]);
  check(
    JSON.stringify(await order()) === JSON.stringify(expectedOrder(before, before[0], before[2])),
    "Stacked: dragging moves a pane down the vertical order",
    JSON.stringify(await order())
  );
  check((await stuck()) === 0, "Stacked: nothing left stuck");
  check(
    (await page.locator('.aggregator-pane button[aria-label^="Expand"]').count()) === before.length,
    "Stacked: dragging a minimised pane doesn't expand anything"
  );
  await page.screenshot({ path: `${SHOT}/agg-drag-stacked.png` });

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
