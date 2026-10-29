// 4b-2 (PLATFORM_PLAN.md §22.8): approvals, artifacts, rerun from a stage,
// and the UI fixes that came with it -- driven as a member and an admin:
//   - the rail's platform pages sit above Sessions (D93); the run header's
//     status is a pill, centred; every workflow is everyone's to run (D160);
//   - a member runs a release: a sign-off only someone else may give
//     (`by: others`) -- they see it wait; the admin's rail counts it, live,
//     and the admin approves it from "Waiting for your approval";
//   - the next step sends HTTP (`effects: external`), so it waits again, and
//     this time the member decides, from the run page they had open;
//   - the artifact downloads; Rerun from here copies the stages before.
// The send goes to a `.fake` host of the dev backend.
import { BASE, check, clearWorkspace, launch, newPage, openApp, report, signIn } from "./harness.mjs";

const STAMP = Date.now();
const WF = `rel_${STAMP}`;
const USER = `rel${STAMP}`;
const RUN_STATUS = ".workflow-run .credential-view-actions .run-status";

const SOURCE = `label: Release ${STAMP}
parameters:
  - { key: version, type: text, default: "1.0" }
steps:
  - id: ok
    label: Sign-off
    approval: { message: "Release {{ params.version }}?", by: others }
  - id: send
    pane: tool-http
    action: send
    with: { method: POST, url: "http://deploy${STAMP}.fake/release", body: "{{ params.version }}" }
  - id: notes
    artifact: { name: "release-{{ params.version }}.txt", value: "Released {{ params.version }}, signed off by {{ steps.ok.outputs.approved_by }}", format: text }
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

async function status(page) {
  return page.locator(RUN_STATUS).getAttribute("data-status");
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  const g = (await api(page, "POST", "/user-groups", { name: `g-${USER}`, pane_types: ["tool-http"], environment_ids: [] })).body;
  await api(page, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  const wf = (await api(page, "POST", "/workflows", { id: WF, source: SOURCE })).body;

  try {
    // ---- 0. the UI fixes
    const order = await page.evaluate(() => {
      const pages = document.querySelector(".rail .rail-pages");
      const sessions = [...document.querySelectorAll(".rail .rail-heading")].find((h) => h.textContent.trim() === "Sessions");
      return !!pages && !!sessions && !!(pages.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    check(order, "The platform's pages are at the top of the rail, above Sessions");
    await page.click('.rail-row-page:has-text("Workflows")');
    await page.click(`[data-workflow="${wf.id}"]`);
    await page.waitForSelector(".workflow-view");
    check((await page.locator('.workflow-view .session-card-label:text-is("Who may run it")').count()) === 0,
      "No group picker: every workflow is everyone's to run (D160)");

    // ---- 1. the member starts it; the sign-off is someone else's
    const member = await newPage(browser);
    await signIn(member, { username: USER, password: "pw-123456" });
    await member.click('.rail-row-page:has-text("Workflows")');
    await member.click(`[data-workflow="${wf.id}"]`);
    await member.click('.workflow-view button:text-is("Run ▸")');
    await member.click('.workflow-params button:text-is("Run")');
    await member.waitForSelector(`${RUN_STATUS}[data-status="waiting"]`, { timeout: 20000 });
    const card = member.locator(".workflow-approval");
    check((await card.innerText()).includes("Release 1.0?") && (await card.locator('button:text-is("Approve")').count()) === 0,
      "The member sees it wait, and that it's someone else's to approve", await card.innerText());
    check((await member.locator(".rail-count").count()) === 0, "…and nothing waits for them in the rail");

    // ---- 2. the admin's rail counts it, live; they approve it from the list
    await page.waitForSelector('.rail-row-page .rail-count[data-approvals="1"]', { timeout: 10000 });
    check(true, "The admin's Workflows row counts what waits for them, without a reload");
    await page.click('.workflow-view button:text-is("← Back")');
    await page.waitForSelector(".workflow-waiting li");
    check((await page.locator(".workflow-waiting li").innerText()).includes("Release 1.0?"), "Waiting for your approval heads the list");
    await page.click(".workflow-waiting li");
    await page.waitForSelector(".workflow-approval");
    const pill = await page.locator(RUN_STATUS).boundingBox();
    const cancel = await page.locator('.workflow-run .credential-view-actions button:text-is("Cancel")').boundingBox();
    check(pill.height < cancel.height && Math.abs(pill.y + pill.height / 2 - (cancel.y + cancel.height / 2)) <= 1,
      "The run's status is a pill, centred beside the buttons", JSON.stringify({ pill, cancel }));
    await page.fill(".workflow-approval-comment", "ship it");
    await page.click('.workflow-approval button:text-is("Approve")');

    // ---- 3. the send waits too -- and this one the member may decide, on the page they have open
    await member.waitForSelector('.workflow-approval button:text-is("Approve")', { timeout: 20000 });
    const inputs = await member.locator(".workflow-approval-inputs").innerText();
    check(inputs.includes(`http://deploy${STAMP}.fake/release`) && (await member.locator(".workflow-approval").innerText()).includes("acts outside the platform"),
      "An action that reaches outside waits for approval, showing what it will send", inputs);
    const hits = async () => (await api(page, "GET", `/dev/fake-http/hits?path=/release`)).body.hits;
    const before = await hits();
    await member.click('.workflow-approval button:text-is("Approve")');
    await member.waitForSelector(`${RUN_STATUS}[data-status="succeeded"]`, { timeout: 20000 });
    check((await hits()) === before + 1, "Approved, it sent -- once");
    await member.click('[data-stage="ok"]');
    check((await member.locator(".workflow-approval-said").innerText()).includes("Approved by admin") &&
      (await member.locator(".workflow-approval-said").innerText()).includes("ship it"), "The sign-off says who gave it, and their comment");

    // ---- 4. the artifact; rerun from a stage
    await member.click('[data-stage="notes"]');
    const href = await member.locator('[data-artifact="release-1.0.txt"]').getAttribute("href");
    const text = await member.evaluate(async (h) => (await fetch(h)).text(), href);
    check(text === "Released 1.0, signed off by admin", "The artifact downloads", text);
    await page.waitForSelector(".rail-row-page .rail-count", { state: "detached", timeout: 10000 });
    check(true, "Nothing waits for the admin any more");
    await member.click('.workflow-stage-detail button:text-is("Rerun from here")');
    await member.waitForFunction(() => document.querySelector(".workflow-run .credential-view-head h2")?.textContent?.endsWith("#2"));
    await member.waitForSelector(`${RUN_STATUS}[data-status="succeeded"]`, { timeout: 20000 });
    const reused = await member.locator(".workflow-stage .workflow-stage-mark").count();
    check(reused === 2 && (await hits()) === before + 1, "Rerun from here: the stages before are copied, nothing sent again",
      `${reused} reused, ${await hits()} sends`);
    await member.close();
  } finally {
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
