// Charts (PLATFORM_PLAN.md §16.11), driven the way a user would:
//   - a pane's rows charted from a type picker beside the card's title, its
//     x / y / series picked from the rows' own columns (D53); the chart
//     library isn't fetched until a chart is shown;
//   - a stat tile: one number, the rows folded;
//   - the chart is session state: another tab of the session shows it, and
//     a write from outside the page (as the agent's set_pane_view makes)
//     changes it in the pane;
//   - a chart naming a column the rows don't have says so;
//   - CloudWatch's Histogram, off by default, on counting every match over
//     time; a query with its own stats gets no histogram and says why, and
//     its results chart as a time series of their count (D52);
//   - OpenSearch's histogram, always there.
//
// The logs half needs the backend served as `uvicorn dev.fake_aws:app`
// (e2e/README.md), as smoke69 does.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, ROW, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Sync-Origin": "agent" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const ROWS_CARD = `${SHOWN} .panel:has(h2:text-is("Rows"))`;
const TYPE = (card) => `${card} [aria-label="Chart type"]`;
const RESULTS = `${SHOWN} .panel:has(h2:text-is("4. Results"))`;
const QUERY = `${SHOWN} .panel:has(h2:text-is("3. Query"))`;

const ROWS = [];
const regions = ["eu-west-1", "us-east-1", "ap-south-1"];
for (let i = 0; i < 24; i++) {
  ROWS.push({
    id: i,
    status: ["open", "paid", "refunded"][i % 3],
    region: regions[i % 3 === 0 ? 0 : (i % 2) + 1],
    total: ((i * 37) % 200) + 10,
    created: new Date(Date.UTC(2026, 0, 1 + (i % 8))).toISOString(),
  });
}
const SUM = ROWS.reduce((s, r) => s + r.total, 0);

