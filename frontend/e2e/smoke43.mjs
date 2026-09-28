// Several panes of one kind in a session, each with its own name.
//
// - The home page's cards take a count (− n +, 0 by default) instead of a
//   tick, so a session can start with two CloudWatch panes and an IoT one.
// - Inside a session the Panes card only *adds* ("+ CloudWatch"); a pane is
//   closed from its own ✕ -- its header's, or its tab's in the tabs layout.
// - Panes of one kind keep separate state, are named "CloudWatch",
//   "CloudWatch 2"..., and can be renamed (✎ in the header, double-click on a
//   tab). A closed pane's state goes with it, so one added later starts empty.
// - A session saved before any of this (pane id = type, no names) still opens.
import { SHOT, SHOWN, addPane, check, clearWorkspace, closePane, launch, newSession, openApp, report } from "./harness.mjs";

const CARD = (label) => `.home-card:has(.home-card-title:text-is("${label}"))`;
const PANE = (title) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${title}"))`;
const TAB = (title) => `${SHOWN} .aggregator-tab-label:text-is("${title}")`;

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  const tabs = () => page.locator(`${SHOWN} .aggregator-tab-label`).allInnerTexts();
  const headers = () => page.locator(`${SHOWN} .aggregator-pane-header h3`).allInnerTexts();
  const layoutTo = async (name) => {
    await page.click(`${SHOWN} .segmented[aria-label="Layout"] button:text-is("${name}")`);
    await page.waitForTimeout(250);
  };

  // ---------- 1. the home page counts instead of ticking ----------
  await page.click(".rail-row-home");
  await page.waitForSelector(".home-create");
  const count = (label) => page.locator(`${CARD(label)} input[type=number]`).inputValue();
  check((await page.locator(".home-card input[type=checkbox]").count()) === 0, "Home cards have no checkboxes any more");
  check((await count("CloudWatch")) === "0", "Every card starts at 0");
  check(await page.locator(`${CARD("CloudWatch")} button[aria-label="One fewer CloudWatch"]`).isDisabled(),
    "…with its − disabled at 0");
  await page.click(`${CARD("CloudWatch")} button[aria-label="One more CloudWatch"]`);
  await page.click(`${CARD("CloudWatch")} button[aria-label="One more CloudWatch"]`);
  await page.click(`${CARD("CloudWatch")} button[aria-label="One more CloudWatch"]`);
  await page.click(`${CARD("CloudWatch")} button[aria-label="One fewer CloudWatch"]`);
  check((await count("CloudWatch")) === "2", "+ and − step the count (3 up, 1 down = 2)", await count("CloudWatch"));
  await page.locator(`${CARD("IoT")} input[type=number]`).fill("1");
  check((await count("IoT")) === "1", "…and a number can be typed in directly");
  const summary = await page.locator('.home .panel:has(h2:text-is("New session")) > p.muted').last().innerText();
  check(summary.includes("3 panes"), "The summary counts panes, not cards", summary);
  await page.screenshot({ path: `${SHOT}/43-home-counts.png` });
  await page.click(".home-create");
  await page.waitForSelector(TAB("CloudWatch"), { timeout: 15000 });
  await page.waitForTimeout(300);
  check(JSON.stringify(await tabs()) === JSON.stringify(["CloudWatch", "CloudWatch 2", "IoT"]),
    "Create makes one pane per count, the second of a kind numbered", JSON.stringify(await tabs()));

  // ---------- 2. panes of one kind keep their own state ----------
  await layoutTo("Stacked");
  await page.locator(`${PANE("CloudWatch 2")} textarea`).first().fill("fields @message | limit 2");
  await page.waitForTimeout(200);
  const q1 = await page.locator(`${PANE("CloudWatch")} textarea`).first().inputValue();
  check(!q1.includes("limit 2"), "Typing in one CloudWatch pane leaves the other alone", JSON.stringify(q1));

  // ---------- 3. the Panes card only adds ----------
  // Scoped to the Panes card itself: the panes inside have checkboxes of their own.
  check((await page.locator(`${SHOWN} .session-card input[type=checkbox]`).count()) === 0,
    "The Panes card has no checkboxes -- nothing there can close a pane");
  await addPane(page, "CloudWatch");
  check((await headers()).includes("CloudWatch 3"), "+ CloudWatch adds another CloudWatch pane, numbered", JSON.stringify(await headers()));
  await addPane(page, "JWT");
  check((await headers()).includes("JWT"), "…and + JWT a JWT pane", JSON.stringify(await headers()));

  // ---------- 4. rename from the header ----------
  await page.click(`${PANE("CloudWatch 2")} button[aria-label="Rename CloudWatch 2"]`);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Prod errors");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check((await headers()).includes("Prod errors") && !(await headers()).includes("CloudWatch 2"),
    "✎ renames a pane in place", JSON.stringify(await headers()));
  check((await page.locator(`${PANE("Prod errors")} textarea`).first().inputValue()).includes("limit 2"),
    "…keeping what's in it");
  // Escape abandons an edit.
  await page.click(`${PANE("JWT")} button[aria-label="Rename JWT"]`);
  await page.keyboard.type("nope");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check((await headers()).includes("JWT"), "Escape cancels a rename", JSON.stringify(await headers()));
  const minimisedAfterRename = await page.locator(`${PANE("JWT")} button[aria-label="Expand JWT"]`).count();
  check(minimisedAfterRename === 0, "…and clicking into the name box doesn't also minimise the pane");

  // ---------- 5. rename from a tab (double-click) ----------
  await layoutTo("Tabs");
  await page.dblclick(TAB("CloudWatch 3"));
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Staging");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check((await tabs()).includes("Staging"), "Double-clicking a tab renames that pane", JSON.stringify(await tabs()));
  // A blank name goes back to the kind's own, numbered past the others.
  await page.dblclick(TAB("Staging"));
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check((await tabs()).includes("CloudWatch 2"), "A blank name falls back to the default (\"CloudWatch 2\" is free now)",
    JSON.stringify(await tabs()));
  await page.screenshot({ path: `${SHOT}/43-renamed-tabs.png` });

  // ---------- 6. close from the tab / the header; a new pane starts empty ----------
  await closePane(page, "Prod errors");
  check(!(await tabs()).includes("Prod errors"), "A tab's ✕ closes that pane", JSON.stringify(await tabs()));
  await layoutTo("Stacked");
  await page.locator(`${PANE("CloudWatch")} textarea`).first().fill("fields old | limit 9");
  await page.waitForTimeout(1500); // past the autosave debounce, so the state really is stored
  await closePane(page, "CloudWatch");
  check(!(await headers()).includes("CloudWatch"), "A header's ✕ closes that pane", JSON.stringify(await headers()));
  await addPane(page, "CloudWatch");
  // It reuses the freed name -- and the freed id, which is the case that
  // would have resurrected the old inputs.
  const fresh = await page.locator(`${PANE("CloudWatch")} textarea`).first().inputValue();
  check(!fresh.includes("limit 9"), "A pane added after closing one of its kind starts empty, not with the closed one's inputs",
    JSON.stringify(fresh));

  // ---------- 7. names and per-pane state survive a reload ----------
  await page.locator(`${PANE("CloudWatch 2")} textarea`).first().fill("fields kept | limit 3");
  await page.waitForTimeout(1800);
  const before = await headers();
  await page.reload();
  await page.waitForSelector(".rail");
  await page.waitForSelector(`${SHOWN} .aggregator-pane-header h3`, { timeout: 15000 });
  await page.waitForTimeout(500);
  check(JSON.stringify(await headers()) === JSON.stringify(before), "Pane names come back after a reload",
    JSON.stringify({ before, after: await headers() }));
  check((await page.locator(`${PANE("CloudWatch 2")} textarea`).first().inputValue()).includes("limit 3"),
    "…each with its own inputs");

  // ---------- 8. a session saved before panes had ids of their own ----------
  await clearWorkspace(page, [
    {
      client_id: "legacy-panes-43", type: "aggregator", title: "Legacy 43", position: 0, category_id: null, truncated: false,
      state: { services: ["logs-cloudwatch", "cognito"], layout: "stacked", "logs-cloudwatch.queryString": "fields legacy" },
    },
  ]);
  await page.reload();
  await page.waitForSelector(".rail");
  await page.waitForSelector('.rail-row:has(.rail-row-label:text-is("Legacy 43"))', { timeout: 15000 });
  await page.click('.rail-row:has(.rail-row-label:text-is("Legacy 43"))');
  await page.waitForSelector(`${SHOWN} .aggregator-pane-header h3`, { timeout: 15000 });
  await page.waitForTimeout(400);
  check(JSON.stringify(await headers()) === JSON.stringify(["CloudWatch", "Cognito"]),
    "An old session (pane id = type, no names) opens with its panes named by kind", JSON.stringify(await headers()));
  check((await page.locator(`${PANE("CloudWatch")} textarea`).first().inputValue()).includes("fields legacy"),
    "…and its inputs where they were");
  await addPane(page, "CloudWatch");
  check((await headers()).includes("CloudWatch 2"), "…and can take a second pane of a kind it already has",
    JSON.stringify(await headers()));
  await clearWorkspace(page);

  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
