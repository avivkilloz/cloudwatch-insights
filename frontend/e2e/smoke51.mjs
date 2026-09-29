// Sharing a session, phase 4: the session-tab chat becomes a real
// conversation between whoever's on it, not just the owner and the agent.
// A plain message never reaches the agent once a session actually has
// members -- only one that mentions @platform-agent does -- and two
// people's messages, sent close together, both survive (the merge unions
// the chat log by turn id rather than letting one side's array win).
import {
  SHOT,
  check,
  clearWorkspace,
  launch,
  newSession,
  openApp,
  report,
} from "./harness.mjs";

const DOCK = ".agent-dock";

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  await clearWorkspace(admin);

  const stamp = Date.now();
  const bobUser = `smoke51-bob-${stamp}`;
  const setup = await admin.evaluate(async (username) => {
    const g = await fetch("/api/user-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `smoke51-group-${username}`, role_name: "R", agent_enabled: true }),
    }).then((r) => r.json());
    await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "pw-123456", group_id: g.id }),
    });
    return g.id;
  }, bobUser);
  check(typeof setup === "number", "Precondition: a second user's group exists, with the agent turned on");

  await newSession(admin, "CloudWatch");
  // The debounced autosave needs a moment before the session's row exists
  // on the server to invite anyone into.
  await admin.waitForTimeout(1500);
  const clientId = await admin.evaluate(async () => {
    const [row] = await (await fetch("/api/live-sessions")).json();
    return row.client_id;
  });
  await admin.evaluate(
    ({ id, username }) =>
      fetch(`/api/live-sessions/${id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, permission: "editor" }),
      }),
    { id: clientId, username: bobUser },
  );

  // ---------- Admin opens the session's chat and sends a plain message ----------
  await admin.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await admin.reload();
  await admin.waitForSelector(".rail");
  await admin.click(`.session-tab-label:text-is("CloudWatch")`);
  await admin.waitForSelector(DOCK);
  await admin.click(`${DOCK} .agent-tab:text-is("Session")`);
  // The one-time fetch that tells the owner's own browser the session has
  // members (an invited member's own `role` already knows without asking).
  await admin.waitForTimeout(1200);

  const intro = await admin.locator(`${DOCK} .agent-transcript`).innerText();
  check(intro.includes("@platform-agent"), "Once a session has a member, its chat says the agent only joins when mentioned",
    intro);

  await admin.fill(`${DOCK} .agent-compose-input`, "hey, checking the logs now");
  await admin.press(`${DOCK} .agent-compose-input`, "Enter");
  await admin.waitForTimeout(600);
  const adminTurn = await admin.evaluate(() => {
    const turns = [...document.querySelectorAll(".agent-dock .agent-turn")];
    const t = turns[turns.length - 1];
    return { count: turns.length, hasAnswer: !!t.querySelector(".agent-answer"), text: t.querySelector(".agent-question").innerText };
  });
  check(adminTurn.count === 1 && !adminTurn.hasAnswer, "A plain message in a shared session's chat never reaches the agent",
    JSON.stringify(adminTurn));
  check(adminTurn.text.includes("admin"), "…and shows who sent it", adminTurn.text);

  // ---------- Bob logs in, sees the same chat ----------
  const bob = await openApp(browser, { username: bobUser, password: "pw-123456" });
  await bob.click(`.session-tab-label:text-is("CloudWatch")`);
  await bob.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await bob.reload();
  await bob.waitForSelector(".rail");
  await bob.click(`.session-tab-label:text-is("CloudWatch")`);
  await bob.waitForSelector(DOCK);
  await bob.click(`${DOCK} .agent-tab:text-is("Session")`);
  await bob.waitForSelector(`${DOCK} .agent-turn`);

  const bobsView = await bob.evaluate(() => {
    const t = document.querySelector(".agent-dock .agent-turn");
    return {
      author: t.querySelector(".agent-turn-author")?.innerText,
      theirs: t.querySelector(".agent-question").classList.contains("agent-question-theirs"),
    };
  });
  check(bobsView.author === "admin" && bobsView.theirs, "A member sees the owner's message live, labelled and on the left",
    JSON.stringify(bobsView));
  await bob.locator(`${DOCK} .agent-transcript`).screenshot({ path: `${SHOT}/51-bob-sees-admin.png` });

  // ---------- Bob replies (plain), then mentions the agent ----------
  await bob.fill(`${DOCK} .agent-compose-input`, "yep, looking too");
  await bob.press(`${DOCK} .agent-compose-input`, "Enter");
  await bob.waitForTimeout(600);
  await bob.fill(`${DOCK} .agent-compose-input`, "@platform-agent hello");
  await bob.press(`${DOCK} .agent-compose-input`, "Enter");
  await bob.waitForSelector(`${DOCK} .agent-turn:nth-child(3) .agent-answer`, { timeout: 15000 });

  const bobFinal = await bob.evaluate(() => {
    const turns = [...document.querySelectorAll(".agent-dock .agent-turn")];
    return {
      count: turns.length,
      lastHasAnswer: !!turns[turns.length - 1].querySelector(".agent-answer"),
      texts: turns.map((t) => t.querySelector(".agent-question").innerText),
    };
  });
  check(bobFinal.count === 3 && bobFinal.lastHasAnswer, "Mentioning the agent, and only that message, gets a reply",
    JSON.stringify(bobFinal));

  // ---------- Both browsers converge: nobody's message was lost ----------
  await admin.waitForTimeout(4000);
  const adminFinal = await admin.evaluate(() => {
    const turns = [...document.querySelectorAll(".agent-dock .agent-turn")];
    return { count: turns.length, texts: turns.map((t) => t.querySelector(".agent-question").innerText) };
  });
  check(adminFinal.count === 3, "The owner's browser ends up with every message too -- none dropped by the merge",
    JSON.stringify(adminFinal));

  await clearWorkspace(admin);
  await admin.close();
  await bob.close();
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
