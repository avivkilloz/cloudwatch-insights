// 4a: the store repo (PLATFORM_PLAN.md §21, D70, D78, D80), driven as an admin:
//   - Settings → Store, not set up: a form; saved with a repo, its namespace and
//     what it keeps are shown;
//   - a new credential type's id sits under the namespace, and the type lands
//     in the repo as a commit by the admin, in a plugin's layout;
//   - with the repo gone, a change saves anyway: "Not pushed" beside it, the
//     reason in the Store tab; back, Sync now pushes it;
//   - edited in the repo and here: a conflict, compared side by side, resolved
//     by taking the repo's.
// The repo is a bare one on disk (file://, allowed by the dev stack's
// STORE_GIT_ALLOW_FILE_URLS), inspected with git itself.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, clearWorkspace, launch, openApp, report } from "./harness.mjs";

const STAMP = String(Date.now()).slice(-6);
const NS = `smoke${STAMP}`;
const DIR = mkdtempSync(join(tmpdir(), "store-smoke-"));
const REMOTE = join(DIR, "remote.git");
const AWAY = join(DIR, "away.git");
const TYPE = `${NS}:deploy_token`;
const FILE = "credential-types/deploy_token.yaml";

const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_NAME: "someone", GIT_AUTHOR_EMAIL: "s@example.com", GIT_COMMITTER_NAME: "someone", GIT_COMMITTER_EMAIL: "s@example.com" },
  });
const log = () => git("--git-dir", REMOTE, "log", "--format=%an|%s", "main").trim().split("\n");
const show = (path) => {
  try {
    return git("--git-dir", REMOTE, "show", `main:${path}`);
  } catch {
    return null;
  }
};

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function openSettings(page, tab) {
  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.click(`.content .settings-tabs button:text-is("${tab}")`);
}

async function openTypes(page) {
  await openSettings(page, "Credentials");
  await page.click('.segmented button:text-is("Types")');
  await page.waitForSelector(".credential-types-table");
}

async function waitFor(fn, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${label}`);
}

const run = async () => {
  git("init", "--quiet", "--bare", "--initial-branch=main", REMOTE);
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await api(page, "DELETE", "/store");

  try {
    // ---- 1. setting it up
    await openSettings(page, "Store");
    await page.waitForSelector("#store-url");
    check(true, "Not set up, the Store tab is a form");
    await page.fill("#store-url", `file://${REMOTE}`);
    await page.fill("#store-namespace", NS);
    await page.click('.store-settings button:text-is("Save")');
    await page.waitForSelector("[data-store-url]");
    const repoText = await page.locator(".store-settings").innerText();
    check(repoText.includes(REMOTE) && repoText.includes(NS), "Saved, it shows the repo and its namespace", repoText.slice(0, 200));

    // ---- 2. a type made here lands in the repo
    await openTypes(page);
    await page.click('.credential-list button:text-is("New type")');
    const prefix = await page.locator(".store-id-prefix").innerText();
    check(prefix === `${NS}:`, "A new type's id sits under the store's namespace", prefix);
    await page.fill("#type-id", "deploy_token");
    await page.fill("#type-label", "Deploy token");
    const KEY = '.credential-type-fields input[aria-label="Key"]';
    if ((await page.locator(KEY).count()) === 0) await page.click('.credential-view button:text-is("Add field")');
    await page.locator(KEY).first().fill("token");
    await page.click('.credential-view button:text-is("Save type")');
    await page.waitForSelector(`[data-credential-type="${TYPE}"]`);
    check(true, "Created, it's named in the namespace", TYPE);
    await waitFor(() => show(FILE) !== null, "the type's file in the repo");
    const [author, subject] = log()[0].split("|");
    check(author === "admin" && subject === `Add credential type ${TYPE}`, "…committed to the repo as the admin", log()[0]);
    check(show("plugin.yaml").includes(`id: ${NS}`) && show("plugin.yaml").includes("deploy_token"), "…in a plugin's layout", show("plugin.yaml"));

    // ---- 3. the repo away: saved anyway, said so, pushed when it's back
    renameSync(REMOTE, AWAY);
    const patched = await api(page, "PATCH", `/credential-types/${encodeURIComponent(TYPE)}`, { label: "Deploy token (renamed)" });
    check(patched.status === 200, "With the repo gone, a change still saves");
    await api(page, "POST", "/store/sync");
    await page.reload();
    await openTypes(page);
    const badge = page.locator(`[data-credential-type="${TYPE}"] .store-badge`);
    check((await badge.innerText()) === "Not pushed", "…shows Not pushed beside it", await badge.innerText());
    await openSettings(page, "Store");
    await page.waitForSelector("[data-store-error]");
    check((await page.locator(`[data-store-item="${TYPE}"]`).getAttribute("data-store-state")) === "pending", "…and the Store tab says what's waiting and why");
    renameSync(AWAY, REMOTE);
    await page.click('.store-settings button:text-is("Sync now")');
    await page.waitForSelector(`[data-store-item="${TYPE}"][data-store-state="synced"]`);
    check(show(FILE).includes("Deploy token (renamed)") && (await page.locator("[data-store-pending]").innerText()) === "Nothing",
      "Back, Sync now pushes it");

    // ---- 4. edited in both places: a conflict, compared, the repo's taken
    const other = join(DIR, "other");
    git("clone", "--quiet", `file://${REMOTE}`, other);
    writeFileSync(join(other, FILE), readFileSync(join(other, FILE), "utf8").replace("Deploy token (renamed)", "Edited in git"));
    git("-C", other, "commit", "--quiet", "-am", "Edited by hand");
    git("-C", other, "push", "--quiet");
    await api(page, "PATCH", `/credential-types/${encodeURIComponent(TYPE)}`, { label: "Edited here" });
    await page.click('.store-settings button:text-is("Sync now")');
    await page.waitForSelector(`[data-store-item="${TYPE}"][data-store-state="conflict"]`);
    check(show(FILE).includes("Edited in git"), "Edited in the repo too, it isn't overwritten");
    await page.click(`[data-store-item="${TYPE}"] button:has-text("Conflict")`);
    await page.waitForSelector("[data-store-theirs]");
    check((await page.locator("[data-store-mine]").innerText()).includes("Edited here") &&
      (await page.locator("[data-store-theirs]").innerText()).includes("Edited in git"), "…both sides are shown");
    await page.click('.store-settings button:text-is("Take the repo\'s")');
    await page.waitForSelector(`[data-store-item="${TYPE}"][data-store-state="synced"]`);
    const types = (await api(page, "GET", "/credential-types")).body;
    check(types.find((t) => t.id === TYPE)?.label === "Edited in git", "Taking the repo's brings it in here");
  } finally {
    // Later suites name types without a namespace: the store goes, and its type.
    await api(page, "DELETE", `/credential-types/${encodeURIComponent(TYPE)}`);
    await api(page, "DELETE", "/store");
    rmSync(DIR, { recursive: true, force: true });
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
