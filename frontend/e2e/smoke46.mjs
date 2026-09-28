// The agent panel as the place you work with the agent, and the shell around
// it:
// - Global and Session tabs: one conversation for the platform, and one per
//   session -- about that session, with the rows checked in its panes
//   attached, kept in the session (so it's still there after a reload), and
//   able to write a query into one of its panes. This is what the ✦ Ask AI
//   assistant did; it's gone.
// - The panel docked beside the page or floating over it, switched from its
//   own header, and shown or hidden from the end of the tab strip.
// - Each tab's ✕, and one ⋮ at the strip's end (rename, save as template,
//   delete) for the session on screen -- a ⋮ per tab was tried and put back.
// - One 16px gap between columns and cards, the dock included; every
//   scrollbar the same thin size; the rail and the dock resizable by
//   dragging the gap beside them.
//
// Needs the agent and the scripted stand-in model running, like smoke45.
import {
  SHOT, SHOWN, TAB, ROW, check, clearWorkspace, closeTab, launch, newSession, openApp, report, tabMenu,
} from "./harness.mjs";

const DOCK = ".agent-dock";
const lastTurn = (page, selector) => page.locator(`${DOCK} .agent-turn`).last().locator(selector);

async function askInDock(page, text) {
  await page.fill(`${DOCK} .agent-compose-input`, text);
  await page.press(`${DOCK} .agent-compose-input`, "Enter");
  await page.waitForSelector(`${DOCK} .agent-compose-actions button:text-is("Ask")`, { timeout: 30000 });
  await page.waitForTimeout(300);
}

