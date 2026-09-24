// Three follow-ups on the dashboard layout: a pane can be resized from any
// corner, not just bottom-right (which the floating Ask AI button can
// cover); dragging a pane toward the bottom edge of the canvas scrolls it
// into view; and moving/resizing keeps at least the standard gap between
// panes -- shown while dragging as a dashed "cut lines" outline at the spot
// the pane will actually land, separate from the pane itself, which follows
// the raw pointer until release commits it there.
import { SHOT, check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

// Scoped to the session on screen: this suite reopens a fresh session more
// than once, and every session body stays mounted (hidden, not unmounted),
// so an unscoped pane selector can still see a previous run's panes.
const PANE = (label) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${label}"))`;
const HEADER = (label) => `${PANE(label)} .aggregator-pane-header`;
const HANDLE = (label, corner) => `${PANE(label)} .aggregator-resize-handle.${corner}`;

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function gapBetween(a, b) {
  const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.max(dx, dy);
}

async function dragTo(page, box, toX, toY, { release = true } = {}) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX + box.width / 2, toY + box.height / 2, { steps: 20 });
  if (release) {
    await page.mouse.move(toX + box.width / 2 + 1, toY + box.height / 2, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  await newSession(page, "CloudWatch", "OpenSearch", "IoT");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const box = (label) => page.locator(PANE(label)).boundingBox();

  // ---------- 1. resize from any corner ----------
  const handleCount = await page.locator(`${PANE("CloudWatch")} .aggregator-resize-handle`).count();
  check(handleCount === 8, "Each dashboard pane has a resize handle on every corner and edge", handleCount);

  const cwBefore = await box("CloudWatch");
  const nw = await page.locator(HANDLE("CloudWatch", "nw")).boundingBox();
  await dragTo(page, nw, nw.x - 60, nw.y - 40);
  const cwAfter = await box("CloudWatch");
  check(cwAfter.width > cwBefore.width && cwAfter.height > cwBefore.height,
    "Resizing from the nw handle grows the pane up-left", JSON.stringify({ cwBefore, cwAfter }));
  check(Math.round(cwAfter.x + cwAfter.width) === Math.round(cwBefore.x + cwBefore.width),
    "…keeping its bottom-right corner fixed, unlike a se resize");
  await page.screenshot({ path: `${SHOT}/39-nw-resize.png` });

  // ---------- 2. auto-scroll while dragging toward the bottom edge ----------
  // Fresh workspace: a pane resized in section 1 can overlap where this one
  // needs to land, and this only needs one pane anyway.
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "CloudWatch", "OpenSearch");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const osHeaderBefore = await page.locator(HEADER("OpenSearch")).boundingBox();
  await dragTo(page, osHeaderBefore, osHeaderBefore.x, osHeaderBefore.y + 1600);
  await page.evaluate(() => { document.querySelector(".content").scrollTop = 0; });
  const scrollable = await page.evaluate(() => {
    const el = document.querySelector(".content");
    return { overflowing: el.scrollHeight > el.clientHeight, scrollTop: el.scrollTop };
  });
  check(scrollable.overflowing, "Pushing a pane far down makes the canvas overflow the viewport", JSON.stringify(scrollable));

  const cwHeaderBox = await page.locator(HEADER("CloudWatch")).boundingBox();
  const contentBox = await page.locator(".content").boundingBox();
  await dragTo(page, cwHeaderBox, cwHeaderBox.x, contentBox.y + contentBox.height - 20, { release: false });
  await page.waitForTimeout(500);
  const scrollDuring = await page.evaluate(() => document.querySelector(".content").scrollTop);
  check(scrollDuring > scrollable.scrollTop, "Holding near the bottom edge while dragging auto-scrolls the canvas",
    `before=${scrollable.scrollTop} during=${scrollDuring}`);
  await page.mouse.up();
  await page.waitForTimeout(300);

  // ---------- 3. minimum gap + the "cut lines" ghost while dragging ----------
  // Fresh workspace: the auto-scroll test above left panes far apart.
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "CloudWatch", "OpenSearch");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const os = await box("OpenSearch");
  const cwHeader = page.locator(HEADER("CloudWatch"));
  let hb = await cwHeader.boundingBox();
  // Aim to land exactly flush (touching) against OpenSearch's right edge.
  await dragTo(page, hb, os.x + os.width + 1, os.y + 1);
  const cwTouching = await box("CloudWatch");
  const osStill = await box("OpenSearch");
  check(!overlaps(cwTouching, osStill), "Dragging toward touching another pane still doesn't overlap it",
    JSON.stringify({ cwTouching, osStill }));
  check(gapBetween(cwTouching, osStill) >= 15, "…and keeps at least the standard gap rather than touching",
    `gap=${gapBetween(cwTouching, osStill)}`);

  // Drag it away, and watch the "cut lines" ghost while mid-drag.
  hb = await cwHeader.boundingBox();
  await dragTo(page, hb, hb.x + 200, hb.y + 200, { release: false });
  await page.waitForTimeout(150);
  const ghostCount = await page.locator(".dashboard-ghost").count();
  check(ghostCount === 1, "A dashed ghost appears at the snap target while dragging", ghostCount);
  const liveDuring = await box("CloudWatch");
  const ghostDuring = await page.locator(".dashboard-ghost").boundingBox();
  check(Math.abs(liveDuring.x - ghostDuring.x) > 5 || Math.abs(liveDuring.y - ghostDuring.y) > 5,
    "…while the pane itself follows the raw pointer rather than jumping to the snap", JSON.stringify({ liveDuring, ghostDuring }));
  await page.screenshot({ path: `${SHOT}/39-ghost-during-drag.png` });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const ghostAfter = await page.locator(".dashboard-ghost").count();
  check(ghostAfter === 0, "…and the ghost is gone once released", ghostAfter);
  const cwSettled = await box("CloudWatch");
  check(Math.abs(cwSettled.x - ghostDuring.x) < 3 && Math.abs(cwSettled.y - ghostDuring.y) < 3,
    "…with the pane landing exactly where the ghost was", JSON.stringify({ cwSettled, ghostDuring }));

  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
