// What the agent panel showed for a real reasoning model, fixed and pinned
// here against the fake model's scripts for each shape (dev/fake_llm.py):
// - "think": reasoning arrives in the content with only a closing
//   "</think>" -- it used to show as literal "</think>" tags with the same
//   sentence either side. Now it's a folded "Thought process" above an
//   answer that holds only the answer.
// - "invent": a one-column table ("| Thing Name |\n|---|") stayed literal
//   pipes, and its rows came from no tool at all. Now the made-up answer is
//   taken back off the screen and the model asked once to run the tool or
//   say so; one that still invents ("invent stubborn") is a real <table>,
//   with a warning under it naming a value no tool returned.
// - "loop": the same four sentences, over and over. Now stopped early with
//   a readable error, the repeated words taken back off the answer.
// - A turn stored before any of this, "</think>" inline, renders the same
//   way as a new one.
// Every turn also opens with its own fresh read of what the asker can reach,
// and a Global turn that Follow takes into a session stays on screen.
// Needs the agent + fake model running (see README).
import { check, clearWorkspace, openApp, launch, report, ROW } from "./harness.mjs";

const DOCK = ".agent-dock";
const TRANSCRIPT = `${DOCK} .agent-transcript`;

async function ask(page, text) {
  await page.fill(`${DOCK} .agent-compose-input`, text);
  await page.click(`${DOCK} button:text-is("Ask")`);
  // Done when the compose box offers Ask again (Stop while running).
  await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 30000 });
}

const lastTurn = (page) => page.locator(`${TRANSCRIPT} .agent-turn`).last();

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(".rail");
  await page.waitForSelector(DOCK);
  await page.click(`${DOCK} button:text-is("Global")`).catch(() => {});

  // ---- 1. reasoning, split off
  await ask(page, "think");
  // The turn opened a session and Follow went there; the panel used to flip
  // to that session's tab and hide the Global turn doing it.
  const selected = await page.locator(`${DOCK} .agent-tab[aria-selected="true"]`).innerText();
  check(selected === "Global", "Following the agent into a session keeps its Global turn on screen", selected);
  let turn = lastTurn(page);
  let text = await turn.innerText();
  check(!text.includes("</think>"), "No literal </think> anywhere in the turn", text);
  const answer = (await turn.locator(".agent-answer > p").allInnerTexts()).join("\n");
  check(answer.includes("Creating it now.") && answer.includes("Done: the Thought session is open."),
    "The answer holds the answer's words", answer);
  check(!answer.includes("I should create one first"), "…and none of the reasoning", answer);
  const thoughts = turn.locator(".agent-thoughts");
  check((await thoughts.count()) === 1, "The reasoning is one folded block", String(await thoughts.count()));
  check((await thoughts.getAttribute("open")) === null, "…folded by default");
  check((await thoughts.locator("summary").innerText()) === "Thought process", "…labelled as the thought process",
    await thoughts.locator("summary").innerText());
  await thoughts.locator("summary").click();
  const thoughtText = await thoughts.locator(".agent-thoughts-text").innerText();
  check(thoughtText.includes("I should create one first.") && thoughtText.includes("I'll say so briefly."),
    "…holding both steps' reasoning", thoughtText);
  const steps = await turn.locator(".agent-step-text").allInnerTexts();
  check(steps[0] === "Checked who's asking and what they can reach", "The turn opened with its own read of what you can reach",
    JSON.stringify(steps));
  check(steps.some((s) => s.startsWith("Created session")), "…and the model's own call still ran", JSON.stringify(steps));

  // ---- 2. rows no tool returned: taken back and redone...
  await ask(page, "invent");
  turn = lastTurn(page);
  text = await turn.innerText();
  check(text.includes("I haven't run a search this turn"), "Made-up rows are replaced by an honest answer", text);
  check(!text.includes("test-device-001") && (await turn.locator("table").count()) === 0,
    "…and taken back off the screen", text);

  // ...and a one-column table of them, when the model does it again
  await ask(page, "invent stubborn");
  turn = lastTurn(page);
  const tables = turn.locator("table");
  check((await tables.count()) === 1, "A one-column table renders as a real <table>", String(await tables.count()));
  const cells = await turn.locator("table tbody td").allInnerTexts();
  check(cells.length === 4 && cells[0] === "test-device-001", "…with each row a cell", JSON.stringify(cells));
  text = await turn.innerText();
  check(!text.includes("|------------|"), "…not literal pipes and dashes", text);
  const notice = turn.locator(".agent-notice");
  check((await notice.count()) === 1, "The made-up rows carry a warning", text);
  if (await notice.count()) {
    const said = await notice.innerText();
    check(said.includes("test-device-001") && said.includes("may not be real"), "…naming one of them", said);
  }

  // ---- 3. a loop, stopped
  const started = Date.now();
  await ask(page, "loop");
  turn = lastTurn(page);
  const error = await turn.locator(".error-text").innerText().catch(() => "");
  check(error.includes("repeating itself"), "A looping step is stopped with a readable error", error);
  check(Date.now() - started < 20000, "…early, not after every round", `${Date.now() - started}ms`);
  text = await turn.innerText();
  const rounds = text.split("Let me configure the IoT pane").length - 1;
  check(rounds === 0, "…and the repeated words are taken back off the answer", `${rounds} rounds left`);

  // ---- 4. a turn stored before reasoning was kept apart
  const put = await page.evaluate(async () => {
    const res = await fetch("/api/live-sessions/legacy-chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "aggregator",
        title: "Legacy chat",
        state: {
          services: ["tool-base64"],
          layout: "tabs",
          agentChat: [
            {
              id: "old1",
              question: "hi",
              answer: "Let me look first. </think> Let me look first. </think> I found it.",
              steps: [],
              status: "done",
            },
          ],
        },
      }),
    });
    return res.status;
  });
  check(put === 200, "Seeded a session with an old-style turn", String(put));
  // Arrives through live sync, as any other tab's new session does.
  await page.waitForSelector(ROW("Legacy chat"));
  await page.click(ROW("Legacy chat"));
  await page.waitForTimeout(500);
  await page.click(`${DOCK} button:text-is("Session")`).catch(() => {});
  turn = lastTurn(page);
  await turn.waitFor();
  text = await turn.innerText();
  check(!text.includes("</think>"), "An old turn's inline </think> isn't shown either", text);
  const oldAnswer = (await turn.locator(".agent-answer > p").allInnerTexts()).join("\n");
  check(oldAnswer === "I found it.", "…its answer is only what came after the reasoning", oldAnswer);
  check((await turn.locator(".agent-thoughts").count()) === 1, "…and the reasoning is folded like a new turn's");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
