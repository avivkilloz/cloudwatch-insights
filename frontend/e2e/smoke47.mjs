// Follow-ups to the agent panel, each from something seen using it:
// - On a laptop-sized window, a wide agent dock squeezed the body until the
//   side-by-side panes (420px at least) ran on underneath the dock and the
//   body scrolled sideways behind it. The body now keeps room for one pane:
//   the dock and the rail stop growing first, and draw narrower when the
//   window does.
// - The dock's cut line sat nearer the cards than the dock (it was centred in
//   the part of the gap left of the body's scrollbar); now it's in the middle
//   of the gap, like the rail's.
// - The floating panel is drawn the way the ✦ assistant's was: a header bar
//   with a rule under it, the conversation edge to edge, the box to type in on
//   a band of its own, and the small four-dot grip.
// - Asked for an MQTT tester, the agent said there was no such thing: kinds
//   whose state lives only in the browser weren't offered to it at all. It can
//   add every kind now, even ones it can't fill in.
//
// Needs the agent and the scripted stand-in model running, like smoke45.
import { SHOWN, SHOT, check, clearWorkspace, launch, newSession, openApp, report } from "./harness.mjs";

const DOCK = ".agent-dock";

const layout = (page) =>
  page.evaluate(() => {
    const content = document.querySelector(".content");
    const dock = document.querySelector(".agent-dock-panel")?.getBoundingClientRect();
    const panes = [...document.querySelectorAll(".session-body:not([hidden]) .aggregator-pane")].map(
      (p) => p.getBoundingClientRect().right,
    );
    return {
      bodyWidth: content.clientWidth,
      sideways: content.scrollWidth - content.clientWidth,
      dockLeft: dock ? dock.left : null,
      furthestPane: Math.max(...panes),
    };
  });

async function dragBy(page, selector, dx) {
  const r = await page.locator(selector).boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + 200);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + dx, r.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/** Where a resizer's dashed line is drawn, against the middle of its gap. */
const lineOffCentre = (page, resizer, leftOf, rightOf) =>
  page.evaluate(
    ([resizer, leftOf, rightOf]) => {
      const el = document.querySelector(resizer);
      const line = el.getBoundingClientRect().left + parseFloat(getComputedStyle(el, "::before").left);
      const a = document.querySelector(leftOf).getBoundingClientRect().right;
      const b = document.querySelector(rightOf).getBoundingClientRect().left;
      return line - (a + b) / 2;
    },
    [resizer, leftOf, rightOf],
  );

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser, { viewport: { width: 1280, height: 800 } });
  await clearWorkspace(page);
  await page.evaluate(() => {
    for (const k of ["cwi-rail-width", "cwi-agent-width", "cwi-agent-float-width", "cwi-agent-float-height"]) {
      localStorage.removeItem(k);
    }
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(DOCK);

  // ---------- 1. A wide dock on a laptop screen leaves the body room ----------
  await newSession(page, "CloudWatch");
  await page.click(`${SHOWN} button:has-text("+ Base64")`);
  await page.click(`${SHOWN} button:has-text("Side by side")`);
  await page.waitForTimeout(300);
  await dragBy(page, ".agent-dock-resizer", -600);
  await dragBy(page, ".rail-resizer", 400);
  let l = await layout(page);
  check(l.bodyWidth >= 430, "Dragging the dock and the side panel as wide as they go still leaves the body room for a pane",
    JSON.stringify(l));
  check(l.sideways === 0, "…so the body never scrolls sideways", JSON.stringify(l));
  check(l.furthestPane <= l.dockLeft - 15, "…and no pane runs on under the dock", JSON.stringify(l));
  await page.screenshot({ path: `${SHOT}/47-laptop-wide-dock.png` });

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(300);
  l = await layout(page);
  check(l.bodyWidth >= 430 && l.sideways === 0 && l.furthestPane <= l.dockLeft - 15,
    "Making the window narrower draws the columns narrower rather than squeezing the body", JSON.stringify(l));
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.waitForTimeout(300);
  l = await layout(page);
  check(l.sideways === 0 && l.furthestPane <= l.dockLeft - 15, "…and widening it again lays everything out as before",
    JSON.stringify(l));

  // ---------- 2. The dock's cut line is in the middle of its gap ----------
  const dockOff = await lineOffCentre(page, ".agent-dock-resizer", `${SHOWN} .panel`, ".agent-dock-panel");
  check(Math.abs(dockOff) <= 1, "The dock's cut line is drawn in the middle of the gap beside it", String(dockOff));
  const railOff = await lineOffCentre(page, ".rail-resizer", ".rail-column", ".session-bar");
  check(Math.abs(railOff) <= 1, "…as the side panel's is", String(railOff));
  const bar = await page.locator(".content").evaluate((el) => el.offsetWidth - el.clientWidth);
  check(bar === 6, "The body's scrollbar keeps its thin width", String(bar));

  // ---------- 3. The floating panel, drawn as the assistant's was ----------
  await page.click(`${DOCK} .agent-icon-btn[aria-label="Float the agent over the page"]`);
  await page.waitForSelector(".agent-float-panel");
  const look = await page.evaluate(() => {
    const css = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
    return {
      panelPadding: css(".agent-float-panel").paddingTop,
      headRule: css(".agent-float-panel .agent-panel-head").borderBottomWidth,
      composeRule: css(".agent-float-panel .agent-compose").borderTopWidth,
      grip: css(".agent-float-resize", "::before").width,
      headLeft: css(".agent-float-panel .agent-panel-head").paddingLeft,
    };
  });
  check(look.panelPadding === "0px" && look.headRule === "1px" && look.composeRule === "1px",
    "Floating, it has a header bar and a band for the box to type in, each ruled off, edge to edge", JSON.stringify(look));
  check(look.grip === "8px" && look.headLeft === "26px", "…and the small grip in its corner, clear of the tabs",
    JSON.stringify(look));
  await page.locator(".agent-float-panel").screenshot({ path: `${SHOT}/47-float.png` });

  // ---------- 4. The agent can add a tool it can't fill in ----------
  await page.click('.agent-float-panel .agent-tab:text-is("Session")');
  await page.fill(".agent-float-panel .agent-compose-input", "add mqtt");
  await page.press(".agent-float-panel .agent-compose-input", "Enter");
  await page.waitForSelector('.agent-float-panel .agent-compose-actions button:text-is("Ask")', { timeout: 30000 });
  await page.waitForTimeout(800);
  const answer = await page.locator(".agent-float-panel .agent-turn").last().locator(".agent-answer").innerText();
  check(answer.includes("Added a MQTT tester pane"), "Asked for an MQTT tester, the agent adds one", answer);
  const tabs = await page.locator(`${SHOWN} .aggregator-pane-header h3`).allInnerTexts();
  check(tabs.includes("MQTT tester"), "…and it's there in the session, beside the panes already in it", JSON.stringify(tabs));

  await page.click('.agent-float-panel .agent-icon-btn[aria-label="Dock the agent beside the page"]');
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
