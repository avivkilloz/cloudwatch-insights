// The Builder's loop (PLATFORM_PLAN.md D116), as an admin, with the fake
// model's "add jobs and rules" (it reads ListJobs and ListTopicRules, adds both
// lists by path -- the jobs' rows at a path the reply doesn't have -- and,
// told so by the check, fixes it):
//   - started from IoT, asked beside the editor, the turn's steps are the
//     loop's: what to change, the operations looked up, a change the check
//     sent back, the fix, the draft in the editor -- and an answer;
//   - the editor holds both lists, the IoT it started from as it was written
//     (inline mappings and all), and it checks clean;
//   - created and opened, its two lists each fetch into their own table, and
//     fetching one keeps the other's rows (every request used to write `rows`
//     and clear the pane).
// Needs the agent + fake model running, and the backend as dev.fake_aws:app (see README).
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const DOCK = ".agent-dock";
const SHOWN = ".session-body:not([hidden])";
const NAME = `iot_plus_${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
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
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(DOCK);
  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const account = "account=000000000001";
  await api(page, "PUT", `/dev/fake-aws?service=iot&operation=ListJobs&${account}`, {
    jobs: [{ jobId: "firmware-7", status: "IN_PROGRESS", createdAt: "2026-10-01T10:00:00Z" }],
  });
  await api(page, "PUT", `/dev/fake-aws?service=iot&operation=ListTopicRules&${account}`, {
    rules: [{ ruleName: "to_s3", topicPattern: "devices/+/telemetry", ruleDisabled: false }],
  });
  let made = null;
  try {
    // ---- 1. asked beside the editor, started from IoT
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    await page.selectOption("#builder-start", "iot");
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("searchMode"));
    const before = await page.inputValue("#builder-source");
    await page.fill(`${DOCK} .agent-compose-input`, "add jobs and rules");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 60000 });
    const turn = await page.locator(`${DOCK} .agent-turn`).last().innerText();
    const order = [
      "Read what a definition can say", "Worked out what to change", "Looked up iot ListJobs", "Looked up iot ListTopicRules",
      "Wrote the changes", "Tried a change: it needs fixing", "Changed the draft", "Put a draft in the editor",
    ];
    const at = order.map((s) => turn.indexOf(s));
    check(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), "The turn's steps are the loop's, in order", turn.slice(0, 600));
    check(turn.includes("The check caught 1 problem on the way, fixed") && turn.includes("not saved yet"),
      "…and it answers, saying what the check caught", turn.slice(-300));
    await page.screenshot({ path: `${SHOT}/smoke98-turn.png` });

    // ---- 2. what's in the editor
    const after = await page.inputValue("#builder-source");
    check(after.includes("operation: ListJobs") && after.includes("operation: ListTopicRules") && after.includes("output: jobs"),
      "The editor holds both lists, each into an output of its own");
    check(/rows:\n\s+at: jobs\n/.test(after), "…the jobs' rows where ListJobs keeps them, as the check said");
    check(after.includes("choice_labels: { things: Things, certificates: Certificates }") && after.startsWith(before.split("\n")[0]),
      "…and the IoT it started from as it was written");
    const gone = before.split("\n").filter((l) => !new Set(after.split("\n")).has(l));
    check(gone.length <= 1, "…nothing of it lost", JSON.stringify(gone));
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")', { timeout: 5000 });
    check(true, "It checks clean");

    // ---- 3. made, opened, both lists fetched
    await page.fill("#builder-id", NAME);
    await page.click('.builder-view button:text-is("Create")');
    await page.waitForSelector('.builder-notice:has-text("everyone can use it now")', { timeout: 10000 }).catch(async (e) => {
      console.log("EDITOR SAID:", await page.locator(".builder-view").innerText());
      throw e;
    });
    made = (await api(page, "GET", "/builder/panes")).body.find((t) => t.id.endsWith(NAME));
    await page.click('.builder-view button:text-is("Open in a session")');
    await page.waitForSelector(`${SHOWN} button:text-is("List jobs")`, { timeout: 10000 });
    await page.locator(`${SHOWN} .checkbox-item`, { hasText: "e2e-fake-aws (" }).first().locator("input").check();
    await page.click(`${SHOWN} button:text-is("List jobs")`);
    await page.waitForFunction((s) => document.querySelector(s)?.innerText.includes("firmware-7"), `${SHOWN} .aggregator-pane:not([hidden])`, { timeout: 15000 });
    await page.click(`${SHOWN} button:text-is("List rules")`);
    await page.waitForFunction((s) => document.querySelector(s)?.innerText.includes("devices/+/telemetry"), `${SHOWN} .aggregator-pane:not([hidden])`, { timeout: 15000 });
    const pane = await page.locator(`${SHOWN} .aggregator-pane:not([hidden])`).first().innerText();
    check(pane.includes("firmware-7") && pane.includes("to_s3"), "Fetching the rules keeps the jobs' rows: two tables, each its own", pane.slice(0, 200));
    check((await page.locator(`${SHOWN} .manifest-table`).count()) === 2, "…two tables");
    await page.screenshot({ path: `${SHOT}/smoke98-pane.png`, fullPage: true });
  } finally {
    await clearWorkspace(page);
    if (made) await api(page, "DELETE", `/builder/panes/${encodeURIComponent(made.id)}`);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
