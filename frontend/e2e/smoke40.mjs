// The dashboard layout's overlap/gap rules (smoke38, smoke39) didn't apply at
// the canvas's own edges: a resize could grow a pane up over the "Panes" card
// above the canvas, or right past the canvas's own width, forcing the page
// into horizontal scroll -- and a drag could push a pane past that same right
// edge. Both are capped now, on whichever edge the gesture actually moves.
// Also: resize handles now cover the four edges, not just the four corners,
// each moving only the one dimension it sits on.
import { SHOT, check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

// Scoped to the session on screen: this suite reopens a fresh session more
// than once, and every session body stays mounted (hidden, not unmounted),
// so an unscoped pane selector can still see a previous run's panes.
const PANE = (label) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${label}"))`;
const HEADER = (label) => `${PANE(label)} .aggregator-pane-header`;
const HANDLE = (label, side) => `${PANE(label)} .aggregator-resize-handle.${side}`;

async function dragTo(page, box, toX, toY) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX + box.width / 2, toY + box.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  await newSession(page, "CloudWatch");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  const box = (label) => page.locator(PANE(label)).boundingBox();
  const canvasBox = () => page.locator(`${SHOWN} .aggregator-dashboard`).boundingBox();
  const overflow = () =>
    page.evaluate(() => {
      const el = document.querySelector(".content");
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });

  // ---------- 1. resizing north can't cross over the "Panes" card ----------
  const nHandle = await page.locator(HANDLE("CloudWatch", "n")).boundingBox();
  await dragTo(page, nHandle, nHandle.x, nHandle.y - 500);
  const afterN = await box("CloudWatch");
  const canvasTop = (await canvasBox()).y;
  check(afterN.y >= canvasTop - 1, "Resizing north can't push the pane above the canvas, over the Panes card",
    `paneTop=${afterN.y} canvasTop=${canvasTop}`);
  await page.screenshot({ path: `${SHOT}/40-n-resize-blocked.png` });

  // ---------- 1b. resizing east can't cross the canvas's right edge ----------
  const eHandle = await page.locator(HANDLE("CloudWatch", "e")).boundingBox();
  await dragTo(page, eHandle, eHandle.x + 3000, eHandle.y);
  const afterE = await box("CloudWatch");
  const canvasE = await canvasBox();
  check(afterE.x + afterE.width <= canvasE.x + canvasE.width + 1,
    "Resizing east can't push the pane's right edge past the canvas", JSON.stringify({ afterE, canvasE }));
  check((await overflow()).scrollWidth <= (await overflow()).clientWidth + 2, "…without introducing horizontal overflow");
  await page.screenshot({ path: `${SHOT}/40-e-resize-blocked.png` });

  // ---------- 2. dragging right can't cross the canvas's right edge either ----------
  const header = await page.locator(HEADER("CloudWatch")).boundingBox();
  await dragTo(page, header, header.x + 3000, header.y);
  const afterDrag = await box("CloudWatch");
  const canvasD = await canvasBox();
  check(afterDrag.x + afterDrag.width <= canvasD.x + canvasD.width + 1,
    "Dragging right can't push the pane past the canvas's right edge either", JSON.stringify({ afterDrag, canvasD }));
  check((await overflow()).scrollWidth <= (await overflow()).clientWidth + 2, "…still no horizontal overflow");
  await page.screenshot({ path: `${SHOT}/40-drag-blocked.png` });

  // ---------- 3. an edge handle resizes only its own axis ----------
  const before = await box("CloudWatch");
  const wHandle = await page.locator(HANDLE("CloudWatch", "w")).boundingBox();
  await dragTo(page, wHandle, wHandle.x - 60, wHandle.y);
  const afterW = await box("CloudWatch");
  check(afterW.width > before.width, "The w (west) edge handle grows the pane's width", `before=${before.width} after=${afterW.width}`);
  check(Math.abs(afterW.height - before.height) < 1, "…without touching its height", `before=${before.height} after=${afterW.height}`);
  check(Math.round(afterW.y) === Math.round(before.y), "…or its top position", `before=${before.y} after=${afterW.y}`);

  const before2 = await box("CloudWatch");
  const sHandle = await page.locator(HANDLE("CloudWatch", "s")).boundingBox();
  await dragTo(page, sHandle, sHandle.x, sHandle.y + 60);
  const afterS = await box("CloudWatch");
  check(afterS.height > before2.height, "The s (south) edge handle grows the pane's height", `before=${before2.height} after=${afterS.height}`);
  check(Math.abs(afterS.width - before2.width) < 1, "…without touching its width", `before=${before2.width} after=${afterS.width}`);
  check(Math.round(afterS.x) === Math.round(before2.x), "…or its left position", `before=${before2.x} after=${afterS.x}`);

  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
