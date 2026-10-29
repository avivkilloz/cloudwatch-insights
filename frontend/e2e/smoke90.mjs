// Published templates (PLATFORM_PLAN.md §23, D76, D99-D102):
//   - an admin publishes a saved template from Settings → Library, and is told
//     what making it portable changed (its AWS panes follow the Environment
//     variable; a secret header's value left out);
//   - a member whose group has every pane of it finds it on the default page,
//     chooses the environment and gets the session: the CloudWatch pane's
//     environment ticked, its log group kept for that environment, and a run
//     of it works (the faked backend's account "0000…");
//   - from the rail's Add, with one environment to choose from, it opens at
//     once; a member whose group can't reach that environment is offered it
//     too (every template is everyone's, D160) but can't open it there.
import { check, clearWorkspace, launch, newPage, openApp, report, SHOWN, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const NAME = `Fleet errors ${STAMP}`;
const ID = `fleet_errors_${STAMP}`;
const ABLE = `able${STAMP}`;
const UNABLE = `unable${STAMP}`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function openLibrary(page) {
  await page.click('[aria-label="Account menu"]');
  await page.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
  await page.click('.content .settings-tabs button:text-is("Library")');
  await page.waitForSelector('.panel:has(h2:text-is("Library")) .tab', { timeout: 15000 });
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const saved = (await api(page, "POST", "/saved-sessions", {
    page: "aggregator",
    name: NAME,
    state: {
      __savedStateVersion: 2,
      services: ["logs-cloudwatch", "tool-http"],
      paneTypes: { "logs-cloudwatch": "logs-cloudwatch", "tool-http": "tool-http" },
      paneTitles: { "logs-cloudwatch": "API errors", "tool-http": "Health check" },
      layout: "stacked",
      description: "Errors in the API's log group.",
      variables: { environment: env.id },
      "logs-cloudwatch.in.connections": [env.id],
      "logs-cloudwatch.in.logGroupSelection": { [String(env.id)]: { __cwiSet: ["/fake/api"] } },
      "logs-cloudwatch.in.queryString": "fields @timestamp, @message | sort @timestamp desc",
      "tool-http.in.url": "https://example.com/health",
      "tool-http.in.headerRows": [{ id: 1, key: "Authorization", value: "Bearer do-not-publish" }, { id: 2, key: "", value: "" }],
    },
  })).body;
  const groups = [];
  for (const [user, envs] of [[ABLE, [env.id]], [UNABLE, []]]) {
    const g = (await api(page, "POST", "/user-groups", { name: `g-${user}`, role_name: "R", environment_ids: envs })).body;
    groups.push(g);
    await api(page, "POST", "/users", { username: user, password: "pw-123456", group_id: g.id });
  }

  const able = await newPage(browser);
  const unable = await newPage(browser);
  try {
    // ---- 1. publish, from the Library
    await openLibrary(page);
    const row = `.result-row:has(.msg:text-is("${NAME}"))`;
    await page.click(`${row} .result-row-summary`);
    await page.click(`${row} button:text-is("Publish…")`);
    await page.fill(`${row} .publish-form input[id^="publish-id"]`, ID);
    await page.click(`${row} .publish-form button:text-is("Publish")`);
    await page.waitForSelector(`${row} [data-published="${ID}"]`, { timeout: 10000 });
    const changes = await page.locator(`${row} .publish-changes li`).allInnerTexts();
    check(changes.some((c) => c.includes("follow the Environment variable")) && changes.some((c) => c.includes("Authorization")),
      "Publishing says what making it portable changed", JSON.stringify(changes));
    await page.locator(row).screenshot({ path: `${SHOT}/smoke90-published.png` });
    const stored = (await api(page, "GET", "/templates")).body.find((t) => t.id === ID);
    check(stored && stored.needs_environment && !JSON.stringify(stored).includes("do-not-publish"), "…and it's published, asking for an environment",
      JSON.stringify(stored));
    await page.click('.panel:has(h2:text-is("Library")) .tab:text-is("Published")');
    await page.waitForSelector(`[data-published="${ID}"] .msg:text-is("${NAME}")`);
    check(true, "The Library's Published tab lists it");

    // ---- 2. a member with its panes opens it for their environment
    await signIn(able, { username: ABLE, password: "pw-123456" });
    await able.click(".rail-row-home");
    const card = `.home-ready[data-template="${ID}"]`;
    await able.waitForSelector(card, { timeout: 10000 });
    await able.click(`${card} .home-card-open`);
    const select = `${card} select[aria-label^="Environment for"]`;
    await able.waitForSelector(`${select} option:text-is("e2e-fake-aws")`, { state: "attached" });
    check((await able.locator(select).inputValue()) === String(env.id), "Its one environment is chosen already");
    await able.locator(card).screenshot({ path: `${SHOT}/smoke90-ready-made.png` });
    await able.click(`${card} button:text-is("Open")`);
    await able.waitForSelector(`${SHOWN} .aggregator-pane-header h3:text-is("API errors")`, { timeout: 15000 });
    const picked = await able.locator(`${SHOWN} :text("environment(s) selected.")`).innerText();
    check(picked.startsWith("1 "), "The session opens with the CloudWatch pane's environment ticked", picked);
    const groupsSelected = await able.locator(`${SHOWN} :text("log group(s) selected")`).first().innerText();
    check(groupsSelected.startsWith("1 "), "…its log group kept, for that environment", groupsSelected);
    await able.click(`${SHOWN} button:text-is("Run query")`);
    await able.waitForSelector(`${SHOWN} :text("row(s) across 1 target")`, { timeout: 30000 });
    check(true, "…and a run of it works");
    const mine = (await api(able, "GET", "/live-sessions")).body.find((s) => s.title === NAME);
    const state = mine ? (await api(able, "GET", `/live-sessions/${mine.client_id}`)).body.state : {};
    check(state.variables?.environment === env.id && !JSON.stringify(state).includes("do-not-publish"),
      "…its Environment variable set, and the secret header nowhere", JSON.stringify(state.variables));

    // ---- 3. from Add, one environment: at once
    await able.click('.rail-row-new');
    await able.click(`.rail-row-published:has(.rail-row-label:text-is("${NAME}"))`);
    await able.waitForFunction(
      (name) => [...document.querySelectorAll(".rail-row.active .rail-row-label")].some((e) => e.textContent?.startsWith(name)),
      NAME,
      { timeout: 15000 },
    );
    const active = await able.locator(".rail-row.active .rail-row-label").innerText();
    check(active === `${NAME} 2`, "From Add it opens at once, with one environment to choose from", active);

    // ---- 4. a member who can't reach the environment: offered it, can't open it there
    await signIn(unable, { username: UNABLE, password: "pw-123456" });
    await unable.click(".rail-row-home");
    await unable.waitForSelector(`.home-ready[data-template="${ID}"]`);
    check(true, "Every template is everyone's: a group without that environment is offered it too");
    check((await api(unable, "POST", `/templates/${ID}/open`, { environment: env.id })).status === 400,
      "…but can't open it for an environment it can't reach");
  } finally {
    await clearWorkspace(able).catch(() => undefined);
    await able.close();
    await unable.close();
    await api(page, "DELETE", `/templates/${ID}`);
    await api(page, "DELETE", `/saved-sessions/${saved.id}`);
    for (const u of (await api(page, "GET", "/users")).body.filter((u) => [ABLE, UNABLE].includes(u.username))) await api(page, "DELETE", `/users/${u.id}`);
    for (const g of groups) await api(page, "DELETE", `/user-groups/${g.id}`);
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
