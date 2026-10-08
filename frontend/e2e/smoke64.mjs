// A tab left open across a deploy (PLATFORM_PLAN.md §15.4): the build it runs
// is compiled in, the deployed one is /version.json. Driven by standing in a
// newer version.json, as a deploy would leave it:
//   - while they match, nothing is said;
//   - once they differ, the tab says a new version is available as soon as
//     it's looked at again (focus);
//   - it doesn't reload under someone mid-task, but does at the next switch
//     of session -- or at once with "Reload now".
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

const NOTICE = ".app-update";

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  await newSession(page, "Base64");
  await newSession(page, "Diff");

  // ---- 1. the same build
  const served = await page.evaluate(async () => (await (await fetch("/version.json", { cache: "no-store" })).json()).build);
  check(typeof served === "string" && served.length > 0, "The server says which build it is serving", String(served));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  check((await page.locator(NOTICE).count()) === 0, "While it's the tab's own build, nothing is said");

  // ---- 2. a deploy
  await page.route("**/version.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ build: `${served}-next` }) }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(NOTICE);
  check((await page.locator(NOTICE).innerText()).includes("A new version of the app is available"),
    "After a deploy, looking at the tab again says a new version is available");

  // Mid-task: typing doesn't reload it.
  await page.evaluate(() => (window.__notReloaded = true));
  await page.locator(`${SHOWN} textarea`).nth(0).fill("still here");
  await page.waitForTimeout(500);
  check(await page.evaluate(() => window.__notReloaded === true), "It doesn't reload while you work in a session");

  // The next switch of session does.
  const reloaded = page.waitForEvent("load");
  await page.click('.rail-row:has(.rail-row-label:text-is("Base64"))');
  await reloaded;
  await page.waitForSelector(".rail");
  check(await page.evaluate(() => window.__notReloaded === undefined), "Switching session reloads it");
  check((await page.locator(`${SHOWN} textarea`).first().inputValue()) === "",
    "…into the session that was picked", await page.locator(`${SHOWN} .panel h2`).first().innerText());
  await page.click('.rail-row:has(.rail-row-label:text-is("Diff"))');
  check((await page.locator(`${SHOWN} textarea`).nth(0).inputValue()) === "still here",
    "…with what was typed just before it kept");

  // ---- 3. "Reload now"
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForSelector(NOTICE);
  await page.evaluate(() => (window.__notReloaded = true));
  const again = page.waitForEvent("load");
  await page.click(`${NOTICE} button:text-is("Reload now")`);
  await again;
  check(await page.evaluate(() => window.__notReloaded === undefined), "Reload now reloads at once");

  await page.unroute("**/version.json");
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
