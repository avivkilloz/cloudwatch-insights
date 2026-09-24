// Live sessions: autosaved to the server, so they survive a reload, follow you
// to a brand-new browser profile, and split Close (kept) from Delete (gone).
import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
/** Add holds the way to the new-session card, the one-click services and
 * tools, and templates. */
const NEW_SESSION = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
const OPEN = ".rail-row:not(.rail-row-type):not(.rail-row-template):not(.rail-row-closed)";
const ROW = (l) => `${OPEN}:has(.rail-row-label:text-is("${l}"))`;
const CLOSED = ".rail-row-closed";

/** A fresh browser profile: no IndexedDB, no localStorage. Anything that comes
 * back here came from the server. */
async function freshPage(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await page.addInitScript(() => {
    try { localStorage.setItem("cwi-rail-catalogue", "open"); } catch {}
  });
  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 15000 });
  await page.fill('input[autocomplete="username"]', ADMIN_USER);
  await page.fill('input[autocomplete="current-password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".rail", { timeout: 15000 });
  return page;
}

const openTitles = (page) =>
  page.locator(`${OPEN} .rail-row-label`).allTextContents().then((t) => t.filter((x) => x !== "Home"));
const closedTitles = (page) => page.locator(`${CLOSED} .rail-row-label`).allTextContents();

/** The server's own view, read through the app's cookie rather than guessed at
 * from the DOM. */
const serverOpen = (page) =>
  page.evaluate(async () => (await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json()).map((s) => s.title));
const serverClosed = (page) =>
  page.evaluate(async () => (await (await fetch("/api/live-sessions/closed", { credentials: "same-origin" })).json()).map((s) => s.title));

async function menu(page, title, item) {
  await page.click(`${ROW(title)} .rail-row-more`);
  await page.click(`.rail-row-menu button:text-is("${item}")`);
}

/** Closing lives on the tab in the strip above the body, not in the rail. */
async function closeTab(page, title) {
  await page.click(`.session-tab:has(.session-tab-label:text-is("${title}")) .session-tab-close`);
}

