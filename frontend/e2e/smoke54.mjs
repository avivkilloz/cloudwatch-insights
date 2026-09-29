// A viewer's chat messages (and the agent's replies to them) reached no one
// but themselves: sync.ts's pushOne skipped a viewer's PUT unconditionally,
// which blocked the whole session `state` blob including agentChat, not
// just the panes/layout a viewer genuinely can't edit. Chatting isn't
// editing the session, so a change confined to just the chat log now goes
// out even for a viewer (chatOnlyChange in sync.ts, mirrored server-side in
// upsert_live_session) -- everything else about the session stays refused.
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

  // Fixed name, cleaned up first -- same reasoning as smoke52/53's own comment.
  const viewerUser = "smoke54-viewer";
  const setup = await owner.evaluate(async (username) => {
    const existing = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    for (const u of existing) {
      if (u.username === username) await fetch(`/api/users/${u.id}`, { method: "DELETE", credentials: "same-origin" });
    }
    const groups = await fetch("/api/user-groups", { credentials: "same-origin" }).then((r) => r.json());
    let group = groups.find((g) => g.name === "smoke54-invitees");
    if (!group) {
      group = await fetch("/api/user-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "smoke54-invitees", role_name: "R", agent_enabled: true }),
      }).then((r) => r.json());
    }
    const u = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "pw-123456", group_id: group.id }),
    }).then((r) => r.json());
    return u.id;
  }, viewerUser);
  check(typeof setup === "number", "Precondition: a viewer user exists", JSON.stringify(setup));

  await newSession(owner, "CloudWatch");
  await owner.waitForTimeout(1500);
  const clientId = await owner.evaluate(async () => (await (await fetch("/api/live-sessions")).json())[0].client_id);
  await owner.evaluate(
    ({ id, username }) =>
      fetch(`/api/live-sessions/${id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, permission: "viewer" }),
      }),
    { id: clientId, username: viewerUser },
  );

  const viewer = await newPage(browser);
  await openDock(viewer);
  await signIn(viewer, { username: viewerUser, password: "pw-123456" });
  await viewer.waitForSelector(`.rail-row:has-text("CloudWatch")`, { timeout: 15000 });
  await viewer.click(`.rail-row:has-text("CloudWatch")`);
  await viewer.waitForSelector(DOCK);
  await viewer.click(`${DOCK} .agent-tab:text-is("Session")`);
  await viewer.waitForTimeout(500);

  // ---------- a viewer's plain chat message reaches the owner ----------
  const viewerMsg = "hello from the viewer";
  await viewer.fill(`${DOCK} .agent-compose-input`, viewerMsg);
  await viewer.click(`${DOCK} button:text-is("Ask")`);
  await viewer.waitForTimeout(2000);

  await owner.click(`.rail-row:has-text("CloudWatch")`);
  await owner.waitForSelector(DOCK);
  await owner.click(`${DOCK} .agent-tab:text-is("Session")`);
  await owner.waitForTimeout(500);
  const ownerText = await owner.locator(`${DOCK} .agent-transcript`).innerText();
  check(ownerText.includes(viewerMsg), "The owner sees the viewer's plain chat message", ownerText);

  // ---------- and it survives a reload for the viewer too (it's really on the server) ----------
  await viewer.reload();
  await viewer.waitForSelector(".rail");
  await viewer.click(`.rail-row:has-text("CloudWatch")`);
  await viewer.waitForSelector(DOCK);
  await viewer.click(`${DOCK} .agent-tab:text-is("Session")`);
  await viewer.waitForTimeout(500);
  const viewerTextAfterReload = await viewer.locator(`${DOCK} .agent-transcript`).innerText();
  check(viewerTextAfterReload.includes(viewerMsg), "…confirmed server-side: it survives a reload for the viewer too",
    viewerTextAfterReload);

  // ---------- a viewer mentioning the agent still gets a real reply, seen by the owner too ----------
  // (the fake model's own commands are startswith-matched against the raw
  // text, which the author-name prefix a shared session adds defeats -- its
  // fallback reply is exactly as good a proof that an actual answer, not
  // just the question, made it to the owner.)
  const mentionMsg = "@platform-agent hello agent";
  await viewer.fill(`${DOCK} .agent-compose-input`, mentionMsg);
  await viewer.click(`${DOCK} button:text-is("Ask")`);
  await viewer.waitForTimeout(3000);
  const viewerAfterMention = await viewer.locator(`${DOCK} .agent-transcript`).innerText();
  check(viewerAfterMention.includes(mentionMsg), "The viewer's own @mention question shows up", viewerAfterMention);

  await owner.reload();
  await owner.waitForSelector(".rail");
  await owner.click(`.rail-row:has-text("CloudWatch")`);
  await owner.waitForSelector(DOCK);
  await owner.click(`${DOCK} .agent-tab:text-is("Session")`);
  await owner.waitForTimeout(1000);
  const ownerAfterMention = await owner.locator(`${DOCK} .agent-transcript`).innerText();
  check(ownerAfterMention.includes(mentionMsg), "…and the owner sees the viewer's @mention question too",
    ownerAfterMention);
  check(ownerAfterMention.includes("I'm the development stand-in model"),
    "…including the agent's actual reply to the viewer, not just their question", ownerAfterMention);

  // ---------- but a viewer genuinely still can't edit the session itself ----------
  const noPaneEdits = await viewer.evaluate(
    async (id) => {
      const resp = await fetch(`/api/live-sessions/${id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "aggregator", title: "hijacked", state: { services: [] }, truncated: false }),
      });
      return resp.status;
    },
    clientId,
  );
  check(noPaneEdits === 403, "A viewer still can't push a non-chat change -- that stays refused", String(noPaneEdits));

  await clearWorkspace(owner);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