async function hasDrawn(page, box) {
  // A canvas with something on it, not just a blank box.
  return page.locator(`${box} canvas`).first().evaluate((c) => {
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  }).catch(() => false);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  const chunks = [];
  page.on("request", (r) => {
    if (/echartsCore|node_modules\/echarts/.test(r.url())) chunks.push(r.url());
  });
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  // The rows from the backend served as dev.fake_aws (a `.fake` host answers
  // with what's put there): the server stores a pane's results itself (D21),
  // so a reply faked in this page would never reach the session's other tab.
  for (const e of (await api(page, "GET", "/environments")).body ?? [])
    if (e.name === "e2e-chart-api") await api(page, "DELETE", `/environments/${e.id}`);
  const apiEnv = (await api(page, "POST", "/environments", { name: "e2e-chart-api" })).body;
  const conn = (await api(page, "POST", `/environments/${apiEnv.id}/connections`, {
    type_id: "http_api", name: "api", config: { base_url: "https://e2e-chart.fake/v1" },
  })).body;
  await api(page, "PUT", `/dev/fake-http?path=${encodeURIComponent("/orders")}`, ROWS);

  // ---- 1. a chart picked beside the title, the library fetched only then
  await newSession(page, "API table");
  await page.waitForTimeout(800);
  await page.selectOption(`${SHOWN} select[aria-label="Connection"]`, String(conn.id));
  await page.fill(`${SHOWN} input[aria-label="Path"]`, "/orders");
  await page.click(`${SHOWN} button:text-is("Fetch")`);
  await page.waitForSelector(TYPE(ROWS_CARD));
  check((await page.inputValue(TYPE(ROWS_CARD))) === "" && (await page.locator(`${ROWS_CARD} .chart-section`).count()) === 0,
    "The Rows card offers a chart beside its title, none chosen, and adds no row for it");
  check(chunks.length === 0, "The chart library isn't fetched before a chart is shown", JSON.stringify(chunks));

  await page.selectOption(TYPE(ROWS_CARD), "timeseries");
  await page.waitForSelector(`${ROWS_CARD} .chart-box canvas`);
  check(chunks.length > 0, "…and is fetched when one is");
  check((await page.inputValue(`${ROWS_CARD} [aria-label="Chart x"]`)) === "created"
    && (await page.inputValue(`${ROWS_CARD} [aria-label="Chart y"]`)) === "total",
    "A time series starts over the time column, summing the first measure (not the id)");
  await page.selectOption(`${ROWS_CARD} [aria-label="Chart series"]`, "status");
  await page.waitForTimeout(600);
  check(await hasDrawn(page, ROWS_CARD), "It draws");

  await page.selectOption(TYPE(ROWS_CARD), "bar");
  await page.selectOption(`${ROWS_CARD} [aria-label="Chart x"]`, "region");
  await page.waitForTimeout(600);
  check(await hasDrawn(page, ROWS_CARD), "A bar chart by region draws");
  await page.selectOption(TYPE(ROWS_CARD), "pie");
  await page.waitForTimeout(600);
  check(await hasDrawn(page, ROWS_CARD), "…and a pie");

  // ---- 2. a stat tile
  await page.selectOption(TYPE(ROWS_CARD), "stat");
  await page.waitForSelector(`${ROWS_CARD} .stat-value`);
  check((await page.locator(`${ROWS_CARD} .stat-value`).textContent()) === SUM.toLocaleString(),
    "A stat tile folds the rows into one number", await page.locator(`${ROWS_CARD} .stat-value`).textContent());
  await page.selectOption(`${ROWS_CARD} [aria-label="Chart of"]`, "max");
  check((await page.locator(`${ROWS_CARD} .stat-value`).textContent()) === String(Math.max(...ROWS.map((r) => r.total))),
    "…by the aggregate picked");
  await page.selectOption(`${ROWS_CARD} [aria-label="Chart of"]`, "sum");

  // ---- 3. session state: another tab, and a write from outside the page
  await page.waitForTimeout(1800);
  const other = await newPage(browser);
  await signIn(other);
  await other.click(ROW("API table"));
  await other.waitForSelector(`${ROWS_CARD} .stat-value`, { timeout: 10000 }).catch(() => {});
  check((await other.locator(`${ROWS_CARD} .stat-value`).textContent().catch(() => "")) === SUM.toLocaleString(),
    "Another tab of the session shows the same chart");
  await other.close();

  const [row] = (await api(page, "GET", "/live-sessions")).body;
  const put = await api(page, "PUT", `/live-sessions/${row.client_id}`, {
    ...row, base_version: row.version,
    state: { ...row.state, "api-table.view.chart": { type: "stat", x: "", y: "count", agg: "count" } },
  });
  check(put.status === 200, "Precondition: a server-side write of the chart, as the agent's set_pane_view makes");
  let counted = "";
  for (let i = 0; i < 40 && counted !== "24"; i++) {
    counted = (await page.locator(`${ROWS_CARD} .stat-value`).textContent().catch(() => "")) ?? "";
    if (counted !== "24") await page.waitForTimeout(250);
  }
  check(counted === "24", "…and the pane follows it: the tile now counts the rows", counted);

  // ---- 4. a column the rows don't have
  const [again] = (await api(page, "GET", "/live-sessions")).body;
  await api(page, "PUT", `/live-sessions/${again.client_id}`, {
    ...again, base_version: again.version,
    state: { ...again.state, "api-table.view.chart": { type: "bar", x: "nope", y: "count", agg: "count" } },
  });
  await page.waitForSelector(`${ROWS_CARD} :text('There\\'s no column "nope"')`, { timeout: 10000 }).catch(() => {});
  check(await page.locator(`${ROWS_CARD} :text('There\\'s no column "nope"')`).isVisible().catch(() => false),
    "A chart naming a column the rows don't have says so");

  // ---- 5. CloudWatch's histogram, on request
  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const user = `e2e-charts-${Date.now()}`;
  const group = (await api(page, "POST", "/user-groups", {
    name: `g-${user}`, role_name: "R", environment_ids: [env.id], logs_enabled: true, opensearch_enabled: true,
  })).body;
  await api(page, "POST", "/users", { username: user, password: "pw-123456", group_id: group.id });
  await clearWorkspace(page);
  const logs = await newPage(browser);
  await signIn(logs, { username: user, password: "pw-123456" });
  await newSession(logs, "CloudWatch");
  await logs.locator(`${SHOWN} .checkbox-item:has-text("e2e-fake-aws") input`).check();
  await logs.click(`${SHOWN} button:text-is("Load log groups")`);
  await logs.locator(`${SHOWN} .group-heading input[type=checkbox]`).check();
  check(!(await logs.locator(`${QUERY} label:has-text("Histogram") input`).isChecked()), "CloudWatch's Histogram is off by default");
  await logs.click(`${SHOWN} button:text-is("Run query")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Running…")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Run query")`, { timeout: 30000 });
  check((await logs.locator(`${RESULTS} .histogram`).count()) === 0, "…so a run shows no histogram");

  await logs.locator(`${QUERY} label:has-text("Histogram") input`).check();
  await logs.click(`${SHOWN} button:text-is("Run query")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Running…")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Run query")`, { timeout: 30000 });
  await logs.waitForTimeout(800);
  const said = (await logs.locator(`${RESULTS} .histogram`).textContent().catch(() => "")) ?? "";
  const matches = Number((said.match(/([\d,]+) matches over time, per 30s/) ?? [])[1]?.replace(/,/g, "") ?? NaN);
  check(matches > 12, "On, it counts every match over time, beyond the rows listed", said);
  check(await hasDrawn(logs, `${RESULTS} .histogram`), "…drawn as bars");

  // ---- 6. a query with its own stats: no histogram, its results charted
  await logs.fill(`${QUERY} textarea`, "stats count(*) by bin(1m)");
  await logs.click(`${SHOWN} button:text-is("Run query")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Running…")`);
  await logs.waitForSelector(`${SHOWN} button:text-is("Run query")`, { timeout: 30000 });
  check((await logs.locator(`${RESULTS} .histogram`).textContent()).includes("its own stats"),
    "A query with its own stats gets no histogram, and the pane says why");
  await logs.selectOption(TYPE(RESULTS), "timeseries");
  await logs.waitForSelector(`${RESULTS} .chart-section:not(.histogram) canvas`);
  check((await logs.inputValue(`${RESULTS} [aria-label="Chart x"]`)) === "bin(1m)"
    && (await logs.inputValue(`${RESULTS} [aria-label="Chart y"]`)) === "count(*)",
    "…and its results chart as a time series of their count");
  await logs.waitForTimeout(600);
  check(await hasDrawn(logs, `${RESULTS} .chart-section:not(.histogram)`), "…which draws");

  // ---- 7. OpenSearch's histogram, always
  await newSession(logs, "OpenSearch");
  await logs.locator(`${SHOWN} .checkbox-item:has-text("e2e-fake-aws") input`).check();
  await logs.click(`${SHOWN} button:text-is("Load OpenSearch domains")`);
  await logs.click(`${SHOWN} button:text-is("Load indices")`);
  await logs.locator(`${SHOWN} .checkbox-item:has-text("app-logs") input`).check();
  await logs.click(`${SHOWN} button:text-is("Run query")`);
  await logs.waitForSelector(`${RESULTS} .histogram`, { timeout: 15000 }).catch(() => {});
  check(/matches over time, per 30s/.test((await logs.locator(`${RESULTS} .histogram`).textContent().catch(() => "")) ?? ""),
    "OpenSearch's search always counts its matches over time");

  await clearWorkspace(logs);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
