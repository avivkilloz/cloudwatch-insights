// Two reports after 5-2, as an admin:
//   - the agent panel's second tab is there only while it's about something:
//     on the default page (no session, run or editor on screen) the panel is
//     Global alone, its chat usable; opening a session brings Session back,
//     selected;
//   - a catalogue category says what it is: Settings → Catalogue takes a
//     description with a new category and edits it with its name; the default
//     page shows it under the heading; and a category without one keeps the
//     same space before its cards as the others (its heading sat on them).
import { check, clearWorkspace, launch, newSession, openApp, report, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const DOCK = ".agent-dock";
const SETTINGS = ".catalogue-settings";
const CATEGORY = (name) => `${SETTINGS} [data-category="${name}"]`;
const DESCRIBED = `Described ${STAMP}`;
const BARE = `Bare ${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function openCatalogue(page) {
  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.click('.content .settings-tabs button:text-is("Catalogue")');
  await page.waitForSelector(`${SETTINGS} .catalogue-pane`);
}

async function addCategory(page, name, description) {
  await page.click(`${SETTINGS} button:text-is("New category")`);
  await page.fill('[aria-label="New category name"]', name);
  if (description) await page.fill('[aria-label="New category description"]', description);
  await page.click(`${SETTINGS} .catalogue-new button:text-is("Add")`);
  await page.waitForSelector(CATEGORY(name));
}

/** Pixels between what's above a category's cards (its description, or its
 * heading when it has none) and the cards. */
const gapAbove = (page, name) =>
  page.evaluate((name) => {
    const box = document.querySelector(`.home [data-category="${name}"]`);
    const above = box.querySelector(".home-group-blurb") ?? box.querySelector("h3");
    return Math.round(box.querySelector(".home-cards").getBoundingClientRect().top - above.getBoundingClientRect().bottom);
  }, name);

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  const original = (await api(page, "GET", "/catalogue")).body;
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(DOCK);
  const tabs = () => page.locator(`${DOCK} .agent-tab`).allInnerTexts();

  try {
    // ---- 1. the second tab only while it's about something
    await page.click(".rail-row-home");
    await page.waitForSelector(".home-create");
    check(JSON.stringify(await tabs()) === '["Global"]', "With no session on screen, the panel is Global alone", JSON.stringify(await tabs()));
    check(
      (await page.locator(`${DOCK} .error-text`).count()) === 0 && !(await page.locator(`${DOCK} .agent-compose-input`).isDisabled()),
      "…and its chat is usable, not \"Open a session…\"",
    );
    await newSession(page, "Base64");
    await page.waitForFunction(() => document.querySelectorAll(".agent-dock .agent-tab").length === 2);
    check((await page.locator(`${DOCK} .agent-tab.active`).innerText()).startsWith("Session"), "Opening a session brings the Session tab back, selected");
    await page.click(".rail-row-home");
    await page.waitForFunction(() => document.querySelectorAll(".agent-dock .agent-tab").length === 1);
    check(true, "…and leaving it for the default page takes it away again");

    // ---- 2. a category says what it is
    await openCatalogue(page);
    await addCategory(page, DESCRIBED, "Panes for the night shift.");
    await addCategory(page, BARE);
    check(
      (await page.locator(`${CATEGORY(DESCRIBED)} .catalogue-description`).innerText()) === "Panes for the night shift.",
      "A new category takes a description, shown in Settings under its name",
    );
    await page.selectOption(`${SETTINGS} [aria-label="Category for JWT"]`, { label: DESCRIBED });
    await page.waitForSelector(`${CATEGORY(DESCRIBED)} [data-pane-type="tool-jwt"]`);
    await page.selectOption(`${SETTINGS} [aria-label="Category for Diff"]`, { label: BARE });
    await page.waitForSelector(`${CATEGORY(BARE)} [data-pane-type="tool-diff"]`);

    await page.click(".rail-row-home");
    await page.waitForSelector(`.home [data-category="${BARE}"]`);
    const shown = await page.locator(`.home [data-category="${DESCRIBED}"] .home-group-blurb`).innerText();
    check(shown === "Panes for the night shift.", "The default page shows it under the heading", shown);
    const described = await gapAbove(page, DESCRIBED);
    const bare = await gapAbove(page, BARE);
    check(bare >= 10 && Math.abs(bare - described) <= 2, "A category without one keeps the same space before its cards", `${bare}px vs ${described}px`);
    const services = await page.locator('.home [data-category="Services"] .home-group-blurb').innerText();
    check(services.startsWith("A window onto an AWS service"), "The built-in categories keep theirs", services);
    await page.screenshot({ path: `${SHOT}/smoke94-home.png`, fullPage: true });

    await openCatalogue(page);
    await page.click(`${SETTINGS} [aria-label="Edit ${BARE}"]`);
    await page.fill('[aria-label="Category description"]', "Comparing things.");
    await page.click(`${CATEGORY(BARE)} .catalogue-inline button:text-is("Save")`);
    await page.waitForSelector(`${CATEGORY(BARE)} .catalogue-description:text-is("Comparing things.")`);
    check(true, "Edit changes its description with its name");
  } finally {
    // The catalogue as it was found, for the suites after this one.
    const now = (await api(page, "GET", "/catalogue")).body;
    await api(page, "PUT", "/catalogue/layout", { categories: original.categories.map((c) => ({ id: c.id, pane_types: c.pane_types })) });
    const keep = original.categories[0].id;
    for (const c of now.categories.filter((c) => c.name === DESCRIBED || c.name === BARE)) {
      await api(page, "DELETE", `/catalogue/categories/${c.id}?move_to=${keep}`);
    }
    await api(page, "PUT", "/catalogue/layout", { categories: original.categories.map((c) => ({ id: c.id, pane_types: c.pane_types })) });
    await clearWorkspace(page);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
