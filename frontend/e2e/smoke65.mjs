// Saved inputs on every pane (PLATFORM_PLAN.md D46), Settings → Library and
// Users | Groups (D50), driven the way a user would:
//   - DynamoDB's Saved ▾ → "Save as…" keeps the pane's inputs under a name;
//     picking it from the menu fills them back in and, as picking the table
//     by hand does, describes it;
//   - the menu sits in the first card's title row, not a row of its own;
//   - a pane that never had saved items (Cognito, Base64) has them now;
//   - nothing sensitive is kept: JWT's inputs never reach the store;
//   - Settings → Library lists them by pane, renames and deletes;
//   - Settings → Users switches between users and their groups.
import { check, clearWorkspace, launch, mockPaneActions, newSession, openApp, PICKER, report, SHOWN } from "./harness.mjs";

const TABLE = "e2e-saved-table";

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
  for (const s of (await api(page, "GET", "/saved-inputs")).body ?? [])
    if (s.name.startsWith("e2e-")) await api(page, "DELETE", `/saved-inputs/${s.id}`);
}

async function saveAs(page, name) {
  page.once("dialog", (d) => d.accept(name));
  await page.click(`${SHOWN} .pane-saved button:text-is("Saved ▾")`);
  await page.click('.pane-saved-menu button:text-is("Save as…")');
  await page.waitForTimeout(600);
}

