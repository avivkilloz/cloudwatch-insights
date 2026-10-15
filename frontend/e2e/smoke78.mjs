// Four reports after 3c-2, driven the way a user would:
//   - the session card's settings read as one form: every setting its own row
//     with its label in the label column (Mode had been squeezed beside Layout,
//     its label floating), every control one height, the variables as chips
//     and "+ …" rather than a sentence; the members a compact list whose
//     permission and ✕ line up with the invite row's select and button, not
//     stretched to the card's far edge;
//   - a long unbroken token in the agent's warning (a topic, an ARN) wraps
//     inside its box instead of running out of it;
//   - a session shared with you is left, not deleted: its menu says Leave,
//     and it stays gone after a reload -- a member's Delete was refused by the
//     server (only the owner may delete), the refusal swallowed, and the
//     session came back on every load;
//   - a delete the server refuses puts the session back and says why.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, ROW, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const CARD = `${SHOWN} .session-card`;
const ROW_OF = (label) => `${CARD} .session-card-row:has(.session-card-label:text-is("${label}"))`;
const DOCK = ".agent-dock";

async function rowMenu(page, title) {
  const row = page.locator(`.rail-row:has(.rail-row-label:text-is("${title}"))`).first();
  await row.hover();
  await row.locator("button[aria-label*='More']").click();
  await page.waitForSelector(".rail-row-menu");
  return (await page.locator(".rail-row-menu button").allInnerTexts()).map((t) => t.trim());
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  const member = `smoke78-${Date.now()}`;
  const g = (await api(page, "POST", "/user-groups", { name: `g-${member}`, role_name: "R", tools_enabled: true })).body;
  check((await api(page, "POST", "/users", { username: member, password: "pw-123456", group_id: g.id })).status === 201, "Precondition: a member to share with");

  // ---- 1. the card's settings
  await newSession(page, "Base64");
  await page.waitForSelector(ROW_OF("Layout"));
  await page.waitForTimeout(1500);
  check((await page.locator(`${CARD} .session-card-label`).allInnerTexts()).join(",").includes("Layout,Mode,Refresh,Variables"),
    "Layout, Mode, Refresh and Variables are each a row of their own");
  await page.click(`${ROW_OF("Variables")} button:text-is("+ Environment")`);
  check((await page.locator(`${ROW_OF("Variables")} .session-card-chip`).innerText()).startsWith("Environment") &&
    (await page.locator(`${ROW_OF("Variables")}`).innerText()).indexOf("Set in the bar") < 0,
    "A defined variable is a chip; the others are buttons, not a sentence");
  const heights = await page.locator(`${ROW_OF("Layout")} button, ${ROW_OF("Mode")} button, ${ROW_OF("Refresh")} select, ${ROW_OF("Variables")} .session-card-chip, ${ROW_OF("Variables")} > .session-card-values > button`)
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check(heights.length >= 8 && heights.every((h) => h === 28), "Every control in those rows is the same height", JSON.stringify(heights));
  await page.fill(`${ROW_OF("Members")} [aria-label="Username to invite"]`, member);
  await page.selectOption(`${ROW_OF("Members")} [aria-label="Permission for the invited user"]`, "viewer");
  await page.click(`${ROW_OF("Members")} .session-member-invite button[type="submit"]`);
  await page.waitForSelector(`${ROW_OF("Members")} .session-member-name`);
  const box = (sel) => page.locator(`${ROW_OF("Members")} ${sel}`).first().boundingBox();
  const [perm, invitePerm, remove, invite, card] = await Promise.all([
    box(".session-member-permission"), box('[aria-label="Permission for the invited user"]'),
    box(".session-member-remove"), box('.session-member-invite button[type="submit"]'), page.locator(ROW_OF("Members")).boundingBox(),
  ]);
  const lined = {
    selects: Math.abs(perm.x - invitePerm.x),
    buttons: Math.abs(remove.x + remove.width / 2 - (invite.x + invite.width / 2)),
    farEdge: card.x + card.width - (remove.x + remove.width),
  };
  check(lined.selects < 1 && lined.buttons < 2, "A member's permission and ✕ line up with the invite row's select and button", JSON.stringify(lined));
  check(lined.farEdge > 100, "…in a compact list, not stretched to the card's far edge", JSON.stringify(lined));

  // ---- 2. a long token in the agent's warning wraps
  const title = await page.locator(".rail-row.active .rail-row-label").innerText();
  await page.evaluate(() => { localStorage.setItem("cwi-agent-open", "open"); localStorage.setItem("cwi-agent-layout", "dock"); });
  await page.reload();
  await page.waitForSelector(`${DOCK} .agent-tab[aria-selected="true"]:has-text("Session")`);
  await page.waitForTimeout(1500);
  const row = (await api(page, "GET", "/live-sessions")).body.find((s) => s.title === title);
  const long = "$aws/events/subscriptions/subscribed/" + "K9524RQM".repeat(12);
  const turn = { id: "t-wrap", question: "connect", answer: "Connected.", steps: [], status: "done", notice: `Answer claims listening to '${long}' but the tool shows otherwise.` };
  const put = await api(page, "PUT", `/live-sessions/${row.client_id}`, { title, type: "aggregator", state: { ...row.state, agentChat: [turn] }, base_version: row.version });
  check(put.status === 200, "Precondition: a turn with a long warning", String(put.status));
  await page.waitForSelector(`${DOCK} .agent-notice`, { timeout: 10000 });
  const fits = await page.locator(`${DOCK} .agent-notice`).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  check(fits.scroll <= fits.client + 1, "A long unbroken token wraps inside the warning", JSON.stringify(fits));

  // ---- 3. a member leaves; it stays gone
  const bob = await newPage(browser);
  await signIn(bob, { username: member, password: "pw-123456" });
  await bob.waitForSelector(ROW(title));
  const menu = await rowMenu(bob, title);
  check(menu.includes("Leave") && !menu.includes("Delete"), "A session shared with you offers Leave, not Delete", JSON.stringify(menu));
  bob.once("dialog", (d) => d.accept());
  await bob.click('.rail-row-menu button:text-is("Leave")');
  await bob.waitForTimeout(2000);
  await bob.reload();
  await bob.waitForSelector(".rail");
  await bob.waitForTimeout(2000);
  check((await bob.locator(ROW(title)).count()) === 0, "Left, it stays gone after a reload");
  check((await api(page, "GET", "/live-sessions")).body.some((s) => s.title === title), "…and stays the owner's");
  await bob.close();

  // ---- 4. a refused delete comes back, saying why
  await newSession(page, "Diff");
  await page.waitForTimeout(1500);
  const doomed = await page.locator(".rail-row.active .rail-row-label").innerText();
  await page.route("**/api/live-sessions/*", (route) =>
    route.request().method() === "DELETE" ? route.fulfill({ status: 500, json: { detail: "The database is read-only right now." } }) : route.continue());
  await rowMenu(page, doomed);
  page.once("dialog", (d) => d.accept());
  await page.click('.rail-row-menu button:text-is("Delete")');
  const said = await page.waitForSelector(".app-notice", { timeout: 8000 }).then((el) => el.innerText(), () => "");
  check(said.includes(`Couldn't delete "${doomed}"`) && said.includes("read-only"), "A refused delete says why", said);
  check((await page.locator(ROW(doomed)).count()) === 1, "…and puts the session back, rather than seeming gone until the next load");
  await page.unroute("**/api/live-sessions/*");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
