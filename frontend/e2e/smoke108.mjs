// The Building chat, when its draft still has problems (the user's ask after
// #142): the notice under the answer carries "Fix what's left", which sends
// those problems back to the agent -- people copied Check's list into the
// chat by hand to do the same. Only on the last turn, and not while one runs.
// It reads what's left from the draft itself (a check first, no plan): sent
// as the notice's words, a notice naming a change that couldn't be made was
// answered "share what Check reports".
// Needs the agent and the fake model (its "never clean" script).
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const DOCK = ".agent-dock";

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
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
    await page.fill("#builder-source", "label: IoT\ndescription: Things.\nactions: []\noutputs: []\nlayout: []\n");

    await page.fill(`${DOCK} .agent-compose-input`, "never clean");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 90000 });
    const notice = await page.locator(`${DOCK} .agent-notice`).last().innerText();
    check(notice.includes("The draft still has problems") && notice.includes("Fix what's left"),
      "A draft left with problems says so, with Fix what's left", notice.slice(0, 160));
    await page.screenshot({ path: `${SHOT}/smoke108-notice.png`, fullPage: true });

    await page.click(`${DOCK} .agent-fix`);
    await page.waitForFunction((dock) => document.querySelectorAll(`${dock} .agent-turn`).length === 2, DOCK);
    const asked = await page.locator(`${DOCK} .agent-question`).last().innerText();
    check(asked === "Fix what's left.", "…which asks the agent to fix what's left", asked.slice(0, 160));
    check((await page.locator(`${DOCK} .agent-fix`).count()) === 0, "…and isn't offered while that turn runs");
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 90000 });
    // Read from the draft, not the notice's words: no plan, a check first (a
    // notice can name a change that couldn't be made, which a plan then
    // answered as a question, "share what Check reports").
    const steps = await page.locator(`${DOCK} .agent-turn`).last().locator(".agent-steps li").allInnerTexts();
    check(steps[1]?.includes("Checked a draft") && !steps.some((t) => t.includes("Worked out what to change")),
      "…working from the draft's own problems, with no plan step", JSON.stringify(steps.slice(0, 4)));
    check((await page.locator(`${DOCK} .agent-fix`).count()) === 1, "Only the last turn offers it");
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
