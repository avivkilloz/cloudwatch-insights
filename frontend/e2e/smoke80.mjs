// 3d-1: access per pane type (D65, PLATFORM_PLAN.md §19.1), driven as an admin
// would:
//   - Users → Groups: a group's Panes are a checkbox per pane type, under
//     Services and Tools, with All / None per row and the Platform agent its
//     own row -- "Tools" used to be one switch for six panes;
//   - a group given one tool sees exactly that tool, in the default page and
//     the side panel's Add list, and nothing else of Tools;
//   - granting another, the member sees it on their next load;
//   - the Admin group's form says "Every pane".
import { SHOT, check, clearWorkspace, launch, newPage, openApp, report, signIn } from "./harness.mjs";

const GROUP = `Smoke grants ${Date.now()}`;
const USER = `grants${Date.now()}`;
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

  // ---- 1. the form
  await openGroups(page);
  await page.click('button:text-is("New group")');
  await page.waitForSelector(ROW_OF("Tools"));
  const tools = (await page.locator(`${ROW_OF("Tools")} .checkbox-item`).allInnerTexts()).map((t) => t.trim());
  const services = (await page.locator(`${ROW_OF("Services")} .checkbox-item`).allInnerTexts()).map((t) => t.trim());
  check(tools.includes("Base64") && tools.includes("HTTP client") && tools.length >= 6,
    "Each tool is its own checkbox, not one Tools switch", JSON.stringify(tools));
  check(services.includes("CloudWatch") && services.includes("IoT"), "…and each service", JSON.stringify(services));
  check((await page.locator(`${ROW_OF("Agent")} .checkbox-item`).innerText()).includes("Platform agent"),
    "The Platform agent is a row of its own");
  check((await page.locator(`${EDITOR} input[type=checkbox]:checked`).count()) === tools.length + services.length,
    "A new group starts with every pane type, ticked where it can be seen (and not the agent)");

  await page.locator(`${EDITOR} .session-card-section:has(h3:text-is("Panes"))`).screenshot({ path: `${SHOT}/80-panes.png` });

  // Only Base64: None on both rows, then the one tick.
  await page.fill("#group-name", GROUP);
  await page.click(`${ROW_OF("Services")} button:text-is("None")`);
  await page.click(`${ROW_OF("Tools")} button:text-is("None")`);
  check((await page.locator(`${ROW_OF("Tools")} input:checked, ${ROW_OF("Services")} input:checked`).count()) === 0,
    "None on a row unticks it");
  await page.locator(`${ROW_OF("Tools")} .checkbox-item:has-text("Base64") input`).check();
  await page.click(`${EDITOR} .credential-view-foot button:text-is("Create")`);
  await page.waitForTimeout(800);
  const stored = (await api(page, "GET", "/user-groups")).body.find((g) => g.name === GROUP);
  check(JSON.stringify(stored?.pane_types) === JSON.stringify(["tool-base64"]), "Saved as exactly that pane type",
    JSON.stringify(stored?.pane_types));
  await api(page, "POST", "/users", { username: USER, password: "pw-123456", group_id: stored.id });

  // ---- 2. what the member sees
  const member = await newPage(browser);
  await signIn(member, { username: USER, password: "pw-123456" });
  await member.click(".rail-row-home");
  await member.waitForSelector(".home .home-card-title");
  let cards = await defaultPageCards(member);
  check(cards.includes("Base64") && !cards.includes("HTTP client") && !cards.includes("CloudWatch"),
    "A member sees Base64 and no other tool or service", JSON.stringify(cards));
  const adds = (await member.locator(".rail-row-type .rail-row-label").allInnerTexts()).map((t) => t.trim());
  check(adds.includes("Base64") && !adds.includes("Diff"), "…in the side panel's Add list too", JSON.stringify(adds));

  // ---- 3. granted one more
  await page.click(`[data-group="${GROUP}"]`);
  await page.waitForSelector(ROW_OF("Tools"));
  check(await page.locator(`${ROW_OF("Tools")} .checkbox-item:has-text("Base64") input`).isChecked() &&
    !(await page.locator(`${ROW_OF("Tools")} .checkbox-item:has-text("Diff") input`).isChecked()),
    "Reopened, the form shows what it has");
  await page.locator(`${ROW_OF("Tools")} .checkbox-item:has-text("HTTP client") input`).check();
  await page.click(`${EDITOR} .credential-view-foot button:text-is("Save")`);
  await page.waitForTimeout(800);
  await member.reload();
  await member.waitForSelector(".rail");
  await member.click(".rail-row-home");
  await member.waitForSelector(".home .home-card-title");
  cards = await defaultPageCards(member);
  check(cards.includes("HTTP client") && cards.includes("Base64") && !cards.includes("Diff"), "Granted the HTTP client, the member has it too",
    JSON.stringify(cards));
  await member.close();

  // ---- 4. the Admin group
  const admin = (await api(page, "GET", "/user-groups")).body.find((g) => g.is_admin);
  await page.click(`[data-group="${admin.name}"]`);
  await page.waitForSelector(`${EDITOR} .session-card-row:has(.session-card-label:text-is("Can use"))`);
  check((await page.locator(ROW_OF("Can use")).innerText()).includes("Every pane"), "The Admin group says it can use every pane");

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
