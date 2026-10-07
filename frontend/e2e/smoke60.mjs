// Settings → Environments (PLATFORM_PLAN.md §14.8, D32), driven the way an
// admin would: open an environment made the old way (one AWS account), add
// a second AWS connection to it, see both reach the panes as "Prod · aws"
// and "Prod · eks", test a connection as a group (one that can't see the
// environment is told so), give another group access, rename a connection,
// and remove one -- after which the environment is called just its name again.
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

const ENV = "e2e-Prod";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function cleanUp(page) {
  for (const e of (await api(page, "GET", "/environments")).body ?? [])
    if (e.name.startsWith("e2e-")) await api(page, "DELETE", `/environments/${e.id}`);
  for (const g of (await api(page, "GET", "/user-groups")).body ?? [])
    if (g.name.startsWith("e2e-")) await api(page, "DELETE", `/user-groups/${g.id}`);
}

const labels = async (page) =>
  ((await api(page, "GET", "/targets?type=aws")).body ?? []).filter((t) => t.environment === ENV).map((t) => t.label);

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await cleanUp(page);
  // The old shape: an environment that is one AWS account and region.
  const env = (await api(page, "POST", "/environments", { name: ENV, account_id: "111122223333", region: "eu-west-1" })).body;
  check(env?.connections?.length === 1 && env.connections[0].id === env.id, "An environment made the old way holds one AWS connection with its id", JSON.stringify(env));
  await api(page, "POST", "/user-groups", { name: "e2e-backend", role_name: "e2e-BackendRole", environment_ids: [env.id] });
  await api(page, "POST", "/user-groups", { name: "e2e-outsider", role_name: "e2e-OutsiderRole" });

  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  await page.click('.content .settings-tabs button:text-is("Environments")');
  await page.waitForSelector(`[data-environment="${ENV}"]`);
  const row = await page.locator(`[data-environment="${ENV}"]`).innerText();
  check(row.includes("111122223333") && row.includes("e2e-backend"), "The list shows its connection and the groups that see it", row);

  // ---- 1. a second AWS account in the same environment
  await page.click(`[data-environment="${ENV}"]`);
  await page.waitForSelector('.environment-editor [data-connection="aws"]');
  await page.click('.environment-editor button:text-is("Add connection")');
  await page.selectOption("#conn-type", "aws");
  await page.fill("#conn-name", "eks");
  await page.fill("#conn-field-account_id", "444455556666");
  await page.fill("#conn-field-region", "us-east-1");
  await page.click('.connection-editor button:text-is("Add connection")');
  await page.waitForSelector('.environment-editor [data-connection="eks"]');
  check(JSON.stringify(await labels(page)) === JSON.stringify([`${ENV} · aws`, `${ENV} · eks`]),
    "Two connections in one environment are each named", JSON.stringify(await labels(page)));

  // ---- 2. test as a group
  const eksRow = page.locator('.environment-editor [data-connection="eks"]');
  await eksRow.locator('select[aria-label="Test as group"]').selectOption({ label: "e2e-outsider" });
  await eksRow.locator('button:text-is("Test")').click();
  await eksRow.locator(".connection-test-result").waitFor();
  const outsider = await eksRow.locator(".connection-test-result").innerText();
  check(outsider.includes(`e2e-outsider can't see ${ENV}`), "Testing as a group that can't see it says so", outsider);
  await eksRow.locator('select[aria-label="Test as group"]').selectOption({ label: "e2e-backend" });
  await eksRow.locator('button:text-is("Test")').click();
  await page.waitForFunction(
    () => document.querySelector('.environment-editor [data-connection="eks"] .connection-test-result')?.textContent?.includes("e2e-backend"),
    null,
    { timeout: 40000 },
  );
  check(true, "Testing as a group that sees it answers for that group (this sandbox has no AWS to reach)");

  // ---- 3. access, saved by Save
  await page.selectOption('.environment-editor select[aria-label="Give a group access"]', { label: "e2e-outsider" });
  await page.click('.environment-editor .credential-view-foot button:text-is("Save")');
  await page.waitForSelector('.credentials-notice:has-text("Saved")');
  const saved = (await api(page, "GET", "/environments")).body.find((e) => e.name === ENV);
  const groups = (await api(page, "GET", "/user-groups")).body;
  const names = saved.group_ids.map((id) => groups.find((g) => g.id === id)?.name).sort();
  check(JSON.stringify(names) === JSON.stringify(["e2e-backend", "e2e-outsider"]), "Access is edited from the environment's side too", JSON.stringify(names));

  // ---- 4. the panes pick connections, by those names
  await newSession(page, "DynamoDB");
  await page.waitForSelector(`${SHOWN} option:has-text("${ENV} · eks")`, { state: "attached" });
  const options = await page.locator(`${SHOWN} select:has(option:has-text("${ENV} · eks"))`).first().locator("option").allInnerTexts();
  check(options.some((o) => o.startsWith(`${ENV} · aws (111122223333`)) && options.some((o) => o.startsWith(`${ENV} · eks (444455556666`)),
    "A pane's environment picker offers each connection by name", JSON.stringify(options.filter((o) => o.includes(ENV))));

  // ---- 5. rename one, remove the other
  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.click('.content .settings-tabs button:text-is("Environments")');
  await page.click(`[data-environment="${ENV}"]`);
  await page.locator('.environment-editor [data-connection="aws"] button:text-is("Edit")').click();
  await page.fill("#conn-name", "iot");
  await page.click('.connection-editor button:text-is("Save connection")');
  await page.waitForSelector('.environment-editor [data-connection="iot"]');
  check((await labels(page)).includes(`${ENV} · iot`), "A connection can be renamed", JSON.stringify(await labels(page)));
  page.once("dialog", (d) => d.accept());
  await page.click('.environment-editor button[aria-label="Remove eks"]');
  await page.waitForSelector('.environment-editor [data-connection="eks"]', { state: "detached" });
  check(JSON.stringify(await labels(page)) === JSON.stringify([ENV]), "With one connection left, it is called just by its environment's name",
    JSON.stringify(await labels(page)));
  const target = (await api(page, "GET", "/targets?type=aws")).body.find((t) => t.environment === ENV);
  check(target?.id === env.id, "…and the remaining connection still has the environment's own id", JSON.stringify(target));

  await clearWorkspace(page);
  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
