// No per-group panes (D160; was 3d-1's access per pane type, D65): every
// pane type is everyone's, and what a group is given is its environments.
//   - Users → Groups: a group's form has Features (the Platform agent, the
//     Builder) and no Panes to tick; a new group's agent is off;
//   - a member of a group with nothing else sees every pane, in the default
//     page and in the side panel's Add list.
import { SHOT, check, clearWorkspace, launch, newPage, openApp, report, signIn } from "./harness.mjs";

const GROUP = `Smoke no grants ${Date.now()}`;
const USER = `nogrants${Date.now()}`;
const EDITOR = ".group-editor";
const ROW_OF = (label) => `${EDITOR} .session-card-row:has(.session-card-label:text-is("${label}"))`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function openGroups(page) {
  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  await page.click('.content .settings-tabs button:text-is("Users")');
  await page.click('.segmented button:text-is("Groups")');
}

const defaultPageCards = (page) => page.locator(".home .home-card-title").allInnerTexts();

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  // ---- 1. the group form
  await openGroups(page);
  await page.click('button:text-is("New group")');
  await page.waitForSelector(ROW_OF("Agent"));
  const sections = (await page.locator(`${EDITOR} .credential-section-head h3`).allInnerTexts()).map((t) => t.toLowerCase());
  check(!sections.includes("panes") && sections.includes("features"), "A group's form has Features and no Panes",
    JSON.stringify(sections));
  check((await page.locator(`${ROW_OF("Agent")} .checkbox-item`).innerText()).includes("Platform agent") &&
    !(await page.locator(`${ROW_OF("Agent")} input`).isChecked()), "The Platform agent is a row of its own, off for a new group");
  check((await page.locator(`${ROW_OF("Builder")} .checkbox-item`).innerText()).includes("Makes new"),
    "…and so is the Builder: making new things");
  await page.locator(`${EDITOR} .credential-section-head:has(h3:text-is("Features"))`).screenshot({ path: `${SHOT}/80-features.png` }).catch(() => {});
  await page.fill("#group-name", GROUP);
  await page.click(`${EDITOR} .credential-view-foot button:text-is("Create")`);
  await page.waitForTimeout(800);
  const stored = (await api(page, "GET", "/user-groups")).body.find((g) => g.name === GROUP);
  check(stored && stored.pane_types === undefined, "A group carries no list of panes", JSON.stringify(stored));
  await api(page, "POST", "/users", { username: USER, password: "pw-123456", group_id: stored.id });

  // ---- 2. what the member sees: everything
  const member = await newPage(browser);
  await signIn(member, { username: USER, password: "pw-123456" });
  await member.click(".rail-row-home");
  await member.waitForSelector(".home .home-card-title");
  const cards = await defaultPageCards(member);
  check(["Base64", "Diff", "HTTP client", "CloudWatch", "IoT"].every((c) => cards.includes(c)),
    "A member of a group given nothing sees every pane", JSON.stringify(cards));
  const adds = (await member.locator(".rail-row-type .rail-row-label").allInnerTexts()).map((t) => t.trim());
  check(adds.includes("Base64") && adds.includes("CloudWatch"), "…in the side panel's Add list too", JSON.stringify(adds));
  await member.close();

  // Tidy: the group and its user.
  const users = (await api(page, "GET", "/users")).body;
  for (const u of users.filter((u) => u.username === USER)) await api(page, "DELETE", `/users/${u.id}`);
  await api(page, "DELETE", `/user-groups/${stored.id}`);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