(async () => {
  const browser = await launch();

  // Start from a clean slate on the server, whatever earlier runs left behind.
  const setup = await freshPage(browser);
  await setup.evaluate(async () => {
    for (const url of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(url, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
  });
  await setup.context().close();

  // ---------- a session reaches the server without anyone pressing save ----------
  const page = await freshPage(browser);
  check((await openTitles(page)).length === 0, "Nothing open to start with", JSON.stringify(await openTitles(page)));

  await newSession(page, "Base64");
  await page.waitForSelector(ROW("Base64"));
  await page.fill(".session-body:not([hidden]) textarea", "autosaved without a save button");
  // Longer than the 1200ms sync debounce.
  await page.waitForTimeout(2500);
  check(JSON.stringify(await serverOpen(page)) === '["Base64"]', "An open session autosaves to the server",
    JSON.stringify(await serverOpen(page)));

  // ---------- and comes back on a browser that has never seen it ----------
  const other = await freshPage(browser);
  // The rail renders before the server's list has landed -- an empty list here
  // means "not yet", not "not there", so wait for the row rather than reading
  // the rail the instant it appears.
  await other.waitForSelector(ROW("Base64"), { timeout: 15000 }).catch(() => undefined);
  check(JSON.stringify(await openTitles(other)) === '["Base64"]',
    "…and is there on a browser profile that has never seen it", JSON.stringify(await openTitles(other)));
  // A fresh browser lands on Home: which tab you were looking at is local, by
  // design, so the sessions are listed but none is showing yet.
  check((await other.locator(".rail-row.active .rail-row-label").textContent()) === "Home",
    "…with a new browser still landing on Home, since the active tab is local");
  await other.click(`${ROW("Base64")} .rail-row-label`);
  await other.waitForSelector(".session-body:not([hidden]) textarea");
  const text = await other.locator(".session-body:not([hidden]) textarea").first().inputValue();
  check(text === "autosaved without a save button", "…with the text that was typed into it, not just its name", text);

  // ---------- close keeps it, and it can be put back ----------
  await closeTab(other, "Base64");
  await other.waitForTimeout(500);
  check((await openTitles(other)).length === 0, "Close takes it off the panel");
  check(JSON.stringify(await closedTitles(other)) === '["Base64"]', "…into Recently closed",
    JSON.stringify(await closedTitles(other)));
  check(JSON.stringify(await serverClosed(other)) === '["Base64"]', "…and the server keeps the row",
    JSON.stringify(await serverClosed(other)));

  await other.click(`${CLOSED} .rail-row-label`);
  await other.waitForTimeout(2200);
  check(JSON.stringify(await openTitles(other)) === '["Base64"]', "Reopening puts it back on the panel",
    JSON.stringify(await openTitles(other)));
  const back = await other.locator(".session-body:not([hidden]) textarea").first().inputValue();
  check(back === "autosaved without a save button", "…with its state intact", back);
  check((await closedTitles(other)).length === 0, "…and out of Recently closed");
  check(JSON.stringify(await serverOpen(other)) === '["Base64"]', "…reopened on the server too",
    JSON.stringify(await serverOpen(other)));

  // ---------- delete is the one that loses it ----------
  other.on("dialog", (d) => d.accept());
  await menu(other, "Base64", "Delete");
  await other.waitForTimeout(600);
  check((await openTitles(other)).length === 0, "Delete takes it off the panel");
  check((await closedTitles(other)).length === 0, "…and does not leave it in Recently closed");
  check((await serverOpen(other)).length === 0 && (await serverClosed(other)).length === 0,
    "…and removes the row from the server");

  const third = await freshPage(browser);
  check((await openTitles(third)).length === 0, "…so a new browser sees nothing either");
  await third.context().close();

  // ---------- several sessions, and the order they are in ----------
  for (const t of ["JWT", "Diff", "IoT"]) {
    await newSession(other, t);
    await other.waitForSelector(ROW(t));
  }
  await other.waitForTimeout(2500);
  check(JSON.stringify(await serverOpen(other)) === '["JWT","Diff","IoT"]',
    "Several sessions autosave in panel order", JSON.stringify(await serverOpen(other)));

  const rows = other.locator(`${OPEN}:not(:has(.rail-row-label:text-is("Home")))`);
  await rows.nth(0).scrollIntoViewIfNeeded();
  const a = await rows.nth(0).boundingBox();
  const c = await rows.nth(2).boundingBox();
  await other.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await other.mouse.down();
  await other.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 15 });
  await other.mouse.up();
  await other.waitForTimeout(2500);
  const reordered = await openTitles(other);
  check(JSON.stringify(reordered) !== '["JWT","Diff","IoT"]', "Dragging still reorders them", JSON.stringify(reordered));
  check(JSON.stringify(await serverOpen(other)) === JSON.stringify(reordered),
    "…and the new order reaches the server", `${JSON.stringify(await serverOpen(other))} vs ${JSON.stringify(reordered)}`);

  const fourth = await freshPage(browser);
  check(JSON.stringify(await openTitles(fourth)) === JSON.stringify(reordered),
    "…so another browser opens them in that order", JSON.stringify(await openTitles(fourth)));
  await fourth.context().close();

  // ---------- renaming follows too ----------
  // Renaming is an input in the row now, not a prompt() box.
  await other.dblclick(`${ROW(reordered[0])} .rail-row-label`);
  await other.waitForSelector(".rail-row-rename");
  await other.fill(".rail-row-rename", "Renamed session");
  await other.keyboard.press("Enter");
  await other.waitForTimeout(2500);
  check((await serverOpen(other)).includes("Renamed session"), "A rename reaches the server",
    JSON.stringify(await serverOpen(other)));

  await other.screenshot({ path: `${SHOT}/29-final.png` });
  await browser.close();
  report();
})();
