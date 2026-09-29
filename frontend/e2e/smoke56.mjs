// MarkdownLite required a blank line around a table or heading to recognize
// it at all -- only lines[0]/lines.length === 1 of a whole blank-line block
// were ever checked. A real model rarely puts that blank line in reliably
// ("Here's what I found:\n| Name |..." or "### Summary\nDetails"), so a
// table or heading landing mid-block fell through to one literal paragraph,
// "|" and "###" shown as plain text. Needs the agent + fake model running
// ("markdown", dev/fake_llm.py's own script for exactly this shape).
import { check, clearWorkspace, openApp, launch, report } from "./harness.mjs";

const DOCK = ".agent-dock";

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(".rail");
  await page.waitForSelector(DOCK);

  await page.fill(`${DOCK} .agent-compose-input`, "markdown");
  await page.click(`${DOCK} button:text-is("Ask")`);
  await page.waitForTimeout(2000);

  const tableCount = await page.locator(`${DOCK} .agent-transcript table`).count();
  check(tableCount === 1, "A table with no blank line before it still renders as a real <table>", String(tableCount));
  if (tableCount === 1) {
    const headerCells = await page.locator(`${DOCK} .agent-transcript table th`).allInnerTexts();
    check(headerCells.join(",") === "Thing Name,Connected", "…with the right header cells", JSON.stringify(headerCells));
    const rowCount = await page.locator(`${DOCK} .agent-transcript table tbody tr`).count();
    check(rowCount === 2, "…and both data rows", String(rowCount));
  }

  const transcriptText = await page.locator(`${DOCK} .agent-transcript`).innerText();
  check(!transcriptText.includes("### Summary"), "A heading with no blank line after it doesn't show literal ### text",
    transcriptText);
  const headingEls = await page.locator(`${DOCK} .agent-transcript div`).filter({ hasText: "Summary" }).count();
  check(headingEls > 0, "…and renders as a real heading element", String(headingEls));
  check(transcriptText.includes("One of two is connected"), "…and the prose right after it still shows up",
    transcriptText);

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
