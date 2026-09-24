import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";
import fs from "fs";

const SCRATCH = `${SHOT}/downloads`;
fs.mkdirSync(SCRATCH, { recursive: true });

const assistCalls = [];
let thingDetailCalls = [];
let certDetailCalls = [];

async function downloadJson(page, exportSelector) {
  await page.click(exportSelector);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.click('.icon-popover-item:has-text("JSON")'),
  ]);
  const path = `${SCRATCH}/${Date.now()}.json`;
  await download.saveAs(path);
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

/** Services are sessions now: started from the + in the strip under the
 * header rather than tabs in the header. Any session already open is closed
 * first, so exactly one page is mounted and the unscoped selectors below still
 * address the one on screen -- every open session stays mounted otherwise. */
async function openSession(page, label) {
  // Closing is the ✕ on the tab in the strip above the body.
  while ((await page.locator(".session-tab-close").count()) > 0) {
    await page.locator(".session-tab-close").first().click();
    await page.waitForTimeout(120);
  }
  await newSession(page, label);
}

(async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("401")) console.log("CONSOLE ERROR:", m.text());
  });

  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (r) => {
    assistCalls.push(JSON.parse(r.request().postData() || "{}"));
    r.fulfill({ json: { reply: "ok", suggested_query: null } });
  });

  await page.route("**/api/iot/search", (r) =>
    r.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            things: ["alpha", "bravo", "charlie"].map((n) => ({
              thing_name: `thing-${n}`,
              thing_id: null,
              thing_type_name: null,
              thing_group_names: [],
              attributes: {},
              connected: true,
              connectivity_timestamp: null,
            })),
            error: null,
          },
        ],
      },
    })
  );
  await page.route("**/api/iot/things/detail", (r) => {
    const body = JSON.parse(r.request().postData() || "{}");
    thingDetailCalls.push(body.thing_name);
    r.fulfill({
      json: {
        thing_name: body.thing_name,
        thing_id: `id-${body.thing_name}`,
        thing_arn: `arn:aws:iot:::thing/${body.thing_name}`,
        thing_type_name: null,
        attributes: {},
        version: 7,
        connected: true,
        connectivity_timestamp: null,
        certificates: [
          { certificate_id: `cert-of-${body.thing_name}`, certificate_arn: "arn:c", status: "ACTIVE", creation_date: null, policies: [] },
        ],
        shadows: [
          { name: "classic", reported: { firmware: `1.2.${body.thing_name.length}` }, desired: {}, version: 3, last_updated: null },
        ],
        jobs: [{ job_id: `job-${body.thing_name}`, status: "SUCCEEDED", queued_at: null, started_at: null, last_updated_at: null }],
        warnings: [],
      },
    });
  });

  await page.route("**/api/iot/certificates/search", (r) =>
    r.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            certificates: ["one", "two"].map((n) => ({
              certificate_id: `cert-${n}`,
              certificate_arn: `arn:aws:iot:::cert/${n}`,
              status: "ACTIVE",
              creation_date: null,
              policies: [{ policy_name: `pol-${n}`, policy_arn: null, policy_document: null }],
            })),
            error: null,
          },
        ],
      },
    })
  );
  await page.route("**/api/iot/certificates/detail", (r) => {
    const body = JSON.parse(r.request().postData() || "{}");
    certDetailCalls.push(body.certificate_id);
    r.fulfill({
      json: {
        certificate_id: body.certificate_id,
        certificate_arn: "arn:c",
        status: "ACTIVE",
        creation_date: null,
        policies: [],
        thing_names: [`attached-to-${body.certificate_id}`],
        warnings: [],
      },
    });
  });

  // Login + environment
  // The rail's catalogue folds shut by default now (smoke28 covers that);
  // these suites are about what it offers, so open it before the first paint.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("cwi-rail-catalogue", "open");
    } catch {}
  });
  await page.goto(BASE);
  await page.waitForSelector("text=Sign in", { timeout: 10000 });
  await page.fill('input[autocomplete="username"]', ADMIN_USER);
  await page.fill('input[autocomplete="current-password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');

  // Sessions live on the server now, so they outlast a browser profile as well
  // as a reload. Start from a clean slate rather than inheriting whatever an
  // earlier suite left open.
  await page.waitForSelector(".rail, .user-menu-trigger", { timeout: 15000 });
  await page.evaluate(async () => {
    for (const url of ["/api/live-sessions", "/api/live-sessions/closed"]) {
      for (const s of await (await fetch(url, { credentials: "same-origin" })).json()) {
        await fetch(`/api/live-sessions/${s.client_id}`, { method: "DELETE", credentials: "same-origin" });
      }
    }
    // The local copy too. Emptying only the server is not enough: a browser
    // holding sessions the server does not is exactly the case the app treats
    // as "this browser has work the backend hasn't heard about yet", so it
    // would push them straight back up.
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase("cloud-insights-sessions");
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  });
  await page.reload();

  await page.waitForSelector(".user-menu-trigger", { timeout: 10000 });
  await page.click(".user-menu-trigger");
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.waitForSelector("text=Profile picture");
  await page.click('.content .tabs button:has-text("Environments")');
  await page.waitForSelector("text=Add environment");
  await page.fill('input[placeholder="Production us-east-1"]', "Demo Env");
  await page.fill('input[placeholder="111122223333"]', "111122223333");
  await page.click('button:has-text("Add environment")');
  await page.waitForSelector("text=Demo Env");

  // ---------- IoT things ----------
  await openSession(page, "IoT");
  await page.waitForSelector('h2:text-is("1. Choose environments")');
  await page.click('label:has-text("Demo Env (111122223333 · us-east-1)") input[type="checkbox"]');
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=thing-alpha");

  const panel = '.panel:has-text("3. Results")';

  check(
    (await page.locator(`${panel} label:has-text("Include shadows")`).count()) === 0,
    "Things: the include-details option is hidden until rows are checked"
  );

  // Check two of the three things.
  await page.click(`${panel} .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.click(`${panel} .result-row >> nth=1 >> input[type="checkbox"]`);
  await page.waitForSelector(`${panel} label:has-text("Include shadows")`);
  check(true, "Things: the option appears once rows are checked");

  // Without it, export is the plain summary.
  let rows = await downloadJson(page, `${panel} button:has-text("Export 2 selected")`);
  check(
    rows.length === 2 && rows[0].shadows === undefined && rows[0].thing_name === "thing-alpha",
    "Things: export without the option is the plain summary",
    JSON.stringify(rows[0])
  );
  check(thingDetailCalls.length === 0, "Things: nothing is fetched while the option is off", JSON.stringify(thingDetailCalls));

  // Turn it on -> detail is fetched for exactly the checked rows.
  await page.click(`${panel} label:has-text("Include shadows") input`);
  await page.waitForFunction(() => !document.body.innerText.includes("Loading details…"));
  check(
    thingDetailCalls.length === 2 && thingDetailCalls.includes("thing-alpha") && thingDetailCalls.includes("thing-bravo"),
    "Things: detail is fetched for exactly the checked rows, not all of them",
    JSON.stringify(thingDetailCalls)
  );

  rows = await downloadJson(page, `${panel} button:has-text("Export 2 selected")`);
  const alpha = rows.find((r) => r.thing_name === "thing-alpha");
  check(
    rows.length === 2 &&
      alpha.shadows?.[0]?.reported?.firmware === "1.2.11" &&
      alpha.certificates?.[0]?.certificate_id === "cert-of-thing-alpha" &&
      alpha.jobs?.[0]?.job_id === "job-thing-alpha" &&
      alpha.thing_arn === "arn:aws:iot:::thing/thing-alpha" &&
      alpha.version === 7,
    "Things: export now carries shadows, certificates, jobs, arn and version",
    JSON.stringify(alpha)
  );

  // The AI assistant sees the same enriched rows.
  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  const before = assistCalls.length;
  await page.fill(".ai-widget-textarea", "what firmware are these on?");
  await page.click('.ai-widget-panel button:has-text("Ask")');
  for (let i = 0; i < 50 && assistCalls.length === before; i++) await page.waitForTimeout(100);
  const sent = assistCalls[assistCalls.length - 1];
  const sentAlpha = (sent?.sample_rows ?? []).find((r) => r.thing_name === "thing-alpha");
  check(
    sent?.sample_rows?.length === 2 && sentAlpha?.shadows?.[0]?.reported?.firmware === "1.2.11",
    "Things: the AI assistant receives the enriched rows too",
    JSON.stringify(sentAlpha)
  );
  await page.click('.ai-widget-panel button[aria-label="Close"]');

  // Checking a third row pulls only that row's detail.
  await page.click(`${panel} .result-row >> nth=2 >> input[type="checkbox"]`);
  await page.waitForFunction(() => !document.body.innerText.includes("Loading details…"));
  check(
    thingDetailCalls.length === 3 && thingDetailCalls.filter((n) => n === "thing-charlie").length === 1,
    "Things: adding a row to the selection fetches only that row",
    JSON.stringify(thingDetailCalls)
  );

  // Expanding an already-fetched row must reuse the cache.
  const callsBeforeExpand = thingDetailCalls.length;
  await page.click(`${panel} .result-row >> nth=0 >> .result-row-summary .msg`);
  await page.waitForSelector(`${panel} .result-row-detail`);
  await page.waitForTimeout(400);
  check(
    thingDetailCalls.length === callsBeforeExpand,
    "Things: expanding a row already fetched for export reuses the cache",
    `${callsBeforeExpand} -> ${thingDetailCalls.length}`
  );

  // Turning it off reverts to the plain summary.
  await page.click(`${panel} label:has-text("Include shadows") input`);
  rows = await downloadJson(page, `${panel} button:has-text("Export 3 selected")`);
  check(
    rows.length === 3 && rows.every((r) => r.shadows === undefined),
    "Things: turning the option off reverts export to the plain summary",
    JSON.stringify(rows[0])
  );

  // ---------- IoT certificates ----------
  await page.click('button:text-is("Certificates")');
  await page.click('button:text-is("Search")');
  await page.waitForSelector("text=cert-one");
  await page.click(`${panel} .result-row >> nth=0 >> input[type="checkbox"]`);
  await page.waitForSelector(`${panel} label:has-text("Include attached things")`);
  await page.click(`${panel} label:has-text("Include attached things") input`);
  await page.waitForFunction(() => !document.body.innerText.includes("Loading details…"));
  check(certDetailCalls.length === 1 && certDetailCalls[0] === "cert-one", "Certificates: detail fetched for the checked certificate", JSON.stringify(certDetailCalls));

  rows = await downloadJson(page, `${panel} button:has-text("Export 1 selected")`);
  check(
    rows.length === 1 && rows[0].thing_names?.[0] === "attached-to-cert-one" && rows[0].policies?.[0]?.policy_name === "pol-one",
    "Certificates: export carries the attached things alongside the policies it already had",
    JSON.stringify(rows[0])
  );

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
