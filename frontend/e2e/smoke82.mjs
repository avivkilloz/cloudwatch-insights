// 3d-3: a new kind of connection, and a pane from a manifest alone (D67,
// PLATFORM_PLAN.md §19.3), driven as an admin and a member would:
//   - Settings → Environments → Types: the built-ins, and Prometheus "from the
//     Prometheus pane" (its manifest shipped it); a type of the admin's own,
//     with a field, edited and deleted; a type a pane needs can't be;
//   - an environment's new connection offers the defined type, with its fields;
//   - the Prometheus pane -- prometheus.yaml and no code -- queries a
//     Prometheus connection over its time range: the series on a chart and in
//     a table, time and value first; it's listed under its own Observability;
//   - a member is offered it either way (D160): dimmed, saying why, until
//     their group can see an environment with a Prometheus connection.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, SHOWN, signIn } from "./harness.mjs";

const STAMP = Date.now();
const USER = `prom${STAMP}`;
const ENV = `Metrics ${STAMP}`;
const LIST = ".credential-list";
const EDITOR = ".connection-type-editor";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function openEnvironments(page) {
  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.click('.content .settings-tabs button:text-is("Environments")');
}

const NOW = Math.floor(Date.now() / 1000);
const series = (job, base) => ({
  metric: { __name__: "up", job, instance: `${job}:9090` },
  values: Array.from({ length: 30 }, (_, i) => [NOW - 3600 + i * 120, String(base + (i % 5))]),
});

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);

  // ---- 1. the types
  await openEnvironments(page);
  await page.click('.segmented button:text-is("Types")');
  await page.waitForSelector('[data-connection-type="prometheus"]');
  const prom = await page.locator('[data-connection-type="prometheus"]').innerText();
  check(prom.includes("From the Prometheus pane") && prom.includes("Base URL"), "Prometheus is a type its pane shipped", prom);
  check((await page.locator('[data-connection-type="aws"]').innerText()).includes("Built in"), "…beside the built-ins");
  await page.click('[data-connection-type="prometheus"]');
  check(await page.locator(`${EDITOR} button:text-is("Delete")`).isDisabled(), "A type a pane reaches can't be deleted");
  await page.click(`${EDITOR} button:text-is("← Back")`);

  await page.click(`${LIST} button:text-is("New connection type")`);
  await page.fill("#connection-type-id", "grafana_smoke");
  await page.fill("#connection-type-name", "Grafana");
  await page.click(`${EDITOR} button:text-is("+ Field")`);
  await page.fill(`${EDITOR} [aria-label="Field key"]`, "org_id");
  await page.fill(`${EDITOR} [aria-label="Field label"]`, "Org ID");
  await page.click(`${EDITOR} button:text-is("Create")`);
  await page.waitForSelector('[data-connection-type="grafana_smoke"]');
  check((await page.locator('[data-connection-type="grafana_smoke"]').innerText()).includes("Base URL, Org ID"),
    "An admin's own type has a Base URL and the fields given");

  // ---- 2. it's offered for a new connection, with its fields
  const env = (await api(page, "POST", "/environments", { name: ENV })).body;
  await page.click('.segmented button:text-is("Environments")');
  await page.click(`[data-environment="${ENV}"]`);
  await page.click('button:text-is("Add connection")');
  await page.selectOption("#conn-type", { label: "Grafana" });
  check((await page.locator("#conn-field-base_url").count()) === 1 && (await page.locator("#conn-field-org_id").count()) === 1,
    "A new connection offers the type, with its fields");
  await page.selectOption("#conn-type", { label: "Prometheus" });
  await page.fill("#conn-name", "prom");
  await page.fill("#conn-field-base_url", "http://prom.fake");
  await page.click('.environment-editor button:text-is("Add connection")');
  await page.waitForSelector('[data-connection="prom"]');
  check(true, "A Prometheus connection is added like any other");

  // The admin's type goes, once nothing holds it.
  await page.click('.environment-editor button:text-is("← Back")');
  await page.click('.segmented button:text-is("Types")');
  await page.click('[data-connection-type="grafana_smoke"]');
  page.once("dialog", (d) => d.accept());
  await page.click(`${EDITOR} button:text-is("Delete")`);
  await page.waitForFunction(() => !document.querySelector('[data-connection-type="grafana_smoke"]'));
  check(true, "An admin's own type, unused, is deleted");

  // ---- 3. the pane, from its manifest alone
  await api(page, "PUT", "/dev/fake-http?path=/api/v1/query_range", {
    status: "success", data: { resultType: "matrix", result: [series("api", 20), series("db", 10)] },
  });
  await newSession(page, "Prometheus");
  const headings = (await page.locator(".rail .rail-heading").allInnerTexts()).map((h) => h.trim().toUpperCase());
  check(headings.includes("OBSERVABILITY"), "It's listed under its own category, Observability", JSON.stringify(headings));
  await page.waitForSelector(`${SHOWN} select[aria-label="Connection"] option:has-text("${ENV}")`, { state: "attached" });
  await page.selectOption(`${SHOWN} select[aria-label="Connection"]`, { label: `${ENV} (http://prom.fake)` });
  await page.click(`${SHOWN} button:text-is("Run")`);
  await page.waitForSelector(`${SHOWN} .panel:has(h2:text-is("Series")) .result-row, ${SHOWN} .panel:has(h2:text-is("Series")) tbody tr`, { timeout: 15000 });
  const card = `${SHOWN} .panel:has(h2:text-is("Series"))`;
  const text = await page.locator(card).innerText();
  check(text.includes("60 rows"), "Run brings every series' every point back as rows", text.slice(0, 120));
  const heads = (await page.locator(`${card} thead th`).allInnerTexts()).map((h) => h.trim()).filter(Boolean);
  check(JSON.stringify(heads.slice(0, 3)) === JSON.stringify(["time", "value", "series"]), "…time, value and series first", JSON.stringify(heads));
  await page.waitForSelector(`${card} canvas`, { timeout: 15000 });
  check((await page.locator(`${card} select[aria-label="Series"], ${card} select`).count()) > 0, "…and a time-series chart over them");

  // ---- 4. a member: offered it either way, and told when it can't run (D160)
  const g = (await api(page, "POST", "/user-groups", { name: `g-${USER}`, environment_ids: [] })).body;
  await api(page, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  const member = await newPage(browser);
  await signIn(member, { username: USER, password: "pw-123456" });
  const PROM = '.rail .rail-row-type:has(.rail-row-label:text-is("Prometheus"))';
  await member.waitForSelector(PROM);
  check((await member.locator(PROM).getAttribute("class")).includes("no-environment") &&
    (await member.locator(PROM).getAttribute("title")).includes("Prometheus"),
    "Without an environment for it, a member is offered it dimmed, saying why");
  await api(page, "PUT", `/user-groups/${g.id}`, { environment_ids: [env.id] });
  await member.reload();
  await member.waitForSelector(PROM);
  check(!(await member.locator(PROM).getAttribute("class")).includes("no-environment"), "Given the environment, it isn't");
  await member.close();

  for (const u of (await api(page, "GET", "/users")).body.filter((u) => u.username === USER)) await api(page, "DELETE", `/users/${u.id}`);
  await api(page, "DELETE", `/user-groups/${g.id}`);
  await api(page, "DELETE", `/environments/${env.id}`);
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
