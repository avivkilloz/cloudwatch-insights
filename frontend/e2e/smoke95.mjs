// A pane type for an AWS service no handler covers, made in the Builder (D110),
// as an admin, against the faked backend's AWS requests (accounts starting
// "0000"):
//   - Lambda functions, as the agent's build_reference shows it: Check finds
//     nothing wrong; a write (Invoke) is named as one, with its line;
//   - its YAML may name it by the Id typed above (no "Its id is …");
//   - created and opened in a session, List runs ListFunctions on each ticked
//     environment as the caller: one table, an Environment column first, and
//     the environment that failed said apart, not failing the rest.
import { check, clearWorkspace, launch, openApp, report, SHOWN, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const NAME = `lambdas_${STAMP}`;
const LABEL = `Lambda functions ${STAMP}`;
const SECOND = `e2e-fake-aws-2-${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const SOURCE = `id: ${NAME}
label: ${LABEL}
description: The Lambda functions in each environment.
category: Services
inputs:
  - key: connections
    type: connections
    connection_type: aws
    label: Environments
actions:
  - id: list
    main: true
    run_label: List
    request:
      connection: connections
      service: lambda
      operation: ListFunctions
      paginate: true
      rows:
        at: Functions
        columns:
          Name: FunctionName
          Runtime: Runtime
          Memory: {from: MemorySize, as: number}
outputs:
  - key: rows
    render: table
    actions: [select, copy, export, attach]
  - key: error
    render: error
layout:
  - title: Functions
    items:
      - input: connections
      - toolbar:
          - action: list
      - output: error
      - output: rows
`;

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const second = (await api(page, "POST", "/environments", { name: SECOND, account_id: "000000000002", region: "eu-west-1" })).body;
  // The first account lists two functions; the second has nothing faked, so it's denied.
  await api(page, "PUT", "/dev/fake-aws?service=lambda&operation=ListFunctions&account=000000000001", {
    Functions: [
      { FunctionName: "orders", Runtime: "python3.12", MemorySize: 256 },
      { FunctionName: "billing", Runtime: "nodejs20.x", MemorySize: 512 },
    ],
  });
  let made = null;
  try {
    // ---- 1. written in the Builder, checked
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");
    await page.fill("#builder-id", NAME);
    const ns = (await api(page, "GET", "/builder/schema")).body.namespace;
    if (ns) {
      const said = await page.locator(".builder-saved-as").innerText();
      check(said.includes(`${ns}:${NAME}`), "With a store, the Id says what it's saved as", said);
    }
    await page.fill("#builder-source", SOURCE.replace("operation: ListFunctions", "operation: Invoke"));
    await page.click('.builder-view button:text-is("Check")');
    const problem = await page.locator(".builder-problems li").first().innerText({ timeout: 5000 });
    check(problem.includes("Invoke changes something") && problem.startsWith("Line "), "A write is refused, with its line", problem);
    await page.fill("#builder-source", SOURCE);
    await page.click('.builder-view button:text-is("Check")');
    await page.waitForSelector('.builder-notice:text-is("No problems found.")', { timeout: 5000 });
    check(true, "Any AWS read API checks clean, and the YAML may name it by the Id above");

    // ---- 2. created, opened, run on two environments
    await page.click('.builder-view button:text-is("Create")');
    await page.waitForSelector('.builder-notice:has-text("your group can use it now")', { timeout: 10000 });
    made = (await api(page, "GET", "/builder/panes")).body.find((t) => t.label === LABEL);
    await page.click('.builder-view button:text-is("Open in a session")');
    await page.waitForSelector(`${SHOWN} .aggregator-tab-label:text-is("${LABEL}")`, { timeout: 10000 });
    for (const name of ["e2e-fake-aws", SECOND]) {
      await page.locator(`${SHOWN} .checkbox-item`, { hasText: `${name} (` }).locator("input").check();
    }
    await page.click(`${SHOWN} button:text-is("List")`);
    await page.waitForSelector(`${SHOWN} .manifest-table tbody tr`, { timeout: 15000 });
    const head = await page.locator(`${SHOWN} .manifest-table thead th`).allInnerTexts();
    const cells = await page.locator(`${SHOWN} .manifest-table tbody tr`).first().locator("td").allInnerTexts();
    check(head.filter((h) => h.trim()).join(",").startsWith("Environment,Name,Runtime,Memory"), "One table, Environment first", JSON.stringify(head));
    check(cells.some((c) => c === "e2e-fake-aws") && cells.some((c) => c === "orders"), "…the functions it listed there", JSON.stringify(cells));
    check((await page.locator(`${SHOWN} .manifest-table tbody tr`).count()) === 2, "…both of them");
    const error = await page.locator(`${SHOWN} .aggregator-pane:not([hidden]) .error-text`).first().innerText();
    check(error.startsWith(`${SECOND}:`) && error.includes("AccessDenied"), "The environment that failed is said apart", error);
    await page.screenshot({ path: `${SHOT}/smoke95-lambdas.png` });
  } finally {
    await clearWorkspace(page);
    if (made) await api(page, "DELETE", `/builder/panes/${encodeURIComponent(made.id)}`);
    await api(page, "DELETE", `/environments/${second.id}`);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
