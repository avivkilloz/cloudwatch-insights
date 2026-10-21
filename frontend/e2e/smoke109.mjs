// The Builder's agent tries its draft (D153, the user's ask: "if the pane we
// are building talks to an environment, the builder agent can ask the user
// which environment he can test with"):
//   - a draft that checks clean and has connections is put in the editor,
//     and the answer offers the environments it could be tried on;
//   - picking one asks "Try it on <env>": the draft runs there as the user --
//     its list, then its first row opened -- and the answer says what came
//     back;
//   - a later turn about the same editor is tried on that environment again,
//     without asking.
// Needs the agent and the fake model, and the backend as dev.fake_aws:app
// (an account starting 0000 answers with what PUT /api/dev/fake-aws put).
import { readFileSync } from "node:fs";
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const DOCK = ".agent-dock";
const STAMP = Date.now();
const ENV = `Try ${STAMP}`;
const RECIPE = readFileSync(new URL("../../backend/app/panes/recipes/rows-that-open/pane.yaml", import.meta.url), "utf8");

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

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
  let envId = null;
  try {
    await clearWorkspace(page);
    envId = (await api(page, "POST", "/environments", { name: ENV, account_id: "000077778888", region: "eu-west-1" })).body.id;
    const fn = { FunctionName: "orders", Runtime: "python3.12", MemorySize: 256, LastModified: "2026-10-01T10:00:00.000+0000" };
    await api(page, "PUT", "/dev/fake-aws?service=lambda&operation=ListFunctions&account=000077778888", { Functions: [fn] });
    await api(page, "PUT", "/dev/fake-aws?service=lambda&operation=GetFunctionConfiguration&account=000077778888", {
      ...fn, Handler: "app.handler", Timeout: 30, Role: "arn:aws:iam::000077778888:role/orders", State: "Active", Layers: [],
    });
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    await page.fill("#builder-source", RECIPE);

    // ---- 1. checked clean, it offers where to try it
    await askAndWait(page, "rename Lambda list");
    check((await page.inputValue("#builder-source")).includes("label: Lambda list"), "The draft is in the editor, renamed");
    // Buttons for a few; a dropdown past six (the suites' database has many).
    const asSelect = (await page.locator(`${DOCK} .agent-choices select`).count()) === 1;
    const offered = asSelect
      ? await page.locator(`${DOCK} .agent-choices select option`).allInnerTexts()
      : await page.locator(`${DOCK} .agent-choices .agent-choice`).allInnerTexts();
    check(offered.includes(ENV), "The answer offers the environments it could be tried on", JSON.stringify(offered.slice(0, 6)));
    if (asSelect) check(offered.length > 7 && offered[0] === "Choose…", "…past six of them, as a dropdown");
    check((await page.locator(`${DOCK} .agent-choices`).getAttribute("aria-label")) === "Try it on", "…as 'Try it on'");
    check((await page.locator(`${DOCK} .agent-answer`).last().innerText()).includes("pick one and I'll run it there"),
      "…saying what picking one does");
    await page.screenshot({ path: `${SHOT}/smoke109-choices.png`, fullPage: true });

    // ---- 2. a pick tries it there
    if (asSelect) await page.selectOption(`${DOCK} .agent-choices select`, ENV);
    else await page.click(`${DOCK} .agent-choice:text-is("${ENV}")`);
    await page.waitForFunction((dock) => document.querySelectorAll(`${dock} .agent-turn`).length === 2, DOCK);
    check((await page.locator(`${DOCK} .agent-question`).last().innerText()) === `Try it on ${ENV}`, "Picking it asks to try it there");
    check((await page.locator(`${DOCK} .agent-choices`).count()) === 0, "…and the choice isn't offered while that turn runs");
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 90000 });
    const steps = await page.locator(`${DOCK} .agent-turn`).last().locator(".agent-steps li").allInnerTexts();
    check(steps.some((s) => s.includes(`Ran the draft on ${ENV}`)), "It runs the draft there", JSON.stringify(steps));
    const answer = await page.locator(`${DOCK} .agent-answer`).last().innerText();
    check(answer.includes(`Tried it on ${ENV}: 1 row; the first row opened onto everything it shows.`),
      "…and says what came back, its first row opened", answer.slice(0, 300));
    await page.screenshot({ path: `${SHOT}/smoke109-tried.png`, fullPage: true });

    // ---- 3. later turns are tried there without asking
    await askAndWait(page, "rename Lambda functions");
    const later = await page.locator(`${DOCK} .agent-answer`).last().innerText();
    check(later.includes(`Tried it on ${ENV}`) && (await page.locator(`${DOCK} .agent-choices`).count()) === 0,
      "A later change is tried on the same environment, without asking again", later.slice(0, 300));
  } finally {
    for (const d of (await api(page, "GET", "/build-drafts")).body ?? []) await api(page, "DELETE", `/build-drafts/${d.id}`);
    if (envId) await api(page, "DELETE", `/environments/${envId}`);
    await clearWorkspace(page);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
