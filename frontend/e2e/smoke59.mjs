// The HTTP client's Auth (PLATFORM_PLAN.md §13.8): pick a stored credential,
// Send, and the backend -- not the browser -- resolves it and adds the
// header. What a browser suite can prove of that, end to end:
//   - the Auth picker offers the credentials that can authenticate a request,
//     and only those;
//   - what the browser sends is the credential's id, never its value;
//   - the backend really resolved it (its audit log records the use, for this
//     request's host), even though the request itself can't go anywhere here
//     (the sandbox has no route out, and the SSRF guard rightly refuses every
//     local echo server) -- the header injection itself is pinned by the
//     backend's own tests;
//   - the session stores the id only, and no response ever carries the secret.
// Needs a backend with PLATFORM_MASTER_KEYS set (see README).
import { check, clearWorkspace, launch, newSession, openApp, report, SHOWN } from "./harness.mjs";

const SECRET = "e2e-token-never-in-the-browser-9931";
const HOST = "e2e-auth-check.invalid";

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
  const creds = (await api(page, "GET", "/credentials")).body ?? [];
  for (const c of creds.filter((c) => c.name.startsWith("e2e-"))) await api(page, "DELETE", `/credentials/${c.id}`);
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await clearWorkspace(page);
  await cleanUp(page);
  const token = (await api(page, "POST", "/credentials", {
    name: "e2e-api-token", type_id: "api_token", scope: "global", values: { token: SECRET },
  })).body;
  await api(page, "POST", "/credentials", {
    name: "e2e-plain-secret", type_id: "secret_text", scope: "global", values: { value: "not-for-requests" },
  });
  check(!!token?.id, "A token credential exists to pick", JSON.stringify(token));

  const bodies = [];
  const sentRequests = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/tools/http-request")) sentRequests.push(req.postData() ?? "");
  });
  page.on("response", async (res) => {
    if (!res.url().includes("/api/")) return;
    try {
      bodies.push(await res.text());
    } catch {
      // streamed or aborted; nothing to keep
    }
  });

  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "HTTP client");
  // The only pane of the session on screen.
  const pane = SHOWN;
  await page.waitForSelector(`${pane} #http-auth`);
  await page.waitForSelector(`${pane} #http-auth option:text-is("e2e-api-token (API token)")`, { state: "attached" });
  const options = await page.locator(`${pane} #http-auth option`).allInnerTexts();
  check(options.includes("e2e-api-token (API token)"), "The Auth picker offers a credential that can authenticate", JSON.stringify(options));
  check(!options.some((o) => o.startsWith("e2e-plain-secret")), "…and not one whose type can't", JSON.stringify(options));

  await page.selectOption(`${pane} #http-auth`, { label: "e2e-api-token (API token)" });
  await page.fill(`${pane} input[placeholder="https://api.example.com/resource"]`, `https://${HOST}/me`);
  await page.click(`${pane} button:text-is("Send")`);
  await page.waitForSelector(`${pane} .error-text`, { timeout: 40000 });
  const error = await page.locator(`${pane} .error-text`).innerText();
  check(error.includes(HOST) && !error.startsWith("400"), "A failed send shows the backend's own sentence", error);

  const sent = sentRequests.map((b) => JSON.parse(b));
  check(sent.length === 1 && sent[0].credential_id === token.id, "The browser sent the credential's id", JSON.stringify(sent));
  check(!sentRequests.some((b) => b.includes(SECRET)), "…and never its value");

  const history = (await api(page, "GET", `/audit?object=credential:${token.id}`)).body;
  const use = history.find((e) => e.action === "credential.use");
  check(use?.detail?.purpose === `HTTP client: GET ${HOST}`, "The backend resolved it for this request (audited)", JSON.stringify(use));

  await page.waitForTimeout(1600); // the autosave debounce
  const sessions = (await api(page, "GET", "/live-sessions")).body;
  const live = (await api(page, "GET", `/live-sessions/${sessions[0].client_id}`)).body;
  const state = JSON.stringify(live.state);
  check(state.includes(`"tool-http.credentialId":${token.id}`), "The session stores the credential's id", state.slice(0, 300));
  check(!state.includes(SECRET), "…and nothing secret");

  const leaked = bodies.filter((b) => b.includes(SECRET));
  check(leaked.length === 0, `No response, out of ${bodies.length}, ever carried the secret`, leaked[0]?.slice(0, 200));

  await clearWorkspace(page);
  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
