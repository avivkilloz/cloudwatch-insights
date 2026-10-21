// The Builder's preview (5-2c, D112) and which handlers a builder may name
// (D113), as a member of a builder group granted Base64 alone, against the
// faked backend's AWS requests (accounts starting "0000"):
//   - Preview draws the draft as the pane it makes, beside the editor; its
//     List runs as the builder on a real (faked) connection and fills the
//     preview's table -- nothing saved, no session made;
//   - typing after it says the preview is of an older text;
//   - a draft naming DynamoDB's scan handler, which their group wasn't
//     granted, is refused by Check and Preview with its line, and the
//     handlers the editor lists leave it out.
import { check, clearWorkspace, launch, newPage, openApp, report, signIn, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const USER = `prv${STAMP}`;
const LABEL = `Functions ${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const LAMBDA = `label: ${LABEL}
description: The Lambda functions in an environment.
inputs:
  - key: connection
    type: connection
    connection_type: aws
    label: Environment
actions:
  - id: list
    main: true
    run_label: List
    request:
      connection: connection
      service: lambda
      operation: ListFunctions
      rows:
        at: Functions
        columns:
          Name: FunctionName
          Runtime: Runtime
outputs:
  - key: rows
    render: table
layout:
  - title: Functions
    items:
      - input: connection
      - toolbar:
          - action: list
      - output: rows
`;

const BASE64 = `label: Shouty ${STAMP}
inputs:
  - key: input
    type: text
    label: Text
    default: ""
actions:
  - id: convert
    live: base64.convert
outputs:
  - key: output
    render: code
layout:
  - title: Input
    items:
      - input: input
  - title: Base64
    items:
      - output: output
`;

const SCAN = `label: Table peek ${STAMP}
inputs:
  - key: connection
    type: connection
    connection_type: aws
  - key: tableName
    type: text
actions:
  - id: scan
    main: true
    handler: aws.dynamodb.scan
outputs:
  - key: items
    render: json
layout:
  - title: Peek
    items:
      - input: connection
      - output: items
`;

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  admin.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  let env = (await api(admin, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(admin, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  await api(admin, "PUT", "/dev/fake-aws?service=lambda&operation=ListFunctions&account=000000000001", {
    Functions: [{ FunctionName: "orders", Runtime: "python3.12" }],
  });
  const group = (await api(admin, "POST", "/user-groups", {
    name: `g-${USER}`, role_name: "R", environment_ids: [env.id], pane_types: ["tool-base64"], builder_enabled: true,
  })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: group.id });
  const page = await newPage(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  try {
    await signIn(page, { username: USER, password: "pw-123456" });
    await clearWorkspace(page);
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("label:"));

    // ---- 1. the draft, drawn and run
    await page.fill("#builder-source", LAMBDA);
    await page.click('.builder-view button:text-is("Preview")');
    await page.waitForSelector(".builder-preview .panel, .builder-preview .card, .builder-preview h3", { timeout: 10000 });
    const drawn = await page.locator(".builder-preview").innerText();
    check(drawn.includes("Functions") && drawn.includes("List"), "Preview draws the draft as the pane it makes", drawn.slice(0, 120));
    const sideBySide = await page.evaluate(() => {
      const [a, b] = [...document.querySelectorAll(".builder-columns > *")].map((e) => e.getBoundingClientRect());
      return a && b ? Math.abs(a.top - b.top) < 4 && b.left > a.right - 1 : false;
    });
    check(sideBySide, "…beside the editor, where there's room");
    await page.selectOption(".builder-preview select", { label: "e2e-fake-aws" }).catch(async () => {
      await page.locator(".builder-preview select").first().selectOption({ index: 1 });
    });
    await page.click('.builder-preview button:text-is("List")');
    await page.waitForSelector(".builder-preview .manifest-table tbody tr", { timeout: 10000 });
    const cells = await page.locator(".builder-preview .manifest-table tbody tr").first().locator("td").allInnerTexts();
    check(cells.includes("orders") && cells.includes("python3.12"), "Its List runs as the builder on the connection, filling its table", JSON.stringify(cells));
    await page.screenshot({ path: `${SHOT}/smoke96-preview.png` });
    check((await api(page, "GET", "/builder/panes")).body.length === 0, "…with nothing saved");
    check((await api(page, "GET", "/live-sessions")).body.length === 0, "…and no session made");

    await page.fill("#builder-source", LAMBDA.replace(LABEL, `${LABEL} v2`));
    await page.waitForSelector(".builder-preview-stale");
    check(true, "Typing after it says the preview is of an older text");

    // ---- 1b. a live function is worked out as you type, in the preview too
    await page.fill("#builder-source", BASE64);
    await page.click(".builder-preview-redraw");
    await page.waitForFunction(() => !document.querySelector(".builder-preview-stale"));
    await page.locator(".builder-preview textarea, .builder-preview input[type=text]").first().fill("hi");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".builder-preview pre, .builder-preview textarea")].some((e) => (e.value ?? e.textContent ?? "").includes("aGk=")),
      undefined,
      { timeout: 5000 },
    );
    check(true, "A live function runs in the preview as you type");

    // ---- 2. a handler of a pane their group wasn't given
    const listed = await page.locator('.session-card-row:has(.session-card-label:text-is("Handlers")) .builder-names').innerText();
    check(!listed.includes("aws.dynamodb"), "The handlers listed are theirs to use: no DynamoDB", listed.slice(0, 120));
    await page.fill("#builder-source", SCAN);
    await page.click('.builder-view button:text-is("Check")');
    const problem = await page.locator(".builder-problems li").first().innerText({ timeout: 5000 });
    check(problem.startsWith("Line 11:") && problem.includes("can't use the handler aws.dynamodb.scan") && problem.includes("DynamoDB"),
      "A handler of a pane their group wasn't granted is refused, with its line", problem);
    await page.click(".builder-preview-redraw");
    await page.waitForTimeout(500);
    const after = await page.locator(".builder-problems li").first().innerText();
    check(after.includes("aws.dynamodb.scan") && (await page.locator(".builder-preview-stale").count()) === 1,
      "…and isn't previewed: the last good preview stays, marked as older");
  } finally {
    await clearWorkspace(page).catch(() => undefined);
    await page.close();
    for (const u of (await api(admin, "GET", "/users")).body.filter((u) => u.username === USER)) await api(admin, "DELETE", `/users/${u.id}`);
    await api(admin, "DELETE", `/user-groups/${group.id}`);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
