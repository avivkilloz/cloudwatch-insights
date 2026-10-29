// The doors between workflows and sessions (PLATFORM_PLAN.md §22.10,
// D95-D98), as an admin, against the faked backend's log groups (an account
// starting "0000") and the fake model:
//   - a run on screen makes the agent panel's second tab "Run" (D163), whose
//     chat reaches the agent with the run read in, and is kept on the run;
//   - Investigate in a session opens what the run found as a pane, holding
//     its results, with where it came from in the description;
//   - that session's Make repeatable… opens a drafted workflow in the
//     editor, unsaved, which checks clean;
//   - the Workflow pane runs a workflow from a session and follows it.
// Needs the agent + fake model running (see README).
import { readFileSync } from "node:fs";
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const WF = `doors_${STAMP}`;
const HELLO = `hello_${STAMP}`;
const LABEL = `Errors ${STAMP}`;
const DOCK = ".agent-dock";
const SOURCE = readFileSync(new URL("../../examples/workflows/02-cloudwatch-errors.yaml", import.meta.url), "utf8").replace(
  "label: Errors in a log group",
  `label: ${LABEL}`,
);
const HELLO_SOURCE = `label: Hello ${STAMP}
parameters:
  - { key: who, type: text, label: Who, required: true }
steps:
  - id: greet
    label: Greet
    note: "Hello, {{ params.who }}."
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

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const wf = (await api(page, "POST", "/workflows", { id: WF, source: SOURCE })).body;
  const hello = (await api(page, "POST", "/workflows", { id: HELLO, source: HELLO_SOURCE })).body;
  let started = (await api(page, "POST", `/workflows/${encodeURIComponent(wf.id)}/runs`, { params: { env: env.id, groups: ["/fake/api"] } })).body;
  for (let i = 0; i < 60 && !["succeeded", "failed"].includes(started.status); i++) {
    await page.waitForTimeout(500);
    started = (await api(page, "GET", `/workflow-runs/${started.id}`)).body;
  }
  check(started.status === "succeeded", "The run to look into succeeded", started.status);

  try {
    // ---- 1. This run: the panel's chat about the run on screen
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.goto(`${new URL(page.url()).origin}/?run=${started.id}`);
    await page.waitForSelector(".workflow-run");
    await page.waitForSelector(DOCK);
    const tabs = await page.locator(`${DOCK} .agent-tab`).allInnerTexts();
    check(tabs.some((t) => t.startsWith("Run")), "A run on screen makes the panel's second tab Run", JSON.stringify(tabs));
    await page.click(`${DOCK} .agent-tab:text-is("Run")`);
    const intro = await page.locator(`${DOCK} .agent-transcript`).innerText();
    check(intro.includes(`${LABEL} #1`), "…and it says which run", intro.slice(0, 200));
    await page.fill(`${DOCK} .agent-compose-input`, "which run is this?");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 30000 });
    const answer = await page.locator(`${DOCK} .agent-turn`).last().locator(".agent-answer").innerText();
    check(answer.includes(`This is ${LABEL} #1, and it succeeded.`), "The agent answered from the run, read at the turn's start", answer);
    await page.screenshot({ path: `${SHOT}/smoke88-this-run.png` });
    const kept = (await api(page, "GET", `/workflow-runs/${started.id}/chat`)).body.turns;
    check(kept.length === 1 && kept[0].status === "done" && kept[0].answer?.includes("succeeded") && kept[0].author,
      "The conversation is kept on the run, with who asked", JSON.stringify(kept).slice(0, 300));

    // ---- 2. Investigate in a session
    await page.click('.workflow-run button:text-is("Investigate in a session")');
    await page.waitForSelector(`${SHOWN} .aggregator-pane-header h3:text-is("Query Logs Insights")`, { timeout: 15000 });
    const titles = await page.locator(`${SHOWN} .aggregator-pane-header h3`).allInnerTexts();
    check(titles.length === 1, "Investigate opens a session with a pane per stage that ran a pane", JSON.stringify(titles));
    const rail = await page.locator(".rail-row.active .rail-row-label").innerText();
    check(rail === `${LABEL} #1`, "…named after the run", rail);
    const description = await page.locator(`${SHOWN} .session-card textarea, ${SHOWN} .session-card .session-card-description`).first()
      .evaluate((el) => el.value ?? el.textContent);
    check(description.includes(`From ${LABEL} #1`) && description.includes("summary: "), "…saying where it came from and what the notes said",
      description);
    const query = await page.locator(`${SHOWN} .aggregator-pane textarea`).first().inputValue();
    check(query.includes("filter @message like /ERROR/"), "…the pane holds the query it ran", query);
    // The step set only the log groups: their environment is ticked too, as
    // picking them by hand does (it said "0 environment(s) selected").
    const picked = await page.locator(`${SHOWN} .aggregator-pane :text("environment(s) selected.")`).innerText();
    check(picked.startsWith("1 "), "…its environment ticked beside its log groups", picked);
    const found = await page.locator(`${SHOWN} .aggregator-pane :text("row(s) across")`).innerText();
    check(found.startsWith("6 row(s) across 1 target"), "…and its results, as the run found them", found);
    const second = await page.locator(`${DOCK} .agent-tab`).nth(1).innerText();
    check(second.startsWith("Session"), "Off the run, the second tab is the session's again", second);
    await page.screenshot({ path: `${SHOT}/smoke88-investigate.png` });

    // ---- 3. Make repeatable
    await page.click(`${SHOWN} .session-card-repeat`);
    await page.waitForSelector("#workflow-source", { timeout: 10000 });
    const drafted = await page.locator("#workflow-source").inputValue();
    check(drafted.includes("pane: logs-cloudwatch") && drafted.includes("type: connection") && drafted.includes("string(params."),
      "Make repeatable drafts the session into a workflow, its environment a parameter", drafted.slice(0, 600));
    const id = await page.locator("#workflow-id").inputValue();
    check(id.length > 0, "…with an id to start from, unsaved", id);
    check(/\ndescription: \|\n {2}From /.test(drafted), "…its description a block, as a person writes it", drafted.slice(0, 300));
    await page.click('.workflow-view button:text-is("Check")');
    await page.waitForSelector('.workflow-view p.muted:text-is("No problems found.")', { timeout: 5000 });
    check(true, "…which checks clean");
    await page.screenshot({ path: `${SHOT}/smoke88-draft.png` });

    // ---- 4. The Workflow pane
    // Its list of workflows needs nothing chosen first, so it loads by itself
    // (a picker without a Load button drew nothing at all).
    await newSession(page, "Workflow");
    await page.waitForSelector(`${SHOWN} select[aria-label="workflow"] option:text-is("Hello ${STAMP}")`, { state: "attached", timeout: 10000 });
    check(true, "The Workflow pane lists the workflows by itself");
    await page.selectOption(`${SHOWN} select[aria-label="workflow"]`, { label: `Hello ${STAMP}` });
    await page.fill(`${SHOWN} .workflow-pane-params .session-card-row:has-text("Who") input`, "Ada");
    await page.waitForTimeout(400);
    await page.click(`${SHOWN} button:text-is("Run")`);
    await page.waitForSelector(`${SHOWN} :text("Hello ${STAMP} #1: succeeded")`, { timeout: 20000 });
    check(true, "The Workflow pane runs it and follows it to the end");
    const stages = await page.locator(`${SHOWN} table tbody tr`).allInnerTexts();
    check(stages.length === 1 && stages[0].includes("Greet") && stages[0].includes("succeeded"), "…a row per stage", JSON.stringify(stages));
    const runs = (await api(page, "GET", `/workflows/${encodeURIComponent(hello.id)}/runs`)).body;
    check(runs.length === 1 && runs[0].trigger === "pane" && runs[0].params.who === "Ada", "…recorded as a run like any other",
      JSON.stringify(runs.map((r) => [r.trigger, r.params])));
    await page.screenshot({ path: `${SHOT}/smoke88-pane.png` });
  } finally {
    await api(page, "DELETE", `/workflows/${encodeURIComponent(wf.id)}`);
    await api(page, "DELETE", `/workflows/${encodeURIComponent(hello.id)}`);
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
