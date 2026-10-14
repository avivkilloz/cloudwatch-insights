// A change to a session's roster reaches the member's open browser at once,
// not at the owner's next edit:
//   - invited, the session appears in their rail while they look at it;
//   - made an editor, their edits start reaching the owner (a viewer's
//     browser keeps its edits to itself, so it has to hear of the change);
//   - removed, it leaves their rail.
// Until now an invite, a permission change and a removal announced nothing:
// the member's browser learnt of them only when the owner next wrote the
// session (which announces a write to every participant), or on a reload.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, ROW, SHOWN, signIn } from "./harness.mjs";

const CARD = `${SHOWN} .session-card`;
const MEMBERS_ROW = `${CARD} .session-card-row:has(.session-card-label:text-is("Members"))`;
const QUERY = `${SHOWN} .panel:has(h2:text-is("3. Query")) textarea`;

const run = async () => {
  const browser = await launch();
  const owner = await openApp(browser);
  await clearWorkspace(owner);

  const member = `smoke70-bob-${Date.now()}`;
  const made = await owner.evaluate(async (username) => {
    const g = await fetch("/api/user-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `smoke70-${username}`, role_name: "R", logs_enabled: true }),
    }).then((r) => r.json());
    return (await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "pw-123456", group_id: g.id }),
    })).status;
  }, member);
  check(made === 201, "Precondition: a second user to invite");

  await newSession(owner, "CloudWatch");
  await owner.waitForSelector(CARD);
  await owner.waitForTimeout(1500);

  // The member's browser is open, on the home page, before anything is shared.
  const bob = await newPage(browser);
  await signIn(bob, { username: member, password: "pw-123456" });
  check((await bob.locator(ROW("CloudWatch")).count()) === 0, "Before the invite, the member's rail doesn't have it");

  // ---- invited: it appears, with nothing more done by the owner
  await owner.fill(`${MEMBERS_ROW} [aria-label="Username to invite"]`, member);
  await owner.selectOption(`${MEMBERS_ROW} [aria-label="Permission for the invited user"]`, "viewer");
  await owner.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await owner.waitForSelector(`${MEMBERS_ROW} .session-member`);
  const appeared = await bob.waitForSelector(ROW("CloudWatch"), { timeout: 8000 }).then(() => true, () => false);
  check(appeared, "Invited, the session appears in the member's rail at once");
  if (!appeared) throw new Error("the invite never reached the member's browser");
  await bob.click(ROW("CloudWatch"));
  await bob.waitForSelector(QUERY);

  // ---- made an editor: their edit reaches the owner without a reload
  await owner.selectOption(`${MEMBERS_ROW} .session-member-permission`, "editor");
  await owner.waitForTimeout(2000);
  await bob.fill(QUERY, "fields @message | limit 70");
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    reached = (await owner.inputValue(QUERY)) === "fields @message | limit 70";
    if (!reached) await owner.waitForTimeout(250);
  }
  check(reached, "Made an editor, the member's edits reach the owner without a reload");

  // ---- removed: it leaves their rail
  await owner.click(`${MEMBERS_ROW} .session-member-remove`);
  const left = await bob
    .locator(ROW("CloudWatch"))
    .waitFor({ state: "detached", timeout: 8000 })
    .then(() => true, () => false);
  check(left, "Removed, the session leaves the member's rail at once");

  await clearWorkspace(owner);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
