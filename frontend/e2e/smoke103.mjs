// Code in the runner (6-1, D131-D135), as a member of a builder group -- not
// an admin:
//   - a new pane started from "An action that's code" checks clean, and its
//     Preview runs the code in the runner, as the builder: it reaches the API
//     through ctx.http (the platform makes the call), reshapes the reply, and
//     its log shows under the preview;
//   - code that fails says so with its line, and its log;
//   - created and opened in a session, its button runs the same code;
//   - a step that's code is tried from its editor, its outputs and log shown.
// Needs the runner, and the backend as dev.fake_aws:app with RUNNER_URL (see README).
import { check, clearWorkspace, launch, newPage, openApp, report, SHOT, signIn, SHOWN } from "./harness.mjs";

const STAMP = Date.now();
const USER = `coder${STAMP}`;
const ENV = `Devices ${STAMP}`;
const PANE = `online_first_${STAMP}`;
const STEP = `online_${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function pickConnection(page, scope) {
  await page.waitForFunction((s) => [...document.querySelectorAll(`${s} select option`)].some((o) => o.textContent.includes("Devices")), scope);
  // The one listing the environment: a session's card has selects of its own.
  const select = page.locator(`${scope} select:has(option:has-text("${ENV}"))`).first();
  const label = (await select.locator("option").allInnerTexts()).find((o) => o.includes(ENV));
  await select.selectOption({ label });
}

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  await clearWorkspace(admin);
  const env = (await api(admin, "POST", "/environments", { name: ENV })).body;
  await api(admin, "POST", `/environments/${env.id}/connections`, { type_id: "http_api", name: "devices", config: { base_url: "https://devices.fake/v1" } });
  await api(admin, "PUT", "/dev/fake-http?path=/v1/devices", {
    items: [{ id: "d1", online: false }, { id: "d2", online: true }, { id: "d3", online: true }],
  });
  const g = (await api(admin, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", builder_enabled: true, pane_types: ["api-table"], environment_ids: [env.id],
  })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });

  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const made = [];
  try {
    await signIn(page, { username: USER, password: "pw-123456" });

    // ---- 1. a pane whose action is code, previewed
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    // The examples are listed once the editor has the schema (and the code example with it).
    await page.waitForFunction(() => document.querySelectorAll("#builder-start option").length > 3);
    await page.selectOption("#builder-start", "__code");
    // The code is a file beside the YAML (D136): its tab, devices.py.
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("file: devices.py"));
    await page.waitForSelector('.workspace-tab[data-file="devices.py"]');
    await page.fill("#builder-id", PANE);
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")');
    check(true, "Started from an action that's code, it checks clean");
    await page.click('.builder-view button:text-is("Preview")');
    await pickConnection(page, ".builder-preview");
    await page.click('.builder-preview button:text-is("List")');
    await page.waitForSelector(".builder-preview .manifest-table tbody tr", { timeout: 20000 });
    const ids = await page.locator(".builder-preview .manifest-table tbody tr td:first-child").allInnerTexts();
    check(JSON.stringify(ids) === '["d2","d3","d1"]', "Previewed, the code reached the API through the platform and reshaped its reply", JSON.stringify(ids));
    check((await page.locator(".builder-code-log").innerText()).includes("3 devices"), "…and its log shows under the preview");
    await page.screenshot({ path: `${SHOT}/smoke103-preview.png`, fullPage: true });

    // ---- 2. code that fails says where
    await page.click('.workspace-tab[data-file="devices.py"] .workspace-tab-name');
    const source = await page.inputValue("#builder-source-file");
    await page.fill("#builder-source-file", source.replace('ctx.log(len(items), "devices")', 'ctx.log("about to fail")\n    raise ValueError("no devices today")'));
    await page.waitForSelector(".builder-preview-stale");
    await page.click(".builder-preview-redraw");
    // Drawn again from the new text: "changed since this was drawn" goes.
    await page.waitForFunction(() => !document.querySelector(".builder-preview-stale"));
    await pickConnection(page, ".builder-preview");
    await page.click('.builder-preview button:text-is("List")');
    await page.waitForSelector('.builder-preview .error-text:has-text("no devices today")', { timeout: 20000 });
    const failed = await page.locator(".builder-preview .error-text").first().innerText();
    check(failed.includes("ValueError: no devices today (line 6 of devices.py)") && failed.includes("about to fail"),
      "Code that fails says what, in which file and on which line, with its log", failed.slice(0, 200));
    await page.fill("#builder-source-file", source);

    // ---- 3. created, it runs in a session
    await page.click('.builder-view button:text-is("Create")');
    await page.waitForSelector('.builder-notice:has-text("everyone can use it now")', { timeout: 10000 });
    const pane = (await api(page, "GET", "/builder/panes")).body.find((t) => t.id.endsWith(PANE));
    made.push(["pane", pane.id]);
    await page.click('.builder-view button:text-is("Open in a session")');
    await page.waitForSelector(`${SHOWN} .aggregator-pane`, { timeout: 10000 });
    await pickConnection(page, SHOWN);
    await page.click(`${SHOWN} button:text-is("List")`);
    await page.waitForSelector(`${SHOWN} .manifest-table tbody tr`, { timeout: 20000 });
    check((await page.locator(`${SHOWN} .manifest-table tbody tr`).count()) === 3, "Created and opened in a session, its button runs the code");

    // ---- 4. a step that's code, tried
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.credential-view-head button:has-text("← Back")').catch(() => {});
    await page.click('.builder-list .segmented button:text-is("Steps")');
    await page.click('.builder-list button:text-is("New step")');
    await page.waitForSelector("#step-start");
    await page.selectOption("#step-start", "code");
    await page.waitForFunction(() => document.querySelector("#step-source")?.value.includes("file: online.py"));
    await page.waitForSelector('.step-view .workspace-tab[data-file="online.py"]');
    await page.fill("#step-id", STEP);
    await page.click('.step-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")');
    await pickConnection(page, ".step-view");
    await page.click('.step-view button:text-is("Try it")');
    await page.waitForSelector(".step-tried", { timeout: 20000 });
    const tried = await page.locator(".step-tried").innerText();
    check(tried.includes('"count": 2') && tried.includes("2 online"), "A step that's code is tried: its outputs and its log", tried.slice(0, 300));
    await page.screenshot({ path: `${SHOT}/smoke103-step.png`, fullPage: true });
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
