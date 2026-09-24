/**
 * What every browser suite in this folder shares: where the app is, how to get
 * signed into it, how to start from an empty workspace, and how a suite reports.
 *
 * The suites drive the real app against a real backend -- there is no component
 * test layer, and the bugs worth catching here (a pane that is mounted but
 * hidden, a strip that is wider than the cards, a sync that races a close) only
 * exist in a browser. See README.md in this folder for how to run them and for
 * the traps that have already cost a release.
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5179";
export const ADMIN_USER = process.env.E2E_USER || "admin";
export const ADMIN_PASSWORD = process.env.E2E_PASSWORD || "SmokeTestPass123!";

/** Where screenshots land. Git-ignored: they are for looking at while working,
 * not artefacts to keep. */
export const SHOT = process.env.E2E_SHOT_DIR || fileURLToPath(new URL("./screenshots", import.meta.url));
mkdirSync(SHOT, { recursive: true });

/** The viewport every suite uses. Wide enough that the rail, the body and a
 * side-by-side pair of panes are all on screen -- several checks measure
 * geometry, and a narrower window would reflow them. */
export const VIEWPORT = { width: 1440, height: 950 };

/**
 * Playwright, from wherever this machine keeps it: the repo does not depend on
 * it (these suites are not part of `npm run build` or CI), so it may be a local
 * install, a global one, or the copy a container image ships. E2E_PLAYWRIGHT
 * overrides all of it.
 */
async function resolvePlaywright() {
  const candidates = [
    process.env.E2E_PLAYWRIGHT,
    "playwright",
    "@playwright/test",
    "/opt/node22/lib/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch {
      // try the next one
    }
  }
  throw new Error(
    `Playwright not found. Tried: ${candidates.join(", ")}. Install it (npm i -D playwright) ` +
      "or point E2E_PLAYWRIGHT at an installed copy.",
  );
}

const playwright = await resolvePlaywright();
export const chromium = playwright.chromium;

/** One browser per suite. E2E_CHROMIUM names an executable when Playwright's
 * own download is not what should run (a container's pre-installed Chromium). */
export function launch() {
  return chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
}

let pass = 0;
let fail = 0;

/** One assertion. `detail` is printed only on failure and should carry what was
 * actually found -- a bare "FAIL: the tabs are in order" costs a rerun to
 * diagnose, "-- [\"Stacked\",\"Tabs\"]" does not. */
export function check(ok, label, detail) {
  if (ok) {
    pass += 1;
    console.log(`OK: ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL: ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** The last line of a suite: prints the tally and sets the exit code, so a
 * runner can tell a red suite from a green one without parsing the output. */
export function report() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

/** A fresh browser profile -- no IndexedDB, no localStorage. Page errors are
 * printed: an exception in React shows up here as the only clue before a
 * selector times out thirty seconds later. */
export async function newPage(browser, { viewport = VIEWPORT, catalogueOpen = true } = {}) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  if (catalogueOpen) {
    // The rail's Add list is folded by default and remembered per browser; the
    // suites that reach into it would otherwise have to unfold it first.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("cwi-rail-catalogue", "open");
      } catch {
        // private mode, blocked storage -- the app copes, so does this
      }
    });
  }
  await page.goto(BASE);
  return page;
}

/** Signs in and waits for the shell, so anything after this can assume a
 * logged-in app rather than a login form. */
export async function signIn(page, { username = ADMIN_USER, password = ADMIN_PASSWORD } = {}) {
  await page.waitForSelector("text=Sign in", { timeout: 15000 });
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[autocomplete="current-password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".rail", { timeout: 15000 });
  return page;
}

/** newPage + signIn: what most suites want on the first line. */
export async function openApp(browser, options = {}) {
  return signIn(await newPage(browser, options), options);
}

/**
 * An empty workspace: no sessions on the server, none in this browser, and no
 * categories.
 *
 * All three matter. Clearing only the server leaves this browser's IndexedDB
 * copy to be adopted and pushed straight back up, which is the adoption rule
 * working correctly and a suite failing for no reason. A category left behind
 * by an earlier run is quieter than that but just as real: every session
 * row's ⋮ offers "Move to <category>" the moment one exists, which a suite
 * written before categories existed has no reason to expect.
 *
 * `rows` seeds live sessions directly onto the server, in whatever shape is
 * wanted -- the only honest way to test a migration is to hand the app rows
 * this version would never write.
 */
export async function clearWorkspace(page, rows = []) {
  await page.evaluate(async (seed) => {
    for (const url of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(url, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    for (const c of await (await fetch("/api/session-categories", { credentials: "same-origin" })).json()) {
      await fetch(`/api/session-categories/${c.id}`, { method: "DELETE", credentials: "same-origin" });
    }
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase("cloud-insights-sessions");
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
    for (const row of seed || []) {
      await fetch(`/api/live-sessions/${row.client_id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
    }
  }, rows);
}

/**
 * Starts a session holding the named panes, the way a person does: the home
 * page's card, tick what goes in it, Create. (Add's service and tool rows are
 * the one-click version, a session holding just that pane.)
 */
export async function newSession(page, ...labels) {
  await page.click(".rail-row-home");
  await page.waitForSelector(".home-create");
  for (const label of labels) {
    await page.locator(`${CARD(label)} input[type=checkbox]`).check();
  }
  await page.click(".home-create");
  // Scoped to the session on screen: every session body stays mounted, so an
  // unscoped wait can settle on a tab inside a hidden one.
  if (labels.length) {
    await page.waitForSelector(`${SHOWN} .aggregator-tab-label:text-is("${labels[0]}")`, { timeout: 15000 });
  } else {
    await page.waitForSelector(`${SHOWN} h2:text-is("Panes")`, { timeout: 15000 });
  }
  await page.waitForTimeout(250);
}

/** The session on screen. Every other one is still mounted, just hidden, so
 * anything addressing panes or pane tabs has to go through this. */
export const SHOWN = ".session-body:not([hidden])";

/** A card on the home page, by its title. */
export const CARD = (label) => `.home-card:has(.home-card-title:text-is("${label}"))`;

/** A session in the rail -- not one of Add's rows, not a closed one, not Home. */
export const OPEN_ROW =
  ".rail-row:not(.rail-row-type):not(.rail-row-closed):not(.rail-row-home)";
export const ROW = (label) => `${OPEN_ROW}:has(.rail-row-label:text-is("${label}"))`;

/** A closed session in the rail: same list, dimmed. */
export const CLOSED_ROW = ".rail-row-closed";

/** A tab in the strip above the body. */
export const TAB = (label) => `.session-tab:has(.session-tab-label:text-is("${label}"))`;

/** A service or tool in Add, which opens a session holding just that pane. */
export const RAIL_TYPE = (label) => `.rail-row-type:has(.rail-row-label:text-is("${label}"))`;

/** The way to the home page's new-session card, at the top of Add. */
export const NEW_SESSION = '.rail-row-new:has(.rail-row-label:text-is("Start new session…"))';
