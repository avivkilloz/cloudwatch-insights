// CloudWatch and OpenSearch are separate group permissions, and a saved item's
// collapsed row shows its name rather than its JSON.
import { BASE, SHOT, check, launch, report } from "./harness.mjs";
const SAVED = '.panel:has(h2:text-is("Saved items"))';
const GROUP = "Smoke CW only";
const USER = "smokecw";

async function login(browser, username, password) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.addInitScript(() => { try { localStorage.setItem("cwi-rail-catalogue", "open"); } catch {} });
  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 15000 });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="current-password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".rail", { timeout: 15000 });
  return page;
}

async function openSettings(page, section) {
  await page.click(".rail-row-home");
  await page.click('.home-card:has(.home-card-title:text-is("Settings")) .home-card-open');
  await page.waitForSelector(`.tab:text-is("${section}")`, { timeout: 15000 });
  await page.click(`.tab:text-is("${section}")`);
}

const run = async () => {
  const browser = await launch();
  const page = await login(browser, "admin", "SmokeTestPass123!");

  // Leftovers from an earlier run, so the group name is free to create again.
  await page.evaluate(async ([group, user]) => {
    for (const u of await (await fetch("/api/users", { credentials: "same-origin" })).json()) {
      if (u.username === user) await fetch(`/api/users/${u.id}`, { method: "DELETE", credentials: "same-origin" });
    }
    for (const g of await (await fetch("/api/user-groups", { credentials: "same-origin" })).json()) {
      if (g.name === group) await fetch(`/api/user-groups/${g.id}`, { method: "DELETE", credentials: "same-origin" });
    }
  }, [GROUP, USER]);

  // ---------- 1. two permissions, not one ----------
  await openSettings(page, "User groups");
  await page.waitForSelector('.field-label:text-is("Visible tabs")', { timeout: 15000 });
  const toggles = await page.locator('.row:has(> .checkbox-item) .checkbox-item').allInnerTexts();
  const names = toggles.map((t) => t.trim());
  check(names.includes("CloudWatch") && names.includes("OpenSearch"),
    "The group form offers CloudWatch and OpenSearch separately", JSON.stringify(names));
  check(!names.some((n) => n.includes("+")), "…and nothing is offered as a pair", JSON.stringify(names));
  await page.screenshot({ path: `${SHOT}/36-groups.png` });

  // A group with one and not the other -- which the old single flag could not say.
  await page.fill('input[placeholder="Group name"], .panel input[type=text]', GROUP).catch(() => {});
  const nameBox = page.locator('.panel:has(.field-label:text-is("Visible tabs")) input[type=text]').first();
  await nameBox.fill(GROUP);
  await page.locator('.checkbox-item:has-text("OpenSearch") input[type=checkbox]').uncheck();
  await page.click('button:text-is("Add group"), button:text-is("Create group"), button:text-is("Save group")');
  await page.waitForTimeout(800);
  const stored = await page.evaluate(async (group) => {
    const list = await (await fetch("/api/user-groups", { credentials: "same-origin" })).json();
    const g = list.find((x) => x.name === group);
    return g && { logs: g.logs_enabled, opensearch: g.opensearch_enabled };
  }, GROUP);
  check(stored && stored.logs === true && stored.opensearch === false,
    "A group can have CloudWatch without OpenSearch", JSON.stringify(stored));

  // And the pane list that user sees follows the two flags independently.
  await page.evaluate(async ([group, user]) => {
    const list = await (await fetch("/api/user-groups", { credentials: "same-origin" })).json();
    const g = list.find((x) => x.name === group);
    await fetch("/api/users", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: "SmokePass123!", group_id: g.id }),
    });
  }, [GROUP, USER]);

  const theirs = await login(browser, USER, "SmokePass123!");
  const cards = await theirs.locator(".home-card-title").allInnerTexts();
  check(cards.includes("CloudWatch"), "That group sees CloudWatch", JSON.stringify(cards));
  check(!cards.includes("OpenSearch"), "…and not OpenSearch", JSON.stringify(cards));
  await theirs.context().close();

  // ---------- 2. a saved row reads as its name ----------
  await page.evaluate(async () => {
    // A run that failed part-way leaves its template behind, and two rows with
    // one name make every selector below ambiguous.
    for (const s of await (await fetch("/api/saved-sessions?page=aggregator", { credentials: "same-origin" })).json()) {
      if (s.name === "Readable template") {
        await fetch(`/api/saved-sessions/${s.id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    await fetch("/api/saved-sessions", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: "aggregator", name: "Readable template",
        state: { services: ["logs-cloudwatch", "cognito"], layout: "tabs", "logs-cloudwatch.queryString": "fields @message" },
      }),
    });
  });
  await page.reload();
  await page.waitForSelector(".rail", { timeout: 15000 });
  await openSettings(page, "Saved");
  const row = `${SAVED} .result-row:has(.msg:text-is("Readable template"))`;
  await page.waitForSelector(row, { timeout: 15000 });
  const collapsed = (await page.locator(`${row} .result-row-summary`).innerText()).trim();
  check(!collapsed.includes("{"), "A collapsed template row shows no JSON", JSON.stringify(collapsed));
  check(collapsed.includes("Readable template"), "…just its name", JSON.stringify(collapsed));
  // The name is readable, not elided to nothing by a summary beside it.
  const nameWidth = await page.locator(`${row} .msg`).evaluate((el) => Math.round(el.getBoundingClientRect().width));
  check(nameWidth > 100, "…at a width you can actually read", `${nameWidth}px`);
  await page.screenshot({ path: `${SHOT}/36-saved-collapsed.png` });

  await page.click(`${row} .result-row-summary`);
  await page.waitForSelector(`${row} .result-row-detail`, { timeout: 15000 });
  const detail = await page.locator(`${row} .result-row-detail pre`).innerText();
  check(detail.includes('"services"') && detail.includes("logs-cloudwatch"),
    "Expanding it shows the JSON, editable as before", detail.slice(0, 80));
  await page.screenshot({ path: `${SHOT}/36-saved-expanded.png` });

  // An HTTP request keeps its short summary -- that one says something.
  await page.click(`${SAVED} .tab:text-is("HTTP Requests")`);
  await page.waitForTimeout(400);
  const httpRows = await page.locator(`${SAVED} .result-row-summary`).allInnerTexts();
  check(httpRows.length === 0 || httpRows.some((t) => /GET|POST|PUT|DELETE/.test(t)),
    "HTTP requests still show method and URL beside the name", JSON.stringify(httpRows.slice(0, 2)));

  // Tidy up after the run.
  await page.evaluate(async ([group, user]) => {
    for (const s of await (await fetch("/api/saved-sessions?page=aggregator", { credentials: "same-origin" })).json()) {
      if (s.name === "Readable template") await fetch(`/api/saved-sessions/${s.id}`, { method: "DELETE", credentials: "same-origin" });
    }
    for (const u of await (await fetch("/api/users", { credentials: "same-origin" })).json()) {
      if (u.username === user) await fetch(`/api/users/${u.id}`, { method: "DELETE", credentials: "same-origin" });
    }
    for (const g of await (await fetch("/api/user-groups", { credentials: "same-origin" })).json()) {
      if (g.name === group) await fetch(`/api/user-groups/${g.id}`, { method: "DELETE", credentials: "same-origin" });
    }
  }, [GROUP, USER]);

  await browser.close();
  report();
};
run().catch((e) => { console.log("SMOKE TEST FAILED:", e.message); process.exit(1); });
