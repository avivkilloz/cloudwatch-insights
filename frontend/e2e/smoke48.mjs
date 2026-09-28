// The shell without its header bar, and the session's own card in the side
// panel:
// - No header: the brand heads the side panel (the way home), or starts the
//   strip while the panel is hidden; the account is a card at the panel's foot,
//   or an avatar on the strip while it's hidden.
// - The docked agent panel's tabs sit level with the strip's tabs, and it has
//   no ✕ of its own (the strip's toggle hides it); floating, it keeps one.
// - Each tab has its ✕ again, and one ⋮ at the strip's end is for the session
//   on screen (the per-tab ⋮ was tried and put back).
// - A session's description: given when it's started, edited from the card
//   under the side panel, kept in the session.
// - The Panes card can move to the side panel, under that card, and back.
import { SHOWN, SHOT, TAB, check, clearWorkspace, launch, newSession, openApp, report } from "./harness.mjs";

const rect = (page, selector) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  });

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.evaluate(() => {
    localStorage.setItem("cwi-rail", "open");
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
    localStorage.removeItem("cwi-panes-in-rail");
  });
  await page.reload();
  await page.waitForSelector(".rail");

  // ---------- 1. No header bar: the brand and the account are in the side panel ----------
  check((await page.locator(".topbar").count()) === 0, "There is no header bar");
  const brandRow = page.locator(".rail > .rail-row-home.rail-brand");
  check((await brandRow.count()) === 1 && (await brandRow.innerText()).includes("Cloud Insights"),
    "The side panel's first row is the platform's logo and name", await brandRow.innerText());
  const [railCard, strip] = [await rect(page, ".rail"), await rect(page, ".session-bar")];
  check(Math.abs(railCard.top - 16) <= 1 && Math.abs(strip.top - 16) <= 1,
    "…and the panel and the strip start 16px from the top of the window", JSON.stringify({ railCard, strip }));
  const account = await rect(page, ".rail-account .user-menu-card");
  const height = await page.evaluate(() => window.innerHeight);
  check(Math.abs(height - account.bottom - 16) <= 1, "The account is a card fixed at the foot of the side panel",
    JSON.stringify({ bottom: account.bottom, height }));
  check((await page.locator(".rail-account .user-menu-card").innerText()).includes("admin"), "…showing who you are");
  await page.click(".user-menu-card");
  const items = await page.locator(".user-menu-popover .icon-popover-item").allInnerTexts();
  check(JSON.stringify(items) === JSON.stringify(["Settings", "Log out"]), "…and opens the account menu", JSON.stringify(items));
  const menu = await rect(page, ".user-menu-popover");
  check(menu.bottom <= account.top, "…upwards, since it's at the bottom", JSON.stringify({ menu, account }));
  await page.click('.user-menu-popover .icon-popover-item:text-is("Settings")');
  await page.waitForTimeout(300);
  await brandRow.click();
  await page.waitForTimeout(300);
  check((await page.locator(".home").count()) === 1 && (await brandRow.getAttribute("class")).includes("active"),
    "Clicking the brand takes you home");
  check((await page.locator(".session-bar-brand").count()) === 0, "With the panel shown, the strip has no logo of its own");

  // ---------- 2. With the panel hidden, the logo and the avatar start the strip ----------
  await page.click(".session-bar-rail");
  await page.waitForTimeout(200);
  const order = await page.locator(".session-bar > *").evaluateAll((els) => els.map((e) => e.className.split(" ")[0]));
  check(order[0] === "session-bar-brand" && order[1] === "icon-popover-wrap" && order[2] === "session-bar-rail",
    "Hiding the panel puts the logo, then the account, before the panel's toggle", JSON.stringify(order));
  await page.click(".session-bar [aria-label='Account menu']");
  check((await page.locator(".user-menu-popover").count()) === 1, "…and the account menu opens from there");
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 600);
  await page.click(".session-bar-rail");
  await page.waitForTimeout(200);

  // ---------- 3. A session's description, given when it's started ----------
  await brandRow.click();
  await page.fill('input[aria-label="Name for the new session"]', "Checkout errors");
  await page.fill('textarea[aria-label="Description for the new session"]', "Why checkout 500s since Tuesday");
  await page.click('.home-card:has(.home-card-title:text-is("CloudWatch")) button[title^="One more"]');
  await page.click(".home-create");
  await page.waitForSelector(TAB("Checkout errors"));
  await page.waitForTimeout(300);
  check((await page.locator(".page-info-description").innerText()) === "Why checkout 500s since Tuesday",
    "A description given when the session is started is shown under the side panel");
  await page.click(".page-info-edit");
  await page.fill(".page-info-description-input", "Checkout 500s since the Tuesday deploy");
  await page.press(".page-info-description-input", "Enter");
  check((await page.locator(".page-info-description").innerText()) === "Checkout 500s since the Tuesday deploy",
    "It can be edited there");
  await page.click(".page-info-edit");
  await page.fill(".page-info-description-input", "thrown away");
  await page.press(".page-info-description-input", "Escape");
  check((await page.locator(".page-info-description").innerText()) === "Checkout 500s since the Tuesday deploy",
    "…and Escape leaves it as it was");
  await page.waitForTimeout(1600);
  await page.reload();
  await page.waitForSelector(".page-info-description");
  check((await page.locator(".page-info-description").innerText()) === "Checkout 500s since the Tuesday deploy",
    "The description is kept in the session, through a reload");

  // ---------- 4. Tabs: a ✕ each, and one ⋮ for the session on screen ----------
  await newSession(page, "Base64");
  check((await page.locator(".session-tab .session-tab-close").count()) === 2 && (await page.locator(".session-tab-more").count()) === 0,
    "Every tab has its ✕, and no ⋮ of its own");
  const end = await page.locator(".session-bar-end > *").evaluateAll((els) => els.map((e) => e.className));
  check(end.length === 2 && end[0].includes("session-bar-more") && end[1].includes("session-bar-agent"),
    "One ⋮ at the strip's end, then the agent panel's toggle", JSON.stringify(end));
  check((await page.locator(".session-bar-more").getAttribute("aria-label")) === "More for Base64",
    "…and the ⋮ is for the session on screen");
  await page.click(".session-bar-more");
  const menuItems = await page.locator(".rail-row-menu button").allInnerTexts();
  check(JSON.stringify(menuItems) === JSON.stringify(["Rename", "Save as template…", "Delete"]),
    "It offers rename, save as template and delete", JSON.stringify(menuItems));
  await page.keyboard.press("Escape");
  const noDesc = await page.locator(".page-info-help").innerText();
  check(noDesc.includes("in one session"), "A session with no description says what's in it instead", noDesc);

  // ---------- 5. The agent panel's header, level with the strip ----------
  const [stripTab, agentTab] = [await rect(page, ".session-tab"), await rect(page, ".agent-dock .agent-tab")];
  check(Math.abs(stripTab.top - agentTab.top) <= 1 && Math.abs(stripTab.height - agentTab.height) <= 1,
    "The docked agent panel's tabs sit level with the strip's, the same height", JSON.stringify({ stripTab, agentTab }));
  check((await page.locator('.agent-dock [aria-label="Close the agent"]').count()) === 0,
    "Docked, it has no ✕ of its own -- the strip's toggle hides it");
  await page.click('.agent-dock .agent-icon-btn[aria-label="Float the agent over the page"]');
  await page.waitForSelector(".agent-float-panel");
  check((await page.locator('.agent-float-panel [aria-label="Close the agent"]').count()) === 1, "Floating, it keeps one");
  await page.click('.agent-float-panel [aria-label="Dock the agent beside the page"]');
  await page.waitForSelector(".agent-dock");
  await page.screenshot({ path: `${SHOT}/48-shell.png` });

  // ---------- 6. The Panes card, moved into the side panel and back ----------
  await page.click(`${SHOWN} .panes-card-move`);
  await page.waitForTimeout(300);
  check((await page.locator(".rail-session-slot .panes-card").count()) === 1 && (await page.locator(`${SHOWN} .panes-card`).count()) === 0,
    "The Panes card can move to the side panel");
  const [info, card] = [await rect(page, ".page-info"), await rect(page, ".rail-session-slot .panes-card")];
  check(card.top > info.bottom && card.top - info.bottom <= 17, "…under the session's title and description",
    JSON.stringify({ info, card }));
  await page.click('.rail-session-slot button[aria-label="Add Diff pane"]');
  await page.waitForTimeout(300);
  check((await page.locator(`${SHOWN} .aggregator-tab-label:text-is("Diff")`).count()) === 1, "…and works from there");
  await page.click(TAB("Checkout errors"));
  await page.waitForTimeout(300);
  const railCards = await page.locator(".rail-session-slot .panes-card").count();
  const offers = await page.locator('.rail-session-slot button[aria-label="Add Diff pane"]').count();
  check(railCards === 1 && offers === 1, "Switching sessions shows that session's card there, and only one", String(railCards));
  await page.screenshot({ path: `${SHOT}/48-panes-in-rail.png` });
  await page.reload();
  await page.waitForSelector(".rail-session-slot .panes-card");
  check(true, "Where the card goes is remembered in this browser");
  await page.click(".session-bar-rail");
  await page.waitForTimeout(300);
  check((await page.locator(`${SHOWN} .panes-card`).count()) === 1, "With the side panel hidden, the card is back above the panes");
  await page.click(".session-bar-rail");
  await page.waitForTimeout(300);
  await page.click(".rail-session-slot .panes-card-move");
  await page.waitForTimeout(300);
  check((await page.locator(".rail-session-slot .panes-card").count()) === 0 && (await page.locator(`${SHOWN} .panes-card`).count()) === 1,
    "…and it moves back from the side panel");
  const slotShown = await page.locator(".rail-session-slot").evaluate((el) => getComputedStyle(el).display);
  check(slotShown === "none", "An empty slot takes no room in the side panel", slotShown);

  await clearWorkspace(page);
  await page.evaluate(() => localStorage.removeItem("cwi-panes-in-rail"));
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
