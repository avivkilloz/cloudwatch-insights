// The Builder's form (5-2d, D115), as an admin, over the starter:
//   - Edit as: Form shows the same definition the YAML holds -- its inputs,
//     actions, outputs and cards;
//   - a label typed, an input renamed (the request and the layout that name it
//     follow), an output and a card added, a card moved: back in the YAML,
//     only those lines changed -- the starter's comments and its inline
//     mappings exactly as they were;
//   - the result checks clean and previews; YAML that doesn't parse says so in
//     the form rather than losing anything.
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const SECTION = (title) => `.builder-form-section:has(h4:text-is("${title}"))`;
const FIELD = (scope, label) => `${scope} label.builder-form-field:has(> span:text-is("${label}")) input`;

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  await page.click('.rail-row-page:has-text("Builder")');
  await page.click('.builder-list button:text-is("New pane")');
  await page.waitForFunction(() => document.querySelector("#builder-source")?.value.includes("label: Service status"));
  const before = await page.inputValue("#builder-source");

  // ---- 1. the same definition, as a form
  await page.click('.builder-view .segmented button:text-is("Form")');
  await page.waitForSelector(".builder-form");
  const keys = await page.locator(`${SECTION("Inputs")} label.builder-form-field:has(> span:text-is("Key")) input`).evaluateAll((els) => els.map((e) => e.value));
  check(JSON.stringify(keys) === '["connection","path"]', "The form shows the YAML's inputs", JSON.stringify(keys));
  const runs = await page.locator(`${SECTION("Actions")} label.builder-form-field:has(> span:text-is("Runs")) select`).inputValue();
  check(runs === "http", "…and that its action is an HTTP request", runs);

  // ---- 2. edits
  await page.locator(FIELD(SECTION("About"), "Label")).first().fill(`Form built ${STAMP}`);
  await page.locator(`${SECTION("Inputs")} .builder-form-item`).nth(1).locator('label.builder-form-field:has(> span:text-is("Key")) input').fill("route");
  await page.click(`${SECTION("Outputs")} button:text-is("+ Output")`);
  await page.click(`${SECTION("Layout")} button:text-is("+ Card")`);
  await page.locator(`${SECTION("Layout")} .builder-form-item`).nth(2).locator("select").last().selectOption("output:output2");
  // The Status card above the Service one.
  await page.locator(`${SECTION("Layout")} .builder-form-item`).nth(1).locator('button[aria-label="Move up"]').click();
  await page.screenshot({ path: `${SHOT}/smoke97-form.png`, fullPage: true });

  // ---- 3. back in the YAML: only what changed
  await page.click('.builder-view .segmented button:text-is("YAML")');
  const after = await page.inputValue("#builder-source");
  check(after.startsWith(before.split("\n").slice(0, 2).join("\n")), "The starter's comments are kept", after.slice(0, 90));
  check(after.includes(`label: Form built ${STAMP}\n`), "The label typed is there");
  check(after.includes("request: { method: GET, connection: connection, path: route }"),
    "The renamed input is renamed in the request too, its inline mapping kept as written", after.match(/request:.*/)?.[0]);
  check(/- input: route\n/.test(after) && !/- input: path\n/.test(after), "…and in the layout");
  check(after.includes("when: { output: response, present: true }"), "Lines not touched are as they were");
  check(after.includes("  - key: output2\n    render: table\n"), "The output added is there");
  check(/title: Card 3\n\s+items:\n\s+- output: output2/.test(after), "…and the card added, holding it", after.slice(-120));
  check(after.indexOf("title: Status") < after.indexOf("title: Service"), "A card moved up is moved");
  const changed = (() => {
    const a = new Set(before.split("\n"));
    return after.split("\n").filter((l) => !a.has(l)).length;
  })();
  check(changed <= 10, "…and nothing else changed", `${changed} new or changed lines`);

  // ---- 4. it's a working pane type
  await page.click('.builder-view button:text-is("Check")');
  await page.waitForSelector('.builder-notice:text-is("No problems found.")', { timeout: 5000 });
  check(true, "What the form made checks clean");
  await page.click('.builder-view button:text-is("Preview")');
  await page.waitForSelector(".builder-preview h3, .builder-preview .card-title", { timeout: 10000 }).catch(() => undefined);
  const drawn = await page.locator(".builder-preview").innerText();
  // The Status card shows only once there's a response (its `when`).
  check(drawn.includes("Service") && drawn.includes("Path") && !drawn.includes("Status"), "…and previews", drawn.slice(0, 80));

  // ---- 5. YAML that doesn't parse
  await page.fill("#builder-source", after + "\n  - : [\n");
  await page.click('.builder-view .segmented button:text-is("Form")');
  const said = await page.locator(".builder-form-unreadable").innerText();
  check(said.includes("doesn't read as YAML"), "YAML that doesn't parse: the form says so and changes nothing", said.slice(0, 80));

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
