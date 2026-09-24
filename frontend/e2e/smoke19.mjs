import { ADMIN_PASSWORD, ADMIN_USER, BASE, SHOT, check, launch, newSession, report } from "./harness.mjs";

const assistCalls = [];
// What the mocked assistant replies with next -- set per assertion so each
// one can drive a different suggestion shape through the parser.
let nextBlock = "{}";

const CARD = ".session-body:not([hidden])";
const APPLY = '.ai-widget-panel button:has-text("Use this request")';
const URL_INPUT = 'input[placeholder="https://api.example.com/resource"]';
const METHOD_SELECT = `${CARD} select >> nth=0`;

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));

  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { configured: true } }));
  await page.route("**/api/ai/assist", (r) => {
    assistCalls.push(JSON.parse(r.request().postData() || "{}"));
    r.fulfill({ json: { reply: `Here you go.\n\`\`\`json\n${nextBlock}\n\`\`\``, suggested_query: nextBlock } });
  });
  // The HTTP tool's own send endpoint -- a 403, so there's something worth asking about.
  await page.route("**/api/tools/http-request", (r) =>
    r.fulfill({
      json: {
        status_code: 403,
        status_text: "Forbidden",
        elapsed_ms: 12,
        headers: [{ key: "content-type", value: "application/json" }],
        body: '{"message":"Missing Authentication Token"}',
        body_truncated: false,
      },
    })
  );

  // assistCalls grows when the request goes out, not when the reply renders,
  // so applying has to wait for the new reply's own button to appear.
  async function ask(question) {
    const before = assistCalls.length;
    await page.fill(".ai-widget-textarea", question);
    await page.click('.ai-widget-panel button:has-text("Ask")');
    for (let i = 0; i < 50 && assistCalls.length === before; i++) await page.waitForTimeout(100);
    return assistCalls[assistCalls.length - 1];
  }
  async function applyLatest(expectedCount) {
    // :has-text() is a Playwright selector, not a CSS one, so this polls
    // through the locator rather than running querySelectorAll in the page.
    for (let i = 0; i < 100 && (await page.locator(APPLY).count()) < expectedCount; i++) {
      await page.waitForTimeout(100);
    }
    await page.locator(APPLY).last().click();
  }
  async function headerKeys() {
    const inputs = await page.locator(`${CARD} input[placeholder="Header name"]`).all();
    return Promise.all(inputs.map((h) => h.inputValue()));
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

  // ---------- The assistant is scoped to the HTTP Client tool ----------
  await openSession(page, "HTTP client");
  await page.waitForSelector(`${CARD} input[placeholder="https://api.example.com/resource"]`);
  check((await page.locator(".ai-widget-button").count()) === 1, "The HTTP client session brings its assistant with it");

  // A different tool is a different session, with no assistant of its own.
  await openSession(page, "JWT");
  check(
    (await page.locator(".ai-widget-button").count()) === 0,
    "A tool with nothing to ask about has no assistant"
  );
  await openSession(page, "HTTP client");
  await page.waitForSelector(".ai-widget-button");
  check(true, "Reopening the HTTP client brings it back");

  // ---------- Build a request from scratch ----------
  await page.click(".ai-widget-button");
  await page.waitForSelector(".ai-widget-panel");
  check(
    (await page.locator('.ai-widget-panel .tab:has-text("Build query")').count()) === 1,
    "HTTP: the assistant offers Build query"
  );

  nextBlock = JSON.stringify({
    method: "POST",
    url: "https://api.example.com/v1/things",
    headers: { "Content-Type": "application/json", Authorization: "Bearer <token>" },
    body: '{"name":"thing-1"}',
  });
  let call = await ask("create a thing");
  check(call?.domain === "tools-http", "HTTP: the request carries domain=tools-http", JSON.stringify(call?.domain));
  check(
    call?.query_string === undefined || call?.query_string === null,
    "HTTP: an empty form sends no 'current request' to refine",
    JSON.stringify(call?.query_string)
  );

  // The button says "request", not "query" -- what it applies isn't a query.
  await page.waitForSelector(APPLY);
  check(
    (await page.locator('.ai-widget-panel button:has-text("Use this query")').count()) === 0,
    "HTTP: the apply button is labelled 'Use this request', not 'Use this query'"
  );

  await applyLatest(1);
  check((await page.inputValue(URL_INPUT)) === "https://api.example.com/v1/things", "HTTP: the URL lands in the form");
  check((await page.inputValue(METHOD_SELECT)) === "POST", "HTTP: the method lands in the form");
  const keys1 = await headerKeys();
  check(
    keys1.includes("Content-Type") && keys1.includes("Authorization"),
    "HTTP: every header lands as its own row",
    JSON.stringify(keys1)
  );
  check(
    (await page.inputValue(`${CARD} textarea`)) === '{"name":"thing-1"}',
    "HTTP: the body lands in the form"
  );
  await page.screenshot({ path: `${SHOT}/http-ai-applied.png` });

  // ---------- Refining sends the current form back as context ----------
  nextBlock = JSON.stringify({
    method: "POST",
    url: "https://api.example.com/v1/things",
    headers: { "Content-Type": "application/json", Authorization: "Bearer <token>", "X-Trace": "1" },
    body: '{"name":"thing-1"}',
  });
  call = await ask("add a trace header");
  const sent = JSON.parse(call?.query_string ?? "{}");
  check(
    sent.url === "https://api.example.com/v1/things" && sent.method === "POST" && !!sent.headers?.Authorization,
    "HTTP: the current form goes along as the request to refine",
    call?.query_string
  );

  // ---------- Tolerant parsing of the shapes a model actually emits ----------
  nextBlock = JSON.stringify({
    method: "put",
    url: "https://api.example.com/v1/things/1",
    headers: [{ key: "X-Api-Key", value: "abc" }],
    body: { name: "thing-1", enabled: true },
  });
  await ask("make it an update");
  await applyLatest(3);
  check((await page.inputValue(METHOD_SELECT)) === "PUT", "HTTP: a lower-case method is still accepted");
  const keys2 = await headerKeys();
  check(
    keys2.includes("X-Api-Key") && !keys2.includes("X-Trace"),
    "HTTP: headers given as an array are accepted, and replace the old rows",
    JSON.stringify(keys2)
  );
  const body2 = await page.inputValue(`${CARD} textarea`);
  check(
    body2.includes('"name": "thing-1"') && body2.includes('"enabled": true'),
    "HTTP: a body inlined as an object is rendered back out, not dropped",
    body2
  );

  // ---------- A malformed suggestion says so instead of silently failing ----------
  nextBlock = "{ not json at all }";
  await ask("something broken");
  await applyLatest(4);
  await page.waitForSelector(`${CARD} .error-text`);
  check(true, "HTTP: an unparseable suggestion surfaces an error rather than doing nothing");
  check(
    (await page.inputValue(URL_INPUT)) === "https://api.example.com/v1/things/1",
    "HTTP: a bad suggestion leaves the form as it was"
  );

  // ---------- About results is the last exchange ----------
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  check(
    (await page.locator(".ai-widget-panel >> text=Send a request first").count()) === 1,
    "HTTP: with no response yet, About results says to send one"
  );
  check(
    await page.locator('.ai-widget-panel button:has-text("Ask")').isDisabled(),
    "HTTP: Ask is disabled until there's a response"
  );

  await page.click('.ai-widget-panel button[aria-label="Close"]');
  await page.click(`${CARD} button:has-text("Send")`);
  await page.waitForSelector("text=403 Forbidden");
  await page.click(".ai-widget-button");
  await page.click('.ai-widget-panel .tab:has-text("About results")');
  await page.waitForSelector(".ai-widget-panel >> text=Asking about the request you just sent");
  check(true, "HTTP: once a response is in, About results names the exchange");

  call = await ask("why is this 403?");
  const row = call?.sample_rows?.[0];
  check(call?.mode === "ask_results", "HTTP: the question goes as ask_results");
  check(
    row?.response?.status_code === 403 && row?.response?.body?.includes("Missing Authentication Token"),
    "HTTP: the response goes with the question",
    JSON.stringify(row?.response)
  );
  check(
    row?.request?.method === "PUT" && row?.request?.url === "https://api.example.com/v1/things/1",
    "HTTP: the request that produced it goes too -- a 403 is unanswerable without it",
    JSON.stringify(row?.request)
  );

  await browser.close();
  report();
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
