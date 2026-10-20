// Drafts of what's built, and a table whose rows open (D124, D125), as a member
// of a builder group -- not an admin:
//   - a new pane type is kept as it's typed: left for another page, and after
//     a full reload, it's in the Builder's list as a Draft and opens as it was
//     left -- its Id, its text, and the Building chat with the agent;
//   - Create makes it, and the chat stays with it; an existing one's unsaved
//     change is a Draft beside it, comes back when opened, and Discard puts
//     back what's saved;
//   - a new workflow is kept the same way;
//   - an EC2-style pane: a column from a tag (Tags[Key=Name].Value), and a
//     table row that opens to its own request's detail.
// Needs the agent + fake model running, and the backend as dev.fake_aws:app (see README).
import { check, clearWorkspace, launch, newPage, openApp, report, SHOT, signIn, SHOWN } from "./harness.mjs";

const STAMP = Date.now();
const USER = `drafter${STAMP}`;
const DOCK = ".agent-dock";
const PANE = `kept_${STAMP}`;
const LABEL = `Kept pane ${STAMP}`;
const WF = `kept_flow_${STAMP}`;
const ACCOUNT = "000000000101";

const EC2 = `label: Instances ${STAMP}
description: EC2 instances; open one for its detail.
inputs:
  - {key: connections, type: connections, connection_type: aws, label: Environments}
actions:
  - id: list
    main: true
    run_label: List instances
    resets: [view.expanded]
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
          State: State.Name
  - id: instance
    args: {connections: row.Environment, instance_id: row.Instance ID}
    request:
      connection: connections
      service: ec2
      operation: DescribeInstances
      params: {InstanceIds: {input: instance_id}}
      rows: {at: Reservations, explode: Instances}
outputs:
  - key: rows
    render: table
    actions: [select, copy]
    config:
      expand: expanded
      detail:
        action: instance
        sections:
          - fields:
              - {label: Type, value: "{{ d.InstanceType }}"}
          - {title: Tags, table: Tags, columns: [{label: Key, value: "{{ row.Key }}"}, {label: Value, value: "{{ row.Value }}"}]}
  - key: error
    render: error
views:
  - {key: expanded, default: []}
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

const saved = (page) => page.waitForSelector('.builder-draft-status:has-text("Draft saved")', { timeout: 10000 });

async function toBuilder(page) {
  await page.click('.rail-row-page:has-text("Builder")');
  await page.waitForSelector(".builder-list, .builder-view");
}

/** From an editor back to its list. */
async function back(page, list = ".builder-list") {
  await page.click('.credential-view-head button:has-text("← Back")');
  await page.waitForSelector(list);
}

const tagged = async (row) => (await row.locator(".builder-draft-tag").count()) > 0;

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  await clearWorkspace(admin);
  const env = (await api(admin, "POST", "/environments", { name: `Fleet ${STAMP}`, account_id: ACCOUNT, region: "eu-west-1" })).body;
  const g = (await api(admin, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", builder_enabled: true, agent_enabled: true, pane_types: ["api-table"], environment_ids: [env.id],
  })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  await api(admin, "PUT", `/dev/fake-aws?service=ec2&operation=DescribeInstances&account=${ACCOUNT}`, {
    Reservations: [{ Instances: [{ InstanceId: "i-1", InstanceType: "t3.micro", State: { Name: "running" },
      Tags: [{ Key: "team", Value: "edge" }, { Key: "Name", Value: "web-1" }] }] }],
  });

  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const made = [];
  try {
    await signIn(page, { username: USER, password: "pw-123456" });
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);

    // ---- 1. a new pane type, kept as it's typed, chat and all
    await toBuilder(page);
    await page.click('.builder-list button:text-is("New pane type")');
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("label:"));
    check((await page.locator(".builder-draft-status").count()) === 0, "Opening the starter keeps nothing yet");
    await page.fill("#builder-id", PANE);
    await saved(page);
    check(true, "The first change makes a draft");
    await page.fill(`${DOCK} .agent-compose-input`, `build ${LABEL}`);
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 60000 });
    await page.waitForFunction((l) => document.querySelector("#builder-source")?.value.includes(`label: ${l}`), LABEL);
    await page.waitForTimeout(1500);

    await page.click('.rail-row-page:has-text("Workflows")');
    await page.waitForSelector(".workflows-list");
    await page.reload();
    await toBuilder(page);
    const row = page.locator(`.builder-list tr[data-draft]:has-text("${LABEL}")`);
    await row.waitFor({ timeout: 10000 });
    check((await tagged(row)) && (await row.innerText()).includes(PANE),
      "Left and reloaded, it's in the list as a Draft, with its Id", await row.innerText());
    await page.screenshot({ path: `${SHOT}/smoke101-list.png`, fullPage: true });
    await row.click();
    await page.waitForFunction((l) => document.querySelector("#builder-source")?.value.includes(`label: ${l}`), LABEL);
    check((await page.inputValue("#builder-id")) === PANE, "…and opens as it was left: the Id and the text");
    await page.waitForSelector(`${DOCK} .agent-turn`, { timeout: 10000 });
    const chat = await page.locator(`${DOCK} .agent-turn`).first().innerText();
    check(chat.includes(`build ${LABEL}`), "…with the Building chat about it", chat.slice(0, 200));
    await page.screenshot({ path: `${SHOT}/smoke101-restored.png`, fullPage: true });

    // ---- 2. created: the chat stays with it; a later change is a Draft beside it
    await page.click('.builder-view button:text-is("Create")');
    await page.waitForSelector('.builder-notice:has-text("your group can use it now")', { timeout: 10000 });
    const paneId = (await api(page, "GET", "/builder/panes")).body.find((t) => t.id.endsWith(PANE)).id;
    made.push(["pane", paneId]);
    // The created one's editor reads its chat back from the draft it became.
    await page.waitForSelector(`${DOCK} .agent-turn`, { timeout: 10000 });
    check((await page.locator(`${DOCK} .agent-turn`).first().innerText()).includes(`build ${LABEL}`), "Created, the chat is still beside it");
    await back(page);
    const built = page.locator(`.builder-list tr[data-built="${paneId}"]`);
    await built.waitFor();
    check((await page.locator(`.builder-list tr[data-draft]:has-text("${LABEL}")`).count()) === 0 && !(await tagged(built)),
      "…and it's listed as made, not a draft", await built.innerText());
    await built.click();
    await page.waitForSelector(`${DOCK} .agent-turn`, { timeout: 10000 });
    check((await page.locator(`${DOCK} .agent-turn`).first().innerText()).includes(`build ${LABEL}`), "Opened again, its chat is there");
    const savedText = await page.inputValue("#builder-source");
    await page.fill("#builder-source", `${savedText}# a change\n`);
    await saved(page);
    await back(page);
    await page.waitForFunction((id) => document.querySelector(`.builder-list tr[data-built="${id}"] .builder-draft-tag`), paneId,
      { timeout: 10000 });
    check(true, "An unsaved change to it is a Draft beside it in the list");
    await built.click();
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("# a change"));
    check((await page.locator(".builder-draft-status").innerText()).includes("are back"), "…opened, the change is back, and says so");
    await page.click('.builder-view button:text-is("Discard")');
    await page.waitForFunction((t) => document.querySelector("#builder-source")?.value === t, savedText);
    await page.waitForTimeout(500);
    await back(page);
    await built.waitFor();
    check(!(await tagged(built)), "Discard goes back to what's saved", await built.innerText());

    // ---- 3. a new workflow, kept the same way
    await page.click('.rail-row-page:has-text("Workflows")');
    await page.click('.workflows-list button:text-is("New workflow")');
    await page.fill("#workflow-id", WF);
    await page.fill("#workflow-source", `label: Kept ${STAMP}\nsteps:\n  - {id: hi, note: "hello"}\n`);
    await saved(page);
    await page.reload();
    await page.click('.rail-row-page:has-text("Workflows")');
    const wfRow = page.locator(`.workflows-list tr[data-draft]:has-text("Kept ${STAMP}")`);
    await wfRow.waitFor({ timeout: 10000 });
    check(await tagged(wfRow), "A new workflow left unsaved is a Draft in the Workflows list");
    await wfRow.click();
    await page.waitForFunction((s) => document.querySelector("#workflow-source")?.value.includes(`label: Kept ${s}`), STAMP);
    check((await page.inputValue("#workflow-id")) === WF, "…and opens as it was left");
    await page.click('.workflow-view button:text-is("Discard")');
    await page.waitForSelector(".workflows-list");

    // ---- 4. rows that open: a tag as a column, a row's own request as its detail
    const ec2 = await api(page, "POST", "/builder/panes", { id: `ec2_${STAMP}`, source: EC2 });
    check(ec2.status === 201, "An EC2 pane with a tag column and rows that open checks clean", JSON.stringify(ec2.body).slice(0, 300));
    made.push(["pane", ec2.body.id]);
    await page.reload();
    await toBuilder(page);
    if (await page.locator(".builder-view").count()) await back(page);
    await page.click(`.builder-list tr[data-built="${ec2.body.id}"]`);
    await page.click('.builder-view button:text-is("Open in a session")');
    await page.waitForSelector(`${SHOWN} .manifest-pane, ${SHOWN} .aggregator-pane`, { timeout: 10000 });
    await page.locator(`${SHOWN} label:has-text("Fleet ${STAMP}") input, ${SHOWN} .checkbox-item:has-text("Fleet ${STAMP}") input`).first().check();
    await page.click(`${SHOWN} button:text-is("List instances")`);
    const tableRow = page.locator(`${SHOWN} .manifest-table tbody tr`).first();
    await tableRow.waitFor({ timeout: 10000 });
    const cells = await tableRow.innerText();
    check(cells.includes("web-1") && cells.includes("running"), "The Name column is the Name tag's value", cells);
    await tableRow.click();
    const detail = page.locator(`${SHOWN} .manifest-table-detail`);
    await detail.waitFor({ timeout: 10000 });
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("t3.micro"), `${SHOWN} .manifest-table-detail`,
      { timeout: 10000 });
    const shown = await detail.innerText();
    check(shown.includes("t3.micro") && shown.includes("team") && shown.includes("edge"),
      "Clicking a row opens its detail, fetched by its own request", shown.slice(0, 200));
    await page.screenshot({ path: `${SHOT}/smoke101-ec2.png`, fullPage: true });
    await tableRow.click();
    await page.waitForFunction((sel) => !document.querySelector(sel), `${SHOWN} .manifest-table-detail`);
    check(true, "…and closes again");
  } finally {
    for (const d of (await api(page, "GET", "/build-drafts")).body ?? []) await api(page, "DELETE", `/build-drafts/${d.id}`);
    for (const [, id] of made) await api(admin, "DELETE", `/builder/panes/${encodeURIComponent(id)}`);
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
