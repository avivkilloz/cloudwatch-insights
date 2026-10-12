// CloudWatch and OpenSearch drawn from their manifests (PLATFORM_PLAN.md
// §16.9), with a CloudWatch query run by the server and polled into the
// session (D51), driven the way a user would:
//   - the environments, then "Load log groups": each environment's groups
//     with a filter, and a select-all that takes only what the filter shows;
//   - choosing "Custom range…" starts at the last 15 minutes;
//   - Run sends the pane's inputs with its session, pane and time zone, and
//     the rows stream in while it runs (Running…, Stop) -- in a second tab
//     of the same session too, and after reloading mid-run, since it's the
//     server, not this page, that polls it;
//   - Stop from the other tab ends it in both, saying who stopped it;
//   - sorting, grouping, the limit and an expanded row: an expanded row is
//     session state (D48), so the other tab opens it too;
//   - a query AWS refuses is that environment's line in Target errors;
//   - OpenSearch: domains, then a domain's indices, then a search;
//   - a session the old page saved opens with its picks, query and results.
//
// Needs the backend served as `uvicorn dev.fake_aws:app` (e2e/README.md):
// AWS answers from there for an environment whose account starts "0000".
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, ROW, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const card = (title) => `${SHOWN} .panel:has(h2:text-is("${title}"))`;
const RESULTS = card("4. Results");
const QUERY = card("3. Query");
const COUNT = `${RESULTS} .toolbar .muted`;
const RUN = `${SHOWN} button:text-is("Run query")`;
const RUNNING = `${SHOWN} button:text-is("Running…")`;
const STOP = `${SHOWN} button:text-is("Stop")`;
// Enabled once the server's write of the run arrives, a moment after Run.
const STOPPABLE = `${STOP}:not([disabled])`;

async function waitRows(page, ok, timeout = 15000) {
  const until = Date.now() + timeout;
  let n = await rowCount(page);
  while (!ok(n) && Date.now() < until) {
    await page.waitForTimeout(250);
    n = await rowCount(page);
  }
  return n;
}

