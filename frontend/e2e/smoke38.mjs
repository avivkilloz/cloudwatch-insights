// The dashboard layout's panes are freeform, pixel-positioned rectangles --
// nothing stopped two of them from being dragged or resized on top of one
// another, and nothing helped you line them up. Panes now refuse to overlap
// (a drag or resize that would is blocked, not just allowed through) and
// snap to a grid and to their neighbours while being moved or resized.
import { SHOT, check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

// Scoped to the session on screen: this suite reopens a fresh session more
// than once, and every session body stays mounted (hidden, not unmounted),
// so an unscoped pane selector can still see a previous run's panes.
const PANE = (label) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${label}"))`;
const HEADER = (label) => `${PANE(label)} .aggregator-pane-header`;
// Bottom-right, matching this suite's own intent (grow down-right); the pane
// also has nw/ne/sw handles now, so this needs to be specific.
const RESIZE_HANDLE = (label) => `${PANE(label)} .aggregator-resize-handle.se`;

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function dragHeader(page, label, toX, toY) {
  const box = await page.locator(HEADER(label)).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX + box.width / 2, toY + box.height / 2, { steps: 20 });
  await page.mouse.move(toX + box.width / 2 + 1, toY + box.height / 2, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(300);
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

  const cw0 = await box("CloudWatch");
  const os0 = await box("OpenSearch");
  const iot0 = await box("IoT");
  check(
    !overlaps(cw0, os0) && !overlaps(os0, iot0) && !overlaps(cw0, iot0),
    "Panes opened together do not start out overlapping",
    JSON.stringify({ cw0, os0, iot0 }),
  );

  // Dragging one pane's header straight on top of another must not let them overlap.
  const osTarget = await box("OpenSearch");
  await dragHeader(page, "CloudWatch", osTarget.x, osTarget.y);
  const cw1 = await box("CloudWatch");
  const os1 = await box("OpenSearch");
  check(!overlaps(cw1, os1), "Dragging a pane onto another is blocked from overlapping it", JSON.stringify({ cw1, os1 }));
  await page.screenshot({ path: `${SHOT}/38-drag-blocked.png` });

  // A fresh, isolated pair for the snap test: with three panes packed into
  // whatever the canvas actually fits, there may be nowhere left to drag a
  // third pane flush beside a second without a first one in the way.
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "CloudWatch", "OpenSearch");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const os2 = await box("OpenSearch");
  const flushX = os2.x + os2.width + 16;
  await dragHeader(page, "CloudWatch", flushX + 2, os2.y + 2);
  const cw2 = await box("CloudWatch");
  check(Math.round(cw2.y - os2.y) === 0, "A pane dragged near a neighbour's edge snaps flush to it", `dy=${Math.round(cw2.y - os2.y)}`);
  check(!overlaps(cw2, os2), "…and the snapped position still does not overlap", JSON.stringify({ cw2, os2 }));

  // Resizing a pane toward a neighbour is capped at the neighbour's edge, not
  // allowed through it -- fresh again, for the same reason.
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "CloudWatch", "OpenSearch", "IoT");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const iotBefore = await box("IoT");
  const handle = await page.locator(RESIZE_HANDLE("IoT")).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 2000, handle.y + 2000, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const iotAfter = await box("IoT");
  const cwAfter = await box("CloudWatch");
  const osAfter = await box("OpenSearch");
  check(
    !overlaps(iotAfter, cwAfter) && !overlaps(iotAfter, osAfter),
    "Resizing a pane into its neighbours is blocked instead of overlapping them",
    JSON.stringify({ iotAfter, cwAfter, osAfter }),
  );
  check(iotAfter.width >= iotBefore.width, "…while still growing as far as it can", `before=${iotBefore.width} after=${iotAfter.width}`);
  await page.screenshot({ path: `${SHOT}/38-resize-blocked.png` });

  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
