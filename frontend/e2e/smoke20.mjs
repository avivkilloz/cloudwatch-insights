import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";

const assistCalls = [];
const SESSION = '.panel:has(h2:text-is("Panes"))';

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

/** Saving is ⋮ → "Save as template…" in the rail now, not a button in the strip. */
async function saveActiveAsTemplate(page) {
  await page.locator(".rail-row.active .rail-row-more").click();
  await page.locator('.rail-row-menu button:text-is("Save as template…")').click();
}

/** An empty session switched to the side-by-side layout. New sessions default
 * to tabs, which shows one pane at a time -- these suites are about how several
 * panes sit together, which is what side by side is for. */
async function newPanedSession(page) {
  await newSession(page);
  await page.click('.session-body:not([hidden]) button:text-is("Side by side")');
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (r) => {
    assistCalls.push(JSON.parse(r.request().postData() || "{}"));
    r.fulfill({ json: { reply: "ok\n```\nQ\n```", suggested_query: "Q" } });
  });
  await page.route("**/api/tools/http-request", (r) =>
    r.fulfill({
      json: {
        status_code: 500,
        status_text: "Internal Server Error",
        elapsed_ms: 9,
        headers: [{ key: "content-type", value: "text/plain" }],
        body: "boom",
        body_truncated: false,
      },
    })
  );
  await page.route("**/api/iot/search", (r) =>
    r.fulfill({
      json: {
        results: [
          {
            environment_id: 1,
            environment_name: "Demo Env",
            account_id: "111122223333",
            region: "us-east-1",
            things: [
              {
                thing_name: "thing-alpha",
                thing_id: null,
                thing_type_name: null,
                thing_group_names: [],
                attributes: {},
                connected: true,
                connectivity_timestamp: null,
              },
            ],
            error: null,
          },
        ],
      },
    })
  );

  /** The pane titles in the order they're actually laid out on screen. */
  // Scoped to the session on screen: opening a saved session leaves the
  // previous one mounted (hidden), so a page-wide selector sees both.
  async function paneOrder() {
    return page.evaluate(() =>
      Array.from(document.querySelectorAll(".session-body:not([hidden]) .aggregator-pane"))
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.top - rb.top || ra.left - rb.left;
        })
        .map((p) => p.querySelector("h3")?.textContent ?? "")
    );
  }
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

  await newPanedSession(page);
  await page.waitForSelector("text=Choose one or more services");

  // ---------- 1. Individual tools are options ----------
  const toolNames = ["HTTP client", "MQTT tester", "JWT", "Base64", "Diff"];
  for (const name of toolNames) {
    check(
      (await page.locator(`${SESSION} label.checkbox-item:text-is("${name}") input`).count()) === 1,
      `"${name}" is offered as its own Aggregator pane`
    );
  }
  check(
    (await page.locator(`${SESSION} label.checkbox-item:text-is("Tools") input`).count()) === 0,
    "There is no single catch-all Tools pane any more"
  );
  // The picker separates the two kinds of thing.
  check(
    (await page.locator(`${SESSION} .toolbar:has-text("Services") .checkbox-item`).count()) === 6 &&
      (await page.locator(`${SESSION} .toolbar:has-text("Tools") .checkbox-item`).count()) === 5,
    "The picker groups search services and tools separately"
  );

  await page.click(`${SESSION} label.checkbox-item:text-is("CloudWatch") input`);
  await page.click(`${SESSION} label.checkbox-item:text-is("IoT") input`);
  await page.click(`${SESSION} label.checkbox-item:text-is("HTTP client") input`);
  await page.waitForSelector(".aggregator-pane >> nth=2");

  const toolsPane = '.aggregator-pane:has(h3:text-is("HTTP client"))';
  check(
    (await page.locator(`${toolsPane} input[placeholder="https://api.example.com/resource"]`).count()) === 1,
    "The HTTP client pane renders the tool itself, ready to use"
  );
  check(
    (await page.locator(`${toolsPane} .tool-card`).count()) === 0,
    "It renders bare -- no tool card inside the pane, the pane's own title bar is the card"
  );
  check(
    (await page.locator(".aggregator-pane").count()) === 3,
    "Picking one tool opens one pane, not a grid of five"
  );

  // The HTTP client carries its own assistant, so opening it inside the
  // Aggregator must register it as a target rather than float a second widget.
  check(
    (await page.locator(".ai-widget-button").count()) === 1,
    "Only one assistant button, even with a tool pane open"
  );

  // A second tool opens alongside it as its own pane.
  await page.click(`${SESSION} label.checkbox-item:text-is("JWT") input`);
  await page.waitForSelector('.aggregator-pane:has(h3:text-is("JWT"))');
  check(
    (await page.locator(".aggregator-pane").count()) === 4,
    "Adding another tool adds another pane"
  );
  await page.click(`${SESSION} label.checkbox-item:text-is("JWT") input`);
  await page.waitForFunction(() => document.querySelectorAll(".aggregator-pane").length === 3);

  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  await page.click('.ai-widget-panel .tab:has-text("Build query")');
  let targets = await page.locator(".ai-widget-panel select option").allTextContents();
  check(
    targets.some((t) => t.includes("HTTP client")),
    "The HTTP client becomes a 'Build for' target inside the Aggregator",
    JSON.stringify(targets)
  );

  // Its exchange pools into the cross-service question like any other rows.
  await page.click('.ai-widget-panel button[aria-label="Close"]');
  await page.fill(`${toolsPane} input[placeholder="https://api.example.com/resource"]`, "https://api.example.com/x");
  await page.click(`${toolsPane} button:has-text("Send")`);
  await page.waitForSelector(`${toolsPane} >> text=500 Internal Server Error`);
  await page.click(".ai-widget-button");
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  await page.waitForSelector(".ai-widget-panel >> text=Across HTTP client.");
  const before = assistCalls.length;
  await page.fill(".ai-widget-textarea", "what happened?");
  await page.click('.ai-widget-panel button:has-text("Ask")');
  for (let i = 0; i < 50 && assistCalls.length === before; i++) await page.waitForTimeout(100);
  const row = assistCalls[assistCalls.length - 1]?.sample_rows?.[0];
  check(
    row?.service === "HTTP client" && row?.response?.status_code === 500,
    "The tool's exchange pools into the cross-service question, tagged by service",
    JSON.stringify(row?.service)
  );
  await page.click('.ai-widget-panel button[aria-label="Close"]');

  // Closing the pane drops it as a target again.
  await page.click(`${SESSION} label.checkbox-item:text-is("HTTP client") input`);
  await page.waitForFunction(() => document.querySelectorAll(".aggregator-pane").length === 2);
  await page.click(".ai-widget-button");
  await page.click('.ai-widget-panel .tab:has-text("Build query")');
  targets = await page.locator(".ai-widget-panel select option").allTextContents();
  check(
    !targets.some((t) => t.includes("HTTP client")),
    "Closing the tool pane drops it as an assistant target",
    JSON.stringify(targets)
  );
  await page.click('.ai-widget-panel button[aria-label="Close"]');
  await page.click(`${SESSION} label.checkbox-item:text-is("HTTP client") input`);
  await page.waitForSelector('.aggregator-pane:has(h3:text-is("HTTP client"))');

  // ---------- 2. Reordering ----------
  check(
    JSON.stringify(await paneOrder()) === JSON.stringify(["CloudWatch", "IoT", "HTTP client"]),
    "Panes start in the order they were opened",
    JSON.stringify(await paneOrder())
  );

  // Side by side: the arrows read left/right.
  const iotPane = '.aggregator-pane:has(h3:text-is("IoT"))';
  check(
    (await page.locator(`${iotPane} button[aria-label="Move IoT left"]`).count()) === 1 &&
      (await page.locator(`${iotPane} button[aria-label="Move IoT right"]`).count()) === 1,
    "Side by side: the move buttons say left/right"
  );

  await page.click(`${iotPane} button[aria-label="Move IoT left"]`);
  check(
    JSON.stringify(await paneOrder()) === JSON.stringify(["IoT", "CloudWatch", "HTTP client"]),
    "Moving a pane left swaps it with the one before",
    JSON.stringify(await paneOrder())
  );
  check(
    !(await page.locator(`${iotPane} .aggregator-pane-body`).isVisible()) === false,
    "Moving a pane doesn't minimise it (the button's click stays off the header)"
  );

  check(
    await page.locator(`${iotPane} button[aria-label="Move IoT left"]`).isDisabled(),
    "The first pane can't move any further left"
  );
  check(
    await page.locator('.aggregator-pane:has(h3:text-is("HTTP client")) button[aria-label="Move HTTP client right"]').isDisabled(),
    "The last pane can't move any further right"
  );

  await page.click('.aggregator-pane:has(h3:text-is("CloudWatch")) button[aria-label="Move CloudWatch right"]');
  check(
    JSON.stringify(await paneOrder()) === JSON.stringify(["IoT", "HTTP client", "CloudWatch"]),
    "Moving right swaps with the one after",
    JSON.stringify(await paneOrder())
  );
  await page.screenshot({ path: `${SHOT}/agg-reordered.png` });

  // Stacked: the same buttons read up/down.
  await page.click(`${SESSION} button:text-is("Stacked")`);
  await page.waitForSelector(".aggregator-stack");
  check(
    (await page.locator(`${iotPane} button[aria-label="Move IoT down"]`).count()) === 1 &&
      (await page.locator(`${iotPane} button[aria-label="Move IoT left"]`).count()) === 0,
    "Stacked: the same buttons read up/down instead"
  );
  await page.click(`${iotPane} button[aria-label="Move IoT down"]`);
  check(
    JSON.stringify(await paneOrder()) === JSON.stringify(["HTTP client", "IoT", "CloudWatch"]),
    "Stacked: moving down works on the vertical order",
    JSON.stringify(await paneOrder())
  );
  check(
    JSON.stringify(await page.locator(`${SESSION} label.checkbox-item`).allTextContents()) ===
      JSON.stringify(["CloudWatch", "OpenSearch", "IoT", "DynamoDB", "S3", "Cognito", "HTTP client", "MQTT tester", "JWT", "Base64", "Diff"]),
    "Reordering panes leaves the picker's own checkboxes in their fixed order",
    JSON.stringify(await page.locator(`${SESSION} label.checkbox-item`).allTextContents())
  );

  // Reordering by dragging lives in smoke21, which drives it with real mouse
  // input -- Playwright's dragTo() injects synthetic drag events and so can
  // pass against an implementation a person's mouse can't actually use.
  await page.click(`${SESSION} button:text-is("Side by side")`);
  await page.waitForSelector(".aggregator-columns");
  const beforeSwitch = await paneOrder();
  check(
    JSON.stringify(beforeSwitch) === JSON.stringify(["HTTP client", "IoT", "CloudWatch"]),
    "Switching layout keeps the order the arrows produced",
    JSON.stringify(beforeSwitch)
  );

  // Clicking the title bar still minimises.
  await page.click('.aggregator-pane:has(h3:text-is("CloudWatch")) .aggregator-pane-header h3');
  await page.waitForSelector('.aggregator-pane:has(h3:text-is("CloudWatch")) button[aria-label="Expand CloudWatch"]');
  check(true, "Clicking the title bar still minimises");

  // ---------- The order survives a save/load round trip ----------
  // Unique per run -- the smoke database persists, so a fixed name would
  // load an older run's session instead of this one's.
  // Saving and opening a session live in the strip now, not in each page.
  const sessionName = `Reordered ${Date.now()}`;
  await page.waitForTimeout(600);
  page.once("dialog", (d) => d.accept(sessionName));
  await saveActiveAsTemplate(page);
  await page.waitForTimeout(700);
  await page.click(`.rail-row-template:has(.rail-row-label:text-is("${sessionName}"))`);
  await page.waitForSelector(`.rail-row-label:text-is("${sessionName}")`);
  await page.waitForFunction(
    () => document.querySelectorAll(".session-body:not([hidden]) .aggregator-pane").length === 3,
  );
  check(
    JSON.stringify(await paneOrder()) === JSON.stringify(beforeSwitch),
    "A saved session restores the pane order, not just which panes",
    JSON.stringify(await paneOrder())
  );

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
