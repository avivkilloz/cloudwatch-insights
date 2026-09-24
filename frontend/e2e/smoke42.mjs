// The dashboard layout, the way it's actually used: panes added one at a
// time, moved in between, closed and reopened, and whole sessions closed and
// reopened while another one is open. smoke41 only ever opened panes all at
// once into a fresh session, which is why it passed while all of this failed:
//
// - a pane that had never been dragged had no stored place, so it was
//   re-laid-out on every render and jumped to a new slot whenever a pane
//   before it moved;
// - a closed pane came back at its old spot even if another pane was there now;
// - the canvas width came from a page-wide querySelector, which with two
//   sessions open found the hidden one's 0px canvas, clamping every drag in
//   the other to nothing (the "can't drag after reopening a session" bug);
// - a session closed within the sync debounce of its last change was never
//   saved, and reopened empty.
//
// Also: the scrollbar sits at the window's edge, with every card -- the
// "Panes" card as much as a dashboard pane -- 16px clear of it.
import { CLOSED_ROW, SHOT, check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

const PANE = (label) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${label}"))`;
const HEADER = (label) => `${PANE(label)} .aggregator-pane-header`;

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const same = (a, b) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

async function drag(page, label, dx, dy) {
  const b = await page.locator(HEADER(label)).boundingBox();
  await page.mouse.move(b.x + 80, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 80 + dx, b.y + b.height / 2 + dy, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/** The session's own "Panes" checkbox -- adds or removes a pane in place. */
async function toggle(page, label) {
  await page.click(`${SHOWN} .checkbox-item:has-text("${label}") input[type=checkbox]`);
  await page.waitForTimeout(300);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  const canvas = () => page.locator(`${SHOWN} .aggregator-dashboard`).boundingBox();
  // Relative to the canvas, not the viewport: a long drag auto-scrolls the
  // page, which moves every viewport coordinate without moving any pane.
  const box = async (label) => {
    const [b, c] = await Promise.all([page.locator(PANE(label)).boundingBox(), canvas()]);
    return { x: b.x - c.x, y: b.y - c.y, width: b.width, height: b.height };
  };
  async function noOverlaps(labels) {
    const boxes = await Promise.all(labels.map(box));
    const bad = [];
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++) if (overlaps(boxes[i], boxes[j])) bad.push(`${labels[i]}/${labels[j]}`);
    return bad;
  }

  await newSession(page, "CloudWatch");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);

  // ---------- 1. panes line up with the "Panes" card ----------
  const cw0 = await box("CloudWatch");
  check(same(cw0, { x: 0, y: 0 }), "The first pane sits at the canvas's top-left, in line with the Panes card above it",
    JSON.stringify(cw0));

  // ---------- 2. panes added one at a time go to the first free place ----------
  await toggle(page, "OpenSearch");
  const os0 = await box("OpenSearch");
  check(Math.abs(os0.y - cw0.y) < 1 && os0.x > cw0.x + cw0.width, "A second pane goes beside the first",
    JSON.stringify({ cw0, os0 }));

  // OpenSearch under CloudWatch; the free spot beside CloudWatch is where the
  // next pane belongs.
  await drag(page, "OpenSearch", cw0.x - os0.x, cw0.height + 20);
  const os1 = await box("OpenSearch");
  check(Math.abs(os1.x - cw0.x) < 1, "A pane dragged under another lines up with its left edge exactly (no grid offset)",
    `dx=${os1.x - cw0.x}`);
  await toggle(page, "IoT");
  const iot0 = await box("IoT");
  check(same(iot0, os0), "A pane added after a move takes the first free place (the one just vacated), not a fixed slot",
    JSON.stringify({ iot0, os0 }));
  check((await noOverlaps(["CloudWatch", "OpenSearch", "IoT"])).length === 0, "…overlapping nothing");

  // ---------- 3. an untouched pane never moves because another one did ----------
  await drag(page, "CloudWatch", 0, 900);
  const iot1 = await box("IoT");
  check(same(iot1, iot0), "Moving one pane away doesn't make a pane that was never dragged jump into its place",
    JSON.stringify({ iot0, iot1 }));

  // ---------- 4. a closed pane reopens in the first free place, not its old spot ----------
  const osOld = await box("OpenSearch");
  await toggle(page, "OpenSearch");
  await toggle(page, "DynamoDB"); // lands in the first free place: CloudWatch's old one
  await drag(page, "DynamoDB", 0, osOld.y - (await box("DynamoDB")).y); // ...then into OpenSearch's old spot
  await toggle(page, "OpenSearch");
  const bad4 = await noOverlaps(["CloudWatch", "IoT", "DynamoDB", "OpenSearch"]);
  check(bad4.length === 0, "A pane reopened after another took its old spot lands somewhere free instead of on top of it",
    bad4.join(", "));
  const osBack = await box("OpenSearch");
  check(same(osBack, { x: 0, y: 0 }), "…namely the first free place, which is now the top-left", JSON.stringify(osBack));

  // ---------- 5. expanding a minimised pane never lands on a neighbour ----------
  await page.click(`${PANE("OpenSearch")} [aria-label="Minimise OpenSearch"]`);
  await page.waitForTimeout(200);
  const ddb = await box("DynamoDB");
  const osMin = await box("OpenSearch");
  // Into the room below the minimised header, which it no longer occupies.
  await drag(page, "DynamoDB", osMin.x - ddb.x, osMin.y + 60 - ddb.y);
  await page.click(`${PANE("OpenSearch")} [aria-label="Expand OpenSearch"]`);
  await page.waitForTimeout(300);
  const bad5 = await noOverlaps(["CloudWatch", "IoT", "DynamoDB", "OpenSearch"]);
  check(bad5.length === 0, "Expanding a minimised pane over panes moved under it moves it somewhere free instead",
    bad5.join(", "));
  await page.screenshot({ path: `${SHOT}/42-placement.png` });

  const layoutA = {};
  for (const l of ["CloudWatch", "IoT", "DynamoDB", "OpenSearch"]) layoutA[l] = await box(l);

  // ---------- 6. a second dashboard session still drags freely ----------
  await newSession(page, "S3", "Cognito");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);
  const s3 = await box("S3");
  const cog = await box("Cognito");
  check(Math.abs(cog.y - s3.y) < 1, "A second session's panes use the full width (side by side), not one narrow column",
    JSON.stringify({ s3, cog }));
  await drag(page, "S3", 0, 450);
  const s3b = await box("S3");
  check(s3b.y - s3.y > 350 && Math.abs(s3b.x - s3.x) < 1,
    "Dragging works in a second dashboard session while the first stays mounted, hidden",
    JSON.stringify({ s3, s3b }));

  // ---------- 7. close a session right after changing it, reopen it: all there, all draggable ----------
  await page.locator(".session-tab:has-text('S3') .session-tab-close").click();
  await page.waitForTimeout(100);
  // Straight after the change -- well inside the sync debounce.
  await page.locator(".session-tab:has-text('CloudWatch')").click();
  await page.waitForTimeout(200);
  await drag(page, "IoT", 0, 60);
  layoutA.IoT = await box("IoT");
  await page.locator(".session-tab:has-text('CloudWatch') .session-tab-close").click();
  await page.waitForTimeout(800);
  await page.locator(`${CLOSED_ROW}:has-text("CloudWatch")`).click();
  await page.waitForSelector(`${PANE("CloudWatch")}`, { timeout: 15000 });
  await page.waitForTimeout(500);
  let restored = true;
  for (const [l, b] of Object.entries(layoutA)) if (!same(await box(l), b)) restored = false;
  check(restored, "A session closed moments after a change reopens with every pane where it was, that change included");
  const iotR = await box("IoT");
  // Diagonally, into the free stretch of the left column between DynamoDB and
  // CloudWatch -- straight down would (rightly) be blocked by OpenSearch.
  await drag(page, "IoT", -iotR.x, 500);
  const iotR2 = await box("IoT");
  check(iotR2.x < 1 && iotR2.y - iotR.y > 350, "…and its panes can still be dragged freely", JSON.stringify({ iotR, iotR2 }));

  // ---------- 8. dragging a minimised pane keeps its real size ----------
  // Fresh: the session above has panes everywhere a drag might aim.
  await newSession(page, "JWT", "Base64");
  await page.click(`${SHOWN} button:has-text("Dashboard")`);
  await page.waitForTimeout(300);
  const jwtBefore = await box("JWT");
  await page.click(`${PANE("JWT")} [aria-label="Minimise JWT"]`);
  await page.waitForTimeout(200);
  await drag(page, "JWT", 0, 420);
  await page.click(`${PANE("JWT")} [aria-label="Expand JWT"]`);
  await page.waitForTimeout(300);
  const jwtAfter = await box("JWT");
  check(Math.abs(jwtAfter.height - jwtBefore.height) < 1 && jwtAfter.y > jwtBefore.y + 300,
    "A minimised pane dragged elsewhere expands back at its own size, where it was dropped (not as a 40px strip)",
    JSON.stringify({ jwtBefore, jwtAfter }));

  // ---------- 9. Escape cancels a dashboard move ----------
  const b64 = await box("Base64");
  const hb = await page.locator(HEADER("Base64")).boundingBox();
  await page.mouse.move(hb.x + 80, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 80, hb.y + hb.height / 2 + 250, { steps: 15 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(300);
  const b64After = await box("Base64");
  check(same(b64After, b64), "Escape mid-drag puts the pane back where it started", JSON.stringify({ b64, b64After }));
  check((await page.locator(`${PANE("Base64")} [aria-label="Minimise Base64"]`).count()) === 1,
    "…and the release that follows doesn't count as a click that minimises it");
  check((await page.locator(`${SHOWN} .dashboard-ghost`).count()) === 0, "…and leaves no ghost outline behind");

  // ---------- 10. the scrollbar is at the window's edge, cards 16px clear of it ----------
  // Tall enough to scroll again: the JWT pane was just dropped low down.
  const geo = await page.evaluate(() => {
    const content = document.querySelector(".content");
    const shown = document.querySelector(".session-body:not([hidden])");
    const r = content.getBoundingClientRect();
    return {
      windowRight: document.documentElement.clientWidth,
      contentRight: r.right,
      // Where the scrollbar starts: the edge of the scroll box's client area
      // (padding included, scrollbar gutter not).
      clientRight: r.left + content.clientLeft + content.clientWidth,
      panesCardRight: shown.querySelector(".panel").getBoundingClientRect().right,
      stripRight: document.querySelector(".session-bar").getBoundingClientRect().right,
      overflowing: content.scrollHeight > content.clientHeight,
    };
  });
  check(geo.overflowing, "Precondition: the page is tall enough to scroll", JSON.stringify(geo));
  check(Math.abs(geo.contentRight - geo.windowRight) < 1, "The scroll box (and so its scrollbar) reaches the window's right edge",
    JSON.stringify(geo));
  check(Math.abs(geo.clientRight - geo.panesCardRight - 16) < 1, "The Panes card ends 16px short of the scrollbar",
    JSON.stringify(geo));
  check(Math.abs(geo.stripRight - geo.panesCardRight) < 1, "…the same as the session strip above it", JSON.stringify(geo));
  const c2 = await canvas();
  check(Math.abs(c2.x + c2.width - geo.panesCardRight) < 1, "…and the same right edge the dashboard's panes stop at",
    JSON.stringify({ c2, geo }));

  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
