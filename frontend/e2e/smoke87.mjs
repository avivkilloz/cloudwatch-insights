// Workflow parameters whose choices load (PLATFORM_PLAN.md §22.9, D94), with
// the form fixes reported beside them, as a member running the CloudWatch
// example (examples/workflows/02-cloudwatch-errors.yaml) against the faked
// backend's log groups (an account starting "0000"):
//   - Build with parameters: each row clear of the next (a help line ran into
//     the next row's field), its control on the label's 28px line;
//   - Log groups says to choose the environment first, then lists that
//     environment's groups as the member (the pane's own loader);
//   - picking two makes two chips, and the run queries both;
//   - a stage's "Inputs" is the detail's size, not a browser summary's 16px.
import { readFileSync } from "node:fs";
import { check, clearWorkspace, launch, newPage, openApp, report, signIn } from "./harness.mjs";

const STAMP = Date.now();
const WF = `params_${STAMP}`;
const USER = `par${STAMP}`;
const RUN_STATUS = ".workflow-run .credential-view-actions .run-status";
const SOURCE = readFileSync(new URL("../../examples/workflows/02-cloudwatch-errors.yaml", import.meta.url), "utf8").replace(
  "label: Errors in a log group",
  `label: Errors ${STAMP}`,
);

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
  await clearWorkspace(page);

  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const g = (await api(page, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", environment_ids: [env.id], pane_types: ["logs-cloudwatch"],
  })).body;
  await api(page, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  const wf = (await api(page, "POST", "/workflows", { id: WF, source: SOURCE })).body;
  await api(page, "PUT", `/workflows/${encodeURIComponent(wf.id)}/grants`, { group_ids: [g.id] });

  const member = await newPage(browser);
  try {
    await signIn(member, { username: USER, password: "pw-123456" });
    await member.click('.rail-row-page:has-text("Workflows")');
    await member.click(`[data-workflow="${wf.id}"]`);
    await member.click('.workflow-view button:text-is("Run ▸")');
    await member.waitForSelector(".workflow-params #param-groups");

    // ---- 1. the form's rows
    const rows = await member.locator(".workflow-params .session-card-row").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const label = el.querySelector(".session-card-label").getBoundingClientRect();
        const control = el.querySelector("input, select");
        const c = control.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, label: label.top + label.height / 2, control: c.top + c.height / 2, height: c.height, kind: control.type };
      }),
    );
    const apart = rows.every((r, i) => i === 0 || rows[i - 1].bottom < r.top);
    check(apart, "Each parameter's row is clear of the next", JSON.stringify(rows.map((r) => [Math.round(r.top), Math.round(r.bottom)])));
    check(rows.every((r) => Math.round(r.height) === 28 && Math.abs(r.label - r.control) <= 1),
      "Every control is on its label's 28px line", JSON.stringify(rows.map((r) => [r.kind, Math.round(r.height), Math.round(r.label - r.control)])));

    // ---- 2. its choices load from the environment chosen above
    await member.waitForSelector('.workflow-param-status:has-text("Choose Environment first.")');
    check(true, "Log groups waits for the environment");
    const label = (await member.locator("#param-env option").allInnerTexts()).find((o) => o.includes("e2e-fake-aws"));
    await member.selectOption("#param-env", { label });
    await member.waitForSelector('.workflow-param-status:has-text("2 to choose from")', { timeout: 15000 });
    const listed = await member.locator("#param-groups-options option").evaluateAll((os) => os.map((o) => o.value));
    check(JSON.stringify(listed.sort()) === JSON.stringify(["/fake/api", "/fake/worker"]),
      "…then lists that environment's log groups, as the member", JSON.stringify(listed));

    // ---- 3. two picked, and the run queries both
    await member.fill("#param-groups", "/fake/api");
    await member.fill("#param-groups", "/fake/worker");
    const chips = await member.locator("[data-chosen]").evaluateAll((els) => els.map((e) => e.dataset.chosen));
    check(JSON.stringify(chips) === JSON.stringify(["/fake/api", "/fake/worker"]) &&
      (await member.locator(".workflow-param-status:has-text('0 to choose from')").count()) === 1,
      "Picking from the list makes a chip each, and takes them off the list", JSON.stringify(chips));
    await member.click('.workflow-params button:text-is("Run")');
    await member.waitForSelector(`${RUN_STATUS}[data-status="succeeded"]`, { timeout: 30000 });
    await member.click('[data-stage="lines"]');
    await member.click('[data-stage-detail="lines"] .workflow-stage-inputs summary');
    const inputs = await member.locator('[data-stage-detail="lines"] .workflow-stage-inputs pre').innerText();
    check(inputs.includes('"/fake/api"') && inputs.includes('"/fake/worker"'), "The run queried both log groups", inputs.slice(0, 200));
    await member.click('[data-stage="summary"]');
    const note = await member.locator('[data-stage-detail="summary"] .workflow-note').innerText();
    check(note.includes("in /fake/api, /fake/worker over the last 1 h"), "…and says so", note);
    await member.click('[data-stage="lines"]');
    const summarySize = await member.locator(".workflow-stage-inputs summary").evaluate((el) => getComputedStyle(el).fontSize);
    check(summarySize === "13px", "A stage's Inputs is the detail's size", summarySize);
  } finally {
    await member.close();
    await api(page, "DELETE", `/workflows/${encodeURIComponent(wf.id)}`);
    for (const u of (await api(page, "GET", "/users")).body.filter((u) => u.username === USER)) await api(page, "DELETE", `/users/${u.id}`);
    await api(page, "DELETE", `/user-groups/${g.id}`);
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