async function loadSaved(page, name) {
  await page.click(`${SHOWN} .pane-saved button:text-is("Saved ▾")`);
  await page.click(`.pane-saved-menu [data-saved-input-item="${name}"]`);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const described = [];
  await mockPaneActions(page, "tables", {
    list_tables: { options: [{ value: TABLE, label: TABLE }] },
    describe: ({ inputs }) => {
      described.push(inputs.tableName);
      return { tableInfo: { table_name: inputs.tableName, status: "ACTIVE", item_count: 1, size_bytes: 1, partition_key: "id", sort_key: null } };
    },
    scan: { items: [{ id: "1" }], scannedCount: 1, lastEvaluatedKey: null },
  });
  await clearWorkspace(page);
  await cleanUp(page);

  // ---- 1. DynamoDB: save, then load into a fresh pane
  await newSession(page, "DynamoDB");
  const card = `${SHOWN} .panel:has-text("Choose environment and table")`;
  await page.waitForSelector(`${card} .pane-saved`);
  const placed = await page.locator(`${card} .pane-saved`).evaluate((el) => {
    const h2 = el.closest(".panel").querySelector("h2");
    const a = el.getBoundingClientRect();
    const b = h2.getBoundingClientRect();
    return { sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 6, right: a.left > b.right };
  });
  check(placed.sameRow && placed.right, "Saved ▾ sits at the right of the first card's title, not in a row of its own",
    JSON.stringify(placed));
  await page.click(`${SHOWN} .pane-saved button:text-is("Saved ▾")`);
  const empty = await page.waitForSelector('.pane-saved-menu .pane-saved-note:text-is("Nothing saved yet")', { timeout: 5000 })
    .then(() => true, () => false);
  check(empty, "With nothing saved, the menu says so");
  await page.keyboard.press("Escape");
  await page.selectOption(`${card} ${PICKER} >> nth=0`, { index: 1 });
  await page.click(`${SHOWN} button:has-text("Load tables")`);
  await page.waitForSelector(`${SHOWN} option[value="${TABLE}"]`, { state: "attached" });
  await page.selectOption(`${card} ${PICKER} >> nth=1`, TABLE);
  await page.fill(`${SHOWN} input[placeholder="field:value field2:value2"]`, "status:ACTIVE");
  await saveAs(page, "e2e-orders");
  const saved = ((await api(page, "GET", "/saved-inputs?pane_type=tables")).body ?? []).find((s) => s.name === "e2e-orders");
  check(saved?.inputs.tableName === TABLE && saved.inputs.queryString === "status:ACTIVE" && typeof saved.inputs.connection === "number",
    "Save as… keeps the pane's inputs under a name, by pane type", JSON.stringify(saved));

  await newSession(page, "DynamoDB");
  described.length = 0;
  await loadSaved(page, "e2e-orders");
  await page.waitForSelector(`${SHOWN} >> text=partition key: id`);
  check((await page.inputValue(`${SHOWN} input[placeholder="field:value field2:value2"]`)) === "status:ACTIVE",
    "Picking it fills the inputs back in");
  check(JSON.stringify(described) === JSON.stringify([TABLE]), "…and describes the table, as picking it by hand does",
    JSON.stringify(described));

  // ---- 2. panes that never had saved items
  await newSession(page, "Base64");
  await page.locator(`${SHOWN} textarea`).first().fill("e2e saved text");
  await saveAs(page, "e2e-greeting");
  await page.locator(`${SHOWN} textarea`).first().fill("");
  await loadSaved(page, "e2e-greeting");
  check((await page.locator(`${SHOWN} textarea`).first().inputValue()) === "e2e saved text", "Base64 can save and load its inputs too");

  await newSession(page, "JWT");
  await page.fill(`${SHOWN} textarea[placeholder^="Paste a JWT"]`, "e2e.secret.token");
  await saveAs(page, "e2e-jwt");
  const jwt = ((await api(page, "GET", "/saved-inputs?pane_type=tool-jwt")).body ?? []).find((s) => s.name === "e2e-jwt");
  check(jwt && !JSON.stringify(jwt).includes("e2e.secret.token"), "A pasted token is never saved", JSON.stringify(jwt));

  // ---- 3. Settings → Library
  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.click('.content .settings-tabs button:text-is("Library")');
  await page.waitForSelector('.panel:has(h2:text-is("Library")) .tab');
  const tabs = await page.locator('.panel:has(h2:text-is("Library")) .tabs .tab').allInnerTexts();
  check(tabs[0] === "Templates" && tabs[1] === "Saved inputs" && !tabs.includes("S3") && !tabs.includes("DynamoDB"),
    "Library: Templates, then Saved inputs; S3's and DynamoDB's own tabs are gone", JSON.stringify(tabs));
  await page.click('.panel:has(h2:text-is("Library")) .tab:text-is("Saved inputs")');
  await page.waitForSelector('[data-saved-input="e2e-orders"]');
  const row = await page.locator('[data-saved-input="e2e-orders"]').innerText();
  check(row.includes("DynamoDB") && row.includes(TABLE), "Saved inputs are listed with their pane", row);
  page.once("dialog", (d) => d.accept("e2e-orders-renamed"));
  await page.click('[data-saved-input="e2e-orders"] button:text-is("Rename")');
  await page.waitForSelector('[data-saved-input="e2e-orders-renamed"]');
  page.once("dialog", (d) => d.accept());
  await page.click('[data-saved-input="e2e-orders-renamed"] button:text-is("Delete")');
  await page.waitForSelector('[data-saved-input="e2e-orders-renamed"]', { state: "detached" });
  check(true, "…renamed and deleted there");

  // ---- 4. Settings → Users | Groups
  const settingsTabs = await page.locator(".content .settings-tabs button").allInnerTexts();
  check(settingsTabs.includes("Users") && !settingsTabs.includes("User groups"), "Users and User groups are one tab",
    JSON.stringify(settingsTabs));
  await page.click('.content .settings-tabs button:text-is("Users")');
  await page.waitForSelector('.segmented button:text-is("Groups")');
  check((await page.locator('.credential-list-head .segmented button[aria-pressed="true"]').innerText()) === "Users",
    "It opens on the users");
  await page.click('.segmented button:text-is("Groups")');
  await page.waitForSelector("[data-group]");
  check((await page.locator('.credential-list-head .segmented button[aria-pressed="true"]').innerText()) === "Groups",
    "…and switches to the groups");

  await cleanUp(page);
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