const box = (page, selector) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, width: r.width };
});

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.evaluate(() => {
    for (const k of ["cwi-agent-open", "cwi-agent-layout", "cwi-rail-width", "cwi-agent-width"]) localStorage.removeItem(k);
  });
  await page.reload();
  await page.waitForSelector(".rail");

  // ---------- 1. The strip's far end shows and hides the agent panel ----------
  check((await page.locator(DOCK).count()) === 0, "The agent panel starts put away");
  check((await page.locator(".ai-widget-button, .ai-widget-panel").count()) === 0, "The old ✦ Ask AI assistant is gone");
  await page.click(".session-bar-agent");
  await page.waitForSelector(DOCK);
  check((await page.locator(".session-bar-agent").getAttribute("aria-expanded")) === "true",
    "The toggle at the end of the strip opens it, docked beside the page");
  const tabs = await page.locator(`${DOCK} .agent-tab`).allInnerTexts();
  check(JSON.stringify(tabs) === JSON.stringify(["Global", "Session"]), "It has a Global and a Session tab", JSON.stringify(tabs));
  await page.click(`${DOCK} .agent-tab:text-is("Session")`);
  const none = await page.locator(`${DOCK} .error-text`).allInnerTexts();
  check(none.some((t) => t.includes("Open a session")), "With no session on screen, the Session tab says to open one", JSON.stringify(none));

  // ---------- 2. A session's own chat, about rows checked in it ----------
  await newSession(page, "CloudWatch");
  await page.waitForTimeout(1600);
  await page.evaluate(async () => {
    const [row] = await (await fetch("/api/live-sessions")).json();
    const results = [{
      environment_id: 1, environment_name: "Demo", account_id: "1", region: "us-east-1", query_id: "q", status: "Complete",
      rows: [0, 1, 2].map((i) => [{ field: "@timestamp", value: `2024-01-01 00:00:0${i}` }, { field: "@message", value: `boom ${i}` }]),
      statistics: null, error: null,
    }];
    await fetch(`/api/live-sessions/${row.client_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Sync-Origin": "agent" },
      body: JSON.stringify({ ...row, state: { ...row.state, "logs-cloudwatch.results": results, "logs-cloudwatch.resultsVersion": 1 }, base_version: row.version }),
    });
  });
  await page.waitForSelector(`${SHOWN} .result-row`, { timeout: 10000 });
  const boxes = page.locator(`${SHOWN} .result-row input[type=checkbox]`);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const attach = await page.locator(`${DOCK} .agent-attach`).innerText();
  check(attach.includes("2 checked rows") && attach.includes("2 in CloudWatch"),
    "The Session tab offers to attach the rows checked in the session's panes", attach);
  await askInDock(page, "rows");
  const answer = await lastTurn(page, ".agent-answer").innerText();
  check(answer.includes("You attached 2 rows, from CloudWatch"), "The checked rows reach the agent with the question", answer);
  check((await lastTurn(page, ".agent-attached").innerText()).includes("2 rows"), "…and the question says what came attached");

  const before = (await page.evaluate(async () => (await (await fetch("/api/live-sessions")).json()).length));
  await askInDock(page, "query fields @message | limit 7");
  await page.waitForTimeout(1500);
  const query = await page.locator(`${SHOWN} [data-pane-id="logs-cloudwatch"] textarea`).first().inputValue();
  check(query === "fields @message | limit 7", "Asked for a query, the agent writes it into the session's own pane", JSON.stringify(query));
  const after = (await page.evaluate(async () => (await (await fetch("/api/live-sessions")).json()).length));
  check(after === before, "…in this session, without starting another one", JSON.stringify({ before, after }));

  await page.click(`${DOCK} .agent-tab:text-is("Global")`);
  check((await page.locator(`${DOCK} .agent-turn`).count()) === 0, "The session's chat isn't in the global one");
  await page.click(`${DOCK} .agent-tab:text-is("Session")`);

  // Kept in the session: back after a reload, and another session has its own.
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector(DOCK);
  await page.click(`${DOCK} .agent-tab:text-is("Session")`);
  await page.waitForTimeout(500);
  check((await page.locator(`${DOCK} .agent-turn`).count()) === 2, "A session's chat is still there after a reload");
  await newSession(page, "Base64");
  await page.waitForTimeout(300);
  check((await page.locator(`${DOCK} .agent-turn`).count()) === 0, "Another session has a chat of its own");
  await page.screenshot({ path: `${SHOT}/46-session-chat.png` });

  // ---------- 3. One gap everywhere, and thin scrollbars ----------
  await page.click(TAB("CloudWatch"));
  await page.waitForTimeout(300);
  const card = await box(page, `${SHOWN} .panel`);
  const dock = await box(page, `${DOCK} .agent-dock-panel`);
  const rail = await box(page, ".rail-column");
  const strip = await box(page, ".session-bar");
  check(Math.abs(dock.left - card.right - 16) <= 1, "The cards end 16px from the agent panel, as they do from each other",
    JSON.stringify({ card: card.right, dock: dock.left }));
  check(Math.abs(strip.left - rail.right - 16) <= 1, "…and start 16px from the side panel", JSON.stringify({ rail: rail.right, strip: strip.left }));
  const bar = await page.locator(".content").evaluate((el) => el.offsetWidth - el.clientWidth);
  check(bar === 6, "The body's scrollbar is the thin one every scrollbar uses", String(bar));
  await page.click(".session-bar-agent");
  await page.waitForTimeout(300);
  const alone = await box(page, `${SHOWN} .panel`);
  const width = await page.evaluate(() => window.innerWidth);
  check(Math.abs(width - alone.right - 16) <= 1, "With the panel put away, the cards end 16px from the window's edge",
    JSON.stringify({ right: alone.right, width }));
  await page.click(".session-bar-agent");
  await page.waitForSelector(DOCK);

  // ---------- 4. Floating instead of docked ----------
  await page.click(`${DOCK} .agent-icon-btn[aria-label="Float the agent over the page"]`);
  await page.waitForSelector(".agent-float-panel");
  check((await page.locator(DOCK).count()) === 0, "The panel can float over the page instead of docking beside it");
  await page.click('.agent-float-panel [aria-label="Close the agent"]');
  check((await page.locator(".agent-float-panel").count()) === 0 && (await page.locator(".agent-float-button").count()) === 1,
    "Put away, it leaves a button in the corner");
  await page.click(".agent-float-button");
  await page.waitForSelector(".agent-float-panel");
  await page.reload();
  await page.waitForSelector(".agent-float-panel");
  check(true, "The layout and whether it's open are remembered in this browser");
  await page.click('.agent-float-panel .agent-icon-btn[aria-label="Dock the agent beside the page"]');
  await page.waitForSelector(DOCK);

  // ---------- 5. Resizing the columns ----------
  const railBefore = (await box(page, ".rail-column")).width;
  const dockBefore = (await box(page, DOCK)).width;
  const drag = async (selector, dx) => {
    const r = await page.locator(selector).boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + 120);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + dx, r.y + 120, { steps: 6 });
    await page.mouse.up();
  };
  await page.hover(".rail-resizer");
  const line = await page.locator(".rail-resizer").evaluate((el) => getComputedStyle(el, "::before").borderLeftStyle);
  check(line === "dashed", "Over the gap beside a column, a dashed cut line shows where it can be dragged", line);
  await drag(".rail-resizer", 80);
  await drag(".agent-dock-resizer", -100);
  const railAfter = (await box(page, ".rail-column")).width;
  const dockAfter = (await box(page, DOCK)).width;
  check(Math.round(railAfter - railBefore) === 80, "Dragging the gap beside the side panel resizes it", JSON.stringify({ railBefore, railAfter }));
  check(Math.round(dockAfter - dockBefore) === 100, "…and the gap beside the agent panel resizes that", JSON.stringify({ dockBefore, dockAfter }));
  await page.reload();
  await page.waitForSelector(DOCK);
  check(Math.round((await box(page, ".rail-column")).width) === Math.round(railAfter), "The widths are remembered");
  await page.dblclick(".rail-resizer");
  check(Math.round((await box(page, ".rail-column")).width) === 212, "A double-click puts a column back to its usual width");

  // ---------- 6. Each tab's ✕, and the strip's one ⋮ ----------
  const tabCount = await page.locator(".session-tab").count();
  check(tabCount === 2 && (await page.locator(".session-tab .session-tab-close").count()) === tabCount,
    "Each tab has a ✕", String(tabCount));
  check((await page.locator(".session-tab-more").count()) === 0, "…and no ⋮ of its own");
  await page.click(`${TAB("CloudWatch")} .session-tab-label`);
  await page.click(".session-bar-more");
  const items = await page.locator(".rail-row-menu button").allInnerTexts();
  check(JSON.stringify(items) === JSON.stringify(["Rename", "Save as template…", "Delete"]),
    "The strip's ⋮ offers rename, save as template and delete", JSON.stringify(items));
  await page.click('.rail-row-menu button:text-is("Rename")');
  await page.fill(".session-tab-rename", "Renamed here");
  await page.press(".session-tab-rename", "Enter");
  check((await page.locator(TAB("Renamed here")).count()) === 1, "Rename works in place on the tab");
  await closeTab(page, "Renamed here");
  check((await page.locator(TAB("Renamed here")).count()) === 0, "The tab's ✕ takes it off the strip");
  check((await page.locator(`.rail-row-closed:has-text("Renamed here")`).count()) === 1, "…and it stays in the panel, closed");
  page.once("dialog", (d) => d.accept());
  await tabMenu(page, "Base64", "Delete");
  await page.waitForTimeout(500);
  check((await page.locator(TAB("Base64")).count()) === 0 && (await page.locator(ROW("Base64")).count()) === 0,
    "Delete from the strip's ⋮ throws the session away, after asking");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
