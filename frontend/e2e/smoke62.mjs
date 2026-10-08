// The API table (PLATFORM_PLAN.md §15.7): a pane that exists only as a YAML
// manifest, drawn by the generic renderer, driven the way a user would:
//   - the catalogue offers it among the tools, with no component of its own;
//   - its connection picker offers HTTP API connections, never AWS ones;
//   - Fetch sends the connection's id, the path, the query rows and where the
//     rows are -- and the backend's own sentence comes back when the host
//     can't be reached (this sandbox has no DNS: the request path itself is
//     covered by backend/tests/test_pane_manifests.py);
//   - with a reply, the rows are a table of every column; checking rows makes
//     Export about them and offers them to the agent;
//   - inputs and rows are the session's: they come back after a reload, under
//     the v2 keys.
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

const ENV = "e2e-Partner";
const BASE_URL = "https://e2e-partner.invalid/v1";

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

async function cleanUp(page) {
  for (const e of (await api(page, "GET", "/environments")).body ?? [])
    if (e.name.startsWith("e2e-")) await api(page, "DELETE", `/environments/${e.id}`);
}

const ROWS = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  customer: `Customer ${i + 1}`,
  total: (i + 1) * 10.5,
  address: { city: "Haifa", street: `Street ${i}` },
}));

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await cleanUp(page);
  const env = (await api(page, "POST", "/environments", { name: ENV, account_id: "111122223333", region: "eu-west-1" })).body;
  const conn = (await api(page, "POST", `/environments/${env.id}/connections`, {
    type_id: "http_api", name: "api", config: { base_url: BASE_URL },
  })).body;

  // ---- 1. offered, and drawn from its manifest
  const types = (await api(page, "GET", "/pane-types")).body.map((m) => m.id);
  check(types.includes("api-table"), "The API table is one of the pane types the server describes", JSON.stringify(types));
  await newSession(page, "API table");
  await page.waitForSelector(`${SHOWN} .panel h2:text-is("Request")`);
  check(true, "A session holding it draws its Request card");

  // ---- 2. the picker offers HTTP API connections only
  const picker = `${SHOWN} select[aria-label="Connection"]`;
  await page.waitForSelector(`${picker} option:has-text("${ENV}")`, { state: "attached" });
  const options = await page.locator(`${picker} option`).allInnerTexts();
  // Its environment's only HTTP API connection, so it goes by the environment's name.
  check(options.some((o) => o === `${ENV} (${BASE_URL})`), "The picker offers the HTTP API connection, with its base URL", JSON.stringify(options));
  check(!options.some((o) => o.includes("111122223333")), "…and not the environment's AWS connection", JSON.stringify(options));

  // ---- 3. Fetch, as the backend answers it
  const sent = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/panes/api-table/actions/fetch")) sent.push(JSON.parse(req.postData() ?? "{}"));
  });
  await page.selectOption(picker, String(conn.id));
  await page.fill(`${SHOWN} input[aria-label="Path"]`, "/orders");
  await page.click(`${SHOWN} button[aria-label="Add a row to Query"]`);
  await page.fill(`${SHOWN} input[aria-label="Query name"]`, "status");
  await page.fill(`${SHOWN} input[aria-label="Query value"]`, "open");
  await page.fill(`${SHOWN} input[aria-label="Rows at"]`, "data.items");
  await page.click(`${SHOWN} button:text-is("Fetch")`);
  await page.waitForSelector(`${SHOWN} .error-text`, { timeout: 40000 });
  check(
    JSON.stringify(sent[0]) ===
      JSON.stringify({ inputs: { connection: conn.id, path: "/orders", query: [{ id: 1, key: "status", value: "open" }], rowsAt: "data.items" } }),
    "Fetch sends the connection's id, the path, the query rows and where the rows are",
    JSON.stringify(sent),
  );
  const error = await page.locator(`${SHOWN} .error-text`).innerText();
  check(error.includes("e2e-partner.invalid"), "An unreachable host is the backend's own readable sentence", error);

  // ---- 4. a reply, as rows
  await page.route("**/api/panes/api-table/actions/fetch", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: ROWS, response: { data: { items: ROWS } } }) }),
  );
  await page.click(`${SHOWN} button:text-is("Fetch")`);
  await page.waitForSelector(`${SHOWN} .manifest-table table`);
  const headers = await page.locator(`${SHOWN} .manifest-table th`).allInnerTexts();
  check(JSON.stringify(headers.filter(Boolean)) === JSON.stringify(["id", "customer", "total", "address"]),
    "The rows are a table of every column", JSON.stringify(headers));
  check((await page.locator(`${SHOWN} .manifest-table tbody tr`).count()) === 12, "…one line per row");
  check(!(await page.locator(`${SHOWN} .error-text`).isVisible()), "…and the earlier error is gone");
  const address = await page.locator(`${SHOWN} .manifest-table tbody tr`).first().locator("td").last().innerText();
  check(address === '{"city":"Haifa","street":"Street 0"}', "A nested value is shown as compact JSON", address);

  await page.click(`${SHOWN} .manifest-table input[aria-label="Select row 2"]`);
  await page.click(`${SHOWN} .manifest-table input[aria-label="Select row 5"]`);
  const counts = await page.locator(`${SHOWN} .manifest-table .toolbar .muted`).innerText();
  check(counts.includes("12 rows, 2 selected"), "Checking rows counts them", counts);
  check(await page.locator(`${SHOWN} .manifest-table button:has-text("Export 2 selected")`).isVisible(), "…and Export is about them");
  if ((await page.locator(".agent-dock").count()) === 0) await page.click(".session-bar-agent");
  await page.click('.agent-dock .agent-tab:text-is("Session")');
  const offered = await page.locator(".agent-dock .agent-attach").innerText();
  check(offered.includes("2 checked rows") && offered.includes("2 in API table"),
    "…and the agent's Session tab offers them, by the pane's name", offered);

  // ---- 5. the session keeps them
  await page.waitForTimeout(2000); // the debounced save
  const live = (await api(page, "GET", "/live-sessions")).body[0];
  check(live.state["api-table.in.path"] === "/orders" && live.state["api-table.out.rows"]?.length === 12,
    "Inputs and rows are saved under the v2 keys", JSON.stringify(Object.keys(live.state)));
  check(!("api-table.out.response" in live.state) || live.state["api-table.out.resultsVersion"] === 1,
    "…with the run's results version beside them", String(live.state["api-table.out.resultsVersion"]));
  await page.unroute("**/api/panes/api-table/actions/fetch");
  await page.reload();
  await page.waitForSelector(`${SHOWN} .manifest-table table`);
  check((await page.locator(`${SHOWN} input[aria-label="Path"]`).inputValue()) === "/orders" &&
    (await page.locator(`${SHOWN} .manifest-table tbody tr`).count()) === 12,
    "After a reload the pane has its inputs and rows back");

  await clearWorkspace(page);
  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
