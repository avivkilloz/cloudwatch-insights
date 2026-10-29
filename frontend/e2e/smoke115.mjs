// The types a pane needs, built as a pane is (D159):
//   - a pane's draft that names a connection type that isn't there says so --
//     Check at its line, and the Needs line under the editor, with "Make it",
//     which opens Connections with a new type of that id; made, the Needs line
//     says it's there and Check passes;
//   - a credential type's editor keeps its work as a draft: left and opened
//     again from the list, it's as it was;
//   - with that editor on screen, Claude Code (an access token) works on its
//     draft -- open_draft(on_screen) -- and each change shows in the form live;
//   - the agent panel's Building tab works beside it too: the Builder's loop
//     reads the type's reference and puts its change in the form. Needs the
//     agent and the fake model.
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:5179";
const DOCK = ".agent-dock";
const STAMP = Date.now();
const CONN = `needs_${STAMP}`;
const PANE = `label: Needs ${STAMP}
description: A pane on an API the platform has no type for yet.
category: Tools
inputs:
  - {key: target, type: connection, connection_type: ${CONN}, label: API}
actions:
  - id: list
    main: true
    request:
      connection: target
      rows: {at: items}
outputs:
  - {key: rows, render: table}
  - {key: error, render: error}
layout:
  - title: Items
    items:
      - input: target
      - toolbar:
          - action: list
      - output: error
      - output: rows
`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function tool(token, name, args = {}) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (body?.result?.isError) throw new Error(`${name}: ${body.result.content[0].text}`);
  return JSON.parse(body.result.content[0].text);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  let tokenId = null;
  try {
    await clearWorkspace(page);

    // ---- 1. a pane that needs a connection type that isn't there
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    await page.fill("#builder-source", PANE);
    await page.waitForSelector(`.builder-need-missing[data-need="${CONN}"]`, { timeout: 10000 });
    check(true, "The Needs line names the connection type the draft reaches, missing");
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector(".builder-problems li");
    const problems = await page.locator(".builder-problems li").allInnerTexts();
    const line = PANE.split("\n").findIndex((l) => l.includes(`connection_type: ${CONN}`)) + 1;
    check(problems.some((p) => p.includes(`no connection type '${CONN}'`) && p.includes(`Line ${line}`)),
      "Check says so, at its line", JSON.stringify(problems));
    await page.screenshot({ path: `${SHOT}/smoke115-needs.png`, fullPage: true });

    await page.click(`.builder-need-missing[data-need="${CONN}"] button:text-is("Make it")`);
    await page.waitForSelector("#connection-type-id");
    check((await page.inputValue("#connection-type-id")) === CONN, "Make it opens Connections with a new type of that id");
    await page.fill("#connection-type-name", `Needs API ${STAMP}`);
    await page.click('.credential-view-foot button:text-is("Create")');
    await page.waitForSelector(`.connection-types-table tr:has-text("Needs API ${STAMP}")`);

    await page.click('.segmented button:text-is("Panes")');
    await page.click(`.builder-list tr:has-text("Needs ${STAMP}")`);
    await page.waitForSelector(`.builder-need[data-need="${CONN}"]:not(.builder-need-missing)`, { timeout: 10000 });
    check((await page.locator(`.builder-need[data-need="${CONN}"]`).innerText()) === `Needs API ${STAMP}`,
      "Back in the pane's draft, the Needs line says it's there");
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")', { timeout: 15000 });
    check(true, "…and Check passes");

    // ---- 2. a credential type's editor keeps its work as a draft
    await page.click(".builder-view .view-head button:has-text(\"Back\"), button:has-text(\"← Back\")");
    await page.click('.segmented button:text-is("Credentials")');
    await page.click('.credential-list-head button:text-is("New type")');
    await page.fill("#type-label", `Kept ${STAMP}`);
    await page.waitForSelector('.builder-draft-status:has-text("Draft saved")', { timeout: 10000 });
    await page.click('.credential-view-foot button:text-is("Cancel")');
    await page.waitForSelector(`.credential-types-table tr:has-text("Kept ${STAMP}") .builder-draft-tag`);
    check(true, "Left unsaved, the credential type is a Draft row in the list");
    await page.click(`.credential-types-table tr:has-text("Kept ${STAMP}")`);
    await page.waitForFunction((label) => document.querySelector("#type-label")?.value === label, `Kept ${STAMP}`, { timeout: 10000 });
    check(true, "…opened again, it's as it was left");

    // ---- 3. with that editor on screen, Claude Code works on it live
    const made = (await api(page, "POST", "/access-tokens", { name: `Types ${STAMP}`, days: 30 })).body;
    tokenId = made.id;
    let screen = null;
    for (let i = 0; i < 40 && !(screen?.view === "builder" && screen?.kind === "credential"); i++) {
      screen = (await tool(made.token, "get_context")).on_screen[0];
      if (!(screen?.kind === "credential")) await new Promise((r) => setTimeout(r, 250));
    }
    check(screen?.kind === "credential" && screen?.draft_id, "get_context: the credential type's editor is on screen, with its draft",
      JSON.stringify(screen));
    const opened = await tool(made.token, "open_draft", { on_screen: true });
    const changed = await tool(made.token, "change_definition", { draft_id: opened.draft_id, changes: [
      { op: "set", path: "label", value: `Kept by Claude ${STAMP}` },
      { op: "set", path: "fields", value: [{ key: "api_key", label: "API key", kind: "text", secret: true, required: true, help: "" }] },
    ] });
    check(changed.ok === true, "Claude Code changes the type's draft, checked", JSON.stringify(changed).slice(0, 200));
    await page.waitForFunction((label) => document.querySelector("#type-label")?.value === label, `Kept by Claude ${STAMP}`, { timeout: 10000 });
    const key = await page.locator('.credential-type-fields [aria-label="Key"]').first().inputValue();
    check(key === "api_key" && (await page.locator('.credential-type-fields [aria-label="Secret"]').first().isChecked()),
      "…and the form shows each change as it's made", key);
    await page.screenshot({ path: `${SHOT}/smoke115-live.png`, fullPage: true });

    // ---- 4. the agent panel's Building tab, beside a type's editor
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.segmented button:text-is("Credentials")');
    await page.click(`.credential-types-table tr:has-text("Kept by Claude ${STAMP}")`);
    await page.waitForFunction((label) => document.querySelector("#type-label")?.value === label, `Kept by Claude ${STAMP}`);
    await page.fill(`${DOCK} .agent-compose-input`, `rename Kept by the agent ${STAMP}`);
    await page.click(`${DOCK} button:text-is("Ask")`);
    await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
    await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 90000 });
    const steps = await page.locator(`${DOCK} .agent-turn`).last().locator(".agent-steps li").allInnerTexts();
    check((await page.inputValue("#type-label")) === `Kept by the agent ${STAMP}` && steps.some((t) => t.includes("Put a draft in the editor")),
      "The Building tab beside a type's editor: its change lands in the form", JSON.stringify(steps).slice(0, 300));
    check((await page.locator(`${DOCK} .agent-answer`).last().innerText()).includes("check it and save"),
      "…and says what to do before saving a type (check, not preview)");
  } finally {
    if (tokenId) await api(page, "DELETE", `/access-tokens/${tokenId}`);
    for (const d of (await api(page, "GET", "/build-drafts")).body ?? []) await api(page, "DELETE", `/build-drafts/${d.id}`);
    for (const t of (await api(page, "GET", "/connection-types")).body ?? []) {
      if (String(t.id).includes(String(STAMP))) await api(page, "DELETE", `/connection-types/${encodeURIComponent(t.id)}`);
    }
    await clearWorkspace(page);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
