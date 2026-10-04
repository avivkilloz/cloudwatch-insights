// Settings → Credential types and Settings → Credentials (PLATFORM_PLAN.md
// §13.6), driven the way an admin would: define a custom type from a pasted
// JSON example (nested, with keys that aren't valid field names, so the
// output template has to rebuild the pasted shape), preview it, store a
// credential of it, edit it without touching the secret, grant it, read its
// history, and see a bad value refused with the backend's own sentence.
//
// Every response from the backend is kept, and the suite fails if the secret
// typed into the form ever comes back in one -- the screens' whole promise.
// Needs a backend with PLATFORM_MASTER_KEYS set (see README).
import { check, launch, openApp, report } from "./harness.mjs";

const SECRET = "e2e-very-secret-password-4711";
const GROUP = "e2e-credentials-group";

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
  const creds = (await api(page, "GET", "/credentials")).body ?? [];
  for (const c of creds.filter((c) => c.name.startsWith("e2e-"))) await api(page, "DELETE", `/credentials/${c.id}`);
  const types = (await api(page, "GET", "/credential-types")).body ?? [];
  for (const t of types.filter((t) => t.id.startsWith("e2e_"))) await api(page, "DELETE", `/credential-types/${t.id}`);
  const groups = (await api(page, "GET", "/user-groups")).body ?? [];
  for (const g of groups.filter((g) => g.name === GROUP)) await api(page, "DELETE", `/user-groups/${g.id}`);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  const bodies = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/")) return;
    try {
      bodies.push(await res.text());
    } catch {
      // a streamed or aborted response; nothing to keep
    }
  });

  await cleanUp(page);
  const status = (await api(page, "GET", "/credentials/status")).body;
  check(status?.enabled === true, "The backend has a master key (credentials are on)", JSON.stringify(status));
  await api(page, "POST", "/user-groups", { name: GROUP, role_name: "R" });

  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");

  // ---- 1. a custom type, from a pasted example
  await page.click('.content .tabs button:text-is("Credential types")');
  await page.waitForSelector('[data-credential-type="username_password"]');
  const builtIns = await page.locator('.credential-types-table tr:has(.tag:text-is("built-in"))').count();
  check(builtIns >= 8, "The built-in types are listed, marked built-in", String(builtIns));
  check(
    (await page.locator('[data-credential-type="username_password"] button:text-is("Edit")').count()) === 0,
    "…and can't be edited (only copied)",
  );

  await page.click('button:text-is("New type")');
  await page.fill(".credential-type-example", JSON.stringify({ userName: "", password: "", auth: { tenant: "acme" } }));
  await page.click('button:text-is("Fill fields from example")');
  await page.waitForSelector(".credential-type-fields tbody tr:nth-child(3)");
  const keys = await page.locator('.credential-type-fields input[aria-label="Key"]').evaluateAll((els) => els.map((e) => e.value));
  check(JSON.stringify(keys) === JSON.stringify(["user_name", "password", "auth_tenant"]), "Fields are proposed from the example", JSON.stringify(keys));
  const secretFlags = await page.locator('.credential-type-fields input[aria-label="Secret"]').evaluateAll((els) => els.map((e) => e.checked));
  check(JSON.stringify(secretFlags) === "[false,true,false]", "…with password guessed secret", JSON.stringify(secretFlags));
  const template = await page.inputValue(".credential-type-template");
  check(template.includes('"userName": user_name') && template.includes('"auth": {"tenant": auth_tenant}'),
    "…and an output template that rebuilds the pasted shape", template);

  await page.fill("#type-id", "e2e_acme");
  await page.fill("#type-label", "E2E Acme");
  await page.fill(".credential-preview textarea", JSON.stringify({ user_name: "u", password: "p" }));
  await page.click('.credential-preview button:text-is("Preview")');
  await page.waitForSelector(".credential-preview-output");
  const preview = JSON.parse(await page.locator(".credential-preview-output").innerText());
  check(preview.userName === "u" && preview.auth?.tenant === "acme", "The preview shows the pasted shape, with the default filled in", JSON.stringify(preview));

  await page.click('button:text-is("Save type")');
  await page.waitForSelector('[data-credential-type="e2e_acme"]');
  check(true, "The custom type is saved and listed");

  // ---- 2. a credential of it
  await page.click('.content .tabs button:text-is("Credentials")');
  await page.waitForSelector('button:text-is("New credential")');
  await page.click('button:text-is("New credential")');
  await page.selectOption("#cred-type", "e2e_acme");
  await page.fill("#cred-name", "e2e-acme");
  await page.fill("#cred-field-user_name", "bot");
  check((await page.getAttribute("#cred-field-password", "type")) === "password", "A secret text field is a password input");
  await page.fill("#cred-field-password", SECRET);
  await page.click('.credential-editor button:text-is("Save")');
  await page.waitForSelector('[data-credential="e2e-acme"]');
  const row = page.locator('[data-credential="e2e-acme"]');
  const details = await row.locator(".credential-details").innerText();
  check(details.includes("user_name: bot") && details.includes("password set"), "The list shows public fields and which secrets are set", details);
  check(!(await page.locator(".content").innerText()).includes(SECRET), "…and never the secret");

  // ---- 3. edit without touching the secret
  await row.locator('button:text-is("Edit")').click();
  await page.waitForSelector(".credential-secret-set");
  check((await page.locator('.credential-secret-set .tag:text-is("•••• set")').count()) === 1, "Editing shows the secret as set, with Replace");
  await page.fill("#cred-field-user_name", "bot2");
  await page.click('.credential-editor button:text-is("Save")');
  await page.waitForSelector('[data-credential="e2e-acme"] .credential-details:has-text("user_name: bot2")');
  const afterEdit = await page.locator('[data-credential="e2e-acme"] .credential-details').innerText();
  check(afterEdit.includes("password set"), "Saving an edit keeps the secret that was left alone", afterEdit);

  // ---- 4. grant it to a group
  await page.selectOption('[data-credential="e2e-acme"] select[aria-label="Grant to a group"]', { label: GROUP });
  await page.waitForSelector(`[data-credential="e2e-acme"] .credential-grant[data-group="${GROUP}"]`);
  const grants = (await api(page, "GET", "/credentials")).body.find((c) => c.name === "e2e-acme").grants;
  check(grants.length === 1, "A global credential can be granted to a group", JSON.stringify(grants));

  // ---- 5. its history
  await page.locator('[data-credential="e2e-acme"] button:text-is("History")').click();
  await page.waitForSelector(".credential-history table");
  const history = await page.locator(".credential-history tbody").innerText();
  check(["create", "update", "grant"].every((a) => history.includes(a)), "The history lists create, update and grant", history);
  check(history.includes("changed user_name") && !history.includes("bot2"), "…saying which fields changed, not their values", history);

  // ---- 6. a bad value is refused with the backend's own sentence; a good one is tested on save
  await page.click('button:text-is("New credential")');
  await page.selectOption("#cred-type", "secret_json");
  await page.fill("#cred-name", "e2e-json");
  await page.fill("#cred-field-value", "{not json");
  await page.click('.credential-editor button:text-is("Save and test")');
  await page.waitForSelector(".credentials-error");
  const refusal = await page.locator(".credentials-error").innerText();
  check(refusal.startsWith("'JSON' isn't valid JSON"), "An invalid value is refused readably, not as raw JSON", refusal);
  await page.fill("#cred-field-value", '{"client_id": "x"}');
  await page.click('.credential-editor button:text-is("Save and test")');
  await page.waitForSelector('.credentials-notice:has-text("Test passed")');
  check(true, "Saving a type with a check tests it straight away");

  // ---- 7. delete
  page.once("dialog", (d) => d.accept());
  await page.locator('[data-credential="e2e-acme"] button:text-is("Delete")').click();
  await page.waitForSelector('[data-credential="e2e-acme"]', { state: "detached" });
  check(true, "A credential can be deleted");

  const leaked = bodies.filter((b) => b.includes(SECRET));
  check(leaked.length === 0, `No response, out of ${bodies.length}, ever carried the secret`, leaked[0]?.slice(0, 200));

  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
