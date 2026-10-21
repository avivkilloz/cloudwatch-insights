// The rail's pages (the user's asks after #140):
//   - no Agent page and no Agent row -- the Global chat is the agent panel's;
//     a browser whose stored view was the Agent page lands home, not on nothing;
//   - Workflows and Builder have an icon each in the rail;
//   - with the rail hidden, the same icons are on the strip right after its
//     toggle, and go to their pages (shown active there); shown again, the
//     strip's icons go.
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  try {
    await clearWorkspace(page);
    const rows = await page.locator(".rail-pages .rail-row-page .rail-row-label").allInnerTexts();
    check(JSON.stringify(rows) === '["Workflows","Builder"]', "The rail's pages are Workflows and Builder: no Agent", JSON.stringify(rows));
    check((await page.locator(".rail-pages .rail-row-page .rail-row-icon svg").count()) === 2, "…each with its icon");

    // Hidden: the same pages on the strip, after the toggle.
    await page.click(".session-bar-rail");
    await page.waitForSelector('.session-bar-page[data-page="workflows"]');
    const order = await page.locator(".session-bar > button").evaluateAll((els) =>
      els.slice(0, 4).map((e) => e.getAttribute("data-page") ?? e.className));
    check(JSON.stringify(order) === '["session-bar-brand","session-bar-rail","workflows","builder"]',
      "Rail hidden, Workflows and Builder are on the strip right after its toggle", JSON.stringify(order));
    await page.click('.session-bar-page[data-page="workflows"]');
    await page.waitForSelector(".workflows-list");
    check((await page.locator('.session-bar-page.active[data-page="workflows"]').count()) === 1, "…Workflows goes to its page, shown active");
    await page.click('.session-bar-page[data-page="builder"]');
    await page.waitForSelector(".builder-list");
    check((await page.locator('.session-bar-page.active[data-page="builder"]').count()) === 1 &&
      (await page.locator('.session-bar-page.active[data-page="workflows"]').count()) === 0, "…and Builder to its own");
    await page.screenshot({ path: `${SHOT}/smoke105-strip.png`, clip: { x: 0, y: 0, width: 800, height: 120 } });
    await page.click(".session-bar-rail");
    await page.waitForSelector(".rail-pages");
    check((await page.locator(".session-bar-page").count()) === 0, "Shown again, the strip's page icons go");

    // A view stored as the Agent page, from before it went: home.
    const rewritten = await page.evaluate(async () => {
      let count = 0;
      const open = indexedDB.open("cloud-insights-sessions");
      await new Promise((resolve) => (open.onsuccess = resolve));
      const db = open.result;
      const names = [...db.objectStoreNames];
      for (const name of names) {
        const tx = db.transaction(name, "readwrite");
        const store = tx.objectStore(name);
        const keys = await new Promise((resolve) => {
          const r = store.getAllKeys();
          r.onsuccess = () => resolve(r.result);
        });
        for (const key of keys) {
          const value = await new Promise((resolve) => {
            const r = store.get(key);
            r.onsuccess = () => resolve(r.result);
          });
          const text = typeof value === "string" ? value : JSON.stringify(value);
          if (text && text.includes('"view"')) {
            const changed = text.replace(/"view":"[a-z]+"/, '"view":"agent"');
            store.put(typeof value === "string" ? changed : JSON.parse(changed), key);
            if (changed.includes('"view":"agent"')) count += 1;
          }
        }
        await new Promise((resolve) => (tx.oncomplete = resolve));
      }
      return count;
    });
    check(rewritten > 0, "(the stored view was set to the Agent page)");
    await page.reload();
    await page.waitForSelector(".rail-pages");
    check((await page.locator(".rail-row-home.active, .home-page, .home-group-title").count()) > 0,
      "A browser whose stored view was the Agent page lands home");
  } finally {
    await clearWorkspace(page);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
