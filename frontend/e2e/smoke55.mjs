// A shared session's chat is people talking to each other, not just to the
// agent -- a group without agent_enabled still has that to use. Previously
// the compose box was disabled outright for anyone whose group lacked agent
// access, blocking plain chat too. Now only an @mention is refused (the
// backend already 403s "the agent isn't turned on for your group" -- unwired
// here, just no longer hidden behind a disabled textarea).
import { check, clearWorkspace, newPage, newSession, signIn, launch, report } from "./harness.mjs";

const DOCK = ".agent-dock";

async function openDock(page) {
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
}

const run = async () => {
  const browser = await launch();
  const owner = await newPage(browser);
  await openDock(owner);
  await signIn(owner);
  await clearWorkspace(owner);

  // Fixed name, cleaned up first -- same reasoning as smoke52's own comment.
  const noAgentUser = "smoke55-noagent";
  await owner.evaluate(async (username) => {
    const existing = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    for (const u of existing) {
      if (u.username === username) await fetch(`/api/users/${u.id}`, { method: "DELETE", credentials: "same-origin" });
    }
    const groups = await fetch("/api/user-groups", { credentials: "same-origin" }).then((r) => r.json());
    let group = groups.find((g) => g.name === "smoke55-noagent-group");
    if (!group) {
      // agent_enabled deliberately omitted -- defaults to false.
      group = await fetch("/api/user-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "smoke55-noagent-group", role_name: "R" }),
      }).then((r) => r.json());
    }
    await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "pw-123456", group_id: group.id }),
    });
  }, noAgentUser);

  await newSession(owner, "CloudWatch");
  await owner.waitForTimeout(1500);
  const clientId = await owner.evaluate(async () => (await (await fetch("/api/live-sessions")).json())[0].client_id);
  await owner.evaluate(
    ({ id, username }) =>
      fetch(`/api/live-sessions/${id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, permission: "editor" }),
      }),
    { id: clientId, username: noAgentUser },
  );

  const member = await newPage(browser);
  await openDock(member);
  await signIn(member, { username: noAgentUser, password: "pw-123456" });
  await member.waitForSelector(`.rail-row:has-text("CloudWatch")`, { timeout: 15000 });
  await member.click(`.rail-row:has-text("CloudWatch")`);
  await member.waitForSelector(DOCK);
  await member.click(`${DOCK} .agent-tab:text-is("Session")`);
  await member.waitForTimeout(500);

  const isDisabled = await member.locator(`${DOCK} .agent-compose-input`).isDisabled();
  check(!isDisabled, "The compose box isn't disabled for a member whose group lacks agent access, in a shared session",
    String(isDisabled));

  // ---------- a plain chat message still works normally ----------
  const plainMsg = "hello, no agent access here";
  await member.fill(`${DOCK} .agent-compose-input`, plainMsg);
  await member.click(`${DOCK} button:text-is("Ask")`);
  await member.waitForTimeout(800);
  const afterPlain = await member.locator(`${DOCK} .agent-transcript`).innerText();
  check(afterPlain.includes(plainMsg), "A plain chat message still works normally", afterPlain);

  // ---------- but @mentioning the agent gets a "no access" reply, not a real answer ----------
  const mentionMsg = "@platform-agent hello";
  await member.fill(`${DOCK} .agent-compose-input`, mentionMsg);
  await member.click(`${DOCK} button:text-is("Ask")`);
  await member.waitForTimeout(1500);
  const afterMention = await member.locator(`${DOCK} .agent-transcript`).innerText();
  check(afterMention.includes(mentionMsg), "The @mention question itself still shows up", afterMention);
  check(afterMention.includes("isn't turned on for your group"),
    "…but the reply says the group lacks agent access, not a real agent answer", afterMention);

  await clearWorkspace(owner);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
