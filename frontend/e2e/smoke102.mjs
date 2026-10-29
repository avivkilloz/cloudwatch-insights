// The Builder as one place, its editors, a Clear the agent can add, and faces
// in a shared session (D126-D129), as a member of a builder group:
//   - the Builder's lists are Pane types | Workflows | Step types; the
//     Workflows page's New workflow opens the Builder's workflow editor, and
//     a workflow made there is run from the Workflows page (Runs ▸);
//   - every editor numbers its lines and marks the ones Check names;
//   - a pane type's editor is as tall as its preview beside it;
//   - asked for a Clear button, the agent's first try (an action with nothing
//     to run) is told it's a card's `clear`, fixes it -- a change by line
//     among them -- and the preview's Clear empties the table;
//   - the session card's members and the session chat show each person's
//     picture.
// Needs the agent + fake model running, and the backend as dev.fake_aws:app (see README).
import { check, clearWorkspace, launch, newPage, openApp, report, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const USER = `pictured${STAMP}`;
const DOCK = ".agent-dock";
const ACCOUNT = "000000000102";
const PANE = `ec2_clear_${STAMP}`;
const WF = `built_here_${STAMP}`;
const SESSION = `s-pic-${STAMP}`;
// Two 1x1 pictures, told apart by their bytes.
const RED = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const BLUE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";

const EC2 = `label: Instances ${STAMP}
description: EC2 instances.
inputs:
  - {key: connections, type: connections, connection_type: aws, label: Environments}
actions:
  - id: list
    main: true
    run_label: List instances
    request:
      connection: connections
      service: ec2
      operation: DescribeInstances
      rows:
        at: Reservations
        explode: Instances
        columns:
          Instance ID: InstanceId
          Name: Tags[Key=Name].Value
outputs:
  - key: rows
    render: table
    actions: [copy]
  - key: error
    render: error
layout:
  - title: Instances
    items:
      - input: connections
      - toolbar:
          - action: list
      - output: error
      - output: rows
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

async function toBuilderList(page, what) {
  await page.click('.rail-row-page:has-text("Builder")');
  await page.waitForSelector(".builder-list, .builder-view");
  if (await page.locator(".builder-view").count()) await page.click('.credential-view-head button:has-text("← Back")');
  await page.click(`.builder-list .segmented button:text-is("${what}")`);
}

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  await clearWorkspace(admin);
  await api(admin, "PUT", "/auth/profile", { avatar_url: BLUE });
  const env = (await api(admin, "POST", "/environments", { name: `Fleet ${STAMP}`, account_id: ACCOUNT, region: "eu-west-1" })).body;
  const g = (await api(admin, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", builder_enabled: true, agent_enabled: true, pane_types: ["api-table"], environment_ids: [env.id],
  })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  await api(admin, "PUT", `/dev/fake-aws?service=ec2&operation=DescribeInstances&account=${ACCOUNT}`, {
    Reservations: [{ Instances: [{ InstanceId: "i-1", Tags: [{ Key: "Name", Value: "web-1" }] }] }],
  });

  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const made = [];
  try {
    await signIn(page, { username: USER, password: "pw-123456" });
    await api(page, "PUT", "/auth/profile", { avatar_url: RED });
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);

    // ---- 1. one Builder: pane types, workflows, step types
    await page.click('.rail-row-page:has-text("Builder")');
    const tabs = await page.locator(".builder-list .segmented button").allInnerTexts();
    check(JSON.stringify(tabs.slice(0, 3)) === '["Panes","Workflows","Steps"]', "The Builder lists panes, workflows and steps", JSON.stringify(tabs));
    await page.click('.rail-row-page:has-text("Workflows")');
    await page.click('.workflows-list button:text-is("New workflow")');
    await page.waitForSelector(".builder-view #workflow-source");
    check(await page.locator('.rail-row-page.active:has-text("Builder")').count() === 1,
      "The Workflows page's New workflow opens the Builder's workflow editor");
    await page.fill("#workflow-id", WF);
    await page.fill("#workflow-source", `label: Built here ${STAMP}\nsteps:\n  - {id: hi, note: "hello"}\n  - {id: bad, pane: nope, action: x}\n`);
    await page.click('.workflow-view button:text-is("Check")');
    await page.waitForSelector(".workflow-problems li");
    const problem = await page.locator(".workflow-problems li").first().innerText();
    const marked = await page.locator(".builder-view .code-editor-gutter .bad").allInnerTexts();
    const numbers = await page.locator(".builder-view .code-editor-gutter > div:not(.code-editor-gutter-end)").count();
    // Four lines and the empty one after the last newline, as the text area has them.
    check(numbers === 5, "Its editor numbers each line", String(numbers));
    check(marked.length > 0 && problem.startsWith(`Line ${marked[0]}:`), "…and marks the line Check names", `${marked} / ${problem}`);
    await page.fill("#workflow-source", `label: Built here ${STAMP}\nsteps:\n  - {id: hi, note: "hello"}\n`);
    await page.click('.workflow-view button:text-is("Create")');
    await page.click('.workflow-view button:text-is("Runs ▸")', { timeout: 10000 });
    await page.waitForSelector('.workflow-view button:text-is("Run ▸")');
    check(true, "Created in the Builder, it's run from the Workflows page (Runs ▸)");
    await toBuilderList(page, "Workflows");
    await page.waitForSelector(`.builder-list tr[data-workflow$="${WF}"]`);
    check(true, "…and listed in the Builder's Workflows");

    // ---- 2. a pane type: as tall as its preview; the agent adds a Clear
    const pane = await api(page, "POST", "/builder/panes", { id: PANE, source: EC2 });
    made.push(pane.body.id);
    await page.reload();
    await toBuilderList(page, "Panes");
    await page.click(`.builder-list tr[data-built="${pane.body.id}"]`);
    await page.waitForFunction((s) => document.querySelector("#builder-source")?.value.includes(`label: Instances ${s}`), STAMP);
    await page.fill(`${DOCK} .agent-compose-input`, "add a clear button");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 60000 });
    const turn = await page.locator(`${DOCK} .agent-turn`).last().innerText();
    check(turn.includes("Tried a change: it needs fixing") && turn.includes("Put a draft in the editor") && !turn.includes("still has problems"),
      "Asked for a Clear, the agent's action-with-nothing-to-run is sent back, and its fix checks clean", turn.slice(0, 500));
    const source = await page.inputValue("#builder-source");
    check(/clear:\s*\n?\s*-?\s*\[?rows/.test(source) && !source.includes("id: clear"), "…a card's `clear: [rows]`, the action gone", source.slice(-300));
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")');

    await page.click('.builder-view button:text-is("Preview")');
    await page.waitForSelector(".builder-preview");
    await page.locator(`.builder-preview label:has-text("Fleet ${STAMP}") input`).first().check();
    await page.click('.builder-preview button:text-is("List instances")', { timeout: 8000 }).catch(async (e) => {
      await page.screenshot({ path: `${SHOT}/smoke102-dbg.png`, fullPage: true });
      console.log("DBG preview:", (await page.locator(".builder-preview").innerText()).slice(0, 600));
      throw e;
    });
    await page.waitForSelector(".builder-preview .manifest-table tbody tr", { timeout: 10000 });
    // Side by side, as on a wide screen (narrower, the two cards stack).
    await page.setViewportSize({ width: 2000, height: 950 });
    await page.click(".builder-preview .manifest-table tbody tr");
    await page.waitForTimeout(300);
    const sides = await page.evaluate(() => {
      const [def, prev] = [...document.querySelectorAll(".builder-columns > .session-card-section")].map((e) => e.getBoundingClientRect());
      const editor = document.querySelector(".builder-view .code-editor").getBoundingClientRect();
      return { def: def.height, prev: prev.height, editor: editor.height, defBottom: def.bottom, prevBottom: prev.bottom };
    });
    check(Math.abs(sides.defBottom - sides.prevBottom) < 2 && sides.def > 0, "The definition's card ends where the preview's does",
      JSON.stringify(sides));
    await page.screenshot({ path: `${SHOT}/smoke102-builder.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.click('.builder-preview button:text-is("Clear")');
    await page.waitForFunction(() => !document.querySelector(".builder-preview .manifest-table tbody tr"), null, { timeout: 5000 });
    check(true, "The preview's Clear empties the table");
    await page.click('.builder-view button:text-is("Discard")').catch(() => {});

    // ---- 3. faces in a shared session
    await api(page, "PUT", `/live-sessions/${SESSION}`, { type: "aggregator", title: `Faces ${STAMP}`, state: { services: [] }, truncated: false });
    await api(page, "POST", `/live-sessions/${SESSION}/members`, { username: "admin", permission: "editor" });
    // The admin says something in its chat.
    const row = (await api(admin, "GET", `/live-sessions/${SESSION}`)).body;
    const said = { id: `t${STAMP}`, question: "hello from admin", author: { id: row.state ? (await api(admin, "GET", "/auth/me")).body.id : 0, name: "admin" },
      answer: "", steps: [], status: "done", agentInvoked: false };
    const put = await api(admin, "PUT", `/live-sessions/${SESSION}`, {
      type: "aggregator", title: row.title, state: { ...row.state, agentChat: [said] }, base_version: row.version, truncated: false,
    });
    check(put.status === 200, "(the admin's message is written)", JSON.stringify(put.body).slice(0, 200));
    await page.reload();
    await page.click(`.rail-row:has-text("Faces ${STAMP}")`);
    await page.waitForSelector(`.session-member:has-text("admin") img.avatar`, { timeout: 10000 });
    check((await page.locator(`.session-member:has-text("admin") img.avatar`).getAttribute("src")) === BLUE,
      "The card's Members show each member's picture");
    await page.waitForSelector(`${DOCK} .agent-question-row.theirs img.avatar`, { timeout: 10000 });
    check((await page.locator(`${DOCK} .agent-question-row.theirs img.avatar`).getAttribute("src")) === BLUE,
      "Someone else's message in the session chat has their picture");
    await page.fill(`${DOCK} .agent-compose-input`, "hi admin");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} .agent-question-row:not(.theirs) img.avatar`, { timeout: 10000 });
    check((await page.locator(`${DOCK} .agent-question-row:not(.theirs) img.avatar`).last().getAttribute("src")) === RED,
      "…and mine has mine");
    await page.screenshot({ path: `${SHOT}/smoke102-faces.png`, fullPage: true });
  } finally {
    await api(page, "DELETE", `/live-sessions/${SESSION}`);
    for (const d of (await api(page, "GET", "/build-drafts")).body ?? []) await api(page, "DELETE", `/build-drafts/${d.id}`);
    const wf = ((await api(admin, "GET", "/workflows")).body ?? []).find((w) => w.id.endsWith(WF));
    if (wf) await api(admin, "DELETE", `/workflows/${encodeURIComponent(wf.id)}`);
    for (const id of made) await api(admin, "DELETE", `/builder/panes/${encodeURIComponent(id)}`);
    await api(admin, "PUT", "/auth/profile", { avatar_url: null });
    await clearWorkspace(page);
    await clearWorkspace(admin);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
