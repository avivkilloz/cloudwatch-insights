// Two follow-ups to sharing phases 2 and 4:
// - Inviting a member through the session card updates the agent panel's own
//   "shared" gating right away (AgentContext's isShared), not only the next
//   time the session is viewed -- previously this needed a reload to notice.
// - The session tab's compose box suggests "@" mentions: every current
//   participant, plus the agent's own handle, narrowing as you type, and
//   picking one splices it into the text.
import { check, clearWorkspace, newPage, newSession, signIn, launch, report } from "./harness.mjs";

const CARD = ".session-body:not([hidden]) .session-card";
const MEMBERS_ROW = `${CARD} .session-card-row:has(.session-card-label:text-is("Members"))`;
const INPUT = `${MEMBERS_ROW} [aria-label="Username to invite"]`;
const SUGGESTIONS = `${MEMBERS_ROW} .username-suggestions`;
const DOCK = ".agent-dock";
const COMPOSE = `${DOCK} .agent-compose-input`;

const run = async () => {
  const browser = await launch();
  // The agent panel's own dock, open from the very first load, on the
  // Session tab -- so "no reload" genuinely means no reload anywhere below.
  const page = await newPage(browser);
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await signIn(page);
  await clearWorkspace(page);

  // Fixed names, cleaned up first (see smoke52's own comment for why).
  const gabi = "smoke53-gabi1";
  const setup = await page.evaluate(async ([names]) => {
    const existing = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
    for (const u of existing) {
      if (names.includes(u.username)) await fetch(`/api/users/${u.id}`, { method: "DELETE", credentials: "same-origin" });
    }
    const groups = await fetch("/api/user-groups", { credentials: "same-origin" }).then((r) => r.json());
    let group = groups.find((g) => g.name === "smoke53-invitees");
    if (!group) {
      group = await fetch("/api/user-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "smoke53-invitees", role_name: "R" }),
      }).then((r) => r.json());
    }
    const ids = [];
    for (const username of names) {
      const u = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "pw-123456", group_id: group.id }),
      }).then((r) => r.json());
      ids.push(u.id);
    }
    return ids;
  }, [[gabi]]);
  check(setup.every((id) => typeof id === "number"), "Precondition: an invitee exists", JSON.stringify(setup));

  await newSession(page, "CloudWatch");
  await page.waitForSelector(CARD);
  await page.waitForTimeout(1500);

  await page.waitForSelector(DOCK);
  await page.click(`${DOCK} .agent-tab:text-is("Session")`);
  const introBefore = await page.locator(`${DOCK} .agent-transcript`).innerText();
  check(!introBefore.includes("@platform-agent"), "Before inviting anyone, the chat doesn't yet say @platform-agent",
    introBefore);

  // ---------- inviting updates the chat's own gating immediately ----------
  await page.fill(INPUT, gabi);
  await page.waitForSelector(SUGGESTIONS);
  await page.click(`${SUGGESTIONS} .username-suggestion:text-is("${gabi}")`);
  await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await page.waitForSelector(`${MEMBERS_ROW} .session-member`);

  // No reload, no switching the Session tab away and back -- just the one
  // fetch `refreshShared` triggers on a successful invite.
  await page.waitForTimeout(800);
  const introAfter = await page.locator(`${DOCK} .agent-transcript`).innerText();
  check(introAfter.includes("@platform-agent"), "Right after inviting, with no reload, the chat already says @platform-agent",
    introAfter);

  // ---------- @ suggests the invited member and the agent, narrowing as you type ----------
  await page.click(COMPOSE);
  await page.type(COMPOSE, "hey @");
  // The participants list is fetched fresh the moment "@" starts a mention
  // (not cached from session mount, so an invite made moments ago is never
  // stale) -- give that request time to land before reading the dropdown.
  await page.waitForTimeout(500);
  let shown = await page.locator(`${DOCK} .username-suggestions .username-suggestion`).allInnerTexts();
  check(shown.some((t) => t.includes(gabi)) && shown.some((t) => t.includes("platform-agent")),
    "@ alone suggests the invited member and the agent's own handle", JSON.stringify(shown));

  await page.type(COMPOSE, "pl");
  await page.waitForTimeout(200);
  shown = await page.locator(`${DOCK} .username-suggestions .username-suggestion`).allInnerTexts();
  check(shown.length === 1 && shown[0].includes("platform-agent"), "Typing more narrows to just the agent",
    JSON.stringify(shown));

  await page.click(`${DOCK} .username-suggestion:text-is("@platform-agent")`);
  const composeValue = await page.locator(COMPOSE).inputValue();
  check(composeValue === "hey @platform-agent ", "Picking a mention splices it into the compose text, with a trailing space",
    composeValue);
  check((await page.locator(`${DOCK} .username-suggestions`).count()) === 0, "…and the dropdown closes");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
