// The shell without a header bar, and a session's own card:
// - The side panel's brand is a header bar the height of the strip, level with
//   the session tabs; with the panel hidden, the logo starts the strip.
// - The account's picture ends the strip -- or, with the agent panel docked,
//   that panel's header (floating, it stays on the strip).
// - With the agent panel docked, the body still scrolls against the window's
//   edge: the dock is drawn over the body's right, not beside it.
// - One Session card: the name and description (both edited in place), the
//   adds and the layout. It sits at the top of the body or in the side panel,
//   and stays where it was put -- even while the panel is hidden.
// - A new session can be filed in a category from the home page.
// - The reorder cut line is drawn inside the pane, so nothing clips it.
import { SHOWN, SHOT, TAB, check, clearWorkspace, launch, newSession, openApp, report } from "./harness.mjs";

const rect = (page, selector) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  });
const CARD = `${SHOWN} .session-card`;

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.evaluate(async () => {
    localStorage.setItem("cwi-rail", "open");
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
    localStorage.removeItem("cwi-panes-in-rail");
    for (const c of await (await fetch("/api/session-categories")).json()) {
      await fetch(`/api/session-categories/${c.id}`, { method: "DELETE" });
    }
    await fetch("/api/session-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Incidents" }),
    });
  });
  await page.reload();
  await page.waitForSelector(".rail");

  // ---------- 1. A new session, named, described and filed in a category ----------
  await page.click(".rail-row-home");
  const options = await page.locator('select[aria-label="Category for the new session"] option').allInnerTexts();
  check(JSON.stringify(options) === JSON.stringify(["None", "Incidents"]),
    "The new-session form offers the categories there are, none by default", JSON.stringify(options));
  await page.fill('input[aria-label="Name for the new session"]', "Checkout errors");
  await page.fill('textarea[aria-label="Description for the new session"]', "Why checkout 500s since Tuesday");
  await page.selectOption('select[aria-label="Category for the new session"]', { label: "Incidents" });
  await page.click('.home-card:has(.home-card-title:text-is("CloudWatch")) button[title^="One more"]');
  await page.click('.home-card:has(.home-card-title:text-is("Base64")) button[title^="One more"]');
  await page.click(".home-create");
  await page.waitForSelector(TAB("Checkout errors"));
  const filed = await page.locator('.rail-category:has(.rail-category-label:text-is("Incidents")) .rail-row-label:text-is("Checkout errors")').count();
  check(filed === 1, "…and the new session is filed in the one chosen");

  // ---------- 2. One Session card: name, description, adds, layout ----------
  check((await page.locator(`${CARD} .session-card-title`).innerText()) === "Checkout errors" &&
    (await page.locator(`${CARD} .session-card-description`).innerText()) === "Why checkout 500s since Tuesday",
    "The session's card has its name and description");
  check((await page.locator(`${CARD} button[aria-label="Add CloudWatch pane"]`).count()) === 1 &&
    (await page.locator(`${CARD} button:text-is("Dashboard")`).count()) === 1, "…and what to add, and the layouts");
  check((await page.locator(".page-info").count()) === 0, "There's no separate title card for a session any more");
  await page.click(`${CARD} [aria-label="Rename the session"]`);
  await page.fill(`${CARD} .session-card-title-input`, "Checkout 500s");
  await page.press(`${CARD} .session-card-title-input`, "Enter");
  check((await page.locator(TAB("Checkout 500s")).count()) === 1, "The name is edited in place, and the tab follows");
  await page.click(`${CARD} [aria-label="Edit the description"]`);
  await page.fill(`${CARD} .session-card-description-input`, "Since the Tuesday deploy");
  await page.press(`${CARD} .session-card-description-input`, "Enter");
  await page.click(`${CARD} [aria-label="Edit the description"]`);
  await page.fill(`${CARD} .session-card-description-input`, "thrown away");
  await page.press(`${CARD} .session-card-description-input`, "Escape");
  check((await page.locator(`${CARD} .session-card-description`).innerText()) === "Since the Tuesday deploy",
    "So is the description; Escape leaves it as it was");

  // ---------- 3. The brand and the account, level with the strip ----------
  const [brand, tab] = [await rect(page, ".rail-head .rail-brand"), await rect(page, ".session-tab")];
  check(Math.abs(brand.top - tab.top) <= 1 && Math.abs(brand.height - tab.height) <= 1,
    "The side panel's brand is a header bar level with the session tabs", JSON.stringify({ brand, tab }));
  // The rule sits a little lower than the strip's own bottom now -- room to
  // breathe under the row, without moving the row itself -- matching the
  // docked agent panel's own header rule instead.
  const [head, dockHead] = [await rect(page, ".rail-head"), await rect(page, ".agent-dock .agent-panel-head")];
  check(Math.abs(head.bottom - dockHead.bottom) <= 1, "…ending level with the agent panel's own header rule",
    JSON.stringify({ head, dockHead }));
  const dockEnd = await page.locator(".agent-dock .agent-panel-actions > *").evaluateAll((els) => els.map((e) => e.className));
  check(dockEnd.length === 2 && dockEnd[0].includes("agent-icon-btn") && dockEnd[1].includes("icon-popover-wrap"),
    "Docked, the agent panel's header ends with the account's picture, after the layout switch", JSON.stringify(dockEnd));
  check((await page.locator(".session-bar [aria-label='Account menu']").count()) === 0, "…and the strip doesn't repeat it");
  await page.click(".agent-dock [aria-label='Account menu']");
  check((await page.locator(".user-menu-popover").count()) === 1, "It opens the account menu from there");
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 900);
  await page.click(".session-bar-agent");
  await page.waitForTimeout(200);
  const stripEnd = await page.locator(".session-bar-end > *").evaluateAll((els) => els.map((e) => e.className.split(" ")[0]));
  check(stripEnd[stripEnd.length - 1] === "icon-popover-wrap", "With the agent panel hidden, the picture ends the strip",
    JSON.stringify(stripEnd));
  await page.click(".session-bar-agent");
  await page.click('.agent-dock .agent-icon-btn[aria-label="Float the agent over the page"]');
  await page.waitForSelector(".agent-float-panel");
  check((await page.locator(".session-bar [aria-label='Account menu']").count()) === 1 &&
    (await page.locator(".agent-float-panel [aria-label='Account menu']").count()) === 0,
    "Floating, the agent panel leaves the picture on the strip");
  await page.click('.agent-float-panel [aria-label="Dock the agent beside the page"]');
  await page.waitForSelector(".agent-dock");

  // ---------- 4. The body's scrollbar at the window's edge, dock or not ----------
  const body = await rect(page, ".content");
  const width = await page.evaluate(() => window.innerWidth);
  check(Math.abs(body.right - width) <= 1, "With the agent panel docked, the body still scrolls against the window's edge",
    JSON.stringify({ right: body.right, width }));
  const [card, dockPanel] = [await rect(page, CARD), await rect(page, ".agent-dock-panel")];
  check(Math.abs(dockPanel.left - card.right - 16) <= 1, "…and its cards still end 16px from the dock",
    JSON.stringify({ card: card.right, dock: dockPanel.left }));
  await page.screenshot({ path: `${SHOT}/48-shell.png` });

  // ---------- 5. The card moves to the side panel, and stays there ----------
  await page.click(`${CARD} .session-card-move`);
  await page.waitForTimeout(300);
  check((await page.locator(".rail-session-slot .session-card").count()) === 1 && (await page.locator(CARD).count()) === 0,
    "The session's card moves to the side panel");
  await page.click('.rail-session-slot button[aria-label="Add Diff pane"]');
  await page.waitForTimeout(300);
  check((await page.locator(`${SHOWN} .aggregator-tab-label:text-is("Diff")`).count()) === 1, "…and works from there");
  await page.click(".session-bar-rail");
  await page.waitForTimeout(300);
  check((await page.locator(".session-card").count()) === 0,
    "Hiding the side panel doesn't bring it back to the body: it stays where it was put");
  await page.click(".session-bar-rail");
  await page.waitForTimeout(300);
  check((await page.locator(".rail-session-slot .session-card").count()) === 1, "…and it's there again with the panel");
  await page.screenshot({ path: `${SHOT}/48-card-in-rail.png` });

  // ---------- 6. The reorder cut line isn't clipped, top or left ----------
  await page.click('.rail-session-slot button:text-is("Stacked")');
  await page.waitForTimeout(300);
  const from = await page.locator(`${SHOWN} .aggregator-pane-header`).first().boundingBox();
  const to = await page.locator(`${SHOWN} .aggregator-pane`).nth(1).boundingBox();
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 60, to.y + 40, { steps: 12 });
  const offset = await page.locator(`${SHOWN} .aggregator-pane.drop-target`).evaluate((el) => parseFloat(getComputedStyle(el).outlineOffset));
  check(offset < 0, "The reorder cut line is drawn inside the pane, where nothing clips it", String(offset));
  await page.keyboard.press("Escape");
  await page.mouse.up();

  await page.click(".rail-session-slot .session-card-move");
  await page.waitForTimeout(300);
  check((await page.locator(CARD).count()) === 1, "Moved back, it's at the top of the body again");

  await clearWorkspace(page);
  await page.evaluate(async () => {
    localStorage.removeItem("cwi-panes-in-rail");
    for (const c of await (await fetch("/api/session-categories")).json()) {
      await fetch(`/api/session-categories/${c.id}`, { method: "DELETE" });
    }
  });
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
