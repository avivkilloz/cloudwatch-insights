// 3d-2: the catalogue with categories (D66, PLATFORM_PLAN.md §19.2), driven as
// an admin and a member would:
//   - Settings → Catalogue: a new category, a pane moved into it, the category
//     moved first, renamed -- and every list of panes follows: the default
//     page, the side panel's Add list, a session's card;
//   - a member sees only the panes their group may use, under the same
//     categories; starring one puts it first in their lists as Favourites,
//     hiding one leaves it out until "Show hidden";
//   - deleting a category moves its panes to the one chosen.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, SHOWN, signIn } from "./harness.mjs";

const USER = `catalogue${Date.now()}`;
const SETTINGS = ".catalogue-settings";
const CATEGORY = (name) => `${SETTINGS} [data-category="${name}"]`;

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

const railHeadings = (page) => page.locator(".rail .rail-heading").allInnerTexts();
const railUnder = (page, heading) =>
  page.evaluate((h) => {
    const out = [];
    for (const head of document.querySelectorAll(".rail .rail-heading")) {
      if (head.textContent.trim().toUpperCase() !== h.toUpperCase()) continue;
      for (const b of head.parentElement.querySelectorAll(".rail-row-type .rail-row-label")) out.push(b.textContent.trim());
    }
    return out;
  }, heading);
const homeHeadings = (page) => page.locator(".home h3").allInnerTexts();

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  const original = (await api(page, "GET", "/catalogue")).body;

  // ---- 1. an admin arranges it
  await openCatalogue(page);
  await page.click(`${SETTINGS} button:text-is("New category")`);
  await page.fill('[aria-label="New category name"]', "Debugging");
  await page.click(`${SETTINGS} .catalogue-new button:text-is("Add")`);
  await page.waitForSelector(CATEGORY("Debugging"));
  check((await page.locator(`${CATEGORY("Debugging")} .catalogue-empty`).count()) === 1, "A new category starts empty, saying how to fill it");
  await page.selectOption(`${SETTINGS} [aria-label="Category for JWT"]`, { label: "Debugging" });
  await page.waitForSelector(`${CATEGORY("Debugging")} [data-pane-type="tool-jwt"]`);
  check((await page.locator(`${CATEGORY("Tools")} [data-pane-type="tool-jwt"]`).count()) === 0, "A pane moves to the category chosen for it");
  // Up until it's first (a pane's own category, Observability, may be there too).
  const categoryOrder = () => page.locator(`${SETTINGS} [data-category]`).evaluateAll((els) => els.map((e) => e.dataset.category));
  for (let i = 0; i < 6 && (await categoryOrder())[0] !== "Debugging"; i++) {
    await page.click(`${SETTINGS} [aria-label="Move Debugging up"]`);
    await page.waitForTimeout(500);
  }
  const order = await page.locator(`${SETTINGS} [data-category]`).evaluateAll((els) => els.map((e) => e.dataset.category));
  check(order[0] === "Debugging", "A category moves up", JSON.stringify(order));
  await page.click(`${SETTINGS} [aria-label="Edit Debugging"]`);
  await page.fill('[aria-label="Category name"]', "Security");
  await page.click(`${SETTINGS} .catalogue-inline button:text-is("Save")`);
  await page.waitForSelector(CATEGORY("Security"));
  check(true, "Renamed");

  // Every list follows.
  await page.click(".rail-row-home");
  await page.waitForSelector(".home h3");
  const homes = (await homeHeadings(page)).map((h) => h.trim().toUpperCase());
  check(homes[0] === "SECURITY" && homes.includes("SERVICES"), "The default page goes by the catalogue's order", JSON.stringify(homes));
  check(JSON.stringify(await railUnder(page, "Security")) === JSON.stringify(["JWT"]), "…the side panel's Add list too",
    JSON.stringify(await railHeadings(page)));
  await newSession(page, "Base64");
  const cardRows = await page.locator(`${SHOWN} .session-card .session-card-label`).allInnerTexts();
  check(cardRows[2] === "Security" && cardRows.includes("Services") && cardRows.includes("Tools"), "…and a session's card", JSON.stringify(cardRows));

  // ---- 2. a member's own view
  const g = (await api(page, "POST", "/user-groups", { name: `g-${USER}`, pane_types: ["tool-jwt", "tool-base64", "tool-diff"] })).body;
  await api(page, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  const member = await newPage(browser);
  await signIn(member, { username: USER, password: "pw-123456" });
  await member.click(".rail-row-home");
  await member.waitForSelector(".home h3");
  const theirs = (await homeHeadings(member)).map((h) => h.trim().toUpperCase());
  check(JSON.stringify(theirs.slice(0, 2)) === JSON.stringify(["SECURITY", "TOOLS"]) && !theirs.includes("SERVICES"),
    "A member sees the same categories, with only their panes, and none left empty", JSON.stringify(theirs));
  await member.hover('.home-card[data-pane-type="tool-base64"]');
  await member.click('[aria-label="Star Base64"]');
  await member.waitForFunction(() => [...document.querySelectorAll(".rail .rail-heading")].some((h) => h.textContent.trim().toUpperCase() === "FAVOURITES"));
  const heads = (await railHeadings(member)).map((h) => h.trim().toUpperCase());
  check(heads.indexOf("FAVOURITES") < heads.indexOf("SECURITY") && JSON.stringify(await railUnder(member, "Favourites")) === JSON.stringify(["Base64"]),
    "Starred, a pane comes first in their lists as Favourites", JSON.stringify(heads));
  check((await api(page, "GET", "/catalogue")).body.favourites.length === 0, "…their own, not the admin's");
  await member.hover('.home-card[data-pane-type="tool-diff"]');
  await member.click('[aria-label="Hide Diff"]');
  await member.waitForSelector('.home-show-hidden:has-text("Show hidden (1)")');
  check((await member.locator('.home-card[data-pane-type="tool-diff"]').count()) === 0 && !(await railUnder(member, "Tools")).includes("Diff"),
    "Hidden, it's left out of the default page and the Add list");
  await member.click(".home-show-hidden");
  await member.waitForSelector('.home-card.hidden-type[data-pane-type="tool-diff"]');
  await member.click('[aria-label="Show Diff again"]');
  await member.waitForFunction(() => !document.querySelector(".home-show-hidden"));
  check((await railUnder(member, "Tools")).includes("Diff"), "Shown again, it's back");
  await member.close();

  // ---- 3. deleting a category moves its panes
  await openCatalogue(page);
  await page.click(`${SETTINGS} [aria-label="Delete Security"]`);
  await page.selectOption(`${SETTINGS} [aria-label="Move its panes to"]`, { label: "Tools" });
  await page.click(`${CATEGORY("Security")} .catalogue-inline button:text-is("Delete")`);
  await page.waitForFunction(() => !document.querySelector('[data-category="Security"]'));
  check((await page.locator(`${CATEGORY("Tools")} [data-pane-type="tool-jwt"]`).count()) === 1, "Deleted, its panes move to the category chosen");

  // Put the catalogue back as it was found, for the suites after this one.
  await api(page, "PUT", "/catalogue/layout", { categories: original.categories.map((c) => ({ id: c.id, pane_types: c.pane_types })) });
  for (const u of (await api(page, "GET", "/users")).body.filter((u) => u.username === USER)) await api(page, "DELETE", `/users/${u.id}`);
  await api(page, "DELETE", `/user-groups/${g.id}`);
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
