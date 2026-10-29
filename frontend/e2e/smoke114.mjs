// Credential and connection types in the Builder (D158; the user: "building
// new credential types is part of the building process of workflows and
// panes"). As a member of a builder group, not an admin:
//   - the Builder has Connections and Credentials beside Panes, Workflows and
//     Steps;
//   - a connection type and a credential type are made there -- the
//     credential type written as YAML, then seen in the form -- each the
//     builder's group's ("Made by");
//   - an admin's type opens read-only, saying why;
//   - once a credential uses their type, it's an admin's to change, and says so;
//   - an admin sees the builder's types in Settings, the same editor.
import { check, clearWorkspace, launch, newPage, openApp, report, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const USER = `typer${STAMP}`;
const GROUP = `Typers ${STAMP}`;
const CRED = `acme_key_${STAMP}`;
const CONN = `acme_${STAMP}`;
const ADMINS = `admins_key_${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function builderTab(page, name) {
  await page.click(`.segmented button:text-is("${name}")`);
}

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  admin.on("dialog", (d) => d.accept());
  const g = (await api(admin, "POST", "/user-groups", { name: GROUP, role_name: "R", builder_enabled: true })).body;
  const user = (await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id })).body;
  const theirs = await api(admin, "POST", "/credential-types", {
    id: ADMINS, label: `Admins' key ${STAMP}`, fields: [{ key: "k", label: "K", kind: "text", secret: false, required: false, help: "" }],
  });
  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  let credId = null;
  try {
    await signIn(page, { username: USER, password: "pw-123456" });
    await page.click('.rail-row-page:has-text("Builder")');
    const tabs = await page.locator(".builder-list .segmented button").allInnerTexts();
    check(JSON.stringify(tabs) === '["Panes","Workflows","Steps","Connections","Credentials"]',
      "The Builder has Connections and Credentials beside Panes, Workflows and Steps", JSON.stringify(tabs));

    // ---- 1. a connection type, made by a builder
    await builderTab(page, "Connections");
    await page.waitForSelector(".connection-types-table");
    await page.click('.credential-list-head button:text-is("New connection type")');
    await page.fill("#connection-type-id", CONN);
    await page.fill("#connection-type-name", `Acme API ${STAMP}`);
    await page.click('button:text-is("+ Field")');
    await page.fill('[aria-label="Field key"]', "tenant");
    await page.fill('[aria-label="Field label"]', "Tenant");
    await page.click('.credential-view-foot button:text-is("Create")');
    await page.waitForSelector(`.connection-types-table tr:has-text("Acme API ${STAMP}")`);
    const connRow = await page.locator(`.connection-types-table tr:has-text("Acme API ${STAMP}")`).innerText();
    check(connRow.includes(`${GROUP} builders`), "A builder makes a connection type in the Builder: their group's", connRow);

    // ---- 2. a credential type, written as YAML
    await builderTab(page, "Credentials");
    await page.waitForSelector(".credential-types-table");
    await page.click('.credential-list-head button:text-is("New type")');
    await page.click('.segmented button:text-is("YAML")');
    const yaml = [
      `id: ${CRED}`,
      `label: Acme key ${STAMP}`,
      "description: Signs Acme API requests.",
      "fields:",
      "  - key: token",
      "    label: Token",
      "    kind: text",
      "    secret: true",
      "    required: true",
      "    help: From Acme's console",
      "inject:",
      "  kind: header",
      "  name: Authorization",
      '  value: \'"Bearer " + token\'',
      "",
    ].join("\n");
    await page.fill("#credential-type-yaml", yaml);
    check((await page.locator(".type-yaml-problem").count()) === 0, "YAML: a definition that reads is taken in");
    await page.click('.segmented button:text-is("Form")');
    check((await page.inputValue("#type-label")) === `Acme key ${STAMP}` &&
      (await page.locator('.credential-type-fields [aria-label="Key"]').first().inputValue()) === "token" &&
      (await page.locator('.credential-type-fields [aria-label="Secret"]').first().isChecked()),
      "…and the form shows what it said: the label, the secret field");
    await page.click('.segmented button:text-is("YAML")');
    await page.fill("#credential-type-yaml", "label: [unclosed");
    check((await page.locator(".type-yaml-problem").count()) === 1, "A YAML that doesn't read is said so, and not taken");
    await page.fill("#credential-type-yaml", yaml);
    await page.screenshot({ path: `${SHOT}/smoke114-yaml.png`, fullPage: true });
    await page.click('.credential-view-foot button:text-is("Save type")');
    await page.waitForSelector(`.credential-types-table tr:has-text("Acme key ${STAMP}")`);
    const credRow = await page.locator(`.credential-types-table tr:has-text("Acme key ${STAMP}")`).innerText();
    check(credRow.includes(`${GROUP} builders`) && credRow.includes("token"), "A builder makes a credential type: their group's", credRow);
    await page.screenshot({ path: `${SHOT}/smoke114-list.png`, fullPage: true });

    // ---- 3. an admin's type opens read-only, saying why
    await page.click(`.credential-types-table tr:has-text("Admins' key ${STAMP}")`);
    check((await page.locator(".credential-locked").innerText()).includes("only they, or an admin, change it") &&
      (await page.locator('.credential-view-foot button:text-is("Save type")').count()) === 0,
      "An admin's type opens read-only, saying why", theirs.status);
    await page.click('.credential-view-foot button:text-is("Close")');

    // ---- 4. once a credential uses theirs, it's an admin's to change
    const made = await api(admin, "POST", "/credentials", { name: `Acme ${STAMP}`, type_id: (await api(page, "GET", "/credential-types")).body.find((t) => t.label === `Acme key ${STAMP}`).id, scope: "global", values: { token: "t-123" } });
    credId = made.body?.id ?? null;
    check(made.status === 201, "An admin makes a credential of it", JSON.stringify(made.body).slice(0, 200));
    await page.reload();
    await page.click('.rail-row-page:has-text("Builder")');
    await builderTab(page, "Credentials");
    await page.click(`.credential-types-table tr:has-text("Acme key ${STAMP}")`);
    check((await page.locator(".credential-locked").innerText()).includes("1 credential uses it"),
      "Once a credential uses it, the builder's type is an admin's to change, and says so");

    // ---- 5. the same types in Settings, for an admin
    await admin.reload();
    await admin.click('[aria-label="Account menu"]');
    await admin.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
    await admin.click('.settings-tabs .tab:text-is("Credentials")');
    await admin.click('.credentials-settings .segmented button:text-is("Types")');
    await admin.waitForSelector(`.credential-types-table tr:has-text("Acme key ${STAMP}")`);
    check((await admin.locator(`.credential-types-table tr:has-text("Acme key ${STAMP}")`).innerText()).includes(`${GROUP} builders`),
      "An admin sees the builder's type in Settings, saying whose");
  } finally {
    if (credId) await api(admin, "DELETE", `/credentials/${credId}`);
    for (const t of (await api(admin, "GET", "/credential-types")).body ?? []) {
      if (String(t.id).includes(String(STAMP))) await api(admin, "DELETE", `/credential-types/${encodeURIComponent(t.id)}`);
    }
    for (const t of (await api(admin, "GET", "/connection-types")).body ?? []) {
      if (String(t.id).includes(String(STAMP))) await api(admin, "DELETE", `/connection-types/${encodeURIComponent(t.id)}`);
    }
    if (user?.id) await api(admin, "DELETE", `/users/${user.id}`);
    if (g?.id) await api(admin, "DELETE", `/user-groups/${g.id}`);
    await clearWorkspace(admin);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
