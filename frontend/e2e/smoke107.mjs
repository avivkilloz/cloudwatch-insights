// The Builder's editor (the user's asks after #141):
//   - a file is added from a "+" that is the last of the editor's tabs, named
//     in a tab of its own (Esc, or leaving it empty, cancels) -- not a
//     "+ File" button beside the tabs;
//   - the Preview card is there only while Preview is on: the editor has the
//     whole width until Preview is pressed, Preview again closes it, and a
//     drawing the definition has moved on from offers "Draw again".
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const PANE = `label: Shout
inputs:
  - {key: mode, type: choice, choices: [encode, decode], default: encode}
  - {key: input, type: text, rows: 3, default: ""}
actions:
  - {id: convert, live: base64.convert}
outputs:
  - {key: output, render: code}
layout:
  - title: Shout
    items:
      - input: input
      - output: output
`;

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());
  try {
    await clearWorkspace(page);
    await page.click('.rail-row-page:has-text("Builder")');
    await page.click('.builder-list button:text-is("New pane")');
    await page.waitForSelector("#builder-source");

    // ---- 1. "+" is a tab
    check((await page.locator('.workspace button:has-text("+ File")').count()) === 0, 'No "+ File" button beside the tabs');
    const tabs = await page.locator(".workspace-tabs > *").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-file") ?? (e.classList.contains("workspace-tab-add") ? "+" : e.className)));
    check(JSON.stringify(tabs) === '["pane.yaml","+"]', '"+" is the last of the tabs', JSON.stringify(tabs));
    const [yamlTab, plusTab] = await Promise.all([
      page.locator('.workspace-tab[data-file="pane.yaml"]').boundingBox(),
      page.locator(".workspace-tab-add").boundingBox(),
    ]);
    check(Math.abs(yamlTab.y + yamlTab.height - (plusTab.y + plusTab.height)) <= 1 && plusTab.height <= yamlTab.height + 1,
      "…sitting on the tabs' line, no taller than a tab", JSON.stringify({ yamlTab, plusTab }));
    await page.click(".workspace-add");
    await page.waitForSelector(".workspace-naming input:focus");
    check((await page.locator(".workspace-tab.workspace-naming").count()) === 1, "Pressed, the new file is named in a tab of its own");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".workspace-tab-add");
    check((await page.locator(".workspace-naming").count()) === 0, "…Esc cancels it");
    await page.click(".workspace-add");
    await page.fill(".workspace-naming input", "helpers");
    await page.keyboard.press("Enter");
    await page.waitForSelector('.workspace-tab.active[data-file="helpers.py"]');
    const after = await page.locator(".workspace-tabs > *").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-file") ?? (e.classList.contains("workspace-tab-add") ? "+" : e.className)));
    check(JSON.stringify(after) === '["pane.yaml","helpers.py","+"]', "…Enter adds it, and + stays last", JSON.stringify(after));
    await page.click('.workspace-tab[data-file="helpers.py"] .workspace-tab-close');
    await page.click('.workspace-tab[data-file="pane.yaml"] .workspace-tab-name');

    // ---- 2. Preview toggles its card
    await page.fill("#builder-source", PANE);
    const columns = await page.locator(".builder-columns").boundingBox();
    const sections = () => page.locator(".builder-columns > .session-card-section").count();
    check((await sections()) === 1, "Until Preview is pressed there's no Preview card");
    const editor = await page.locator(".builder-columns > .session-card-section").first().boundingBox();
    check(Math.abs(editor.width - columns.width) <= 1, "…and the editor has the whole width", `${editor.width} of ${columns.width}`);
    await page.screenshot({ path: `${SHOT}/smoke107-closed.png`, fullPage: true });
    await page.click('.builder-view button:text-is("Preview")');
    await page.waitForSelector(".builder-preview textarea");
    check((await sections()) === 2 && (await page.locator(".builder-preview-toggle").getAttribute("aria-pressed")) === "true",
      "Preview opens its card beside the editor, the button pressed");
    await page.screenshot({ path: `${SHOT}/smoke107-open.png`, fullPage: true });
    await page.fill("#builder-source", PANE.replace("label: Shout", "label: Shout louder"));
    await page.waitForSelector(".builder-preview-stale .builder-preview-redraw");
    await page.click(".builder-preview-redraw");
    await page.waitForFunction(() => !document.querySelector(".builder-preview-stale"));
    check((await sections()) === 2, "A drawing the definition moved on from is drawn again from its own link");
    await page.click('.builder-view button:text-is("Preview")');
    await page.waitForFunction(() => document.querySelectorAll(".builder-columns > .session-card-section").length === 1);
    check((await page.locator(".builder-preview-toggle").getAttribute("aria-pressed")) === "false", "Preview again closes it");
    const wide = await page.locator(".builder-columns > .session-card-section").first().boundingBox();
    check(Math.abs(wide.width - columns.width) <= 1, "…and the editor has the width back");
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
