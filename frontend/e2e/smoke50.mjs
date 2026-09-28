// Sharing a session, phase 2: the session card's own Members section.
// Phase 1 (backend) added the roster API; this is the UI on top of it --
// invite by username at a permission, change a member's permission, remove
// one, and the errors the API can hand back (no such user, already a
// member, inviting yourself). None of this yet lets an invited member
// actually reach the session -- that's phase 3.
import { SHOT, SHOWN, addPane, check, clearWorkspace, newSession, openApp, launch, report } from "./harness.mjs";

const CARD = `${SHOWN} .session-card`;
const MEMBERS_ROW = `${CARD} .session-card-row:has(.session-card-label:text-is("Members"))`;

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  // Unique every run: this suite's own database isn't reset between runs
  // the way the pytest one is, and group/user names are unique.
  const stamp = Date.now();
  const invitee = `smoke50-carol-${stamp}`;
  const setup = await page.evaluate(
    async (username) => {
      const g = await fetch("/api/user-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `smoke50-invitees-${username}`, role_name: "R" }),
      }).then((r) => r.json());
      const u = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "pw-123456", group_id: g.id }),
      }).then((r) => r.json());
      return u.id;
    },
    invitee,
  );
  check(typeof setup === "number", "Precondition: a second user exists to invite", JSON.stringify(setup));

  await newSession(page, "CloudWatch");
  await page.waitForSelector(CARD);
  // The session card's own writes (its name, description, the panes it
  // holds) go through the debounced autosave; the Members API needs the
  // session's row to exist on the server first, or an invite 404s -- the
  // same window every other write into a brand-new session already has.
  await page.waitForTimeout(1500);

  check((await page.locator(MEMBERS_ROW).count()) === 1, "The card has a Members row");
  check((await page.locator(`${MEMBERS_ROW} .session-member`).count()) === 0, "…with nobody on it yet");

  // ---------- inviting someone who doesn't exist ----------
  await page.fill(`${MEMBERS_ROW} [aria-label="Username to invite"]`, "smoke50-nobody");
  await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await page.waitForSelector(`${SHOWN} .error-text`);
  check((await page.locator(`${SHOWN} .error-text`).innerText()).includes("No user named"),
    "Inviting a username that doesn't exist is refused, readably");

  // ---------- inviting yourself ----------
  await page.fill(`${MEMBERS_ROW} [aria-label="Username to invite"]`, "admin");
  await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await page.waitForTimeout(300);
  check((await page.locator(`${SHOWN} .error-text`).innerText()).includes("already own"),
    "Inviting yourself (the owner) is refused");

  // ---------- invite, at a chosen permission ----------
  await page.fill(`${MEMBERS_ROW} [aria-label="Username to invite"]`, invitee);
  await page.selectOption(`${MEMBERS_ROW} [aria-label="Permission for the invited user"]`, "viewer");
  await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await page.waitForSelector(`${MEMBERS_ROW} .session-member`);
  const invited = {
    name: await page.locator(`${MEMBERS_ROW} .session-member-name`).innerText(),
    perm: await page.locator(`${MEMBERS_ROW} .session-member-permission`).inputValue(),
  };
  check(invited.name === invitee && invited.perm === "viewer", "The invited user appears, at the permission chosen",
    JSON.stringify(invited));
  check((await page.locator(`${MEMBERS_ROW} [aria-label="Username to invite"]`).inputValue()) === "",
    "…and the invite field clears, ready for another");
  await page.locator(MEMBERS_ROW).screenshot({ path: `${SHOT}/50-members.png` });

  // ---------- inviting the same user twice ----------
  await page.fill(`${MEMBERS_ROW} [aria-label="Username to invite"]`, invitee);
  await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await page.waitForTimeout(300);
  check((await page.locator(`${SHOWN} .error-text`).innerText()).includes("already a member"),
    "Inviting the same user again is refused");
  check((await page.locator(`${MEMBERS_ROW} .session-member`).count()) === 1, "…and they aren't listed twice");

  // ---------- changing a member's permission ----------
  await page.selectOption(`${MEMBERS_ROW} .session-member-permission`, "editor");
  await page.waitForTimeout(300);
  check((await page.locator(`${MEMBERS_ROW} .session-member-permission`).inputValue()) === "editor",
    "A member's permission can be changed in place");

  // ---------- it's server-backed, not session state: survives a reload ----------
  await page.reload();
  await page.waitForSelector(MEMBERS_ROW);
  await page.waitForSelector(`${MEMBERS_ROW} .session-member`);
  const afterReload = {
    name: await page.locator(`${MEMBERS_ROW} .session-member-name`).innerText(),
    perm: await page.locator(`${MEMBERS_ROW} .session-member-permission`).inputValue(),
  };
  check(afterReload.name === invitee && afterReload.perm === "editor",
    "The member and their (changed) permission survive a reload", JSON.stringify(afterReload));

  // ---------- removing a member ----------
  await page.click(`${MEMBERS_ROW} .session-member-remove`);
  await page.waitForTimeout(300);
  check((await page.locator(`${MEMBERS_ROW} .session-member`).count()) === 0, "Removing a member takes them off the list");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
