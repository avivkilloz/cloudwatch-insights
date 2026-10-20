// The agent builds beside the editor (PLATFORM_PLAN.md §24, 5-2, D107; the
// Builder's loop, D116), as an admin, with the fake model's "build <label>"
// script (it renames what's in the editor, by path; the loop checks it and
// proposes it):
//   - opening the Builder's editor makes the agent panel's second tab
//     "Building", selected, its intro naming what's open;
//   - asked there, the agent reads what a definition can say and the editor's
//     text, and its proposal lands in the editor, unsaved, with a notice --
//     nothing is saved until the user saves it;
//   - the same beside a workflow's editor;
//   - away from an editor, with no session open, the panel is Global alone.
// Needs the agent + fake model running (see README).
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const DOCK = ".agent-dock";
const PANE_LABEL = `Loud ${STAMP}`;
const WF_LABEL = `Built ${STAMP}`;

async function api(page, method, path) {
  return page.evaluate(
    async ({ method, path }) => {
      const res = await fetch(`/api${path}`, { method });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path },
  );
}

async function ask(page, text) {
  await page.fill(`${DOCK} .agent-compose-input`, text);
  await page.click(`${DOCK} button:text-is("Ask")`);
  await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 30000 });
  return page.locator(`${DOCK} .agent-turn`).last().innerText();
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

  // ---- 1. a new pane type
  await page.click('.rail-row-page:has-text("Builder")');
  await page.click('.builder-list button:text-is("New pane type")');
  await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("label: Service status"));
  const tabs = await page.locator(`${DOCK} .agent-tab`).allInnerTexts();
  check(tabs[1]?.startsWith("Building"), "The Builder's editor makes the panel's second tab Building", JSON.stringify(tabs));
  check(
    (await page.locator(`${DOCK} .agent-tab.active`).innerText()).startsWith("Building"),
    "…and opening the editor selects it",
  );
  const intro = await page.locator(`${DOCK} .agent-transcript`).innerText();
  check(intro.includes("New pane type") && intro.includes("never saves"), "…its intro says what's open and that it won't save", intro);

  const turn = await ask(page, `build ${PANE_LABEL}`);
  check(turn.includes("Read what a definition can say"), "The turn read what a definition can say", turn);
  check(turn.includes("Put a draft in the editor"), "…and put its draft in the editor", turn);
  const source = await page.inputValue("#builder-source");
  check(source.includes(`\nlabel: ${PANE_LABEL}\n`) && !source.includes("Service status") && source.includes("actions:"), "The editor holds the agent's draft, the rest as it was", source.slice(0, 80));
  const notice = await page.locator(".builder-notice").innerText();
  check(notice.includes("not saved yet") && notice.includes(`Renamed it ${PANE_LABEL}`), "…with a notice that it isn't saved", notice);
  const saved = (await api(page, "GET", "/builder/panes")).body;
  check(!saved.some((t) => t.label === PANE_LABEL), "Nothing was saved: the user's Create does that");
  await page.screenshot({ path: `${SHOT}/smoke93-builder.png` });

  // ---- 1b. started from a platform pane, as the user did with IoT: it checks
  // clean as it comes (its flag: line failed Check first), and a change to
  // it is one small edit to the turn's draft, the rest kept (D114)
  await page.selectOption("#builder-start", "iot");
  await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("searchMode"));
  await page.click('.builder-view button:text-is("Check")');
  await page.waitForSelector('.builder-notice:text-is("No problems found.")', { timeout: 5000 });
  check(true, "Started from the IoT pane, the draft checks clean as it comes");
  const edited = await ask(page, `rename IoT plus ${STAMP}`);
  check(edited.includes("Changed the draft") && edited.includes("Put a draft in the editor"), "The agent changes it by path, then proposes the draft", edited);
  const iot = await page.inputValue("#builder-source");
  check(iot.includes(`label: IoT plus ${STAMP}`) && iot.includes("searchMode") && iot.includes("aws.iot.search"),
    "…and the editor holds IoT with only that changed", iot.slice(0, 120));

  // ---- 2. a workflow's editor
  await page.click('.rail-row-page:has-text("Workflows")');
  await page.click('button:text-is("New workflow")');
  await page.waitForSelector("#workflow-source");
  check((await page.locator(`${DOCK} .agent-tab.active`).innerText()).startsWith("Building"), "A workflow's editor is the Building tab too");
  const before = await page.inputValue("#workflow-source");
  await ask(page, `build ${WF_LABEL}`);
  const after = await page.inputValue("#workflow-source");
  check(after.startsWith(`label: ${WF_LABEL}\n`) && after !== before, "…and the agent's draft lands in it", after.slice(0, 80));
  const workflows = (await api(page, "GET", "/workflows")).body;
  check(!workflows.some((w) => w.label === WF_LABEL), "…unsaved");

  // ---- 3. away from an editor
  await page.click('.rail-row-page:has-text("Workflows")');
  await page.waitForTimeout(300);
  await page.click(".rail-row-home");
  await page.waitForTimeout(300);
  const away = await page.locator(`${DOCK} .agent-tab`).allInnerTexts();
  check(JSON.stringify(away) === '["Global"]', "Away from an editor (and any session), the panel is Global alone", JSON.stringify(away));

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
