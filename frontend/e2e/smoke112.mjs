// The platform from outside (D156; the user: "I want to know if it's possible
// to connect Claude to an MCP of this platform"): Claude Code on a machine
// that can reach the app, with a personal access token.
//   - Settings → My account → Access tokens makes one: shown once, with the
//     `claude mcp add` line for this app's /api/mcp; listed by name after,
//     never again in full;
//   - with it, an MCP client builds in a Builder draft -- open, change,
//     propose -- and `/?draft=<id>` opens that draft in the Builder, the
//     proposal in its chat; nothing saved;
//   - revoked, it stops working at once;
//   - and a pane's first Python file brings requirements.txt with it.
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:5179";
const NAME = `Laptop ${Date.now()}`;

/** One MCP call, as Claude Code makes it: JSON-RPC over HTTP to /api/mcp. */
async function mcp(token, method, params = {}) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function tool(token, name, args) {
  const { status, body } = await mcp(token, "tools/call", { name, arguments: args });
  if (status !== 200 || body?.result?.isError) throw new Error(`${name}: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return JSON.parse(body.result.content[0].text);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());
  let draftId = null;
  try {
    await clearWorkspace(page);

    // ---- 1. a token, made in Settings and shown once
    await page.click('[aria-label="Account menu"]');
    await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
    await page.waitForSelector(".access-tokens");
    await page.fill(".access-token-name", NAME);
    await page.selectOption(".access-token-days", "30");
    await page.click('.access-tokens button:text-is("Create token")');
    await page.waitForSelector(".access-token-made");
    const token = await page.inputValue(".access-token-value");
    check(/^cwi_[A-Za-z0-9_-]{40,}$/.test(token), "Create token: the token, shown once", token.slice(0, 10));
    const commands = await page.locator(".access-token-command").allInnerTexts();
    check(commands[0] === `claude mcp add --transport http platform ${BASE}/api/mcp --header "Authorization: Bearer ${token}"`,
      "…with the line that adds it to Claude Code, this app's /api/mcp", commands[0]);
    check(commands[1].includes('"Bearer ${PLATFORM_TOKEN}"') && !commands[1].includes(token),
      "…and a .mcp.json that reads it from PLATFORM_TOKEN, never holding it", commands[1].slice(0, 200));
    check((await page.locator(`.access-tokens .access-tokens-table tr:has-text("${NAME}") code`).innerText()) === `${token.slice(0, 10)}…`,
      "…listed by its name and first characters");
    await page.screenshot({ path: `${SHOT}/smoke112-token.png`, fullPage: true });
    await page.reload();
    await page.click('[aria-label="Account menu"]');
    await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
    await page.waitForSelector(`.access-tokens .access-tokens-table tr:has-text("${NAME}")`);
    check(!(await page.content()).includes(token), "Opened again, the token itself is nowhere on the page");

    // ---- 2. an MCP client builds in a draft; the link opens it in the Builder
    const init = await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke112", version: "1" } });
    check(init.status === 200 && init.body.result.instructions.includes("read_guide"), "The token opens /api/mcp, and its instructions say where to start");
    const opened = await tool(token, "open_draft", { kind: "pane", start_from: "recipe:rows-that-open" });
    draftId = opened.draft_id;
    const lines = (await tool(token, "read_draft", { draft_id: draftId })).text.split("\n");
    const at = lines.find((l) => /^\d+: label: /.test(l)).split(":")[0];
    const changed = await tool(token, "change_definition", {
      draft_id: draftId,
      changes: [{ op: "lines", from: Number(at), to: Number(at), text: "label: Lambdas from Claude Code" }],
    });
    check(changed.ok === true, "…opens a draft from a recipe and changes it", JSON.stringify(changed).slice(0, 200));
    const proposed = await tool(token, "propose_definition", { draft_id: draftId, summary: "A Lambda list, renamed." });
    check(proposed.link === `/?draft=${draftId}` && proposed.note.includes("Builder → Panes → Lambdas from Claude Code"),
      "…and proposes it: left in the Builder, the answer saying where", proposed.note);

    await page.goto(`${BASE}${proposed.link}`);
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("Lambdas from Claude Code"), null, { timeout: 15000 });
    check(true, "Opened at /?draft=<id>: the Builder, holding the draft");
    check(!page.url().includes("draft="), "…the link dropped from the address once taken", page.url());
    check((await page.locator(".builder-draft-status").innerText()).includes("Your draft from"), "…said to be a draft");
    const types = await page.evaluate(async () => (await fetch("/api/builder/panes")).json());
    check(!types.some((t) => t.label === "Lambdas from Claude Code"), "…and nothing saved: that's the user's");
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.goto(`${BASE}/?draft=${draftId}`);
    await page.waitForSelector(".agent-dock .agent-answer", { timeout: 15000 });
    check((await page.locator(".agent-dock .agent-question").last().innerText()).includes(`access token “${NAME}”`) &&
      (await page.locator(".agent-dock .agent-answer").last().innerText()).includes("A Lambda list, renamed."),
      "Its Building chat says who proposed it, and what");
    await page.screenshot({ path: `${SHOT}/smoke112-draft.png`, fullPage: true });

    // ---- 3. revoked, it stops at once
    await page.click('[aria-label="Account menu"]');
    await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
    await page.click(`.access-tokens .access-tokens-table tr:has-text("${NAME}") button:text-is("Revoke")`);
    await page.waitForSelector(`.access-tokens .access-tokens-table tr:has-text("${NAME}") .tag:text-is("Revoked")`);
    check((await mcp(token, "tools/list")).status === 401, "Revoked: /api/mcp refuses it at once");

    // ---- 4. a pane's first Python file brings requirements.txt
    await page.reload();
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    await page.click(".workspace-add");
    await page.fill("#builder-source-new-file", "helpers");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.workspace-tab.active[data-file="helpers.py"]');
    const tabs = await page.locator(".workspace-tab[data-file]").evaluateAll((els) => els.map((e) => e.getAttribute("data-file")));
    check(JSON.stringify(tabs) === '["pane.yaml","helpers.py","requirements.txt"]',
      "+ File: the first Python file brings requirements.txt with it", JSON.stringify(tabs));
    await page.click('.workspace-tab[data-file="requirements.txt"] .workspace-tab-name');
    check((await page.inputValue("#builder-source-file")).startsWith("# A package a line"), "…saying what goes in it");
  } finally {
    for (const d of (await page.evaluate(async () => (await fetch("/api/build-drafts")).json())) ?? []) {
      await page.evaluate(async (id) => fetch(`/api/build-drafts/${id}`, { method: "DELETE" }), d.id);
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
