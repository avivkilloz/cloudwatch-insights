// The Aggregator's third layout: one tab per pane, only the selected one shown,
// and every pane still mounted so nothing in flight is lost.
import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
const PANES = '.panel:has(h2:text-is("Panes"))';
const TAB = (l) => `.aggregator-tab:has(.aggregator-tab-label:text-is("${l}"))`;

/** Shown means shown, not just "the hidden attribute is absent": .aggregator-pane
 *  sets display:flex, which beats the browser's own [hidden] rule. */
const shownPanes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".aggregator-pane")]
      .filter((e) => getComputedStyle(e).display !== "none")
      .map((e) => e.dataset.paneId));
const mountedPanes = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".aggregator-pane")].map((e) => e.dataset.paneId));

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.addInitScript(() => { try { localStorage.setItem("cwi-rail-catalogue", "open"); } catch {} });
  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 15000 });
  await page.fill('input[autocomplete="username"]', ADMIN_USER);
  await page.fill('input[autocomplete="current-password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".rail", { timeout: 15000 });
  await page.evaluate(async () => {
    for (const u of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(u, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    await new Promise((r) => { const q = indexedDB.deleteDatabase("cloud-insights-sessions"); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  });
  await page.reload();
  await page.waitForSelector(".rail");

  await newSession(page);
  await page.waitForSelector(PANES);

  // ---------- it leads the two that were there ----------
  const layouts = await page.locator(`${PANES} .toolbar:has(span:text-is("Layout")) button`).allTextContents();
  check(JSON.stringify(layouts) === JSON.stringify(["Tabs", "Side by side", "Stacked"]),
    "Tabs is offered first, being what a session starts in", JSON.stringify(layouts));

  // A new session starts in tabs, which is what makes one pane read like a
  // page. This suite is about the three layouts, so it starts from the one
  // that shows everything at once.
  await page.click(`${PANES} button:text-is("Side by side")`);
  await page.waitForTimeout(250);
  check((await page.locator(".aggregator-tabs").count()) === 0, "No tab row in the other layouts");

  for (const l of ["CloudWatch", "IoT", "Base64"]) {
    await page.locator(`${PANES} label.checkbox-item:text-is("${l}") input`).check();
    await page.waitForTimeout(250);
  }
  check((await shownPanes(page)).length === 3, "Side by side shows all three panes");

  // ---------- one tab per pane, in pane order ----------
  await page.click('button:text-is("Tabs")');
  await page.waitForSelector(".aggregator-tabs");
  const tabs = await page.locator(".aggregator-tab-label").allTextContents();
  check(JSON.stringify(tabs) === JSON.stringify(["CloudWatch", "IoT", "Base64"]),
    "One tab per pane, in the order the panes are in", JSON.stringify(tabs));
  const inARow = await page.evaluate(() => {
    const t = [...document.querySelectorAll(".aggregator-tab")];
    return Math.abs(t[0].getBoundingClientRect().top - t[2].getBoundingClientRect().top) < 2;
  });
  check(inARow, "…laid out as a row, not a stack");

  // ---------- only the selected one is on screen ----------
  let shown = await shownPanes(page);
  check(shown.length === 1, "Only one pane is on screen", JSON.stringify(shown));
  check((await mountedPanes(page)).length === 3, "…while all three stay mounted");
  const active = await page.locator(".aggregator-tab.active .aggregator-tab-label").textContent();
  check(shown[0] === "tool-base64" && active === "Base64",
    "…the one whose tab is selected", `${JSON.stringify(shown)} / ${active}`);

  await page.click(`${TAB("IoT")} .aggregator-tab-label`);
  await page.waitForTimeout(300);
  shown = await shownPanes(page);
  check(JSON.stringify(shown) === JSON.stringify(["iot"]), "Choosing a tab swaps which pane shows", JSON.stringify(shown));
  check((await mountedPanes(page)).length === 3, "…and still none is thrown away");

  // ---------- a pane's own work survives being tabbed away from ----------
  await page.click(`${TAB("Base64")} .aggregator-tab-label`);
  await page.waitForTimeout(300);
  await page.fill('.aggregator-pane:not([hidden]) textarea', "typed while its tab was selected");
  await page.click(`${TAB("CloudWatch")} .aggregator-tab-label`);
  await page.waitForTimeout(300);
  await page.click(`${TAB("Base64")} .aggregator-tab-label`);
  await page.waitForTimeout(300);
  const kept = await page.locator('.aggregator-pane:not([hidden]) textarea').first().inputValue();
  check(kept === "typed while its tab was selected", "A pane keeps its state while another tab is showing", kept);

  // ---------- the tab is the pane's header ----------
  const chrome = await page.evaluate(() => ({
    headers: document.querySelectorAll(".aggregator-tabbed .aggregator-pane-header").length,
    closes: document.querySelectorAll(".aggregator-tab-close").length,
  }));
  check(chrome.headers === 0, "A tabbed pane has no title bar of its own — the tab is it", JSON.stringify(chrome));
  check(chrome.closes === 3, "…and each tab carries the ✕ that closes its pane", JSON.stringify(chrome));

  // ---------- closing from a tab ----------
  await page.click(`${TAB("IoT")} .aggregator-tab-close`);
  await page.waitForTimeout(400);
  check((await page.locator(".aggregator-tab-label").allTextContents()).join(",") === "CloudWatch,Base64",
    "The ✕ closes that pane");
  check((await page.locator(`${PANES} label.checkbox-item:text-is("IoT") input`).isChecked()) === false,
    "…and unticks it above, since they are the same thing");

  // Closing the selected one falls back rather than showing nothing.
  await page.click(`${TAB("Base64")} .aggregator-tab-label`);
  await page.waitForTimeout(250);
  await page.click(`${TAB("Base64")} .aggregator-tab-close`);
  await page.waitForTimeout(400);
  shown = await shownPanes(page);
  check(JSON.stringify(shown) === JSON.stringify(["logs-cloudwatch"]),
    "Closing the selected pane falls back to another rather than showing nothing", JSON.stringify(shown));

  // ---------- the choice is part of the session ----------
  await page.locator(`${PANES} label.checkbox-item:text-is("IoT") input`).check();
  await page.waitForTimeout(250);
  check((await shownPanes(page))[0] === "iot", "Ticking a service selects its tab, which is what ticking it meant");
  await page.click(`${TAB("CloudWatch")} .aggregator-tab-label`);
  await page.waitForTimeout(2200);
  await page.reload();
  await page.waitForSelector(".aggregator-tabs", { timeout: 15000 });
  await page.waitForTimeout(500);
  check((await page.locator(".aggregator-tab.active .aggregator-tab-label").textContent()) === "CloudWatch",
    "The layout and the chosen tab both come back after a reload");

  // ---------- and going back to side by side restores everything ----------
  await page.click('button:text-is("Side by side")');
  await page.waitForTimeout(400);
  check((await shownPanes(page)).length === 2, "Side by side shows both again");
  check((await page.locator(".aggregator-tabs").count()) === 0, "…and the tab row goes away with it");
  check((await page.locator(".aggregator-pane-header").count()) === 2, "…and the panes get their title bars back");

  await page.screenshot({ path: `${SHOT}/33-final.png` });
  await browser.close();
  report();
})();
