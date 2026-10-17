// Run on open (D77, PLATFORM_PLAN.md §21.8): a dashboard pane set to run when
// the session is opened does, once -- not again on switching away and back
// within its window, again once its results are older than that, and never for
// a pane without it. Counted by the requests the pane's Prometheus connection
// (a `.fake` host of the dev backend) receives.
import { check, clearWorkspace, launch, openApp, openPaneMenu, report, SHOWN } from "./harness.mjs";

const STAMP = Date.now();
const ENV = `Open ${STAMP}`;
const PATH = "/api/v1/query_range";
const NOW = Math.floor(Date.now() / 1000);

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const hits = async (page) => (await api(page, "GET", `/dev/fake-http/hits?path=${encodeURIComponent(PATH)}`)).body.hits;
const row = (title) => `.rail-row:has(.rail-row-label:text-is("${title}"))`;

async function openSession(page, title) {
  await page.click(row(title));
  await page.waitForSelector(`${row(title)}.active`);
}

async function settle(page) {
  await page.waitForTimeout(1500);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  const env = (await api(page, "POST", "/environments", { name: ENV })).body;
  const conn = (await api(page, "POST", `/environments/${env.id}/connections`, {
    type_id: "prometheus", name: "prom", config: { base_url: "http://open.fake" },
  })).body;
  await api(page, "PUT", `/dev/fake-http?path=${PATH}`, {
    status: "success",
    data: { resultType: "matrix", result: [{ metric: { __name__: "up", job: "api" }, values: [[NOW - 60, "1"], [NOW, "1"]] }] },
  });
  const prom = (extra) => ({
    services: ["prometheus"], layout: "tabs", "prometheus.in.connection": conn.id, "prometheus.in.query": "up", ...extra,
  });
  await clearWorkspace(page, [
    { client_id: `open-a-${STAMP}`, title: "Dashboard", type: "aggregator", position: 0, state: prom({ "prometheus.refreshOnOpen": 300 }) },
    { client_id: `open-b-${STAMP}`, title: "Elsewhere", type: "aggregator", position: 1, state: { services: ["tool-base64"], layout: "tabs" } },
    { client_id: `open-c-${STAMP}`, title: "Not on open", type: "aggregator", position: 2, state: prom({}) },
  ]);
  await page.reload();
  await page.waitForSelector(row("Dashboard"));
  const start = await hits(page);

  // ---- 1. opened: it runs, once
  await openSession(page, "Dashboard");
  await page.waitForSelector(`${SHOWN} .panel:has(h2:text-is("Series")) tbody tr`, { timeout: 15000 });
  check((await hits(page)) === start + 1, "Opening the session runs the pane set to run on open", `${await hits(page)} vs ${start}`);
  check((await page.locator(`${SHOWN} .pane-refresh-on`).first().innerText()).includes("on open"), "…and its header says it does");

  // ---- 2. away and back within the window: not again
  await openSession(page, "Elsewhere");
  await openSession(page, "Dashboard");
  await settle(page);
  check((await hits(page)) === start + 1, "Switching away and back within its window doesn't run it again");

  // ---- 3. older than the window: again
  await api(page, "POST", `/dev/age-outputs?session=open-a-${STAMP}&pane=prometheus&seconds=600`);
  await openSession(page, "Elsewhere");
  await openSession(page, "Dashboard");
  await page.waitForFunction(
    async ({ path, want }) => {
      const res = await fetch(`/api/dev/fake-http/hits?path=${encodeURIComponent(path)}`);
      return (await res.json()).hits >= want;
    },
    { path: PATH, want: start + 2 },
    { timeout: 15000, polling: 250 },
  );
  check(true, "Its results older than the window, coming back runs it again");

  // ---- 4. a pane without it doesn't run on open
  await openSession(page, "Not on open");
  await settle(page);
  check((await hits(page)) === start + 2, "A pane not set to run on open doesn't");

  // ---- 5. it's set in the pane's ⚙ (and the session's card)
  await openSession(page, "Dashboard");
  await openPaneMenu(page);
  const chosen = await page.locator('.pane-menu-list select[aria-label="Run on open"]').inputValue();
  check(chosen === "300", "The pane's ⚙ shows its run on open", chosen);
  await page.keyboard.press("Escape");
  await openSession(page, "Not on open");
  if (!(await page.locator(`${SHOWN} select[aria-label="Run panes on open"]`).isVisible())) await page.click(`${SHOWN} .session-card-head`);
  await page.selectOption(`${SHOWN} select[aria-label="Run panes on open"]`, "900");
  await page.waitForFunction(
    async (id) => {
      const res = await fetch(`/api/live-sessions/${id}`);
      return (await res.json()).state.refreshOnOpen === 900;
    },
    `open-c-${STAMP}`,
    { timeout: 10000, polling: 250 },
  );
  check(true, "The session's card sets it for every pane");

  await clearWorkspace(page);
  await api(page, "DELETE", `/environments/${env.id}`);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
