// Reports from use, after 4c:
//   - the Workflow pane showed a run's summary and stages but no way to the
//     whole run: it now links to it, opened in place on the Workflows page;
//   - the agent said it couldn't show a workflow: open_workflow shows its page
//     (the fake model's "show workflow <id>");
//   - after publishing a template, Add listed it twice under one name -- the
//     published one and the saved one it came from. Now once.
// Needs the agent + fake model running (see README).
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const WF = `linked_${STAMP}`;
const LABEL = `Linked ${STAMP}`;
const NAME = `Twice ${STAMP}`;
const DOCK = ".agent-dock";

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
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  const wf = (await api(page, "POST", "/workflows", {
    id: WF,
    source: `label: ${LABEL}\nsteps:\n  - id: hello\n    label: Hello\n    note: "hi"\n`,
  })).body;
  const saved = (await api(page, "POST", "/saved-sessions", {
    page: "aggregator",
    name: NAME,
    state: { __savedStateVersion: 2, services: ["tool-base64"], "tool-base64.in.input": "aGk=" },
  })).body;

  try {
    // ---- 1. the Workflow pane links to its run
    await newSession(page, "Workflow");
    await page.waitForSelector(`${SHOWN} select[aria-label="workflow"] option:text-is("${LABEL}")`, { state: "attached", timeout: 10000 });
    await page.selectOption(`${SHOWN} select[aria-label="workflow"]`, { label: LABEL });
    await page.waitForTimeout(400);
    await page.click(`${SHOWN} button:text-is("Run")`);
    const link = `${SHOWN} .pane-link a:has-text("Open ${LABEL} #1 on the Workflows page")`;
    await page.waitForSelector(link, { timeout: 20000 });
    await page.screenshot({ path: `${SHOT}/smoke91-run-link.png` });
    const before = page.url();
    await page.click(link);
    await page.waitForSelector(`.workflow-run h2:has-text("${LABEL} #1"), .workflow-run :text("${LABEL} #1")`, { timeout: 10000 });
    check(true, "The Workflow pane links to its run, which opens on the Workflows page");
    check(new URL(page.url()).searchParams.get("run") !== null && new URL(before).origin === new URL(page.url()).origin,
      "…in place, its address the run's", page.url());

    // ---- 2. the agent shows a workflow's page
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);
    await page.click(".rail-row-home");
    await page.click(`${DOCK} .agent-tab:has-text("Global")`);
    await page.fill(`${DOCK} .agent-compose-input`, `show workflow ${wf.id}`);
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 30000 });
    await page.waitForSelector(`.workflow-view :text-is("${LABEL}")`, { timeout: 10000 });
    check(true, "Asked to show a workflow, the agent opens its page");
    const answer = await page.locator(`${DOCK} .agent-turn`).last().locator(".agent-answer").innerText();
    check(answer.includes(`It's on the Workflows page: ${LABEL}`), "…and says so", answer);

    // ---- 3. a published template is offered once
    const published = await api(page, "POST", "/templates", { saved_session_id: saved.id, id: `twice_${STAMP}`, label: NAME });
    check(published.status === 201, "Published", JSON.stringify(published.body));
    await page.reload();
    await page.waitForSelector(".rail");
    await page.click(".rail-row-new");
    await page.waitForSelector(`.rail-row-template:has(.rail-row-label:text-is("${NAME}"))`);
    const offered = await page.locator(`.rail-row-template:has(.rail-row-label:text-is("${NAME}"))`).count();
    check(offered === 1, "Add offers a published template once, not beside the saved one it came from", String(offered));
    check((await page.locator(`.rail-row-published:has(.rail-row-label:text-is("${NAME}"))`).count()) === 1,
      "…the published one");
  } finally {
    await api(page, "DELETE", `/templates/twice_${STAMP}`);
    await api(page, "DELETE", `/saved-sessions/${saved.id}`);
    await api(page, "DELETE", `/workflows/${encodeURIComponent(wf.id)}`);
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
