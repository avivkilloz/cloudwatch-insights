// The platform agent, end to end: a question typed in the agent panel's Global
// tab goes to the agent container, which works through the backend's MCP tools as the user --
// creating sessions, filling in and running panes, arranging a dashboard --
// and every change arrives in the panes through live sync while the dock
// beside them shows what it's doing.
//
// Needs the whole stack, with the scripted stand-in model instead of a real
// one (platform-agent/dev/fake_llm.py): its answers are fixed by the question,
// so this can check exactly what should happen. See e2e/README.md.
import { SHOWN, ROW, check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const DOCK = ".agent-dock";
// The newest turn in the dock. Not :last-child -- the transcript ends in the
// element it scrolls to.
const lastTurn = (page, selector) => page.locator(`${DOCK} .agent-turn`).last().locator(selector);

/** Asks in the dock's Global tab -- the way in since the header's question box
 * went: the strip's toggle (at its far end) opens the panel if it's hidden. */
async function ask(page, text) {
  if ((await page.locator(DOCK).count()) === 0) await page.click(".session-bar-agent");
  await page.click(`${DOCK} .agent-tab:text-is("Global")`);
  await page.fill(`${DOCK} .agent-compose-input`, text);
  await page.press(`${DOCK} .agent-compose-input`, "Enter");
  await page.waitForSelector(`${DOCK} .agent-question:text-is("${text}")`);
}

/** Waits for the current turn to end (the Ask button comes back). */
async function settled(page, timeout = 30000) {
  await page.waitForSelector(`${DOCK} .agent-compose-actions button:text-is("Ask")`, { timeout });
}

async function stepTexts(page) {
  return lastTurn(page, ".agent-step-text").allInnerTexts();
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  // ---------- 1. Asked from the Global tab: a session made, filled in and run ----------
  await ask(page, "encode hello agent");
  check((await page.locator(`${DOCK} .agent-question:text-is("encode hello agent")`).count()) === 1,
    "The Global tab's question goes to the agent beside the page, with the question in it");
  // While it works, the session it's building is marked as the agent's.
  const marked = await page.waitForSelector(`${ROW("Base64")} .agent-working`, { timeout: 15000 }).then(() => true, () => false);
  check(marked, "The session the agent is working on is marked in the panel while it works");
  await settled(page);
  const steps = await stepTexts(page);
  check(
    JSON.stringify(steps) ===
      JSON.stringify([
        // Every turn opens with its own read of the asker's context (agent.py).
        "Checked who's asking and what they can reach",
        "Looked at what you can reach",
        "Created session “Base64”",
        "Ran a pane",
      ]),
    "Each step it took is listed, in order, in words", JSON.stringify(steps));
  check((await lastTurn(page, ".agent-step-ok").count()) === 4, "…each one marked as done");
  const answer = await lastTurn(page, ".agent-answer").innerText();
  check(answer.includes("aGVsbG8gYWdlbnQ="), "Its answer streams in, carrying the result", answer);

  // Follow is on by default: the app went to the session the agent made.
  const onBase64 = await page.locator(`.session-tab.active .session-tab-label:text-is("Base64")`).count();
  check(onBase64 === 1, "With Follow on, the app shows the session the agent created");
  const input = await page.locator(`${SHOWN} [data-pane-id="tool-base64"] textarea`).first().inputValue();
  const output = await page.locator(`${SHOWN} [data-pane-id="tool-base64"] textarea[readonly]`).inputValue();
  check(input === "hello agent" && output === "aGVsbG8gYWdlbnQ=",
    "The pane shows what the agent put in it, worked out as if typed by hand", JSON.stringify({ input, output }));
  await page.screenshot({ path: `${SHOT}/45-agent-encode.png` });

  // ---------- 2. A dashboard the agent lays out ----------
  await ask(page, "dashboard");
  await settled(page);
  await page.waitForSelector(`.session-tab.active .session-tab-label:text-is("Dashboard")`, { timeout: 10000 });
  await page.waitForSelector(`${SHOWN} .aggregator-dashboard [data-pane-id="tool-base64~2"]`, { timeout: 10000 });
  await page.waitForTimeout(800);
  const box = async (id) => page.locator(`${SHOWN} .aggregator-dashboard [data-pane-id="${id}"]`).boundingBox();
  const [a, b, c] = [await box("tool-base64"), await box("tool-diff"), await box("tool-base64~2")];
  const canvas = await page.locator(`${SHOWN} .aggregator-dashboard`).boundingBox();
  check(Math.abs(a.y - b.y) < 2 && b.x > a.x + a.width,
    "The agent's first row is two panes side by side", JSON.stringify({ a, b }));
  check(Math.abs(b.x + b.width - (c.x + c.width)) < 3 && c.y > a.y + a.height && Math.abs(c.x - a.x) < 3,
    "…and its second one pane across the full width below them", JSON.stringify({ a, b, c, canvas }));
  check(Math.abs(a.width - b.width) < 3, "…with the widths it asked for (6 and 6 of 12)", JSON.stringify({ a, b }));
  await page.screenshot({ path: `${SHOT}/45-agent-dashboard.png` });

  // ---------- 3. "Here" means the session on screen ----------
  await ask(page, "here");
  await settled(page);
  await page.waitForSelector(`${SHOWN} [data-pane-id="tool-diff~2"] textarea`, { timeout: 10000 });
  const left = await page.locator(`${SHOWN} [data-pane-id="tool-diff~2"] textarea`).first().inputValue();
  check(left === "one\ntwo", "A request about the session on screen changes that session", JSON.stringify(left));
  const titles = await page.locator(`${SHOWN} .aggregator-pane-title`).allInnerTexts().catch(() => []);
  check(titles.length === 0 || titles.some((t) => t.includes("Agent diff")), "…with the pane named as the agent named it",
    JSON.stringify(titles));

  // ---------- 4. A step that fails is shown as failed, and the agent says so ----------
  await ask(page, "break");
  await settled(page);
  check((await lastTurn(page, ".agent-step-failed").count()) === 1, "A failed step is marked as failed");
  const said = await lastTurn(page, ".agent-answer").innerText();
  check(said.includes("didn't work") && said.includes("no-such-session"),
    "…and the agent reports what went wrong rather than pretending", said);

  // ---------- 5. Follow off: the agent works without moving you ----------
  await page.click(".rail-row-home");
  await page.uncheck(`${DOCK} .agent-follow input`);
  await ask(page, "encode quietly");
  await settled(page);
  check((await page.locator(".rail-row-home.active").count()) === 1,
    "With Follow off, you stay where you were while it works");
  check((await page.locator(ROW("Base64 2")).count()) === 1, "…and what it made is still there in the panel");
  // An "Open" on the step takes you there when you want.
  await lastTurn(page, ".agent-step-open").first().click();
  check((await page.locator(`.session-tab.active .session-tab-label:text-is("Base64 2")`).count()) === 1,
    "A step's Open takes you to the session it touched");

  // ---------- 6. The same conversation on the Agent page ----------
  // The dock's Global tab and the Agent page are one conversation.
  await page.click(".rail-row-home");
  await page.click('.home-card-open:has(.home-card-title:text-is("Agent"))');
  await page.waitForSelector(`.agent-session .agent-question:text-is("dashboard")`);
  check((await page.locator(".agent-session .agent-turn").count()) === 5,
    "The Agent page shows the same conversation as the dock's Global tab");
  check((await page.locator(DOCK).count()) === 0, "…and the dock steps aside while it's on screen");

  // ---------- 7. A group without the agent can't use it ----------
  const groupId = await page.evaluate(async () => {
    const g = await (
      await fetch("/api/user-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `No agent ${Date.now()}` }),
      })
    ).json();
    await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `noagent${g.id}`, password: "pw-123456", group_id: g.id }),
    });
    return g.id;
  });
  const other = await openApp(browser, { username: `noagent${groupId}`, password: "pw-123456" });
  // With no header box to type into, the panel's Global tab is where they'd
  // ask -- and it says why it can't before anything is typed, with the box
  // disabled, so there is no question to send.
  if ((await other.locator(DOCK).count()) === 0) await other.click(".session-bar-agent");
  await other.click(`${DOCK} .agent-tab:text-is("Global")`);
  await other.waitForSelector(`${DOCK} .error-text`, { timeout: 10000 });
  const refused = await other.locator(`${DOCK} .error-text`).allInnerTexts();
  check(refused.some((t) => t.includes("isn't turned on for your group")),
    "Someone whose group doesn't have the agent is told so, and nothing is done", JSON.stringify(refused));
  check(await other.locator(`${DOCK} .agent-compose-input`).isDisabled(), "…with nowhere to type a question");
  check((await other.locator(ROW("Base64")).count()) === 0,
    "…and no session appears for them");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
