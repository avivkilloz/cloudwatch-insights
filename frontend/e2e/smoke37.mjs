// Closing a session used to eject it from its category into one flat list at
// the bottom of the rail. It now stays put, dimmed, so closing a session
// doesn't also un-group it.
import { SHOT, check, clearWorkspace, launch, newSession, openApp, report, ROW, CLOSED_ROW, TAB } from "./harness.mjs";

const CATEGORY_LABEL = (name) => `.rail-category-label:text-is("${name}")`;
const CATEGORY = (name) => `.rail-category:has(${CATEGORY_LABEL(name)})`;
const CATEGORY_HEADER = (name) => `.rail-category-header:has(${CATEGORY_LABEL(name)})`;
const CATEGORY_TOGGLE = (name) => `.rail-category-toggle:has(${CATEGORY_LABEL(name)})`;
const CATEGORY_SESSIONS = (name) => `${CATEGORY(name)} .rail-category-sessions`;

async function dragOnto(page, source, target) {
  const s = await source.boundingBox();
  const t = await target.boundingBox();
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 10 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);

  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  page.once("dialog", (d) => d.accept("Prod"));
  await page.click(".rail-category-add");
  await page.waitForSelector(CATEGORY_LABEL("Prod"), { timeout: 5000 });

  await newSession(page, "CloudWatch");
  await newSession(page, "Base64");

  await dragOnto(page, page.locator(ROW("CloudWatch")), page.locator(CATEGORY_HEADER("Prod")));
  const inCategory = await page.locator(`${CATEGORY_SESSIONS("Prod")} .rail-row-label:text-is("CloudWatch")`).count();
  check(inCategory === 1, "Dragging a session onto a category puts it inside", inCategory);

  // Close it -- still categorized -- and it should stay in the category, dimmed.
  await page.click(`${TAB("CloudWatch")} .session-tab-close`);
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${SHOT}/37-closed-in-category.png` });

  const closedInCategory = await page.locator(`${CATEGORY_SESSIONS("Prod")} ${CLOSED_ROW} .rail-row-label:text-is("CloudWatch")`).count();
  check(closedInCategory === 1, "Closing it keeps it inside the category, dimmed", closedInCategory);

  const closedOutsideCategory = await page.locator(`.rail > ${CLOSED_ROW} .rail-row-label:text-is("CloudWatch")`).count();
  check(closedOutsideCategory === 0, "…rather than dropping into a separate list at the bottom", closedOutsideCategory);

  // A collapsed category's count includes its closed sessions too.
  await page.click(CATEGORY_TOGGLE("Prod"));
  await page.waitForTimeout(200);
  const badge = (await page.locator(`${CATEGORY("Prod")} .rail-category-count`).innerText()).trim();
  check(badge === "1", "The collapsed category's count includes the closed session", badge);
  await page.screenshot({ path: `${SHOT}/37-collapsed-count.png` });
  await page.click(CATEGORY_TOGGLE("Prod"));

  // Reopening it works the same from inside the category.
  await page.click(`${CATEGORY_SESSIONS("Prod")} ${CLOSED_ROW} .rail-row-label:text-is("CloudWatch")`);
  await page.waitForTimeout(1000);
  const reopened = await page
    .locator(`${CATEGORY_SESSIONS("Prod")} .rail-row[data-session-id]:not(${CLOSED_ROW}):has(.rail-row-label:text-is("CloudWatch"))`)
    .count();
  check(reopened === 1, "Clicking a closed session inside its category reopens it there");

  // An uncategorized session closes the same way, at the top level.
  await page.click(`${TAB("Base64")} .session-tab-close`);
  await page.waitForTimeout(2200);
  const uncategorizedClosed = await page.locator(`.rail > ${CLOSED_ROW} .rail-row-label:text-is("Base64")`).count();
  check(uncategorizedClosed === 1, "An uncategorized closed session still shows at the top level, dimmed", uncategorizedClosed);

  // A category left behind here is quiet -- it doesn't break this suite on a
  // rerun (clearWorkspace clears it too), but it changes what every session's
  // ⋮ offers ("Move to Prod") for every suite that runs after this one until
  // something else happens to clear it.
  await page.evaluate(async () => {
    for (const c of await (await fetch("/api/session-categories", { credentials: "same-origin" })).json()) {
      await fetch(`/api/session-categories/${c.id}`, { method: "DELETE", credentials: "same-origin" });
    }
  });

  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
