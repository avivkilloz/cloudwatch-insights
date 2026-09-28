// Follow-ups to the Session card round:
// - A dashboard pane flush with the canvas's left edge ran on under the agent
//   panel when the canvas narrowed (a wider dock, a smaller window): its
//   overflow was checked against a width already cut down to the canvas, so
//   0 + canvas never counted as past it. It now shrinks to fit, and grows
//   back when there's room, since its own width is kept.
// - Double-clicking a session tab renames it, as a pane's tab does.
// - The account's picture keeps clear of the toggle before it.
// - The Session card reads as one form: one label column, one values column,
//   three ruled sections, the move button in the corner, and the name and
//   description edited in the same kind of box.
import { SHOWN, SHOT, TAB, addPane, check, clearWorkspace, launch, newSession, openApp, report } from "./harness.mjs";

const PANE = (label) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${label}"))`;
const CARD = `${SHOWN} .session-card`;

async function dragBy(page, selector, dx) {
  const r = await page.locator(selector).first().boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + Math.min(200, r.height / 2));
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + dx, r.y + Math.min(200, r.height / 2), { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

const fit = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(".session-body:not([hidden]) .aggregator-dashboard").getBoundingClientRect();
    const panes = [...document.querySelectorAll(".session-body:not([hidden]) .aggregator-pane")];
    return {
      canvasWidth: Math.round(canvas.width),
      overflow: Math.max(...panes.map((p) => Math.round(p.getBoundingClientRect().right - canvas.right))),
      firstWidth: Math.round(panes[0].getBoundingClientRect().width),
    };
  });

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
    localStorage.removeItem("cwi-agent-width");
    localStorage.removeItem("cwi-panes-in-rail");
  });
  await page.reload();
  await page.waitForSelector(".rail");

  // ---------- 1. A pane at the left edge fits a narrower canvas ----------
  await newSession(page, "CloudWatch");
  await page.click(`${CARD} .segmented button:text-is("Dashboard")`);
  await addPane(page, "Base64");
  await page.waitForTimeout(300);
  await dragBy(page, `${PANE("CloudWatch")} .aggregator-resize-handle.e`, 900);
  let f = await fit(page);
  check(f.overflow <= 0 && f.firstWidth === f.canvasWidth, "Precondition: a pane at the left, as wide as the canvas",
    JSON.stringify(f));
  const full = f.firstWidth;
  await dragBy(page, ".agent-dock-resizer", -150);
  f = await fit(page);
  check(f.overflow <= 0, "Widening the agent panel narrows a pane at the left edge rather than running it under the dock",
    JSON.stringify(f));
  await page.setViewportSize({ width: 1150, height: 900 });
  await page.waitForTimeout(400);
  f = await fit(page);
  check(f.overflow <= 0, "…and so does a smaller window", JSON.stringify(f));
  await page.setViewportSize({ width: 1440, height: 950 });
  await dragBy(page, ".agent-dock-resizer", 150);
  f = await fit(page);
  check(f.firstWidth === full, "Given the room back, it's as wide as it was: its own width is kept", JSON.stringify({ ...f, full }));

  // ---------- 2. Double-click a session tab to rename it ----------
  await page.dblclick(".session-tab.active .session-tab-label");
  await page.fill(".session-tab-rename", "Checkout");
  await page.press(".session-tab-rename", "Enter");
  check((await page.locator(TAB("Checkout")).count()) === 1, "Double-clicking a session tab renames it in place");
  check((await page.locator(`${CARD} .session-card-title`).innerText()) === "Checkout", "…and the session's card follows");

  // ---------- 3. The picture keeps clear of the toggle before it ----------
  const gap = (container, before) =>
    page.evaluate(
      ([container, before]) => {
        const b = document.querySelector(`${container} ${before}`).getBoundingClientRect();
        const p = document.querySelector(`${container} [aria-label="Account menu"]`).getBoundingClientRect();
        return Math.round(p.left - b.right);
      },
      [container, before],
    );
  const inDock = await gap(".agent-dock .agent-panel-actions", ".agent-icon-btn");
  check(inDock >= 8, "In the docked agent panel's header, the picture keeps clear of the layout switch", `${inDock}px`);
  await page.click(".session-bar-agent");
  await page.waitForTimeout(200);
  const onStrip = await gap(".session-bar-end", ".session-bar-agent");
  check(onStrip >= 8, "…and on the strip, of the agent panel's toggle", `${onStrip}px`);
  await page.click(".session-bar-agent");
  await page.waitForSelector(".agent-dock");

  // ---------- 4. The Session card is one form ----------
  const form = await page.evaluate(() => {
    const card = document.querySelector(".session-body:not([hidden]) .session-card");
    const c = card.getBoundingClientRect();
    const rows = [...card.querySelectorAll(".session-card-row")];
    const lefts = (sel) => [...new Set(rows.map((r) => Math.round(r.querySelector(sel).getBoundingClientRect().left)))];
    const move = card.querySelector(".session-card-move").getBoundingClientRect();
    return {
      labels: rows.map((r) => r.querySelector(".session-card-label").textContent),
      labelLefts: lefts(".session-card-label"),
      valueLefts: lefts(".session-card-values"),
      sections: card.querySelectorAll(".session-card-section").length,
      moveInset: [Math.round(c.right - move.right), Math.round(move.top - c.top)],
    };
  });
  check(JSON.stringify(form.labels) === JSON.stringify(["Name", "Description", "Services", "Tools", "Layout"]),
    "The card's rows are its name, description, services, tools and layout", JSON.stringify(form.labels));
  check(form.labelLefts.length === 1 && form.valueLefts.length === 1, "…every label in one column and every value in the next",
    JSON.stringify(form));
  check(form.sections === 3, "…in three sections: what it is, what it holds, how it's laid out", String(form.sections));
  check(form.moveInset.every((d) => d <= 10), "The move button sits in the card's corner", JSON.stringify(form.moveInset));
  check((await page.locator(`${CARD} .segmented[aria-label="Layout"] button[aria-pressed="true"]`).innerText()) === "Dashboard",
    "The layout is one control, showing the one that's on");

  const box = async (selector) =>
    page.locator(selector).evaluate((el) => {
      const cs = getComputedStyle(el);
      return [cs.borderTopWidth, cs.borderTopStyle, cs.borderRadius, cs.paddingLeft, cs.fontFamily, cs.backgroundColor].join("|");
    });
  await page.click(`${CARD} [aria-label="Rename the session"]`);
  const titleBox = await box(`${CARD} .session-card-title-input`);
  await page.keyboard.press("Escape");
  await page.click(`${CARD} [aria-label="Add a description"]`);
  const descBox = await box(`${CARD} .session-card-description-input`);
  await page.keyboard.press("Escape");
  check(titleBox === descBox, "The name and the description edit in the same kind of box", JSON.stringify({ titleBox, descBox }));
  await page.locator(CARD).screenshot({ path: `${SHOT}/49-card.png` });

  // The header is ruled off from what's under it, and in the body the card
  // folds down to that header and the session's name.
  const rule = await page.locator(`${CARD} .session-card-head`).evaluate((el) => getComputedStyle(el).borderBottomWidth);
  check(rule === "1px", "The card's header is ruled off from its sections", rule);
  await page.click(`${CARD} [aria-label="Collapse the session card"]`);
  check((await page.locator(`${CARD} .session-card-row`).count()) === 0 &&
    (await page.locator(`${CARD} .session-card-folded-title`).innerText()) === "Checkout",
    "In the body, the card folds down to its header and the session's name");
  await page.waitForTimeout(1600);
  await page.reload();
  await page.waitForSelector(CARD);
  check((await page.locator(`${CARD} [aria-label="Expand the session card"]`).count()) === 1, "…and stays folded, kept with the session");
  await page.click(`${CARD} [aria-label="Expand the session card"]`);
  check((await page.locator(`${CARD} .session-card-row`).count()) === 5, "…until it's expanded again");
  const inset = await page.evaluate(() => {
    const h = document.querySelector(".agent-dock .agent-panel-head").getBoundingClientRect();
    const p = document.querySelector('.agent-dock [aria-label="Account menu"]').getBoundingClientRect();
    return Math.round(h.right - p.right);
  });
  check(inset >= 10, "The picture sits in from the end of the agent panel's header", `${inset}px`);

  await page.click(`${CARD} .session-card-move`);
  await page.waitForTimeout(300);
  check((await page.locator(".rail-session-slot .session-card-fold").count()) === 0, "In the side panel there's nothing to fold");
  const stacked = await page.evaluate(() => {
    const row = document.querySelector(".rail-session-slot .session-card-row");
    return row.querySelector(".session-card-values").getBoundingClientRect().top >= row.querySelector(".session-card-label").getBoundingClientRect().bottom - 1;
  });
  check(stacked, "In the side panel, each label sits over its values");
  await page.locator(".rail-session-slot .session-card").screenshot({ path: `${SHOT}/49-card-in-rail.png` });
  await page.click(".rail-session-slot .session-card-move");

  await clearWorkspace(page);
  await page.evaluate(() => {
    localStorage.removeItem("cwi-panes-in-rail");
    localStorage.removeItem("cwi-agent-width");
  });
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
