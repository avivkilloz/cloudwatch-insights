// Two follow-ups on the dashboard layout: opening panes landed them by a fixed
// three-column formula, blind to where panes that had never been moved were
// already sitting -- two never-moved panes could collide, and a pane could be
// placed past the canvas's actual width if it was narrower than three columns'
// worth. Panes now resolve together, in open order, into the first slot that
// doesn't come within the standard gap of anything already placed, sized to
// however many columns the canvas actually fits. Separately, the canvas's
// right edge (and the visual gap panes keep from it) used to shift whenever a
// vertical scrollbar appeared or disappeared, which could leave an
// already-placed pane sitting past the new edge; the scrollbar gutter is now
// reserved permanently so that edge never moves.
import { SHOT, check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

// Scoped to the session on screen: this suite reopens a fresh session more
// than once, and every session body stays mounted (hidden, not unmounted),
// so an unscoped pane selector can still see a previous run's panes.
const PANE = (label) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${label}"))`;

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  const box = (label) => page.locator(PANE(label)).boundingBox();
  const canvasBox = () => page.locator(`${SHOWN} .aggregator-dashboard`).boundingBox();

  // ---------- 1. panes opened together land in the first available slot, none overlapping ----------
  // Five panes at the default 1440px viewport: enough that they can't all fit
  // in one row, so this also exercises wrapping to a second row rather than
  // being placed past the canvas's actual width.
  await newSession(page, "CloudWatch", "OpenSearch", "IoT", "DynamoDB", "S3");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const labels = ["CloudWatch", "OpenSearch", "IoT", "DynamoDB", "S3"];
  const boxes = {};
  for (const label of labels) boxes[label] = await box(label);

  let anyOverlap = false;
  const overlapPairs = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (overlaps(boxes[labels[i]], boxes[labels[j]])) {
        anyOverlap = true;
        overlapPairs.push([labels[i], labels[j]]);
      }
    }
  }
  check(!anyOverlap, "Five panes opened together all land without overlapping each other",
    JSON.stringify({ overlapPairs, boxes }));

  const canvas0 = await canvasBox();
  const allWithinRight = labels.every((l) => boxes[l].x + boxes[l].width <= canvas0.x + canvas0.width + 1);
  check(allWithinRight, "…and none of them is placed past the canvas's own right edge",
    JSON.stringify({ canvas0, boxes }));

  const wrapped = labels.some((l) => Math.round(boxes[l].y) > Math.round(boxes["CloudWatch"].y));
  check(wrapped, "…with a pane that doesn't fit the first row wrapping to a second one instead of overflowing",
    JSON.stringify(boxes));
  await page.screenshot({ path: `${SHOT}/41-first-available-packing.png` });

  // ---------- 2. reopening a closed pane (never moved) still finds a free slot ----------
  // Close CloudWatch, then reopen it via the same session's own "Panes"
  // checkbox (not a new session) -- it has no stored rect, so it goes through
  // the same first-available placement as a brand new pane, and must not land
  // back on top of whichever pane is now sitting where it used to be.
  await page.click(`${PANE("CloudWatch")} [aria-label="Close CloudWatch"]`);
  await page.waitForTimeout(300);
  await page.click(`${SHOWN} .checkbox-item:has-text("CloudWatch") input[type=checkbox]`);
  await page.waitForTimeout(300);

  const others = ["OpenSearch", "IoT", "DynamoDB", "S3"];
  const otherBoxes = {};
  for (const label of others) otherBoxes[label] = await box(label);
  const cwReopened = await box("CloudWatch");
  const overlapsAny = others.some((l) => overlaps(cwReopened, otherBoxes[l]));
  check(!overlapsAny, "A closed-then-reopened pane with no stored position lands in a free slot, not back on top of another pane",
    JSON.stringify({ cwReopened, otherBoxes }));

  // ---------- 3. the canvas's right edge doesn't shift when a scrollbar appears ----------
  // Fresh session, one pane: measure the boundary with no vertical overflow,
  // then add panes until the canvas is tall enough to scroll, and confirm the
  // boundary (and the first pane's position) hasn't moved out from under it.
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "CloudWatch");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const noScroll = await page.evaluate(() => {
    const el = document.querySelector(".content");
    return { overflowing: el.scrollHeight > el.clientHeight, clientWidth: el.clientWidth };
  });
  check(!noScroll.overflowing, "Starting point: one pane doesn't yet overflow the canvas vertically", JSON.stringify(noScroll));
  const canvasBefore = await canvasBox();
  const cwBefore = await box("CloudWatch");

  // Enough panes, stacked by the app's own placement, to force vertical
  // overflow and bring the scrollbar in -- added to this same session via its
  // own "Panes" checkboxes, not a new session.
  for (const label of ["OpenSearch", "IoT", "DynamoDB", "S3", "Cognito"]) {
    await page.click(`${SHOWN} .checkbox-item:has-text("${label}") input[type=checkbox]`);
  }
  await page.waitForTimeout(300);

  const afterAdd = await page.evaluate(() => {
    const el = document.querySelector(".content");
    return { overflowing: el.scrollHeight > el.clientHeight, clientWidth: el.clientWidth };
  });
  check(afterAdd.overflowing, "Adding enough panes makes the canvas overflow vertically, bringing the scrollbar in",
    JSON.stringify(afterAdd));
  check(afterAdd.clientWidth === noScroll.clientWidth,
    "…without the column's own width (and so the dashboard's right edge) shifting when the scrollbar appears",
    JSON.stringify({ before: noScroll.clientWidth, after: afterAdd.clientWidth }));

  const canvasAfter = await canvasBox();
  const cwAfter = await box("CloudWatch");
  check(Math.abs(canvasAfter.width - canvasBefore.width) < 1,
    "…and the canvas itself renders at the same width before and after", JSON.stringify({ canvasBefore, canvasAfter }));
  check(Math.abs(cwAfter.x - cwBefore.x) < 1 && Math.abs(cwAfter.width - cwBefore.width) < 1,
    "…so a pane already sitting at the edge stays inside the canvas rather than ending up past it",
    JSON.stringify({ cwBefore, cwAfter }));
  await page.screenshot({ path: `${SHOT}/41-scrollbar-stable-edge.png` });

  // ---------- 4. cards keep a visible gap from the scrollbar, which sits close to the edge ----------
  const gap = await page.evaluate(() => {
    const content = document.querySelector(".content");
    const style = getComputedStyle(content);
    const contentRect = content.getBoundingClientRect();
    const pane = document.querySelector(".aggregator-pane");
    const paneRect = pane.getBoundingClientRect();
    return {
      scrollbarWidth: style.scrollbarWidth,
      scrollbarGutter: style.scrollbarGutter,
      contentRight: contentRect.right,
      paneRight: paneRect.right,
    };
  });
  check(gap.scrollbarWidth === "thin", "The scrollbar is styled thin, closer to the border", JSON.stringify(gap));
  check(gap.scrollbarGutter.includes("stable"), "…and its space is permanently reserved rather than shifting layout when it appears",
    JSON.stringify(gap));
  check(gap.contentRight - gap.paneRight >= 15, "…leaving cards a visible gap from it rather than touching it",
    `gap=${gap.contentRight - gap.paneRight}`);

  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
