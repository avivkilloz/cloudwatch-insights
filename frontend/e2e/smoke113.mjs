// Claude Code beside the user (D157; the user: "can I now work with claude
// code as my platform/session/builder agent ... help me build a pane while
// I'm looking at it?"). An MCP client with the user's access token:
//   - the session on screen is "here": get_context's on_screen and
//     viewing_session name it, and a pane added there appears in the open
//     session at once;
//   - with a new pane's editor open (no draft yet), open_draft(on_screen)
//     gives that editor a draft from a recipe -- the editor shows it, and says
//     by whom -- and every later change shows in the editor as it's made,
//     the user's own typing kept in the same draft;
//   - a proposal shows in the editor's Building chat, live.
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:5179";
const STAMP = Date.now();
const NAME = `Beside ${STAMP}`;
const DOCK = ".agent-dock";

async function mcp(token, method, params = {}) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function tool(token, name, args = {}) {
  const { status, body } = await mcp(token, "tools/call", { name, arguments: args });
  if (status !== 200 || body?.result?.isError) throw new Error(`${name}: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  return JSON.parse(body.result.content[0].text);
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

/** get_context, until what's on screen says what's wanted (a tab reports as it changes). */
async function screenUntil(token, ok) {
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = await tool(token, "get_context");
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());
  let tokenId = null;
  try {
    await clearWorkspace(page);
    const made = await api(page, "POST", "/access-tokens", { name: NAME, days: 30 });
    tokenId = made.body.id;
    const token = made.body.token;

    // ---- 1. the session on screen is "here"
    await api(page, "PUT", `/live-sessions/here${STAMP}`, { type: "aggregator", title: `Here ${STAMP}`, truncated: false, state: { services: [], layout: "stacked" } });
    await page.reload();
    await page.click(`.rail-row:has-text("Here ${STAMP}")`);
    const context = await screenUntil(token, (c) => c.on_screen?.[0]?.session_id === `here${STAMP}`);
    check(context.on_screen[0].session_id === `here${STAMP}` && context.on_screen[0].in_front === true,
      "get_context's on_screen: the session in front", JSON.stringify(context.on_screen));
    check(context.viewing_session?.session_id === `here${STAMP}`, "…and it's the viewing session: \"here\"");
    await tool(token, "add_pane", { session_id: context.viewing_session.session_id, kind: "tool-base64", title: "From Claude Code" });
    await page.waitForSelector('.session-body:not([hidden]) :text("From Claude Code")', { timeout: 10000 });
    check(true, "A pane added \"here\" appears in the open session at once");

    // ---- 2. building beside the user: the open editor takes the draft
    await page.evaluate(() => {
      localStorage.setItem("cwi-agent-open", "open");
      localStorage.setItem("cwi-agent-layout", "dock");
    });
    await page.reload();
    await page.waitForSelector(DOCK);
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    const builderScreen = await screenUntil(token, (c) => c.on_screen?.[0]?.view === "builder");
    check(builderScreen.on_screen[0].kind === "pane" && builderScreen.on_screen[0].draft_id === null,
      "A new pane's editor is on screen, with no draft yet", JSON.stringify(builderScreen.on_screen[0]));

    const opened = await tool(token, "open_draft", { on_screen: true, start_from: "recipe:rows-that-open" });
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("label: Lambda functions"), null, { timeout: 10000 });
    check(true, "open_draft(on_screen): the open editor shows the recipe at once");
    const status = await page.locator(".builder-draft-status").innerText();
    check(status.includes(`Changed by “${NAME}”`), "…and says who changed it", status);
    const nowShown = await screenUntil(token, (c) => c.on_screen?.[0]?.draft_id === opened.draft_id);
    check(nowShown.on_screen[0].draft_id === opened.draft_id, "…the editor now reports that draft as on screen");
    await page.screenshot({ path: `${SHOT}/smoke113-taken.png`, fullPage: true });

    // ---- 3. every change shows as it's made; the user's own typing is kept
    const lines = (await tool(token, "read_draft", { draft_id: opened.draft_id })).text.split("\n");
    const at = Number(lines.find((l) => /^\d+: label: /.test(l)).split(":")[0]);
    await tool(token, "change_definition", { draft_id: opened.draft_id, changes: [{ op: "lines", from: at, to: at, text: "label: Lambdas, live" }] });
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("label: Lambdas, live"), null, { timeout: 10000 });
    check(true, "Claude's change shows in the editor as it's made");

    const typed = (await page.inputValue("#builder-source")).replace(/^description: .*$/m, "description: Typed by the user.");
    await page.fill("#builder-source", typed);
    await page.waitForSelector('.builder-draft-status:has-text("Draft saved")', { timeout: 10000 });
    const after = (await tool(token, "read_draft", { draft_id: opened.draft_id })).text;
    check(after.includes("description: Typed by the user.") && after.includes("label: Lambdas, live"),
      "The user's typing lands in the same draft, beside Claude's change");
    await tool(token, "change_definition", { draft_id: opened.draft_id, changes: [{ op: "set", path: "category", value: "Tools" }] });
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("category: Tools"), null, { timeout: 10000 });
    const both = await page.inputValue("#builder-source");
    check(both.includes("description: Typed by the user.") && both.includes("label: Lambdas, live"),
      "…and Claude's next change shows on top of it, nothing lost");

    // ---- 4. a proposal shows in the Building chat, live
    await tool(token, "propose_definition", { draft_id: opened.draft_id, summary: "Lambdas, renamed and filed under Tools." });
    await page.waitForSelector(`${DOCK} .agent-answer:has-text("Lambdas, renamed and filed under Tools.")`, { timeout: 10000 });
    check((await page.locator(`${DOCK} .agent-question`).last().innerText()).includes(`access token “${NAME}”`),
      "The proposal shows in the editor's Building chat as it's made");
    await page.screenshot({ path: `${SHOT}/smoke113-live.png`, fullPage: true });
    const types = await api(page, "GET", "/builder/panes");
    check(!types.body.some((t) => t.label === "Lambdas, live"), "…and nothing is saved: Save is the user's");
  } finally {
    if (tokenId) await api(page, "DELETE", `/access-tokens/${tokenId}`);
    for (const d of (await api(page, "GET", "/build-drafts")).body ?? []) await api(page, "DELETE", `/build-drafts/${d.id}`);
    await clearWorkspace(page);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
