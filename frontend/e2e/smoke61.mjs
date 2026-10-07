// Settings → User groups → Identities (PLATFORM_PLAN.md D31), and the HTTP
// client's Target (D33), driven the way an admin and a user would:
//   - a group's role, set the old way, shows as its default AWS identity;
//   - an override for one connection is added with "A new AWS role…", and
//     saving creates that role as the group's own credential;
//   - removing the default clears the group's role;
//   - the HTTP client offers the HTTP API connection as a Target, says the
//     URL is now a path, and sends the target's id -- never a base URL or a
//     secret of its own making.
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

const ENV = "e2e-Prod";
const GROUP = "e2e-backend";
const PARTNER = "e2e-Partner";

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
  for (const g of (await api(page, "GET", "/user-groups")).body ?? []) {
    if (!g.name.startsWith("e2e-")) continue;
    // Its identities first: an identity's credential can't be deleted while in use.
    await api(page, "PUT", `/user-groups/${g.id}/identities`, { identities: [] });
    for (const c of (await api(page, "GET", "/credentials")).body ?? [])
      if (c.group_id === g.id) await api(page, "DELETE", `/credentials/${c.id}`);
    await api(page, "DELETE", `/user-groups/${g.id}`);
  }
  for (const e of (await api(page, "GET", "/environments")).body ?? [])
    if (e.name.startsWith("e2e-")) await api(page, "DELETE", `/environments/${e.id}`);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await cleanUp(page);
  const env = (await api(page, "POST", "/environments", { name: ENV, account_id: "111122223333", region: "eu-west-1" })).body;
  const eks = (await api(page, "POST", `/environments/${env.id}/connections`, {
    type_id: "aws", name: "eks", config: { account_id: "444455556666", region: "us-east-1" },
  })).body;
  const partner = (await api(page, "POST", "/environments", { name: PARTNER })).body;
  const api1 = (await api(page, "POST", `/environments/${partner.id}/connections`, {
    type_id: "http_api", name: "api", config: { base_url: "https://e2e-partner.invalid/v1" },
  })).body;
  const group = (await api(page, "POST", "/user-groups", { name: GROUP, role_name: "e2e-ReadOnly", environment_ids: [env.id] })).body;
  check(group?.role_name === "e2e-ReadOnly", "A group's role set the old way is kept", JSON.stringify(group));

  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  await page.click('.content .settings-tabs button:text-is("User groups")');
  await page.waitForSelector(`[data-group="${GROUP}"]`);
  check((await page.locator(`[data-group="${GROUP}"]`).innerText()).includes("e2e-ReadOnly"), "The list shows each group's AWS role");

  // ---- 1. the role is the group's default AWS identity
  await page.click(`[data-group="${GROUP}"]`);
  await page.waitForSelector('.group-editor [data-identity="aws:"] select');
  const chosen = await page.locator('.group-editor [data-identity="aws:"] select').evaluate((s) => s.selectedOptions[0]?.textContent ?? "");
  check(chosen.includes("e2e-ReadOnly"), "Its role shows as its default AWS identity", chosen);

  // ---- 2. an override for one connection, as a new AWS role
  await page.selectOption('.group-editor select[aria-label="Identity for"]', { label: `AWS · ${ENV} · eks` });
  await page.selectOption('.group-editor select[aria-label="Identity credential"]', { label: "A new AWS role…" });
  await page.fill('.group-editor input[aria-label="Role name"]', "e2e-EksRole");
  await page.click('.group-editor .group-identity-add button:text-is("Add")');
  await page.waitForSelector(`.group-editor [data-identity="aws:${eks.id}"]`);
  await page.click('.group-editor .credential-view-foot button:text-is("Save")');
  await page.waitForSelector(`.credentials-notice:has-text("Saved ${GROUP}")`);
  const identities = (await api(page, "GET", `/user-groups/${group.id}/identities`)).body;
  const override = identities.find((i) => i.connection_id === eks.id);
  const creds = (await api(page, "GET", "/credentials")).body;
  const role = creds.find((c) => c.id === override?.credential_id);
  check(override?.credential_type === "AWS role" && role?.public_fields?.role_name === "e2e-EksRole" && role?.group_id === group.id,
    "Saving creates the new role as the group's own credential and sets it for that one connection",
    JSON.stringify({ identities, role }));

  // ---- 3. removing the default clears the group's role
  await page.click(`[data-group="${GROUP}"]`);
  await page.waitForSelector('.group-editor [data-identity="aws:"]');
  await page.click('.group-editor [data-identity="aws:"] button[aria-label^="Remove the identity"]');
  await page.click('.group-editor .credential-view-foot button:text-is("Save")');
  await page.waitForSelector(`.credentials-notice:has-text("Saved ${GROUP}")`);
  const after = (await api(page, "GET", "/user-groups")).body.find((g) => g.id === group.id);
  const left = (await api(page, "GET", `/user-groups/${group.id}/identities`)).body;
  check(after.role_name === null && left.length === 1 && left[0].connection_id === eks.id,
    "Removing the default AWS identity clears the role; the override stays", JSON.stringify({ role: after.role_name, left }));

  // ---- 4. the HTTP client's Target
  const sent = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/tools/http-request")) sent.push(JSON.parse(req.postData() ?? "{}"));
  });
  await newSession(page, "HTTP client");
  await page.waitForSelector(`${SHOWN} #http-target option:has-text("${PARTNER}")`, { state: "attached" });
  await page.selectOption(`${SHOWN} #http-target`, { label: `${PARTNER} (https://e2e-partner.invalid/v1)` });
  const placeholder = await page.getAttribute(`${SHOWN} input[aria-label="URL"]`, "placeholder");
  check(placeholder.includes("after https://e2e-partner.invalid/v1"), "With a target picked, the URL is a path after its base URL", placeholder);
  const none = await page.locator(`${SHOWN} #http-auth option[value=""]`).innerText();
  check(none === "Your group's identity there", "…and Auth defaults to the group's identity there", none);
  await page.fill(`${SHOWN} input[aria-label="URL"]`, "/status");
  await page.click(`${SHOWN} button:text-is("Send")`);
  await page.waitForSelector(`${SHOWN} .error-text`, { timeout: 40000 });
  check(sent.length === 1 && sent[0].target_id === api1.id && sent[0].url === "/status",
    "The browser sends the target's id and the path, nothing else", JSON.stringify(sent));
  const error = await page.locator(`${SHOWN} .error-text`).innerText();
  check(error.includes("e2e-partner.invalid"), "The backend joined the base URL (its own sentence names the host)", error);

  await clearWorkspace(page);
  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
