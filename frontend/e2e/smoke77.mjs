// 3c-2 (PLATFORM_PLAN.md §18.7): a session as a dashboard, driven the way a
// user would.
//   - Session variables (D60): an Environment and a Time range, added from the
//     session card and set in a bar under it. Every pane with such an input
//     follows: the input shows the value, read-only, and says where it comes
//     from; a pane with none (Base64) is untouched. Changing one re-runs the
//     panes that had run -- in the tab that changed it, not in a second tab
//     watching, which only follows. Unlinking keeps a pane's own value; ⚙ →
//     Follow takes the variable again; a pane added later follows from the
//     start.
//   - View mode (D61): a session's Mode → View hides every pane's inputs and
//     buttons and keeps its results, with "Updated … · Refresh"; a pane's ⚙
//     can show its own inputs anyway.
//   - A viewer (D61, D62) always sees view mode, can't switch it, and their
//     Refresh runs the pane as them when they can reach it -- and says so
//     when they can't.
//
// Needs the backend served as `uvicorn dev.fake_aws:app` (e2e/README.md): a
// viewer's refresh runs on the server, against a `.fake` HTTP API.
import { check, clearWorkspace, launch, mockPaneActions, newPage, newSession, openApp, openPaneMenu, report, ROW, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const PANE = (title) => `${SHOWN} .aggregator-pane:has(.aggregator-pane-header h3:text-is("${title}"))`;
const CARD = `${SHOWN} .session-card`;
const MEMBERS_ROW = `${CARD} .session-card-row:has(.session-card-label:text-is("Members"))`;
const ROWS = [{ id: 1, status: "open" }, { id: 2, status: "paid" }];

function groups(env) {
  return [{ environment_id: env, environment_name: "e", account_id: "1", region: "r", error: null,
    things: [{ thing_name: "robot-1", thing_type_name: "sensor", connected: true, attributes: {} }] }];
}

async function environment(page, name, body) {
  for (const e of (await api(page, "GET", "/environments")).body ?? []) if (e.name === name) await api(page, "DELETE", `/environments/${e.id}`);
  return (await api(page, "POST", "/environments", { name, ...body })).body;
}

async function user(page, name, envIds) {
  const g = (await api(page, "POST", "/user-groups", { name: `g-${name}`, role_name: "R", environment_ids: envIds, tools_enabled: true })).body;
  return (await api(page, "POST", "/users", { username: name, password: "pw-123456", group_id: g.id })).status;
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  const searched = [];
  const scanned = [];
  await mockPaneActions(page, "iot", { search: ({ inputs }) => (searched.push(inputs), { certResults: [], thingResults: groups(inputs.connections[0]) }) });
  await mockPaneActions(page, "tables", { scan: ({ inputs }) => (scanned.push(inputs), { items: [], scannedCount: 0, lastEvaluatedKey: null }) });
  await clearWorkspace(page);
  const a = await environment(page, "e2e-vars-a", { account_id: "333344445555", region: "us-east-1" });
  const b = await environment(page, "e2e-vars-b", { account_id: "444455556666", region: "us-east-1" });
  const labelOf = (e) => `${e.name} (${e.account_id} · us-east-1)`;

  // ---- 1. variables: added, set, followed
  await newSession(page, "IoT", "DynamoDB", "Base64");
  await page.click(`${CARD} button:has-text("Stacked")`);
  await page.click(`${CARD} button:text-is("+ Environment")`);
  await page.click(`${CARD} button:text-is("+ Time range")`);
  await page.waitForSelector(`${CARD} .session-variable`);
  check((await page.locator(`${CARD} .session-variable select`).count()) === 2 && (await page.locator(`${SHOWN} .session-variables`).count()) === 0,
    "Added from the card, the variables are set in its Variables row, not a bar of their own");
  await page.selectOption(`${SHOWN} select[aria-label="Session environment"]`, { label: labelOf(a) });
  await page.waitForTimeout(500);
  const dynamo = `${PANE("DynamoDB")} select[aria-label="Environment"]`;
  check((await page.inputValue(dynamo)) === String(a.id) && (await page.locator(dynamo).evaluate((el) => el.matches(":disabled"))),
    "A pane's environment takes the session's, and can't be changed there");
  check((await page.locator(`${PANE("DynamoDB")} .bound-note`).innerText()).startsWith("From the session's Environment"),
    "…saying where it comes from");
  const iotBox = `${PANE("IoT")} label:has-text("${labelOf(a)}") input[type="checkbox"]`;
  check(await page.locator(iotBox).isChecked(), "A pane that picks several environments takes just that one");
  check((await page.locator(`${PANE("Base64")} .bound-note`).count()) === 0, "A pane with no such input is left alone");

  // ---- 2. a change re-runs what had run, in this tab only
  await page.click(`${PANE("IoT")} button:text-is("Search")`);
  await page.waitForSelector(`${PANE("IoT")} >> text=robot-1`);
  check(searched.length === 1 && JSON.stringify(searched[0].connections) === JSON.stringify([a.id]), "Precondition: IoT searched",
    JSON.stringify(searched.map((s) => s.connections)));
  const title = await page.locator(".rail-row.active .rail-row-label").innerText();
  const other = await newPage(browser);
  await signIn(other);
  await other.click(ROW(title));
  await other.waitForSelector(`${SHOWN} .session-variable`);
  let otherRan = 0;
  other.on("request", (r) => { if (r.url().includes("/api/panes/iot/actions/search")) otherRan++; });

  await page.selectOption(`${SHOWN} select[aria-label="Session environment"]`, { label: labelOf(b) });
  await page.waitForTimeout(3000);
  check(searched.length === 2 && JSON.stringify(searched[1].connections) === JSON.stringify([b.id]),
    "Changing the variable re-runs a pane that had run, with the new value", JSON.stringify(searched.map((s) => s.connections)));
  check(scanned.length === 0, "…and not one that hadn't");
  const followed = await other.locator(`${PANE("IoT")} label:has-text("${labelOf(b)}") input[type="checkbox"]`).isChecked();
  check(followed && otherRan === 0, "A second tab follows the inputs without running anything itself", `followed ${followed}, ran ${otherRan}`);
  await other.close();

  // ---- 3. unlink, follow again, a new pane
  await page.click(`${PANE("DynamoDB")} .bound-note button:text-is("Unlink")`);
  await page.waitForTimeout(300);
  check(!(await page.locator(dynamo).evaluate((el) => el.matches(":disabled"))), "Unlinked, the pane's own input can be changed again");
  await page.selectOption(`${SHOWN} select[aria-label="Session environment"]`, { label: labelOf(a) });
  await page.waitForTimeout(800);
  check((await page.inputValue(dynamo)) === String(b.id), "…and keeps its value when the variable changes", await page.inputValue(dynamo));
  await openPaneMenu(page, "DynamoDB");
  await page.check('.pane-menu-list label:has-text("Follow the session\'s Environment") input');
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check((await page.inputValue(dynamo)) === String(a.id), "Following again from its ⚙, it takes the variable's value");
  await page.click(`${CARD} button:text-is("+ CloudWatch")`);
  await page.waitForSelector(`${PANE("CloudWatch")} select[aria-label="Time range"]`);
  await page.waitForTimeout(500);
  check((await page.inputValue(`${PANE("CloudWatch")} select[aria-label="Time range"]`)) === "3600",
    "A pane added later follows the session's time range from the start");

  // ---- 4. view mode
  await page.click(`${CARD} button:text-is("View")`);
  await page.waitForTimeout(400);
  check((await page.locator(`${SHOWN} .aggregator-pane select[aria-label="Environment"]`).count()) === 0 &&
    (await page.locator(`${PANE("IoT")} button:text-is("Search")`).count()) === 0,
    "View mode hides the panes' inputs and buttons");
  check((await page.locator(`${PANE("IoT")} >> text=robot-1`).count()) > 0 && (await page.locator(`${PANE("IoT")} .view-mode-line`).innerText()).includes("Updated"),
    "…keeping their results, with how old they are");
  check((await page.locator(`${CARD} .session-variable select`).count()) === 2, "…and the variables in the card, which drive the dashboard");
  await openPaneMenu(page, "IoT");
  await page.selectOption('.pane-menu-list select[aria-label="This pane\'s inputs"]', "shown");
  await page.keyboard.press("Escape");
  check((await page.locator(`${PANE("IoT")} button:text-is("Search")`).count()) === 1, "A pane's ⚙ shows its own inputs anyway");
  await page.click(`${CARD} button:text-is("Edit")`);

  // ---- 5. a viewer: always view mode; refreshes as themselves, if they can reach it
  await clearWorkspace(page);
  const apiEnv = await environment(page, "e2e-vars-api", {});
  const conn = (await api(page, "POST", `/environments/${apiEnv.id}/connections`, {
    type_id: "http_api", name: "api", config: { base_url: "https://e2e-vars.fake/v1" },
  })).body;
  check((await api(page, "PUT", `/dev/fake-http?path=${encodeURIComponent("/orders")}`, ROWS)).status === 200,
    "Precondition: the backend serves dev.fake_aws");
  const stamp = Date.now();
  const reaches = `smoke77-v-${stamp}`;
  const cannot = `smoke77-n-${stamp}`;
  check((await user(page, reaches, [apiEnv.id])) === 201 && (await user(page, cannot, [])) === 201, "Precondition: two viewers");
  await newSession(page, "API table");
  await page.waitForTimeout(800);
  await page.selectOption(`${SHOWN} select[aria-label="Connection"]`, String(conn.id));
  await page.fill(`${SHOWN} input[aria-label="Path"]`, "/orders");
  await page.click(`${SHOWN} button:text-is("Fetch")`);
  await page.waitForSelector(`${SHOWN} .manifest-table table`);
  const shared = await page.locator(".rail-row.active .rail-row-label").innerText();
  for (const name of [reaches, cannot]) {
    await page.fill(`${MEMBERS_ROW} [aria-label="Username to invite"]`, name);
    await page.selectOption(`${MEMBERS_ROW} [aria-label="Permission for the invited user"]`, "viewer");
    await page.click(`${MEMBERS_ROW} .session-member-invite button[type="submit"]`);
    await page.waitForTimeout(600);
  }
  const versionOf = async () => (await api(page, "GET", "/live-sessions")).body.find((s) => s.title === shared)?.outputs?.["api-table"]?.values?.resultsVersion;
  const before = await versionOf();
  await page.waitForTimeout(9000); // past the 10 s floor's "just refreshed"

  const viewer = await newPage(browser);
  await signIn(viewer, { username: reaches, password: "pw-123456" });
  await viewer.click(ROW(shared));
  await viewer.waitForSelector(`${SHOWN} .view-mode-line`);
  check((await viewer.locator(`${SHOWN} input[aria-label="Path"]`).count()) === 0 && (await viewer.locator(`${SHOWN} .manifest-table table`).count()) === 1,
    "A viewer sees view mode: the results, not the inputs");
  check(await viewer.locator(`${CARD} button:text-is("Edit")`).isDisabled(), "…and can't switch it");
  await viewer.click(`${SHOWN} .view-mode-line button:text-is("Refresh")`);
  await viewer.waitForTimeout(2500);
  const after = await versionOf();
  check(after === before + 1, "Their Refresh runs the pane, as them, since they can reach it", `${before} → ${after}`);

  const outsider = await newPage(browser);
  await signIn(outsider, { username: cannot, password: "pw-123456" });
  await outsider.click(ROW(shared));
  await outsider.waitForSelector(`${SHOWN} .view-mode-line`);
  await outsider.waitForTimeout(9000);
  await outsider.click(`${SHOWN} .view-mode-line button:text-is("Refresh")`);
  await outsider.waitForSelector(`${SHOWN} .view-mode-line >> text=can't reach`, { timeout: 8000 }).catch(() => {});
  const said = await outsider.locator(`${SHOWN} .view-mode-line`).innerText();
  check(said.includes("can't reach") && (await versionOf()) === after, "One who can't reach it is told so, and nothing runs", said);

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
