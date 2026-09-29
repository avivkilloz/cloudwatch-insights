// The session card's invite field suggests usernames as you type, narrowing
// with every character: "g" -> both a "gabi1" and a "gar2" user, "ga" ->
// still both, "gab" -> only "gabi1". Clicking a suggestion fills the field
// and still lets the normal invite flow (submit) go through.
import { SHOT, SHOWN, check, clearWorkspace, newSession, openApp, launch, report } from "./harness.mjs";

const CARD = `${SHOWN} .session-card`;
const MEMBERS_ROW = `${CARD} .session-card-row:has(.session-card-label:text-is("Members"))`;
const INPUT = `${MEMBERS_ROW} [aria-label="Username to invite"]`;
const SUGGESTIONS = `${MEMBERS_ROW} .username-suggestions`;

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  // Fixed names, not timestamped: the discriminating prefixes below ("g",
  // "ga", "gab") have to belong to exactly these three users and no others,
  // forever -- a timestamp suffix wouldn't stop a *previous run's* same-named
  // users (this suite doesn't delete what it creates) from also matching a
  // short shared prefix the next time it runs. So this run first deletes any
  // leftovers of its own from an earlier run, then creates them fresh.
  const gabi = "smoke52-gabi1";
  const gar = "smoke52-gar2";
  const harriet = "smoke52-harriet";
  const setup = await page.evaluate(
    async ([names]) => {
      const existing = await fetch("/api/users", { credentials: "same-origin" }).then((r) => r.json());
      for (const u of existing) {
        if (names.includes(u.username)) await fetch(`/api/users/${u.id}`, { method: "DELETE", credentials: "same-origin" });
      }
      const groups = await fetch("/api/user-groups", { credentials: "same-origin" }).then((r) => r.json());
      let group = groups.find((g) => g.name === "smoke52-invitees");
      if (!group) {
        group = await fetch("/api/user-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "smoke52-invitees", role_name: "R" }),
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
    },
    [[gabi, gar, harriet]],
  );
  check(setup.every((id) => typeof id === "number"), "Precondition: three users exist to suggest among",
    JSON.stringify(setup));

  await newSession(page, "CloudWatch");
  await page.waitForSelector(CARD);
  await page.waitForTimeout(1500);

  // ---------- typing narrows the suggestions, prefix by prefix ----------
  // "smoke52-" is common to all three (so an old run's leftover users would
  // still confuse this if it didn't clean them up above); "g" is where gabi1
  // and gar2 diverge from harriet, "gab" is where they diverge from each other.
  await page.fill(INPUT, "smoke52-g");
  await page.waitForSelector(SUGGESTIONS);
  await page.waitForTimeout(300);
  let shown = await page.locator(`${SUGGESTIONS} .username-suggestion`).allInnerTexts();
  check(shown.includes(gabi) && shown.includes(gar) && !shown.includes(harriet),
    "Typing a single shared letter suggests both matching users, not the third", JSON.stringify(shown));

  await page.type(INPUT, "a"); // "smoke52-ga"
  await page.waitForTimeout(300);
  shown = await page.locator(`${SUGGESTIONS} .username-suggestion`).allInnerTexts();
  check(shown.includes(gabi) && shown.includes(gar), "Both still match a longer shared prefix", JSON.stringify(shown));

  await page.type(INPUT, "b"); // "smoke52-gab"
  await page.waitForTimeout(300);
  shown = await page.locator(`${SUGGESTIONS} .username-suggestion`).allInnerTexts();
  check(shown.length === 1 && shown[0] === gabi, "One more letter narrows it to just gabi1", JSON.stringify(shown));
  await page.locator(MEMBERS_ROW).screenshot({ path: `${SHOT}/52-suggestions.png` });

  // ---------- the dropdown is as wide as the input, not the whole row ----------
  const inputBox = await page.locator(INPUT).boundingBox();
  const dropdownBox = await page.locator(SUGGESTIONS).boundingBox();
  check(Math.abs(inputBox.width - dropdownBox.width) < 2, "The dropdown's width matches the input's own",
    `input=${inputBox.width} dropdown=${dropdownBox.width}`);

  // ---------- clicking a suggestion fills the field and closes the dropdown ----------
  await page.click(`${SUGGESTIONS} .username-suggestion:text-is("${gabi}")`);
  check((await page.locator(INPUT).inputValue()) === gabi, "Clicking a suggestion fills the field with it");
  check((await page.locator(SUGGESTIONS).count()) === 0, "…and closes the dropdown");
  // The debounced fetch effect still runs once for the picked name (matching
  // it exactly) -- past its 150ms delay is where a suppressed re-run had to
  // actually take effect, or the dropdown reopens right back up on its own.
  await page.waitForTimeout(400);
  check((await page.locator(SUGGESTIONS).count()) === 0, "…and it's still closed once that debounced fetch would have fired");

  // ---------- the normal invite flow still works from a picked suggestion ----------
  await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
  await page.waitForSelector(`${MEMBERS_ROW} .session-member`);
  check((await page.locator(`${MEMBERS_ROW} .session-member-name`).innerText()) === gabi,
    "Submitting after picking a suggestion invites that exact user");

  // ---------- someone already invited is never suggested again ----------
  await page.fill(INPUT, "smoke52-g");
  await page.waitForTimeout(300);
  shown = await page.locator(`${SUGGESTIONS} .username-suggestion`).allInnerTexts();
  check(!shown.includes(gabi) && shown.includes(gar), "An already-invited user drops out of future suggestions",
    JSON.stringify(shown));

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
