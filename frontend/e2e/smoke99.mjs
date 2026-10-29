// The IoT pane the user asked the agent for (D119, D120), as an admin, with
// the fake model's "add modes for jobs and rules" -- written the way a real
// model wrote its changes ({"path", "old", "new"}, "actions/-", lists as text)
// and with a `when` an action can't have:
//   - the changes are read as meant; the check names the stray field with
//     those an action may have; the fix lands; the draft is proposed;
//   - the pane made from it has Rules and Jobs as two more choices of
//     "Search for", one Search button in each, and each mode's Search runs
//     that mode's own request into its own table.
// Needs the agent + fake model running, and the backend as dev.fake_aws:app (see README).
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const DOCK = ".agent-dock";
const SHOWN = ".session-body:not([hidden])";
const PANE = `${SHOWN} .aggregator-pane:not([hidden])`;
const NAME = `iot_modes_${STAMP}`;

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

const visibleSearch = (page) => page.locator(`${PANE} button:text-is("Search"):visible`);

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
  await api(page, "PUT", `/dev/fake-aws?service=iot&operation=ListJobs&${account}`, { jobs: [{ jobId: "firmware-7", status: "QUEUED" }] });
  await api(page, "PUT", `/dev/fake-aws?service=iot&operation=ListTopicRules&${account}`, {
    rules: [{ ruleName: "to_s3", topicPattern: "devices/+/telemetry" }],
  });
  let made = null;
  try {
    // ---- 1. asked beside the editor
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    await page.selectOption("#builder-start", "iot");
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("searchMode"));
    await page.fill(`${DOCK} .agent-compose-input`, "add modes for jobs and rules");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 60000 });
    const turn = await page.locator(`${DOCK} .agent-turn`).last().innerText();
    const order = ["Wrote the changes", "Tried a change: it needs fixing", "Wrote the changes", "Changed the draft", "Put a draft in the editor"];
    let at = 0;
    const inOrder = order.every((s) => (at = turn.indexOf(s, at)) >= 0 && (at += s.length));
    check(inOrder, "Its changes, in its own shape, are read as meant; the check's problem is fixed; the draft lands", turn.slice(0, 500));
    const source = await page.inputValue("#builder-source");
    check(source.includes("choices: [things, certificates, rules, jobs]"), "…an inline list written inline again", source.match(/choices:.*/)?.[0]);
    check(/main:\n\s+input: searchMode\n\s+equals: rules/.test(source) && !/- id: list_rules\n(.*\n){0,6}?\s+when:/.test(source),
      "…each new action main for its mode, with no `when` of its own");
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")', { timeout: 5000 });
    check(true, "It checks clean");

    // ---- 2. made and used
    await page.fill("#builder-id", NAME);
    await page.click('.builder-view button:text-is("Create")');
    await page.waitForSelector('.builder-notice:has-text("everyone can use it now")', { timeout: 10000 });
    made = (await api(page, "GET", "/builder/panes")).body.find((t) => t.id.endsWith(NAME));
    await page.click('.builder-view button:text-is("Open in a session")');
    await page.waitForSelector(`${PANE} button:text-is("Rules")`, { timeout: 10000 });
    await page.locator(`${PANE} .checkbox-item`, { hasText: "e2e-fake-aws (" }).first().locator("input").check();
    check((await visibleSearch(page).count()) === 1, "Things: one Search button");

    await page.click(`${PANE} button:text-is("Jobs")`);
    check((await visibleSearch(page).count()) === 1, "Jobs: one Search button, the jobs' own");
    check((await page.locator(`${PANE} input[placeholder="thingName:*"]:visible`).count()) === 0, "…and no fleet-index query to type");
    await visibleSearch(page).click();
    await page.waitForFunction((s) => document.querySelector(s)?.innerText.includes("firmware-7"), PANE, { timeout: 15000 });
    check(true, "Jobs' Search lists the jobs");

    await page.click(`${PANE} button:text-is("Rules")`);
    await visibleSearch(page).click();
    await page.waitForFunction((s) => document.querySelector(s)?.innerText.includes("devices/+/telemetry"), PANE, { timeout: 15000 });
    const shown = await page.locator(PANE).innerText();
    check(shown.includes("to_s3") && !shown.includes("firmware-7"), "Rules' Search lists the rules, in the rules' table alone");
    await page.screenshot({ path: `${SHOT}/smoke99-rules.png`, fullPage: true });
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
