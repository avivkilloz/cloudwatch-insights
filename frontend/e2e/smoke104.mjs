// A pane's files (6-1b, D136-D140), as a member of a builder group:
//   - started from code, the editor is a workspace: pane.yaml and devices.py,
//     a tab each; "+ File" adds helpers.py, which devices.py imports, and the
//     preview runs both in the runner;
//   - a file that doesn't parse: Check lists the problem by file and line,
//     its tab is marked, and clicking the problem opens it with the line marked;
//   - left and reloaded, the draft is back with its files;
//   - the Building tab's agent writes code as a file of its own (shaped.py),
//     never Python inside the YAML, and fixes it by that file's line.
// Needs the runner, the agent and the fake model, and the backend as
// dev.fake_aws:app with RUNNER_URL (see README).
import { check, clearWorkspace, launch, newPage, openApp, report, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const USER = `files${STAMP}`;
const ENV = `Fleet ${STAMP}`;
const PANE = `fleet_${STAMP}`;
const DOCK = ".agent-dock";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function pickConnection(page) {
  await page.waitForFunction((env) => [...document.querySelectorAll(".builder-preview select option")].some((o) => o.textContent.includes(env)), ENV);
  const select = page.locator(`.builder-preview select:has(option:has-text("${ENV}"))`).first();
  const label = (await select.locator("option").allInnerTexts()).find((o) => o.includes(ENV));
  await select.selectOption({ label });
}

async function openTab(page, name) {
  await page.click(`.workspace-tab[data-file="${name}"] .workspace-tab-name`);
}

const HELPERS = 'def online_first(items):\n    return sorted(items, key=lambda d: not d.get("online"))\n';

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  await clearWorkspace(admin);
  const env = (await api(admin, "POST", "/environments", { name: ENV })).body;
  await api(admin, "POST", `/environments/${env.id}/connections`, { type_id: "http_api", name: "fleet", config: { base_url: "https://fleet.fake/v1" } });
  await api(admin, "PUT", "/dev/fake-http?path=/v1/devices", {
    items: [{ id: "d1", online: false }, { id: "d2", online: true }, { id: "d3", online: true }],
  });
  const g = (await api(admin, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", builder_enabled: true, agent_enabled: true, pane_types: ["api-table"], environment_ids: [env.id],
  })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });

  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  try {
    await signIn(page, { username: USER, password: "pw-123456" });
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);

    // ---- 1. files that import each other, previewed
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForFunction(() => document.querySelectorAll("#builder-start option").length > 3);
    await page.selectOption("#builder-start", "__code");
    await page.waitForSelector('.workspace-tab[data-file="devices.py"]');
    const tabs = await page.locator(".workspace-tab").evaluateAll((els) => els.map((e) => e.getAttribute("data-file")));
    check(JSON.stringify(tabs) === '["pane.yaml","devices.py"]', "Started from code: the YAML and its Python, a tab each", JSON.stringify(tabs));
    check((await page.inputValue("#builder-source")).includes("file: devices.py") &&
      !(await page.inputValue("#builder-source")).includes("def run"), "…the YAML names the file; the code isn't in it");
    await page.fill("#builder-id", PANE);
    await page.click('.workspace-add');
    await page.fill("#builder-source-new-file", "helpers");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.workspace-tab.active[data-file="helpers.py"]');
    await page.fill("#builder-source-file", HELPERS);
    await openTab(page, "devices.py");
    const devices = await page.inputValue("#builder-source-file");
    await page.fill("#builder-source-file", "from helpers import online_first\n\n\n" +
      devices.replace('    items.sort(key=lambda d: not d.get("online"))\n', "").replace('{"rows": items}', '{"rows": online_first(items)}'));
    await page.click('.builder-view button:text-is("Preview")');
    await pickConnection(page);
    await page.click('.builder-preview button:text-is("List")');
    await page.waitForSelector(".builder-preview .manifest-table tbody tr", { timeout: 20000 });
    const ids = await page.locator(".builder-preview .manifest-table tbody tr td:first-child").allInnerTexts();
    check(JSON.stringify(ids) === '["d2","d3","d1"]', "+ File: helpers.py, imported by devices.py, both run in the runner", JSON.stringify(ids));
    await page.screenshot({ path: `${SHOT}/smoke104-files.png`, fullPage: true });

    // ---- 2. a file that doesn't parse: by file and line
    await openTab(page, "helpers.py");
    await page.fill("#builder-source-file", HELPERS.replace('not d.get("online"))', 'not d.get("online")'));
    await openTab(page, "pane.yaml");
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector(".builder-problems .workspace-problem-file");
    const problem = await page.locator(".builder-problems li").first().innerText();
    check(problem.startsWith("helpers.py, line 2:") && problem.includes("isn't valid Python"), "Check names the file and its line", problem);
    check((await page.locator('.workspace-tab[data-file="helpers.py"] .workspace-tab-bad').count()) === 1 &&
      (await page.locator('.workspace-tab[data-file="pane.yaml"] .workspace-tab-bad').count()) === 0, "…and marks its tab");
    await page.click(".builder-problems .workspace-problem-file");
    await page.waitForSelector('.workspace-tab.active[data-file="helpers.py"]');
    check((await page.locator(".code-editor-gutter .bad").allInnerTexts()).join() === "2", "Clicked, the file opens with the line marked");
    await page.fill("#builder-source-file", HELPERS);
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")');
    await page.waitForSelector('.builder-draft-status:has-text("Draft saved")', { timeout: 10000 });
    await page.waitForTimeout(1200);

    // ---- 3. left and reloaded: the draft with its files
    await page.reload();
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click(`.builder-list tr[data-draft]:has-text("${PANE}")`);
    await page.waitForSelector('.workspace-tab[data-file="helpers.py"]');
    await openTab(page, "helpers.py");
    check((await page.inputValue("#builder-source-file")) === HELPERS, "Left and reloaded, the draft is back with its files");
    await openTab(page, "devices.py");
    check((await page.inputValue("#builder-source-file")).startsWith("from helpers import online_first"), "…every one of them");

    // ---- 4. the agent writes code as a file, and fixes it by its line
    await page.fill(`${DOCK} .agent-compose-input`, "use code sorted by id");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 60000 });
    await page.waitForSelector('.workspace-tab[data-file="shaped.py"]', { timeout: 10000 });
    await openTab(page, "pane.yaml");
    const yaml = await page.inputValue("#builder-source");
    check(yaml.includes("file: shaped.py") && !yaml.includes("def run"), "The agent's code is a file of its own, which the YAML names");
    await openTab(page, "shaped.py");
    const shaped = await page.inputValue("#builder-source-file");
    check(shaped.split("\n")[2] === "    rows = sorted(items, key=lambda d: d['id'])", "…its broken line fixed by that file's line", shaped);
    check((await page.locator(`${DOCK} .agent-turn`).last().innerText()).includes("shaped.py"), "…as the chat says");
    await page.screenshot({ path: `${SHOT}/smoke104-agent.png`, fullPage: true });
  } finally {
    for (const d of (await api(page, "GET", "/build-drafts")).body ?? []) await api(page, "DELETE", `/build-drafts/${d.id}`);
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
