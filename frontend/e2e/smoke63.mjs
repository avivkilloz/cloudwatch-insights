// Base64, Diff and JWT drawn from their manifests (PLATFORM_PLAN.md §15), and
// what was saved before they were:
//   - the live functions in the browser give the same answers as the old
//     tools did, on the fixtures the backend's Python twins are held to;
//   - each tool works as you type, as before;
//   - JWT's token and secrets never leave the tab;
//   - a template saved before the port (old keys) opens with its inputs;
//   - so does a session an old tab wrote after the deploy;
//   - a template saved now keeps the inputs (in.) and drops the results.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../backend/tests/fixtures/live_functions.json", import.meta.url));
const TEMPLATE = "e2e-before-the-port";

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
  for (const t of (await api(page, "GET", "/saved-sessions?page=aggregator")).body ?? [])
    if (t.name.startsWith("e2e-")) await api(page, "DELETE", `/saved-sessions/${t.id}`);
}

/** frontend/src/panes/live.ts, bundled for Node, against the shared fixtures. */
async function liveFunctionsAgree() {
  const out = join(mkdtempSync(join(tmpdir(), "live-")), "live.mjs");
  execFileSync(join(FRONTEND, "node_modules/.bin/esbuild"),
    ["src/panes/live.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${out}`, "--log-level=warning"],
    { cwd: FRONTEND });
  const { LIVE_FUNCTIONS } = await import(out);
  const { cases } = JSON.parse(readFileSync(FIXTURES, "utf8"));
  const wrong = [];
  for (const c of cases) {
    const got = await LIVE_FUNCTIONS[c.function](c.inputs);
    if (JSON.stringify(got) !== JSON.stringify(c.expected)) wrong.push({ ...c, got });
  }
  check(cases.length >= 20 && wrong.length === 0,
    `The browser's live functions answer all ${cases.length} fixtures as the old tools did`, JSON.stringify(wrong));
}

const run = async () => {
  await liveFunctionsAgree();

  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  await cleanUp(page);

  // ---- 1. the tools, as you type
  await newSession(page, "Base64");
  await page.locator(`${SHOWN} textarea`).first().fill("hello world");
  check((await page.locator(`${SHOWN} textarea`).nth(1).inputValue()) === "aGVsbG8gd29ybGQ=", "Base64 encodes as you type");
  await page.click(`${SHOWN} button:text-is("Decode")`);
  const titles = (await page.locator(`${SHOWN} .aggregator-pane-body .panel h2`).allInnerTexts()).join(",");
  check(titles === "Input,Text", "Decoding turns the output card into Text", titles);
  await page.locator(`${SHOWN} textarea`).first().fill("!!");
  check((await page.locator(`${SHOWN} .error-text`).innerText()) === "That doesn't look like valid Base64.", "Bad Base64 says so");

  await newSession(page, "Diff");
  check((await page.locator(`${SHOWN} .panel`).last().innerText()).includes("Paste text into both boxes above to see the diff."),
    "An empty diff says what to do");
  await page.locator(`${SHOWN} textarea`).nth(0).fill("a\nb\nc\n");
  await page.locator(`${SHOWN} textarea`).nth(1).fill("a\nB\nc\nd\n");
  await page.waitForSelector(`${SHOWN} .diff-output`);
  check((await page.locator(`${SHOWN} .panel`).last().innerText()).includes("1 removal, 2 additions"), "The diff counts its changes");
  check((await page.locator(`${SHOWN} .diff-line-add`).count()) === 2, "…and draws them");
  await page.selectOption(`${SHOWN} select:has(option[value=compact])`, "split");
  check((await page.locator(`${SHOWN} .diff-split-row`).count()) === 4, "Split view lays the lines side by side");

  await newSession(page, "JWT");
  await page.click(`${SHOWN} button:text-is("Encode")`);
  await page.locator(`${SHOWN} input[aria-label="Secret"]`).fill("e2e-s3cret");
  await page.click(`${SHOWN} button:text-is("Generate token")`);
  const signed = await page.locator(`${SHOWN} .panel:has(h2:text-is("Token")) pre`).innerText();
  check(signed.split(".").length === 3, "JWT signs a token", signed);
  await page.click(`${SHOWN} button:text-is("Decode")`);
  await page.fill(`${SHOWN} textarea[placeholder^="Paste a JWT"]`, signed);
  await page.fill(`${SHOWN} input[placeholder="Secret"]`, "e2e-s3cret");
  await page.waitForSelector(`${SHOWN} .tag.ok:text-is("✓ Valid signature")`);
  check(true, "…and verifies it with the same secret");
  await page.fill(`${SHOWN} input[placeholder="Secret"]`, "e2e-wrong");
  await page.waitForSelector(`${SHOWN} .tag.error:text-is("✗ Invalid signature")`);
  check(true, "…and not with another");
  await page.waitForTimeout(2000); // the debounced save
  const everything = JSON.stringify((await api(page, "GET", "/live-sessions")).body);
  check(!everything.includes("e2e-s3cret") && !everything.includes(signed.split(".")[2]),
    "Neither the secret nor the token reached the server");

  // ---- 2. a template saved before the port
  await clearWorkspace(page);
  await api(page, "POST", "/saved-sessions", {
    page: "aggregator",
    name: TEMPLATE,
    state: {
      services: ["tool-base64", "tool-diff~2"],
      paneTypes: { "tool-diff~2": "tool-diff" },
      layout: "stacked",
      "tool-base64.mode": "decode",
      "tool-base64.input": "aGVsbG8=",
      "tool-diff~2.left": "one\n",
      "tool-diff~2.right": "two\n",
      __savedStateVersion: 2,
    },
  });
  await page.reload();
  await page.click(`.rail-row-template:has(.rail-row-label:text-is("${TEMPLATE}"))`);
  await page.waitForSelector(`${SHOWN} .diff-output`);
  const boxes = page.locator(`${SHOWN} textarea`);
  check((await boxes.nth(0).inputValue()) === "aGVsbG8=" && (await boxes.nth(1).inputValue()) === "hello",
    "A template saved before the port opens with its Base64 input, decoded");
  check((await boxes.nth(2).inputValue()) === "one\n" && (await boxes.nth(3).inputValue()) === "two\n",
    "…and its second Diff pane's texts");
  await page.waitForTimeout(2000);
  const started = (await api(page, "GET", "/live-sessions")).body[0];
  check(started.state["tool-base64.in.input"] === "aGVsbG8=" && !("tool-base64.input" in started.state),
    "The session it started is saved in the new shape", JSON.stringify(Object.keys(started.state)));

  // ---- 3. a tab from before the deploy, writing old keys
  await clearWorkspace(page);
  const put = await api(page, "PUT", "/live-sessions/e2e-old-tab", {
    title: "Old tab", type: "aggregator", base_version: null,
    state: { services: ["tool-base64"], layout: "tabs", "tool-base64.mode": "encode", "tool-base64.input": "from an old tab" },
  });
  check(put.status === 200 && put.body.state["tool-base64.in.input"] === "from an old tab", "The server takes an old tab's keys in the new shape",
    JSON.stringify(put.body?.state));
  await page.reload();
  await page.click('.rail-row:has(.rail-row-label:text-is("Old tab"))');
  check((await page.locator(`${SHOWN} textarea`).first().inputValue()) === "from an old tab", "…and the session opens with its input");

  // ---- 4. saving a template now keeps the inputs, not the results
  page.once("dialog", (d) => d.accept(`${TEMPLATE}-now`));
  await page.locator(".rail-row.active .rail-row-more").click();
  await page.locator('.rail-row-menu button:text-is("Save as template…")').click();
  await page.waitForTimeout(1000);
  const saved = ((await api(page, "GET", "/saved-sessions?page=aggregator")).body ?? []).find((t) => t.name === `${TEMPLATE}-now`);
  check(saved?.state["tool-base64.in.input"] === "from an old tab" && !Object.keys(saved.state).some((k) => k.includes(".out.")),
    "A template saved from a ported pane keeps its inputs and no results", JSON.stringify(saved?.state));

  await clearWorkspace(page);
  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
