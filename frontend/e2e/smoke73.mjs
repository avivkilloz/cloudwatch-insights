// Two chart fixes and zooming by dragging, reported after 3b-4:
//   - Series offers only columns with few values: one with a value per row
//     (a message) as series drew a legend of whole rows over the chart;
//   - a time series over raw rows is folded into bars of one width ("Per
//     1h") instead of a spike per row;
//   - dragging across the histogram sets the pane's time range to what was
//     dragged and runs it again; Undo zoom goes back; a pane with no time
//     range (the API table) doesn't offer it.
//
// The CloudWatch half needs the backend served as `uvicorn dev.fake_aws:app`.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const ROWS_CARD = `${SHOWN} .panel:has(h2:text-is("Rows"))`;
const QUERY = `${SHOWN} .panel:has(h2:text-is("3. Query"))`;
const RESULTS = `${SHOWN} .panel:has(h2:text-is("4. Results"))`;

// 100 rows, each at its own minute, each with its own message.
const ROWS = Array.from({ length: 100 }, (_, i) => ({
  id: i,
  status: ["open", "paid", "refunded"][i % 3],
  message: `request ${i} took ${(i * 37) % 900} ms for customer ${1000 + i}`,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0) + i * 60_000).toISOString(),
}));

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  await page.route("**/api/panes/api-table/actions/fetch", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: ROWS, response: { items: ROWS } }) }),
  );

  // ---- 1. Series: few-valued columns only
  await newSession(page, "API table");
  await page.waitForTimeout(800);
  await page.click(`${SHOWN} button:text-is("Fetch")`);
  await page.waitForSelector(`${ROWS_CARD} [aria-label="Chart type"]`);
  await page.selectOption(`${ROWS_CARD} [aria-label="Chart type"]`, "timeseries");
  await page.waitForSelector(`${ROWS_CARD} [aria-label="Chart series"]`);
  const series = await page.locator(`${ROWS_CARD} [aria-label="Chart series"] option`).allTextContents();
  check(series.includes("status") && !series.includes("message"),
    "Series offers a column with few values, never one with a value per row", JSON.stringify(series));

  // ---- 2. raw rows over time, as bars of one width
  check((await page.inputValue(`${ROWS_CARD} [aria-label="Chart x"]`)) === "at", "Precondition: the time series is over the time column");
  check(await page.locator(`${ROWS_CARD} :text("Per 5m")`).isVisible(),
    "100 rows at their own minute are folded into bars of one width, and it says which",
    await page.locator(`${ROWS_CARD} .chart-section`).innerText());
  check(!(await page.locator(`${ROWS_CARD} :text("Drag across the chart to zoom in")`).count()),
    "A pane with no time range doesn't offer to zoom");

  // ---- 3. zoom by dragging across the histogram
  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const user = `e2e-zoom-${Date.now()}`;
  const group = (await api(page, "POST", "/user-groups", { name: `g-${user}`, role_name: "R", environment_ids: [env.id], logs_enabled: true })).body;
  await api(page, "POST", "/users", { username: user, password: "pw-123456", group_id: group.id });
  await clearWorkspace(page);
  const logs = await newPage(browser);
  await signIn(logs, { username: user, password: "pw-123456" });
  await newSession(logs, "CloudWatch");
  await logs.locator(`${SHOWN} .checkbox-item:has-text("e2e-fake-aws") input`).check();
  await logs.click(`${SHOWN} button:text-is("Load log groups")`);
  await logs.locator(`${SHOWN} .group-heading input[type=checkbox]`).check();
  await logs.locator(`${QUERY} label:has-text("Histogram") input`).check();
  const runs = [];
  logs.on("request", (r) => r.url().includes("/api/panes/logs-cloudwatch/actions/run") && runs.push(r.postDataJSON()));
  await logs.click(`${SHOWN} button:text-is("Run query")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Running…")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Run query")`, { timeout: 30000 });
  await logs.waitForSelector(`${RESULTS} .histogram canvas`);
  check(await logs.locator(`${RESULTS} :text("Drag across the chart to zoom in")`).isVisible(), "The histogram offers to zoom");
  const box = await logs.locator(`${RESULTS} .histogram .chart-box`).boundingBox();
  await logs.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await logs.mouse.down();
  await logs.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 8 });
  await logs.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
  await logs.mouse.up();
  await logs.waitForTimeout(800);
  const preset = await logs.locator(`${QUERY} select`).first().inputValue();
  const start = await logs.locator(`${QUERY} input[placeholder="YYYY-MM-DDTHH:mm"]`).nth(0).inputValue().catch(() => "");
  const end = await logs.locator(`${QUERY} input[placeholder="YYYY-MM-DDTHH:mm"]`).nth(1).inputValue().catch(() => "");
  const span = (Date.parse(end) - Date.parse(start)) / 1000;
  check(preset === "custom" && /T\d\d:\d\d:\d\d$/.test(start) && span > 60 && span < 600,
    "Dragging across it sets a custom range, to the second, about what was dragged", `${preset} ${start} → ${end}`);
  const zoomed = runs.at(-1)?.inputs ?? {};
  check(runs.length === 2 && zoomed.preset === "custom" && zoomed.customStart === start,
    "…and runs the query again over it", JSON.stringify(zoomed));
  await logs.waitForSelector(`${SHOWN} button:text-is("Run query")`, { timeout: 30000 });
  await logs.waitForTimeout(800);
  check(/per (1|5|10)s/.test(await logs.locator(`${RESULTS} .histogram`).innerText()),
    "The histogram's bars are narrower over the shorter range", await logs.locator(`${RESULTS} .histogram span.muted`).first().innerText());

  await logs.click(`${RESULTS} button:text-is("Undo zoom")`);
  await logs.waitForTimeout(800);
  check((await logs.locator(`${QUERY} select`).first().inputValue()) === "900" && runs.length === 3,
    "Undo zoom puts the range back and runs it again");
  check(!(await logs.locator(`${RESULTS} button:text-is("Undo zoom")`).count()), "…with nothing left to undo");

  await clearWorkspace(logs);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
