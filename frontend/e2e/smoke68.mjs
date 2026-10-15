// The HTTP client drawn from its manifest (PLATFORM_PLAN.md §16.4.4), driven
// the way a user would:
//   - the Body card is there only for a method that sends one;
//   - Add header / Remove edit the header rows, and Send sends exactly the
//     pane's inputs to the one action endpoint;
//   - the response: status toned by range, time, "truncated", headers,
//     the body pretty-printed;
//   - the last exchange is always offered to the agent's chat, no checkbox;
//   - a failed send is its own card, and leaves no response or exchange;
//   - Saved inputs (the pane's ⋮) keep a request, headers included;
//   - a session saved by the old tool opens with its request and response.
import { check, clearWorkspace, launch, mockPaneActions, newSession, openApp, report, SHOWN, openPaneMenu } from "./harness.mjs";

const NAME = "e2e-http-orders";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function cleanUp(page) {
  for (const s of (await api(page, "GET", "/saved-inputs?pane_type=tool-http")).body ?? [])
    if (s.name.startsWith("e2e-")) await api(page, "DELETE", `/saved-inputs/${s.id}`);
}

const REPLY = {
  status_code: 201, status_text: "Created", elapsed_ms: 37, body_truncated: true,
  headers: [{ key: "content-type", value: "application/json" }, { key: "x-request-id", value: "r-1" }],
  body: '{"id":7,"tags":["a"]}',
};

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const sent = [];
  let fail = false;
  await mockPaneActions(page, "tool-http", {
    send: ({ inputs }) => {
      sent.push(inputs);
      if (fail) return { __status: 400, detail: "Refusing to request 'internal.example' -- private addresses are blocked." };
      return { response: REPLY, exchange: [{ request: { method: inputs.method, url: inputs.url }, response: REPLY }] };
    },
  });
  await clearWorkspace(page);
  await cleanUp(page);
  const card = (title) => `${SHOWN} .panel:has(h2:text-is("${title}"))`;
  const method = `${SHOWN} select[aria-label="method"]`;

  // ---- 1. the Body card goes with the method
  await newSession(page, "HTTP client");
  await page.waitForSelector(card("Request"));
  check((await page.locator(card("Body")).count()) === 0, "GET has no Body card");
  await page.selectOption(method, "POST");
  await page.waitForSelector(card("Body"));
  check(true, "POST has one");
  await page.selectOption(method, "HEAD");
  check((await page.locator(card("Body")).count()) === 0, "HEAD has none again");
  await page.selectOption(method, "POST");

  // ---- 2. headers, and Send
  await page.fill(`${SHOWN} input[aria-label="URL"]`, "https://api.example.com/orders");
  await page.locator(`${card("Headers")} input[placeholder="Header name"]`).first().fill("Accept");
  await page.locator(`${card("Headers")} input[placeholder="Value"]`).first().fill("application/json");
  await page.click(`${card("Headers")} button:text-is("Add header")`);
  await page.locator(`${card("Headers")} input[placeholder="Header name"]`).nth(1).fill("X-Drop");
  check((await page.locator(`${card("Headers")} input[placeholder="Header name"]`).count()) === 2, "Add header adds a row");
  await page.locator(`${card("Headers")} button:text-is("Remove")`).nth(1).click();
  check((await page.locator(`${card("Headers")} input[placeholder="Header name"]`).count()) === 1, "Remove takes it away");
  await page.fill(`${card("Body")} textarea`, '{"qty":2}');
  await page.click(`${SHOWN} button:text-is("Send")`);
  await page.waitForSelector(`${SHOWN} h2:text-is("Response")`);
  const s0 = sent[0];
  check(s0.method === "POST" && s0.url === "https://api.example.com/orders" && s0.body === '{"qty":2}' &&
      JSON.stringify(s0.headerRows.map((r) => [r.key, r.value])) === JSON.stringify([["Accept", "application/json"]]),
    "Send sends the pane's inputs as they stand", JSON.stringify(s0));

  // ---- 3. the response
  const head = `${SHOWN} .toolbar:has(h2:text-is("Response"))`;
  check((await page.locator(`${head} .tag.ok`).innerText()) === "201 Created", "The status, toned by its range");
  check((await page.locator(`${head} .muted`).innerText()) === "37 ms", "…the time it took");
  check(await page.locator(`${head} .tag.pending:text-is("response truncated")`).isVisible(), "…and that the body was cut off");
  const headers = await page.locator(`${SHOWN} .panel:has(h2:text-is("Response")) td`).allInnerTexts();
  check(headers.includes("x-request-id") && headers.includes("r-1"), "The headers are a table", JSON.stringify(headers));
  const body = await page.locator(`${SHOWN} .panel:has(h2:text-is("Response")) pre`).innerText();
  check(body === JSON.stringify({ id: 7, tags: ["a"] }, null, 2), "The body, pretty-printed", body);

  // ---- 4. the exchange is always offered to the agent's chat
  if ((await page.locator(".agent-dock").count()) === 0) await page.click(".session-bar-agent");
  await page.click('.agent-dock .agent-tab:text-is("Session")');
  await page.waitForSelector(".agent-dock .agent-attach");
  const offered = await page.locator(".agent-dock .agent-attach").innerText();
  check(offered.includes("1 checked row") && offered.includes("1 in HTTP client"),
    "The last exchange is offered to the agent's chat, with nothing to check", offered);

  // ---- 5. a failed send
  fail = true;
  await page.click(`${SHOWN} button:text-is("Send")`);
  await page.waitForSelector(`${SHOWN} .panel > .error-text`);
  check((await page.locator(`${SHOWN} .panel > .error-text`).innerText()).startsWith("Refusing to request 'internal.example'"),
    "A failed send is its own card, in the backend's words");
  check((await page.locator(`${SHOWN} h2:text-is("Response")`).count()) === 0, "…and the last response goes");
  await page.waitForTimeout(300);
  check((await page.locator(".agent-dock .agent-attach").count()) === 0, "…and with it the exchange on offer");
  fail = false;

  // ---- 6. Saved inputs (the pane's ⋮)
  page.once("dialog", (d) => d.accept(NAME));
  await openPaneMenu(page);
  await page.click('.pane-menu-list button:text-is("Save these inputs as…")');
  await page.waitForTimeout(600);
  await newSession(page, "HTTP client");
  await page.waitForSelector(card("Request"));
  await openPaneMenu(page);
  await page.click(`.pane-menu-list [data-saved-input-item="${NAME}"]`);
  await page.waitForSelector(card("Body"));
  check((await page.inputValue(`${SHOWN} input[aria-label="URL"]`)) === "https://api.example.com/orders" &&
      (await page.locator(`${card("Headers")} input[placeholder="Header name"]`).first().inputValue()) === "Accept" &&
      (await page.inputValue(`${card("Body")} textarea`)) === '{"qty":2}',
    "A saved request comes back whole: method, URL, headers and body");

  // ---- 7. a session the old tool saved
  await clearWorkspace(page);
  const put = await api(page, "PUT", "/live-sessions/e2e-old-http", {
    title: "Old HTTP", type: "aggregator", base_version: null,
    state: {
      services: ["tool-http"], layout: "tabs", "tool-http.method": "PUT", "tool-http.url": "https://api.example.com/old",
      "tool-http.headerRows": [{ id: 1, key: "X-Old", value: "1" }], "tool-http.body": "old", "tool-http.response": REPLY,
      "tool-http.exchange": [{ request: {}, response: REPLY }], "tool-http.exchangeVersion": 4,
    },
  });
  check(put.status === 200 && put.body.state["tool-http.in.url"] === "https://api.example.com/old" &&
      !("tool-http.exchangeVersion" in put.body.state),
    "The server moves an old HTTP client session to the new keys", JSON.stringify(Object.keys(put.body?.state ?? {})));
  await page.reload();
  await page.click('.rail-row:has(.rail-row-label:text-is("Old HTTP"))');
  await page.waitForSelector(`${SHOWN} h2:text-is("Response")`);
  check((await page.inputValue(method)) === "PUT" && (await page.inputValue(`${SHOWN} input[aria-label="URL"]`)) === "https://api.example.com/old",
    "It opens with its request…");
  check((await page.locator(`${SHOWN} .toolbar:has(h2:text-is("Response")) .tag.ok`).innerText()) === "201 Created", "…and its response");

  await clearWorkspace(page);
  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
