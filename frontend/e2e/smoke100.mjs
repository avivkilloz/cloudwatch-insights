// Step types and workflows for builders (5-3, D121-D122), as a member of a
// builder group -- not an admin:
//   - the Builder's Step types: a new one, a POST to an HTTP connection with
//     its path and body from its inputs, checked, tried for real (it asks
//     first), and created;
//   - Workflows: the builder makes a workflow of their own that uses it, has
//     no Access section (granting other groups is an admin's), and runs it --
//     the step changes something, so it waits for a person; approved, it
//     sends the POST as the builder.
// Needs the backend as dev.fake_aws:app (a `.fake` host answers) -- see README.
import { BASE, check, clearWorkspace, launch, newPage, openApp, report, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const USER = `stepper${STAMP}`;
const ENV = `Devices ${STAMP}`;
const STEP = `restart_${STAMP}`;
const WF = `restart_flow_${STAMP}`;
const RUN_STATUS = ".workflow-run .credential-view-actions .run-status";

const RESTART = `label: Restart a device ${STAMP}
description: Asks the devices API to restart one.
inputs:
  - {key: connection, type: connection, connection_type: http_api, label: API}
  - {key: device, required: true}
  - {key: reason, default: maintenance}
request:
  connection: connection
  method: POST
  path: "/devices/{{ inputs.device }}/restart"
  body: {reason: "{{ inputs.reason }}"}
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
  const admin = await openApp(browser);
  await clearWorkspace(admin);
  const env = (await api(admin, "POST", "/environments", { name: ENV })).body;
  await api(admin, "POST", `/environments/${env.id}/connections`, { type_id: "http_api", name: "devices", config: { base_url: "https://devices.fake/v1" } });
  await api(admin, "PUT", "/dev/fake-http?path=/v1/devices/d7/restart", { ok: true });
  const g = (await api(admin, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", builder_enabled: true, pane_types: ["api-table"], environment_ids: [env.id],
  })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  let stepId = null;
  try {
    await signIn(page, { username: USER, password: "pw-123456" });

    // ---- 1. a step type, checked, tried and created
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list .segmented button:text-is("Step types")');
    await page.click('.builder-list button:text-is("New step type")');
    await page.waitForFunction(() => document.querySelector("#step-source")?.value.includes("label: Post a message"));
    check(true, "A new step type starts from a working request");
    await page.fill("#step-id", STEP);
    await page.fill("#step-source", RESTART.replace("{{ inputs.device }}", "{{ inputs.devise }}"));
    await page.click('.step-view button:text-is("Check")');
    const problem = await page.locator(".builder-problems li").first().innerText({ timeout: 5000 });
    check(problem.startsWith("Line 10:") && problem.includes("inputs.devise isn't one of its inputs"), "Check names the mistake and its line", problem);
    await page.fill("#step-source", RESTART);
    await page.click('.step-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")');
    check(true, "…and passes it once fixed");

    await page.waitForSelector(`#step-try-connection option:has-text("${ENV}")`, { state: "attached" });
    const label = (await page.locator("#step-try-connection option").allInnerTexts()).find((o) => o.includes(ENV));
    await page.selectOption("#step-try-connection", { label });
    await page.fill("#step-try-device", "d7");
    await page.click('.step-view button:text-is("Send POST")');
    await page.waitForSelector(".step-tried", { timeout: 10000 });
    check((await page.locator(".step-tried").innerText()).includes("HTTP 200"), "Try sends it, as the builder, and shows the reply");
    const sent = (await api(admin, "GET", "/dev/fake-http/last?path=/v1/devices/d7/restart")).body;
    check(sent.method === "POST" && JSON.parse(sent.body).reason === "maintenance", "…a POST, its body from the inputs and their defaults", JSON.stringify(sent));
    await page.screenshot({ path: `${SHOT}/smoke100-step.png`, fullPage: true });

    await page.click('.step-view button:text-is("Create")');
    await page.waitForSelector('.builder-notice:has-text("Created")', { timeout: 10000 });
    stepId = (await api(page, "GET", "/builder/steps")).body.find((s) => s.id.endsWith(STEP)).id;
    check(true, `Created, as ${stepId}`);

    // ---- 2. a workflow of the builder's own that uses it
    await page.click('.rail-row-page:has-text("Workflows")');
    await page.click('.workflows-list button:text-is("New workflow")');
    check(true, "A builder may make workflows");
    await page.fill("#workflow-id", WF);
    await page.fill("#workflow-source", `label: Restart ${STAMP}
parameters:
  - {key: api, type: connection, connection_type: http_api, required: true}
steps:
  - id: restart
    step: ${stepId}
    with: {connection: "{{ params.api }}", device: d7, reason: "a test"}
`);
    await page.click('.workflow-view button:text-is("Create")');
    // Made in the Builder's Workflows (D128); its runs are the Workflows page's.
    await page.click('.workflow-view button:text-is("Runs ▸")', { timeout: 10000 });
    await page.waitForSelector('.workflow-view button:text-is("Run ▸")', { timeout: 10000 });
    const sections = await page.locator(".workflow-view .settings-section h3, .workflow-view h3").allInnerTexts();
    check(!sections.some((t) => t.trim() === "Access"), "It's the builder's group's: no Access section (granting is an admin's)", JSON.stringify(sections));

    await page.click('.workflow-view button:text-is("Run ▸")');
    await page.waitForSelector(`#param-api option:has-text("${ENV}")`, { state: "attached" });
    const envLabel = (await page.locator("#param-api option").allInnerTexts()).find((o) => o.includes(ENV));
    await page.selectOption("#param-api", { label: envLabel });
    await page.click('.workflow-params button:text-is("Run")');
    await page.waitForSelector(`${RUN_STATUS}[data-status="waiting"]`, { timeout: 20000 });
    const approval = await page.locator(".workflow-approval").innerText();
    check(approval.includes("changes something outside the platform"), "The step changes something, so it waits for a person", approval.slice(0, 160));
    await page.click('.workflow-approval button:text-is("Approve")');
    await page.waitForSelector(`${RUN_STATUS}[data-status="succeeded"]`, { timeout: 20000 });
    const again = (await api(admin, "GET", "/dev/fake-http/last?path=/v1/devices/d7/restart")).body;
    check(JSON.parse(again.body).reason === "a test", "Approved, it sends the POST with the workflow's inputs", JSON.stringify(again));
    await page.screenshot({ path: `${SHOT}/smoke100-run.png`, fullPage: true });
  } finally {
    const wf = (await api(admin, "GET", "/workflows")).body.find((w) => w.id.endsWith(WF));
    if (wf) await api(admin, "DELETE", `/workflows/${encodeURIComponent(wf.id)}`);
    if (stepId) await api(admin, "DELETE", `/builder/steps/${encodeURIComponent(stepId)}`);
    await clearWorkspace(admin);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
void BASE;
