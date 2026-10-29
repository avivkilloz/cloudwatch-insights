// A new pane asked for in plain words starts from the closest working pane
// (D155; the user: "I just want to tell the builder agent what I want to see
// in the pane"). The editor holds only the starter; the request names nothing
// of the platform's -- no recipe, no operation. The Builder picks the recipe
// by its words (the fake model names none), makes the draft that pane, its
// file beside it, and says so; a draft with work in it is never replaced.
// Needs the agent and the fake model.
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const DOCK = ".agent-dock";
const PLAIN =
  "I want a pane to follow our IoT OTA firmware jobs. For each job, show its status, when it started, and how many " +
  "devices are waiting, in progress, succeeded and failed. When I click on a job, show its description, which " +
  "devices or groups it targets, the job document, and the status of each device. I also want to export the jobs " +
  "I pick, with all those details.";

async function askAndWait(page, text) {
  await page.fill(`${DOCK} .agent-compose-input`, text);
  await page.click(`${DOCK} button:text-is("Ask")`);
  await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 90000 });
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());
  try {
    await clearWorkspace(page);
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("Service status"));
    check(true, "A new pane opens holding the starter");

    // ---- 1. plain words, a blank draft: it starts from the closest recipe
    await askAndWait(page, PLAIN);
    const answer = await page.locator(`${DOCK} .agent-answer`).last().innerText();
    check(answer.includes("I started from recipe:per-row-values-in-code"),
      "Asked in plain words, it starts from the recipe closest to them", answer.slice(0, 200));
    const yaml = await page.inputValue("#builder-source");
    check(!yaml.includes("Service status") && yaml.includes("code:") && yaml.includes("include:"),
      "…the starter replaced by that working pane: listing in code, export with detail", yaml.slice(0, 200));
    check(!yaml.includes("# Recipe"), "…without the recipe's notes, which went to the model");
    const tabs = await page.locator(".workspace-tab[data-file]").evaluateAll((els) => els.map((e) => e.getAttribute("data-file")));
    check(tabs.includes("jobs.py") && tabs.includes("job.py"), "…its files beside it", JSON.stringify(tabs));
    const steps = await page.locator(`${DOCK} .agent-turn`).last().locator(".agent-steps li").allInnerTexts();
    check(steps.some((s) => s.includes("recipe:per-row-values-in-code")), "…the recipe read as a step you can see",
      JSON.stringify(steps.slice(0, 5)));
    await page.screenshot({ path: `${SHOT}/smoke111-started.png`, fullPage: true });

    // ---- 2. a draft with work in it is never replaced
    await askAndWait(page, PLAIN);
    const again = await page.locator(`${DOCK} .agent-answer`).last().innerText();
    check(!again.includes("I started from"), "Asked again, the draft it now holds is changed, not replaced", again.slice(0, 160));
  } finally {
    for (const d of (await page.evaluate(async () => (await fetch("/api/build-drafts")).json())) ?? []) {
      await page.evaluate(async (id) => fetch(`/api/build-drafts/${id}`, { method: "DELETE" }), d.id);
    }
    await clearWorkspace(page);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