async function rowCount(page) {
  const text = (await page.locator(COUNT).first().textContent().catch(() => "")) ?? "";
  const m = text.match(/(\d+) row\(s\)/) ?? text.match(/of (\d+) row/);
  return m ? Number(m[1]) : 0;
}

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);

  // ---- an environment the fake answers for, and a user whose group reaches it
  let env = (await api(admin, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(admin, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const user = `e2e-logs-${Date.now()}`;
  const group = (await api(admin, "POST", "/user-groups", {
    name: `g-${user}`, role_name: "R", environment_ids: [env.id], logs_enabled: true, opensearch_enabled: true,
  })).body;
  check((await api(admin, "POST", "/users", { username: user, password: "pw-123456", group_id: group.id })).status === 201,
    "Precondition: a user whose group reaches the fake environment");
  const groups = await api(admin, "POST", "/panes/logs-cloudwatch/actions/list_log_groups", { inputs: { connections: [env.id] } });
  check(groups.body?.groups?.[0]?.items?.includes("/fake/api") || groups.body?.groups?.[0]?.error?.includes("no AWS role"),
    "Precondition: the backend answers from dev.fake_aws", JSON.stringify(groups.body));

  const page = await newPage(browser);
  await signIn(page, { username: user, password: "pw-123456" });
  const sent = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/panes/logs-cloudwatch/actions/run")) sent.push(r.postDataJSON());
  });

  // ---- 1. environments, then log groups
  await newSession(page, "CloudWatch");
  await page.locator(`${SHOWN} .checkbox-item:has-text("e2e-fake-aws") input`).check();
  await page.click(`${SHOWN} button:text-is("Load log groups")`);
  await page.waitForSelector(`${SHOWN} .checkbox-item:has-text("/fake/worker")`);
  check((await page.locator(`${SHOWN} .group-heading`).textContent()).includes("2 log group(s)"),
    "Load log groups lists the environment's groups under it");
  await page.fill(`${SHOWN} input[placeholder="Filter log groups…"]`, "api");
  await page.locator(`${SHOWN} .group-heading input[type=checkbox]`).check();
  check(await page.locator(`${SHOWN} :text("1 log group(s) selected")`).isVisible(),
    "Its select-all takes only the groups the filter shows");
  await page.fill(`${SHOWN} input[placeholder="Filter log groups…"]`, "");
  await page.locator(`${SHOWN} .checkbox-item:has-text("/fake/worker") input`).check();
  check(await page.locator(`${SHOWN} :text("2 log group(s) selected")`).isVisible(), "…and a group can be ticked by hand");

  // ---- 2. the time range
  await page.locator(`${QUERY} select`).first().selectOption("custom");
  const start = await page.locator(`${QUERY} input[placeholder="YYYY-MM-DDTHH:mm"]`).nth(0).inputValue();
  const end = await page.locator(`${QUERY} input[placeholder="YYYY-MM-DDTHH:mm"]`).nth(1).inputValue();
  const minutes = (Date.parse(end) - Date.parse(start)) / 60000;
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(start) && minutes === 15, "Custom range… starts at the last 15 minutes", `${start} → ${end}`);
  await page.locator(`${QUERY} select`).first().selectOption("900");

  // ---- 3. a run the server polls: streaming, a second tab, a reload
  await page.fill(`${QUERY} textarea`, "fields @timestamp, @log, @message #slow");
  await page.click(RUN);
  await page.waitForSelector(RUNNING);
  await page.waitForSelector(STOPPABLE);
  check(await page.locator(RUNNING).isVisible(), "Running, the button says so and Stop is offered");
  const body = sent.at(-1) ?? {};
  check(body.session && body.pane === "logs-cloudwatch" && body.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone
    && body.inputs?.queryString?.includes("#slow") && body.inputs?.logGroupSelection?.[env.id]?.length === 2,
    "Run sends the inputs with the session, the pane and the time zone", JSON.stringify(body));
  const first = await waitRows(page, (n) => n > 0);
  await page.waitForTimeout(4500);
  const later = await rowCount(page);
  check(first > 0 && later > first, "Rows stream in while it runs", `${first} then ${later}`);

  const other = await newPage(browser);
  await signIn(other, { username: user, password: "pw-123456" });
  await other.click(ROW("CloudWatch"));
  await other.waitForSelector(RUNNING);
  await other.waitForSelector(STOPPABLE);
  check(true, "A second tab of the session shows it running, Stop offered");
  const there = await rowCount(other);
  await other.waitForTimeout(4500);
  check((await rowCount(other)) > there, "…with the rows streaming in there too");

  await page.reload();
  await page.waitForSelector(RUNNING);
  await page.waitForSelector(STOPPABLE);
  const reloaded = await rowCount(page);
  await page.waitForTimeout(4500);
  check((await rowCount(page)) > reloaded, "Reloaded mid-run, the page finds it still running and the rows still coming");

  await other.click(STOP);
  await page.waitForSelector(RUN);
  check(await page.locator(`${SHOWN} :text("Stopped by ${user}.")`).isVisible(), "Stop in one tab ends it in both, saying who");
  check(!(await page.locator(STOP).isEnabled()), "…and Stop is off again");
  const stoppedAt = await rowCount(page);
  await page.waitForTimeout(3000);
  check((await rowCount(page)) === stoppedAt, "…and nothing more arrives");

  // ---- 4. a run that finishes, and how its results are shown
  await page.fill(`${QUERY} textarea`, "fields @timestamp, @log, @message");
  await page.click(RUN);
  await page.waitForSelector(RUNNING);
  await page.waitForSelector(RUN, { timeout: 30000 });
  check((await rowCount(page)) === 12, "A query that finishes leaves all its rows", String(await rowCount(page)));
  check(!(await page.locator(`${SHOWN} :text("Stopped by")`).isVisible()), "…and the last run's Stopped note goes");
  const firstMessage = () => page.locator(`${RESULTS} .result-row .msg`).first().textContent();
  check((await firstMessage()) === "/fake/api message 1", "Newest first by default", await firstMessage());
  await page.locator(`${QUERY} label:has-text("Sort by") select`).first().selectOption("@message");
  await page.locator(`${QUERY} label:has-text("Sort by") select`).nth(1).selectOption("asc");
  check((await firstMessage()) === "/fake/api message 1" && (await page.locator(`${RESULTS} .result-row .msg`).last().textContent()) === "/fake/worker message 6",
    "Sort by a field, ascending");
  await page.locator(`${QUERY} label:has-text("Sort by") select`).first().selectOption("@timestamp");
  await page.locator(`${QUERY} label:has-text("Sort by") select`).nth(1).selectOption("desc");
  await page.locator(`${RESULTS} label:has-text("Group by") select`).selectOption("log");
  check((await page.locator(`${RESULTS} h3`).allTextContents()).join("|") === "/fake/api|/fake/worker", "Group by log group");
  await page.locator(`${RESULTS} label:has-text("Group by") select`).selectOption("none");
  await page.fill(`${QUERY} input[type=number]`, "3");
  check(await page.locator(`${RESULTS} :text("Showing most recent 3 of 12 row(s) across 1 target(s)")`).isVisible(),
    "The limit caps the merged rows, most recent first");
  await page.fill(`${QUERY} input[type=number]`, "100");
  await page.locator(`${RESULTS} .result-row-summary`).first().click();
  check(await page.locator(`${RESULTS} .result-row-detail td:text-is("@ptr")`).isVisible(), "A row expands to every field");
  await other.waitForSelector(`${RESULTS} .result-row-detail td:text-is("@ptr")`, { timeout: 10000 }).catch(() => {});
  check(await other.locator(`${RESULTS} .result-row-detail`).count() === 1, "…and the other tab opens it too (session state)");
  await other.close();

  // ---- 5. a query AWS refuses
  await page.fill(`${QUERY} textarea`, "fields @message #fail");
  await page.click(RUN);
  await page.waitForSelector(`${RESULTS} h3:text-is("Target errors")`, { timeout: 20000 });
  check((await page.locator(`${RESULTS} .error-text`).first().textContent()).includes("e2e-fake-aws: ")
    && (await page.locator(`${RESULTS} .error-text`).first().textContent()).includes("MalformedQueryException"),
    "A query AWS refuses is that environment's line in Target errors");
  await page.waitForSelector(RUN, { timeout: 20000 });

  // ---- 6. OpenSearch: domains, then indices, then a search
  await newSession(page, "OpenSearch");
  await page.locator(`${SHOWN} .checkbox-item:has-text("e2e-fake-aws") input`).check();
  await page.click(`${SHOWN} button:text-is("Load OpenSearch domains")`);
  await page.click(`${SHOWN} button:text-is("Load indices")`);
  await page.waitForSelector(`${SHOWN} .checkbox-item:has-text("app-logs")`);
  check((await page.locator(`${SHOWN} .checkbox-item:has-text("app-logs")`).textContent()).includes("(1200 docs)"),
    "A domain's indices are listed with their document counts");
  await page.locator(`${SHOWN} .checkbox-item:has-text("app-logs") input`).check();
  await page.locator(`${SHOWN} .checkbox-item:has-text("audit") input`).check();
  check(await page.locator(`${SHOWN} :text("2 index/indices selected")`).isVisible(), "…and ticked one by one");
  await page.click(RUN);
  check((await waitRows(page, (n) => n === 6)) === 6, "OpenSearch's search fills its results");
  check(await page.locator(`${RESULTS} .tag:text-is("fake-domain/audit")`).first().isVisible(), "A search shows its hits, tagged with their index");

  // ---- 7. a session the old page saved
  await clearWorkspace(page);
  const put = await api(page, "PUT", "/live-sessions/e2e-old-logs", {
    title: "Old logs", type: "aggregator", base_version: null,
    state: {
      services: ["logs-cloudwatch"], layout: "tabs",
      "logs-cloudwatch.selectedEnvironmentIds": { __cwiSet: [env.id] },
      "logs-cloudwatch.logGroupSelection": { [env.id]: { __cwiSet: ["/fake/api"] } },
      "logs-cloudwatch.queryString": "fields @message | limit 5",
      "logs-cloudwatch.results": [{ environment_id: env.id, environment_name: "e2e-fake-aws", query_id: "q", status: "Complete",
        rows: [[{ field: "@timestamp", value: "2025-01-01 00:00:00.000" }, { field: "@message", value: "from the old page" }]], error: null }],
      "logs-cloudwatch.ranAt": Date.now() - 3600_000, "logs-cloudwatch.resultsVersion": 2, "logs-cloudwatch.startedQueries": [],
    },
  });
  check(put.status === 200 && put.body.state["logs-cloudwatch.in.queryString"] === "fields @message | limit 5"
    && put.body.state["logs-cloudwatch.out.results"] && !("logs-cloudwatch.startedQueries" in put.body.state),
    "The server moves an old CloudWatch session to the new keys", JSON.stringify(Object.keys(put.body?.state ?? {})));
  await page.reload();
  await page.click('.rail-row:has(.rail-row-label:text-is("Old logs"))');
  await page.waitForSelector(`${RESULTS} .msg:text-is("from the old page")`);
  check(await page.locator(`${SHOWN} .checkbox-item:has-text("e2e-fake-aws") input`).isChecked(), "It opens with its environment ticked");
  check(await page.locator(`${SHOWN} :text("1 log group(s) selected")`).isVisible(), "…its log group picked");
  check((await page.inputValue(`${QUERY} textarea`)) === "fields @message | limit 5", "…its query");
  check(await page.locator(`${SHOWN} :text("Showing results fetched")`).first().isVisible(), "…and its results, said to be restored");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
