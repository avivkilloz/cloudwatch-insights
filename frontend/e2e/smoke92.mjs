// The Builder, first part (PLATFORM_PLAN.md §24, D103-D106), as a member of a
// group with the Builder turned on:
//   - the rail's Builder row, a new pane type from the starter, Check finding
//     a mistake with its line, then none;
//   - Create: their group may use it at once -- "Open in a session" opens it,
//     and it works (a Base64 live function, worked out as you type);
//   - a member of another group isn't offered it; an admin's Users → Groups
//     has the Builder switch.
import { check, clearWorkspace, launch, newPage, openApp, report, SHOWN, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const ID = `shouty_${STAMP}`;
const BUILDER = `bld${STAMP}`;
const OTHER = `oth${STAMP}`;
const SOURCE = `label: Shouty ${STAMP}
description: Base64, for a team that shouts.
category: Tools
inputs:
  - key: input
    type: text
    label: Text
    default: ""
actions:
  - id: convert
    live: base64.convert
outputs:
  - key: output
    render: code
layout:
  - title: Input
    items:
      - input: input
  - title: Base64
    items:
      - output: output
`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  const groups = [];
  for (const [user, flags] of [[BUILDER, { builder_enabled: true }], [OTHER, {}]]) {
    const g = (await api(page, "POST", "/user-groups", { name: `g-${user}`, role_name: "R", pane_types: ["tool-base64"], ...flags })).body;
    groups.push(g);
    await api(page, "POST", "/users", { username: user, password: "pw-123456", group_id: g.id });
  }
  const builder = await newPage(browser);
  const other = await newPage(browser);
  try {
    // ---- 1. a new pane type, checked
    await signIn(builder, { username: BUILDER, password: "pw-123456" });
    await builder.click('.rail-row-page:has-text("Builder")');
    await builder.click('.builder-list button:text-is("New pane")');
    await builder.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("label: Service status"));
    check(true, "A new pane type starts from a working starter");
    await builder.fill("#builder-id", ID);
    await builder.fill("#builder-source", SOURCE.replace("live: base64.convert", "handler: no.such"));
    await builder.click('.builder-view button:text-is("Check")');
    const problem = await builder.locator(".builder-problems li").first().innerText({ timeout: 5000 });
    check(problem.startsWith("Line 11:") && problem.includes("There is no handler no.such"), "Check names the mistake and its line", problem);
    await builder.fill("#builder-source", SOURCE);
    await builder.click('.builder-view button:text-is("Check")');
    await builder.waitForSelector('.builder-notice:text-is("No problems found.")');
    check(true, "…and none once it's right");

    // ---- 2. created: theirs at once
    await builder.click('.builder-view button:text-is("Create")');
    await builder.waitForSelector(`.builder-notice:has-text("your group can use it now")`, { timeout: 10000 });
    await builder.screenshot({ path: `${SHOT}/smoke92-builder.png` });
    await builder.click('.builder-view button:text-is("Open in a session")');
    await builder.waitForSelector(`${SHOWN} .aggregator-tab-label:text-is("Shouty ${STAMP}")`, { timeout: 10000 });
    await builder.fill(`${SHOWN} textarea, ${SHOWN} input[type="text"]`, "hi");
    await builder.waitForFunction(
      (sel) => [...document.querySelectorAll(sel)].some((e) => (e.value ?? e.textContent ?? "").includes("aGk=")),
      `${SHOWN} pre, ${SHOWN} textarea`,
      { timeout: 10000 },
    );
    check(true, "Open in a session: the pane it made works, for their group, at once");
    await builder.screenshot({ path: `${SHOT}/smoke92-pane.png` });
    const stored = (await api(builder, "GET", "/builder/panes")).body.find((t) => t.id === ID);
    check(stored && stored.source.startsWith(`id: ${ID}\n`), "…kept as written, its id line added", stored?.source.slice(0, 60));

    // ---- 3. nobody else's until granted
    await signIn(other, { username: OTHER, password: "pw-123456" });
    const theirs = (await api(other, "GET", "/pane-types")).body.map((m) => m.id);
    check(!theirs.includes(ID), "Another group isn't offered it until an admin grants it", JSON.stringify(theirs));
    check((await other.locator('.rail-row-page:has-text("Builder")').count()) === 0, "…and without the Builder, no Builder row");
    await page.click('[aria-label="Account menu"]');
    await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
    await page.click('.content .settings-tabs button:text-is("Users")');
    await page.click('.content button:text-is("Groups")').catch(() => undefined);
    await page.click(`tr:has-text("g-${BUILDER}")`);
    const switchOn = await page.locator('.session-card-row:has(.session-card-label:text-is("Builder")) input[type="checkbox"]').isChecked();
    check(switchOn, "Users → Groups has the Builder switch, on for that group");
  } finally {
    await clearWorkspace(builder).catch(() => undefined);
    await api(page, "DELETE", `/builder/panes/${ID}`);
    await builder.close();
    await other.close();
    for (const u of (await api(page, "GET", "/users")).body.filter((u) => [BUILDER, OTHER].includes(u.username))) await api(page, "DELETE", `/users/${u.id}`);
    for (const g of groups) await api(page, "DELETE", `/user-groups/${g.id}`);
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
