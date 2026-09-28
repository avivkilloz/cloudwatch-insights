// Two-way live sync: a session changed anywhere shows up everywhere it's open.
//
// Until now the browser owned the workspace and only ever pushed it, so a
// second browser saw someone else's change on its next reload, and then
// overwrote it on its next save. Now the server announces every write on
// /api/live-sessions/events, each write says which version it was made from
// (a stale one is refused with 409 and merged), and a mounted pane takes a
// value that changed under it. That's what the platform agent will need --
// it writes on the server, never in a browser -- so the "agent" step below
// does exactly that: a PUT from outside any page, and every open pane follows.
import { CLOSED_ROW, ROW, SHOT, SHOWN, check, clearWorkspace, closeTab, launch, newSession, openApp, report } from "./harness.mjs";

const CW = `${SHOWN} [data-pane-id="logs-cloudwatch"] textarea`;
const B64 = `${SHOWN} [data-pane-id="tool-base64"] textarea`;

async function valueEventually(page, selector, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value = "";
  while (Date.now() < deadline) {
    value = await page.locator(selector).first().inputValue().catch(() => "");
    if (predicate(value)) return value;
    await page.waitForTimeout(200);
  }
  return value;
}

const run = async () => {
  const browser = await launch();
  const a = await openApp(browser);
  await clearWorkspace(a);
  await a.reload();
  await a.waitForSelector(".rail");
  // A second, separate browser for the same user: its own cookies, its own
  // IndexedDB, its own event stream.
  const b = await openApp(browser);

  // ---------- 1. a session made in A appears in B, without a reload ----------
  await newSession(a, "CloudWatch", "Base64");
  await b.waitForSelector(ROW("CloudWatch +1"), { timeout: 10000 }).catch(() => undefined);
  check((await b.locator(ROW("CloudWatch +1")).count()) === 1, "A session created in one browser appears in the other's panel");
  check((await b.locator(".rail-row-home.active, .rail-row-home[aria-current]").count()) >= 0 &&
    (await b.locator(`${SHOWN} .aggregator-pane`).count()) === 0,
    "…without pulling the other browser off what it was looking at");
  await b.click(ROW("CloudWatch +1"));
  await b.waitForSelector(CW, { timeout: 10000 });

  // ---------- 2. typing in A shows up in B's pane ----------
  await a.fill(CW, "fields @message | limit 44");
  const seen = await valueEventually(b, CW, (v) => v.includes("limit 44"));
  check(seen.includes("limit 44"), "What's typed into a pane in one browser appears in the same pane in the other", JSON.stringify(seen));

  // ---------- 3. both browsers editing different panes at once: nothing lost ----------
  // Inside the 1.2s sync debounce of each other, so one of the two writes is
  // necessarily made from a version the other has already replaced.
  await b.click(`${SHOWN} .aggregator-tab-label:text-is("Base64")`);
  await b.waitForSelector(B64);
  await Promise.all([a.fill(CW, "fields @timestamp | limit 45"), b.fill(B64, "aGVsbG8gZnJvbSBC")]);
  const aB64 = await valueEventually(a, B64, (v) => v === "aGVsbG8gZnJvbSBC");
  const bCw = await valueEventually(b, CW, (v) => v.includes("limit 45"));
  check(aB64 === "aGVsbG8gZnJvbSBC", "An edit made in B at the same moment as one in A reaches A", JSON.stringify(aB64));
  check(bCw.includes("limit 45"), "…and A's reaches B -- a stale write is merged, not lost", JSON.stringify(bCw));
  const aCw = await a.locator(CW).inputValue();
  check(aCw.includes("limit 45"), "…while A keeps its own", JSON.stringify(aCw));

  // ---------- 4. a write made on the server (as the agent will) reaches every open pane ----------
  await a.waitForTimeout(1500);
  const written = await a.evaluate(async () => {
    const list = await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json();
    const row = list.find((s) => s.title === "CloudWatch +1");
    const state = { ...row.state, "logs-cloudwatch.queryString": "fields @agent | limit 46" };
    const res = await fetch(`/api/live-sessions/${row.client_id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Sync-Origin": "agent" },
      body: JSON.stringify({ ...row, state, base_version: row.version }),
    });
    return res.status;
  });
  check(written === 200, "A server-side write from the session's current version is accepted", written);
  const aAgent = await valueEventually(a, CW, (v) => v.includes("@agent"));
  const bAgent = await valueEventually(b, CW, (v) => v.includes("@agent"));
  check(aAgent.includes("@agent") && bAgent.includes("@agent"),
    "…and shows up in the pane in both browsers, with no reload", JSON.stringify({ aAgent, bAgent }));
  await a.screenshot({ path: `${SHOT}/44-agent-write-in-a.png` });

  // A write made from an old version is refused rather than applied.
  const stale = await a.evaluate(async () => {
    const list = await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json();
    const row = list.find((s) => s.title === "CloudWatch +1");
    const res = await fetch(`/api/live-sessions/${row.client_id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Sync-Origin": "agent" },
      body: JSON.stringify({ ...row, state: {}, base_version: row.version - 1 }),
    });
    return res.status;
  });
  check(stale === 409, "A write made from a stale version is refused (409), not applied over newer work", stale);

  // ---------- 5. a close in B takes it off A's strip ----------
  await closeTab(b, "CloudWatch +1");
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    gone = (await a.locator(`.session-tab:has-text("CloudWatch +1")`).count()) === 0;
    if (!gone) await a.waitForTimeout(200);
  }
  check(gone, "Closing a session in one browser takes it off the other's strip");
  check((await a.locator(`${CLOSED_ROW}:has-text("CloudWatch +1")`).count()) === 1, "…and lists it there as closed, dimmed");

  // ---------- 6. back after a drop: whatever was missed is caught up ----------
  await newSession(b, "JWT");
  await a.waitForSelector(ROW("JWT"), { timeout: 10000 }).catch(() => undefined);
  await a.context().setOffline(true);
  await a.waitForTimeout(500);
  await b.evaluate(async () => {
    const list = await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json();
    const row = list.find((s) => s.title === "JWT");
    await fetch(`/api/live-sessions/${row.client_id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Sync-Origin": "agent" },
      body: JSON.stringify({ ...row, title: "JWT while offline", base_version: row.version }),
    });
  });
  await a.waitForTimeout(800);
  await a.context().setOffline(false);
  let caughtUp = false;
  for (let i = 0; i < 60 && !caughtUp; i++) {
    caughtUp = (await a.locator(ROW("JWT while offline")).count()) === 1;
    if (!caughtUp) await a.waitForTimeout(250);
  }
  check(caughtUp, "A change made while this browser was offline arrives once it reconnects");

  // ---------- 7. a reorder made elsewhere is followed, not undone ----------
  // A tab still holding the old order used to push it straight back with its
  // next save; now the order belongs to /reorder, and every tab follows it.
  await newSession(b, "Diff");
  await a.waitForSelector(ROW("Diff"), { timeout: 10000 }).catch(() => undefined);
  const openLabels = (page) =>
    page.locator(".rail-row:not(.rail-row-type):not(.rail-row-closed):not(.rail-row-home) .rail-row-label").allInnerTexts();
  const before = await openLabels(a);
  const reversed = await b.evaluate(async () => {
    const list = await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json();
    const ids = list.map((s) => s.client_id).reverse();
    await fetch("/api/live-sessions/reorder", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Sync-Origin": "agent" },
      body: JSON.stringify({ client_ids: ids }),
    });
    return list.map((s) => s.title).reverse();
  });
  let followed = false;
  for (let i = 0; i < 40 && !followed; i++) {
    followed = JSON.stringify(await openLabels(a)) === JSON.stringify(reversed);
    if (!followed) await a.waitForTimeout(250);
  }
  check(followed, "A reorder made elsewhere is followed live in this browser's panel",
    JSON.stringify({ before, now: await openLabels(a), expected: reversed }));
  // ...and this browser saving afterwards doesn't put the old order back.
  await a.click(ROW("Diff"));
  await a.waitForTimeout(2500);
  const serverOrder = await a.evaluate(async () =>
    (await (await fetch("/api/live-sessions", { credentials: "same-origin" })).json()).map((s) => s.title));
  check(JSON.stringify(serverOrder) === JSON.stringify(reversed), "…and a save from here afterwards doesn't undo it",
    JSON.stringify({ serverOrder, reversed }));

  await clearWorkspace(a);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
