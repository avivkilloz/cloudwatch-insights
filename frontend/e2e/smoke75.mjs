// Results in their own store (PLATFORM_PLAN.md D21) and auto-refresh (R4,
// §18.3), driven the way a user would, on the API table:
//   - a pane's refresh runs it again by itself, and a second tab watching the
//     same session follows the results without fetching the session again --
//     only the pane's outputs;
//   - two tabs watching cause one run per interval, not two;
//   - nobody looking (the session off screen) means no runs;
//   - the session's own refresh drives a pane that hasn't one of its own;
//   - a refresh that fails says why, in the pane;
//   - typing into an input while results arrive loses nothing.
//
// Needs the backend served as `uvicorn dev.fake_aws:app`: its `.fake` hosts
// answer the API table with what the suite puts there.
import { check, clearWorkspace, launch, newPage, newSession, openApp, openPaneMenu, report, ROW, SHOWN, signIn } from "./harness.mjs";

// The pane's own refresh is in its ⋮ menu.
const REFRESH = '.pane-menu-list select[aria-label="Refresh every"]';
async function setRefresh(page, value) {
  await openPaneMenu(page);
  await page.selectOption(REFRESH, value);
  await page.keyboard.press("Escape");
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const ROWS = [{ id: 1, status: "open" }, { id: 2, status: "paid" }];

async function outputs(page) {
  const [session] = (await api(page, "GET", "/live-sessions")).body;
  return { id: session.client_id, version: session.version, values: session.outputs?.["api-table"]?.values ?? {} };
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  for (const e of (await api(page, "GET", "/environments")).body ?? []) if (e.name === "e2e-refresh-api") await api(page, "DELETE", `/environments/${e.id}`);
  const env = (await api(page, "POST", "/environments", { name: "e2e-refresh-api" })).body;
  const conn = (await api(page, "POST", `/environments/${env.id}/connections`, {
    type_id: "http_api", name: "api", config: { base_url: "https://e2e-refresh.fake/v1" },
  })).body;
  check((await api(page, "PUT", `/dev/fake-http?path=${encodeURIComponent("/orders")}`, ROWS)).status === 200,
    "Precondition: the backend serves dev.fake_aws");

  await newSession(page, "API table");
  await page.waitForTimeout(800);
  await page.selectOption(`${SHOWN} select[aria-label="Connection"]`, String(conn.id));
  await page.fill(`${SHOWN} input[aria-label="Path"]`, "/orders");
  await page.click(`${SHOWN} button:text-is("Fetch")`);
  await page.waitForSelector(`${SHOWN} .manifest-table table`);
  await page.waitForTimeout(1500);
  const first = await outputs(page);
  check(first.values.resultsVersion === 1 && first.values.rows?.length === 2, "Precondition: one Fetch, stored for the pane", JSON.stringify(first.values));

  // ---- 1. the pane's own refresh; a second tab follows without refetching the session
  await openPaneMenu(page);
  const options = await page.locator(`${REFRESH} option`).allInnerTexts();
  await page.keyboard.press("Escape");
  check(options.includes("Every 10s") && options.includes("Off"), "The pane's ⋮ offers a refresh", JSON.stringify(options));
  const other = await newPage(browser);
  await signIn(other);
  await other.click(ROW("API table"));
  await other.waitForSelector(`${SHOWN} .manifest-table table`);
  const fetched = { session: 0, outputs: 0, ranItself: 0 };
  other.on("request", (r) => {
    if (/\/api\/live-sessions\/[^/?]+$/.test(r.url()) && r.method() === "GET") fetched.session++;
    if (/\/api\/live-sessions\/[^/]+\/outputs/.test(r.url())) fetched.outputs++;
  });
  // Both tabs' timers ask; whichever asks first runs it. A run the other tab
  // asked for comes back in its own answer, with the outputs, not as an event.
  other.on("response", async (r) => {
    if (!/\/api\/panes\/[^/]+\/refresh$/.test(r.url())) return;
    if ((await r.json().catch(() => null))?.refreshed) fetched.ranItself++;
  });
  await setRefresh(page, "10");
  const badge = await page.locator(`${SHOWN} .aggregator-tab.active .pane-refresh-on`).innerText().catch(() => "");
  check(badge === "↻ 10s", "…and once on, says so beside the ⋮", badge);
  const started = Date.now();
  await page.waitForTimeout(25_000);
  const after = await outputs(page);
  const ran = after.values.resultsVersion - first.values.resultsVersion;
  check(ran >= 1 && ran <= 2, "Two tabs watching, every 10 s for 25 s: one run per interval, not one per tab", `${ran} runs in ${Math.round((Date.now() - started) / 1000)}s`);
  // The session itself is written once -- the refresh setting -- and the
  // other tab fetches it once for that; every result is the pane's alone.
  check(after.version === first.version + 1, "The session itself moved only for the refresh setting, not for any result", `${first.version} → ${after.version}`);
  // Both runs can be the other tab's own, by the timers' jitter: then it had
  // nothing to fetch. That failed this check about one run in four.
  check(fetched.outputs + fetched.ranItself >= 1 && fetched.session <= after.version - first.version,
    "…and the other tab fetched only the pane's outputs for the results, never the whole session", JSON.stringify(fetched));

  // ---- 2. typing while results arrive
  const typed = "data.items.with.a.long.path";
  for (const ch of typed) {
    await page.type(`${SHOWN} input[aria-label="Rows at"]`, ch);
    await page.waitForTimeout(400);
  }
  check((await page.inputValue(`${SHOWN} input[aria-label="Rows at"]`)) === typed, "Typing through a refresh loses nothing", await page.inputValue(`${SHOWN} input[aria-label="Rows at"]`));
  await page.fill(`${SHOWN} input[aria-label="Rows at"]`, "");

  // ---- 3. nobody looking, no runs
  await other.close();
  await page.click(".rail-row-home");
  await page.waitForTimeout(500);
  const offScreen = (await page.locator(".session-body:not([hidden]) .manifest-table").count()) === 0;
  const hidden = await outputs(page);
  await page.waitForTimeout(15_000);
  const stillHidden = await outputs(page);
  check(offScreen && stillHidden.values.resultsVersion === hidden.values.resultsVersion,
    "With the session off screen, nothing refreshes", `${hidden.values.resultsVersion} → ${stillHidden.values.resultsVersion} (off screen: ${offScreen})`);
  await page.click(ROW("API table"));
  await page.waitForSelector(`${SHOWN} .manifest-table table`);

  // ---- 4. the session's refresh drives a pane without its own
  await setRefresh(page, "session");
  await page.selectOption(`${SHOWN} select[aria-label="Refresh panes every"]`, "10");
  const before = await outputs(page);
  await page.waitForTimeout(14_000);
  check((await outputs(page)).values.resultsVersion > before.values.resultsVersion, "The session's refresh runs a pane that follows it");
  await openPaneMenu(page);
  const label = await page.locator(`${REFRESH} option:checked`).innerText();
  await page.keyboard.press("Escape");
  check(label === "As the session (10s)", "…and the pane says it follows the session", label);

  // ---- 5. a failure says why
  await page.fill(`${SHOWN} input[aria-label="Path"]`, "/nothing-here");
  await page.waitForSelector(`${SHOWN} .pane-refresh-error`, { timeout: 25_000 });
  const failure = await page.locator(`${SHOWN} .pane-refresh-error`).innerText();
  check(failure.includes("Refreshing failed") && failure.includes("404"), "A refresh that fails says so in the pane, with the reason", failure);

  await page.selectOption(`${SHOWN} select[aria-label="Refresh panes every"]`, "0");
  await clearWorkspace(page);
  await api(page, "DELETE", `/environments/${env.id}`);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
