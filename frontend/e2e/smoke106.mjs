// A pane's requirements (6-2, D141-D144), as a member of a builder group:
//   - "+ File" takes requirements.txt (typed "requirements"), after the Python;
//   - Check locks it: a requirements.lock tab appears, read-only, every package
//     pinned with its hashes; the Python imports the package and the preview
//     runs it in the runner, installed through the platform's own index;
//   - a line that isn't a package's name is refused by its line, and nothing
//     is locked;
//   - removing requirements.txt takes its lock with it.
// Needs the runner, and the backend as dev.fake_aws:app with RUNNER_URL; the
// backend reaches the package index (PyPI, or DEPS_INDEX_URL) -- see README.
import { check, clearWorkspace, launch, newPage, openApp, report, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const USER = `deps${STAMP}`;
const ENV = `Deps ${STAMP}`;
const PANE = `deps_${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function openTab(page, name) {
  await page.click(`.workspace-tab[data-file="${name}"] .workspace-tab-name`);
}

const CODE =
  "import six\n\n\ndef run(inputs, ctx):\n" +
  '    items = ctx.http(inputs["connection"], "/devices").json()["items"]\n' +
  '    return {"rows": [{"id": d["id"], "six": six.__version__} for d in items]}\n';

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  await clearWorkspace(admin);
  const env = (await api(admin, "POST", "/environments", { name: ENV })).body;
  await api(admin, "POST", `/environments/${env.id}/connections`, { type_id: "http_api", name: "fleet", config: { base_url: "https://deps.fake/v1" } });
  await api(admin, "PUT", "/dev/fake-http?path=/v1/devices", { items: [{ id: "d1" }, { id: "d2" }] });
  const g = (await api(admin, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", builder_enabled: true, pane_types: ["api-table"], environment_ids: [env.id],
  })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });

  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  try {
    await signIn(page, { username: USER, password: "pw-123456" });
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForFunction(() => document.querySelectorAll("#builder-start option").length > 3);
    await page.selectOption("#builder-start", "__code");
    await page.waitForSelector('.workspace-tab[data-file="devices.py"]');
    await page.fill("#builder-id", PANE);

    // ---- 1. + File takes requirements.txt, after the Python
    await page.click(".workspace-add");
    await page.fill("#builder-source-new-file", "requirements");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.workspace-tab.active[data-file="requirements.txt"]');
    check((await page.inputValue("#builder-source-file")).startsWith("# A package a line"), "+ File: \"requirements\" is requirements.txt, with a line saying what goes in it");
    await page.fill("#builder-source-file", "six==1.16.0\n");
    await openTab(page, "devices.py");
    await page.fill("#builder-source-file", CODE);

    // ---- 2. Check locks it
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")', { timeout: 60000 });
    const tabs = await page.locator(".workspace-tab[data-file]").evaluateAll((els) => els.map((e) => e.getAttribute("data-file")));
    check(JSON.stringify(tabs) === '["pane.yaml","devices.py","requirements.txt","requirements.lock"]',
      "Check locked it: a requirements.lock tab, after requirements.txt", JSON.stringify(tabs));
    await openTab(page, "requirements.lock");
    const lock = await page.inputValue("#builder-source-file");
    check(lock.startsWith("# Locked by the platform from requirements.txt") && lock.includes("six==1.16.0") && /--hash=sha256:[0-9a-f]{64}/.test(lock),
      "…every package pinned with its hashes", lock.slice(0, 200));
    check((await page.locator("#builder-source-file").getAttribute("readonly")) !== null &&
      (await page.locator('.workspace-tab[data-file="requirements.lock"] .workspace-tab-close').count()) === 0 &&
      (await page.locator(".workspace-lock-note").count()) === 1, "…read-only, not removable, saying whose it is");
    await page.screenshot({ path: `${SHOT}/smoke106-lock.png`, fullPage: true });

    // ---- 3. the preview runs with the package installed
    await page.click('.builder-view button:text-is("Preview")');
    await page.waitForFunction((env) => [...document.querySelectorAll(".builder-preview select option")].some((o) => o.textContent.includes(env)), ENV);
    const select = page.locator(`.builder-preview select:has(option:has-text("${ENV}"))`).first();
    await select.selectOption({ label: (await select.locator("option").allInnerTexts()).find((o) => o.includes(ENV)) });
    await page.click('.builder-preview button:text-is("List")');
    await page.waitForSelector(".builder-preview .manifest-table tbody tr", { timeout: 120000 });
    const versions = await page.locator(".builder-preview .manifest-table tbody tr td:nth-child(2)").allInnerTexts();
    check(JSON.stringify(versions) === '["1.16.0","1.16.0"]', "The preview's code imports it, installed in the runner", JSON.stringify(versions));

    // ---- 4. a line that isn't a package: refused by its line
    await openTab(page, "requirements.txt");
    await page.fill("#builder-source-file", "six==1.16.0\n-r /etc/passwd\n");
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector(".builder-problems .workspace-problem-file");
    const problem = await page.locator(".builder-problems li").first().innerText();
    check(problem.startsWith("requirements.txt, line 2:") && problem.includes("-r isn't taken here"), "An option in requirements.txt is refused by its line", problem);
    check((await page.locator(".builder-problems li").count()) === 1, "…said once (not also as a stale lock)");

    // ---- 5. removed, it takes its lock with it
    await page.click('.workspace-tab[data-file="requirements.txt"] .workspace-tab-close');
    await page.waitForFunction(() => !document.querySelector('.workspace-tab[data-file="requirements.lock"]'));
    check((await page.locator('.workspace-tab[data-file="requirements.txt"]').count()) === 0, "Removing requirements.txt takes its lock with it");
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
