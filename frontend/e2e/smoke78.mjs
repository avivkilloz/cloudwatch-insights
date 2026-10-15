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
//   - a delete the server refuses puts the session back and says why;
//   - a browser's stale copy never wins on load: a change made elsewhere just
//     before a reload survives it, and a session deleted elsewhere while this
//     browser was away stays deleted -- the reloaded page used to push its
//     whole local copy over the server's (a pane writing the values it opened
//     with counted as a change), which is how the IoT session kept coming
//     back. One this browser never managed to save is still pushed.
import { BASE, check, clearWorkspace, launch, newPage, newSession, openApp, report, ROW, SHOWN, signIn } from "./harness.mjs";

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
  check((await page.locator(`${ROW_OF("Variables")} .session-variable`).innerText()).startsWith("Environment") &&
    (await page.locator(`${ROW_OF("Variables")} .session-variable select`).count()) === 1 &&
    (await page.locator(`${ROW_OF("Variables")}`).innerText()).indexOf("Set in the bar") < 0,
    "A defined variable is set right there in its row; the others are buttons, not a sentence");
  const heights = await page.locator(`${ROW_OF("Layout")} button, ${ROW_OF("Mode")} button, ${ROW_OF("Refresh")} select, ${ROW_OF("Variables")} .session-variable, ${ROW_OF("Variables")} > .session-card-values > button`)
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check(heights.length >= 8 && heights.every((h) => h === 28), "Every control in those rows is the same height", JSON.stringify(heights));

  // The variables belong to the card: folded, its header keeps their
  // controls; moved to the side panel, they go with it, and it folds there.
  await page.click(`${CARD} [aria-label="Collapse the session card"]`);
  const foldedEnv = `${CARD} .session-card-head select[aria-label="Session environment"]`;
  await page.waitForSelector(foldedEnv);
  await page.selectOption(foldedEnv, { index: 1 });
  const picked = await page.inputValue(foldedEnv);
  check(picked !== "" && (await page.locator(`${CARD} [aria-label="Collapse the session card"]`).count()) === 0,
    "Folded, the card's header still sets the variables, without unfolding it");
  await page.click(`${CARD} [aria-label="Expand the session card"]`);
  // The row's own control fetches the environments again before it can show one.
  await page.waitForFunction((sel) => document.querySelector(sel)?.options.length > 1, `${CARD} select[aria-label="Session environment"]`);
  check((await page.inputValue(`${ROW_OF("Variables")} select[aria-label="Session environment"]`)) === picked, "…the same value its row shows");
  check((await page.locator(`${SHOWN} .session-variables`).count()) === 0, "There is no separate variables bar under the card");
  await page.click(`${CARD} .session-card-move`);
  const RAIL_CARD = ".rail-session-slot .session-card";
  await page.waitForSelector(`${RAIL_CARD} select[aria-label="Session environment"]`);
  check((await page.locator(`${SHOWN} select[aria-label="Session environment"]`).count()) === 0,
    "Moved to the side panel, the variables go with the card");
  await page.click(`${RAIL_CARD} [aria-label="Collapse the session card"]`);
  check((await page.locator(`${RAIL_CARD} .session-card-row`).count()) === 0 &&
    (await page.locator(`${RAIL_CARD} .session-card-head select[aria-label="Session environment"]`).count()) === 1,
    "…and it folds there, keeping them in its header");
  const head = await page.locator(`${RAIL_CARD} .session-card-head`).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [...el.querySelectorAll("button, select")].every((c) => { const b = c.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right + 0.5; });
  });
  check(head, "…all of it inside the side panel");
  await page.click(`${RAIL_CARD} [aria-label="Expand the session card"]`);
  await page.click(`${RAIL_CARD} .session-card-move`);
  await page.waitForSelector(ROW_OF("Members"));
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

  // ---- 5. the server's copy wins on load
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "Base64");
  await page.waitForTimeout(1800);
  // Stored in this browser, not pushed yet (the push waits 1.2 s).
  await page.click(`${CARD} button:text-is("View")`);
  await page.waitForTimeout(700);
  let [live] = (await api(page, "GET", "/live-sessions")).body;
  const elsewhere = { id: "tquick", question: "q", answer: "from elsewhere", steps: [], status: "done" };
  const written = await api(page, "PUT", `/live-sessions/${live.client_id}`, {
    title: live.title, type: "aggregator", state: { ...live.state, agentChat: [elsewhere] }, base_version: live.version,
  });
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector(".rail");
  await page.waitForTimeout(3000);
  [live] = (await api(page, "GET", "/live-sessions")).body;
  check(written.status === 200 && live.state.agentChat?.[0]?.id === "tquick", "A change made elsewhere just before a reload survives it",
    JSON.stringify(live.state.agentChat ?? null).slice(0, 80));
  check(live.state.viewMode === true, "…and so does this browser's own change before it");

  await newSession(page, "Diff");
  await page.waitForTimeout(1800);
  const away = await page.locator(".rail-row.active .rail-row-label").innerText();
  const awayId = (await api(page, "GET", "/live-sessions")).body.find((s) => s.title === away).client_id;
  await page.goto("about:blank");
  const gone = await page.context().request.delete(`${BASE}/api/live-sessions/${awayId}`);
  await page.goto(BASE);
  await page.waitForSelector(".rail");
  await page.waitForTimeout(3000);
  check(gone.status() === 204 && (await page.locator(ROW(away)).count()) === 0, "A session deleted elsewhere while this browser was away isn't on its panel");
  check(!(await api(page, "GET", "/live-sessions")).body.some((s) => s.client_id === awayId), "…and isn't put back on the server");

  await page.route("**/api/live-sessions/*", (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue());
  await newSession(page, "JWT");
  const unsaved = await page.locator(".rail-row.active .rail-row-label").innerText();
  await page.waitForTimeout(2500);
  await page.unroute("**/api/live-sessions/*");
  await page.goto("about:blank");
  await page.goto(BASE);
  await page.waitForSelector(".rail");
  await page.waitForTimeout(3500);
  check((await page.locator(ROW(unsaved)).count()) === 1, "A session this browser never managed to save is kept");
  check((await api(page, "GET", "/live-sessions")).body.some((s) => s.title === unsaved), "…and saved once the server answers");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
