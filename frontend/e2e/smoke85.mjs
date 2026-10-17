// 4b-1: workflows (PLATFORM_PLAN.md §22), driven as an admin and a member:
//   - Workflows is a row of the rail, its own page; an admin writes one in YAML,
//     and Check points at the line a mistake is on before anything is saved;
//   - Run ▸ asks for its parameters (a connection by name), and the run page
//     shows its stages finishing, a stage's rows as a table, a note's text,
//     the parameters by their labels;
//   - the run has an address (?run=<id>) that opens it; Rerun runs it again;
//   - a member whose group is granted the workflow runs it as themselves, and
//     sees that the admin's run happened but not what it found (D84).
// The steps query a `.fake` Prometheus host of the dev backend.
import { BASE, check, clearWorkspace, launch, newPage, openApp, report, signIn } from "./harness.mjs";

const STAMP = Date.now();
const ENV = `Wf ${STAMP}`;
const WF = `wf_${STAMP}`;
const USER = `wf${STAMP}`;
const NOW = Math.floor(Date.now() / 1000);
const RUN_STATUS = ".workflow-run .credential-view-actions .run-status";

const SOURCE = `label: Jobs up ${STAMP}
description: Asks Prometheus which jobs are up.
parameters:
  - { key: prom, type: connection, connection_type: prometheus, label: Prometheus, required: true }
  - { key: query, type: text, default: up }
steps:
  - id: query
    label: Query Prometheus
    pane: prometheus
    action: run
    with: { connection: "{{ params.prom }}", query: "{{ params.query }}" }
  - id: each
    for_each: "{{ steps.query.outputs.rows }}"
    note: "{{ item.series }} = {{ item.value }}"
  - id: summary
    note: "{{ size(steps.query.outputs.rows) }} points from {{ params.query }}."
`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function runIt(page) {
  await page.click('.workflow-view button:text-is("Run ▸")');
  await page.waitForSelector(`#param-prom option:has-text("${ENV}")`, { state: "attached" });
  const label = (await page.locator("#param-prom option").allInnerTexts()).find((o) => o.includes(ENV));
  await page.selectOption("#param-prom", { label });
  await page.click('.workflow-params button:text-is("Run")');
  await page.waitForSelector(`${RUN_STATUS}[data-status="succeeded"]`, { timeout: 20000 });
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  const env = (await api(page, "POST", "/environments", { name: ENV })).body;
  await api(page, "POST", `/environments/${env.id}/connections`, { type_id: "prometheus", name: "prom", config: { base_url: "http://wf.fake" } });
  await api(page, "PUT", "/dev/fake-http?path=/api/v1/query_range", {
    status: "success",
    data: { resultType: "matrix", result: [{ metric: { job: "api" }, values: [[NOW - 60, "1"], [NOW, "1"]] }, { metric: { job: "db" }, values: [[NOW, "0"]] }] },
  });
  const g = (await api(page, "POST", "/user-groups", { name: `g-${USER}`, pane_types: ["prometheus"], environment_ids: [env.id] })).body;
  await api(page, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });

  try {
    // ---- 1. written, checked, saved
    await page.click('.rail-row-page:has-text("Workflows")');
    await page.waitForSelector(".workflows-list");
    check(true, "Workflows is a row of the rail, a page of its own");
    await page.click('.workflows-list button:text-is("New workflow")');
    await page.fill("#workflow-id", WF);
    await page.fill("#workflow-source", SOURCE.replace("action: run", "action: runn"));
    await page.click('.workflow-view button:text-is("Check")');
    await page.waitForSelector(".workflow-problems li");
    const problem = await page.locator(".workflow-problems li").first().innerText();
    check(problem.startsWith("Line 10:") && problem.includes("no action 'runn'"), "Check names the mistake and its line", problem);
    await page.fill("#workflow-source", SOURCE);
    await page.click('.workflow-view button:text-is("Create")');
    await page.waitForSelector('.workflow-view button:text-is("Run ▸")');
    check((await page.locator(".workflow-view .credential-view-head h2").innerText()) === `Jobs up ${STAMP}`, "Created, its page opens");

    // ---- 2. run with parameters; the run page
    await runIt(page);
    check(true, "Run ▸ asks for the connection by name, and the run page shows it finish");
    const stages = await page.locator(".workflow-stage").evaluateAll((els) => els.map((e) => `${e.dataset.stage}:${e.dataset.status}`));
    check(JSON.stringify(stages) === JSON.stringify(["query:succeeded", "each:succeeded", "summary:succeeded"]), "Every stage is listed with its status", JSON.stringify(stages));
    check((await page.locator('[data-param="prom"]').innerText()).includes(ENV), "The parameters are shown by label, the connection by its name",
      await page.locator('[data-param="prom"]').innerText());
    await page.click('[data-stage="query"]');
    await page.waitForSelector('[data-stage-detail="query"] [data-output="rows"] tbody tr');
    check((await page.locator('[data-stage-detail="query"] [data-output="rows"] tbody tr').count()) === 3, "A stage's rows are a table");
    await page.click('[data-stage="summary"]');
    check((await page.locator('[data-stage-detail="summary"] .workflow-note').innerText()) === "3 points from up.", "A note is its text");

    // ---- 3. the run's address; Rerun
    const url = new URL(page.url());
    const runId = url.searchParams.get("run");
    check(!!runId, "The run has an address", page.url());
    const other = await newPage(browser);
    await signIn(other);
    await other.goto(`${BASE}/?run=${runId}`);
    await other.waitForSelector(`${RUN_STATUS}[data-status="succeeded"]`, { timeout: 15000 });
    check((await other.locator(".workflow-run .credential-view-head h2").innerText()).endsWith("#1"), "…which opens it");
    await other.close();
    await page.click('.workflow-run button:text-is("Rerun")');
    await page.waitForFunction(() => document.querySelector(".workflow-run .credential-view-head h2")?.textContent?.endsWith("#2"));
    await page.waitForSelector(`${RUN_STATUS}[data-status="succeeded"]`, { timeout: 20000 });
    check(true, "Rerun runs it again, as #2");

    // ---- 4. a member, once their group may run it
    const wf = (await api(page, "GET", "/workflows")).body.find((w) => w.id.endsWith(WF));
    await api(page, "PUT", `/workflows/${encodeURIComponent(wf.id)}/grants`, { group_ids: [g.id] });
    const member = await newPage(browser);
    await signIn(member, { username: USER, password: "pw-123456" });
    await member.click('.rail-row-page:has-text("Workflows")');
    await member.waitForSelector(`[data-workflow="${wf.id}"]`);
    check((await member.locator(".workflows-list button:text-is('New workflow')").count()) === 0, "A member can run it but not write one");
    await member.click(`[data-workflow="${wf.id}"]`);
    await member.click('.workflow-view [data-run] >> nth=1');
    await member.waitForSelector(".workflow-run");
    const text = await member.locator(".workflow-run").innerText();
    check(text.includes("seen by admin, their group and admins") && (await member.locator(".workflow-stage").count()) === 0,
      "The admin's run: that it happened, not what it found", text.slice(0, 200));
    await member.click('.workflow-run button:text-is("← Back")');
    await runIt(member);
    check((await member.locator(".workflow-stage").count()) === 3, "Run by the member, as themselves: theirs to see");
    await member.close();
  } finally {
    const wf = ((await api(page, "GET", "/workflows")).body || []).find((w) => w.id.endsWith(WF));
    if (wf) await api(page, "DELETE", `/workflows/${encodeURIComponent(wf.id)}`);
    for (const u of (await api(page, "GET", "/users")).body.filter((u) => u.username === USER)) await api(page, "DELETE", `/users/${u.id}`);
    await api(page, "DELETE", `/user-groups/${g.id}`);
    await api(page, "DELETE", `/environments/${env.id}`);
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
