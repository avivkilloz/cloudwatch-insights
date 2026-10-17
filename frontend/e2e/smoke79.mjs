// 3c-3: a session as the home page (R3, D63, PLATFORM_PLAN.md §18.9), driven
// the way a person would:
//   - a session's ⋮ makes it the home page, its row in the side panel then
//     carries a house, and the ⋮ offers to stop;
//   - the brand goes there, from anywhere; "Start new session…" still shows
//     the default page, the catalogue you start things from;
//   - a load that would land on the default page (a reload on it, signing in)
//     lands on the home session instead, and a closed one is reopened;
//   - a session shared with you can be your home page; once you leave it (or
//     it's deleted), the default page says so, and Dismiss clears it;
//   - stopping makes the brand the default page again.
import { check, clearWorkspace, closeTab, launch, newPage, newSession, openApp, report, ROW, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function rowMenu(page, title, closed = false) {
  const row = page.locator(`${closed ? ".rail-row-closed" : ".rail-row"}:has(.rail-row-label:text-is("${title}"))`).first();
  await row.hover();
  await row.locator("button[aria-label*='More']").click();
  await page.waitForSelector(".rail-row-menu");
  return (await page.locator(".rail-row-menu button").allInnerTexts()).map((t) => t.trim());
}

const BRAND = ".rail-row-home";
const START = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
const activeTitle = (page) => page.locator(".rail-row.active:not(.rail-row-home):not(.rail-row-page) .rail-row-label").innerText();
const onDefaultPage = (page) => page.locator(".home .home-cards").first().isVisible().catch(() => false);

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await page.reload();
  await page.waitForSelector(".rail");

  // ---- 1. set from the ⋮
  await newSession(page, "Base64");
  const homeTitle = await activeTitle(page);
  await newSession(page, "Diff");
  const otherTitle = await activeTitle(page);
  await page.waitForTimeout(1600);
  let menu = await rowMenu(page, homeTitle);
  check(menu.includes("Set as my home page"), "A session's ⋮ offers to make it the home page", JSON.stringify(menu));
  await page.click('.rail-row-menu button:text-is("Set as my home page")');
  await page.waitForSelector(`${ROW(homeTitle)} .rail-row-home-mark`);
  check((await page.locator(".rail-row-home-mark").count()) === 1, "Its row in the side panel carries a house, and only its row");
  check((await api(page, "GET", "/live-sessions/home")).body.home?.title === homeTitle, "…kept on the server, per user");
  menu = await rowMenu(page, homeTitle);
  check(menu.includes("Stop using as home page") && !menu.includes("Set as my home page"), "…and its ⋮ now offers to stop", JSON.stringify(menu));
  await page.keyboard.press("Escape");

  // ---- 2. the brand goes there; Start new session… is still the catalogue
  await page.click(ROW(otherTitle));
  await page.click(START);
  await page.waitForTimeout(300);
  check(await onDefaultPage(page), "\"Start new session…\" still shows the default page");
  await page.click(BRAND);
  await page.waitForTimeout(300);
  check(!(await onDefaultPage(page)) && (await activeTitle(page)) === homeTitle, "The brand goes to the home session");

  // ---- 3. a load that would land on the default page lands there
  await page.click(START);
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector(".rail");
  await page.waitForFunction(() => document.querySelector(".rail-row.active:not(.rail-row-home):not(.rail-row-page)") !== null, null, { timeout: 8000 }).catch(() => undefined);
  check(!(await onDefaultPage(page)) && (await activeTitle(page).catch(() => "")) === homeTitle, "Reloaded on the default page, it lands on the home session");
  await page.click(ROW(otherTitle));
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector(ROW(otherTitle));
  await page.waitForTimeout(1500);
  check((await activeTitle(page)) === otherTitle, "…but a reload on another session stays on it");

  const fresh = await openApp(browser);
  await fresh.waitForFunction(() => document.querySelector(".rail-row.active:not(.rail-row-home):not(.rail-row-page)") !== null, null, { timeout: 8000 }).catch(() => undefined);
  check((await activeTitle(fresh).catch(() => "")) === homeTitle && !(await onDefaultPage(fresh)), "Signing in on a fresh browser lands on the home session");
  await fresh.close();

  // Closed, the brand reopens it.
  await closeTab(page, homeTitle);
  await page.waitForSelector(`.rail-row-closed:has(.rail-row-label:text-is("${homeTitle}")) .rail-row-home-mark`);
  check(true, "A closed home session keeps its house");
  await page.click(BRAND);
  await page.waitForSelector(ROW(homeTitle));
  await page.waitForTimeout(500);
  check((await activeTitle(page)) === homeTitle, "The brand reopens a closed home session");

  // ---- 4. a shared session as a member's home, then left
  const member = `smoke79-${Date.now()}`;
  const g = (await api(page, "POST", "/user-groups", { name: `g-${member}`, role_name: "R", tools_enabled: true })).body;
  await api(page, "POST", "/users", { username: member, password: "pw-123456", group_id: g.id });
  const shared = (await api(page, "GET", "/live-sessions")).body.find((s) => s.title === otherTitle);
  check((await api(page, "POST", `/live-sessions/${shared.client_id}/members`, { username: member, permission: "viewer" })).status === 201,
    "Precondition: a session shared with a viewer");
  const bob = await newPage(browser);
  await signIn(bob, { username: member, password: "pw-123456" });
  await bob.waitForSelector(ROW(otherTitle));
  menu = await rowMenu(bob, otherTitle);
  check(menu.includes("Set as my home page"), "A session shared with you can be your home page", JSON.stringify(menu));
  await bob.click('.rail-row-menu button:text-is("Set as my home page")');
  await bob.waitForSelector(`${ROW(otherTitle)} .rail-row-home-mark`);
  check((await api(page, "GET", "/live-sessions/home")).body.home?.title === homeTitle, "…without changing anyone else's");
  await bob.click(START);
  await bob.waitForTimeout(300);
  await bob.click(BRAND);
  await bob.waitForTimeout(300);
  check((await activeTitle(bob)) === otherTitle, "…and the brand takes them there");
  await rowMenu(bob, otherTitle);
  bob.once("dialog", (d) => d.accept());
  await bob.click('.rail-row-menu button:text-is("Leave")');
  await bob.waitForTimeout(1500);
  await bob.click(START);
  const note = await bob.waitForSelector(".home-missing", { timeout: 8000 }).then((el) => el.innerText(), () => "");
  check(note.includes(`“${otherTitle}”`) && note.includes("isn't shared with you any more"), "Left, the default page says the home page is gone", note);
  await bob.click(BRAND);
  await bob.waitForTimeout(300);
  check(await onDefaultPage(bob), "…and the brand shows the default page");
  await bob.click('.home-missing button:text-is("Dismiss")');
  await bob.waitForTimeout(500);
  check((await bob.locator(".home-missing").count()) === 0 && (await api(bob, "GET", "/live-sessions/home")).body.missing === null,
    "Dismissed, the note goes and the setting with it");
  await bob.close();

  // ---- 5. stop using it
  await rowMenu(page, homeTitle);
  await page.click('.rail-row-menu button:text-is("Stop using as home page")');
  await page.waitForTimeout(500);
  check((await page.locator(".rail-row-home-mark").count()) === 0, "Stopped, the house goes");
  await page.click(BRAND);
  await page.waitForTimeout(300);
  check(await onDefaultPage(page), "…and the brand shows the default page again");

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
