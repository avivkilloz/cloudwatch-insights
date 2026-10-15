// IoT drawn from its manifest (PLATFORM_PLAN.md §16.4), driven the way a user
// would:
//   - the mode buttons put that mode's own query in and clear the last
//     search; Show examples lists them and Use fills the query in;
//   - Search sends exactly what the pane shows (the ticked environments as a
//     list, the mode, the query, Max results), and an environment that
//     failed is its own line in Target errors while the others list rows;
//   - expanding a row fetches its detail once, drawn from the manifest's
//     sections (shadows, a certificate opening to its policies, jobs);
//   - an expanded row is session state (D48): another tab of the session
//     opens it too, and fetches its detail there;
//   - Saved inputs (the pane's ⋮) keep a search: loading one in the other mode puts back its
//     mode *and* its query, not the mode's default;
//   - a session saved by the old page opens with its environments ticked and
//     its results, in the new keys.
import { check, clearWorkspace, launch, mockPaneActions, newPage, newSession, openApp, report, SHOWN, signIn, openPaneMenu } from "./harness.mjs";

const NAME = "e2e-iot-inactive";

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
  for (const s of (await api(page, "GET", "/saved-inputs?pane_type=iot")).body ?? [])
    if (s.name.startsWith("e2e-")) await api(page, "DELETE", `/saved-inputs/${s.id}`);
}

function groups(env) {
  return [
    { environment_id: env, environment_name: "Ok env", account_id: "1", region: "r", error: null,
      things: [
        { thing_name: "robot-1", thing_type_name: "sensor", connected: true, attributes: {} },
        { thing_name: "robot-2", thing_type_name: null, connected: false, attributes: {} },
      ] },
    { environment_id: 999, environment_name: "Gone env", account_id: "", region: "", error: "Environment 999 is not configured", things: [] },
  ];
}

const detail = (name) => ({
  thing_name: name, thing_arn: `arn:${name}`, version: 1, attributes: { stage: "prod" }, warnings: [],
  shadows: [{ name: "classic", version: 4, last_updated: null, reported: { fw: "1.2" }, desired: {} }],
  certificates: [{ certificate_id: "cert-9", status: "REVOKED", creation_date: null,
    policies: [{ policy_name: "AllowConnect", policy_document: { Statement: [] } }] }],
  jobs: [{ job_id: "job-1", status: "FAILED", queued_at: null, started_at: null, last_updated_at: null }],
});

async function mock(page, searched, detailed) {
  await mockPaneActions(page, "iot", {
    search: ({ inputs }) => {
      searched?.push(inputs);
      return inputs.searchMode === "certificates"
        ? { thingResults: [], certResults: [] }
        : { certResults: [], thingResults: groups(inputs.connections[0]) };
    },
    thing_detail: ({ inputs }) => {
      detailed?.push(inputs);
      return detail(inputs.thingName);
    },
  });
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const searched = [];
  const detailed = [];
  await mock(page, searched, detailed);
  await clearWorkspace(page);
  await cleanUp(page);
  const targets = (await api(page, "GET", "/targets?type=aws")).body;
  check(targets.length > 0, "There is an AWS connection to search", JSON.stringify(targets));
  const env = targets[0];
  const query = `${SHOWN} .panel:has(h2:text-is("2. Search")) input[type="text"]`;

  // ---- 1. mode, examples
  await newSession(page, "IoT");
  await page.waitForSelector(`${SHOWN} h2:text-is("1. Choose environments")`);
  check((await page.inputValue(query)) === "thingName:*", "Things start with their own default query");
  await page.click(`${SHOWN} button:text-is("Certificates")`);
  check((await page.inputValue(query)) === "status:ACTIVE", "Certificates put theirs in");
  check(await page.locator(`${SHOWN} p.muted:has-text("Fleet Indexing does not cover certificates")`).isVisible(),
    "…and say how they're searched");
  await page.click(`${SHOWN} button:text-is("Things")`);
  await page.click(`${SHOWN} button:text-is("Show examples")`);
  await page.click(`${SHOWN} .checkbox-list .row:has(code:text-is("connectivity.connected:true")) button:text-is("Use")`);
  check((await page.inputValue(query)) === "connectivity.connected:true", "Use puts an example in the query");
  await page.click(`${SHOWN} button:text-is("Hide examples")`);
  check((await page.locator(`${SHOWN} code:text-is("connectivity.connected:true")`).count()) === 0, "Hide examples hides them");

  // ---- 2. search, per-environment errors
  await page.click(`${SHOWN} button:text-is("Search")`);
  await page.waitForSelector(`${SHOWN} .panel:has(h2:text-is("2. Search")) .error-text`);
  check((await page.locator(`${SHOWN} .panel:has(h2:text-is("2. Search")) .error-text`).innerText()) ===
    "Select at least one environment to search.", "Search with nothing ticked says what's missing", "");
  check(searched.length === 0, "…without asking the server");
  // The first, as /api/targets listed it: several suites leave a "Demo Env" behind.
  const tick = `${SHOWN} .panel:has(h2:text-is("1. Choose environments")) label.checkbox-item input >> nth=0`;
  await page.click(tick);
  await page.fill(`${SHOWN} .panel:has(h2:text-is("2. Search")) input[type="number"]`, "20");
  await page.click(`${SHOWN} button:text-is("Search")`);
  await page.waitForSelector(`${SHOWN} .result-row-summary:has-text("robot-1")`);
  check(JSON.stringify(searched[0]) === JSON.stringify({
    connections: [env.id], searchMode: "things", queryString: "connectivity.connected:true", maxResults: 20,
  }), "Search sends what the pane shows: the ticked environments as a list, the mode, the query, the limit", JSON.stringify(searched[0]));
  const errors = await page.locator(`${SHOWN} .panel:has(h3:text-is("Target errors")) .error-text`).allInnerTexts();
  check(JSON.stringify(errors) === JSON.stringify(["Gone env: Environment 999 is not configured"]),
    "An environment that failed is its own line in Target errors", JSON.stringify(errors));
  const count = await page.locator(`${SHOWN} .panel:has(h2:text-is("3. Results")) .toolbar .muted`).first().innerText();
  check(count === "2 thing(s) across 2 target(s)", "…while the others' rows are listed", count);
  const tags = await page.locator(`${SHOWN} .result-row-summary:has-text("robot-1") .tag`).allInnerTexts();
  check(JSON.stringify(tags) === JSON.stringify(["Connected", "Ok env", "sensor"]), "A thing's tags: connectivity, environment, type",
    JSON.stringify(tags));

  // ---- 3. expand to fetch
  await page.click(`${SHOWN} .result-row-summary:has-text("robot-1") .msg`);
  await page.waitForSelector(`${SHOWN} h3:text-is("Shadows (1)")`);
  check(JSON.stringify(detailed) === JSON.stringify([{ connection: env.id, thingName: "robot-1" }]),
    "Expanding a row fetches its detail, with the row's environment and name", JSON.stringify(detailed));
  await page.click(`${SHOWN} .result-row-detail .result-row-summary:has-text("cert-9")`);
  await page.waitForSelector(`${SHOWN} h3:text-is("Attached policies (1)")`);
  check(await page.locator(`${SHOWN} .result-row-detail .tag.error:text-is("REVOKED")`).isVisible(),
    "A certificate inside the detail opens to its policies, its status toned");
  check(await page.locator(`${SHOWN} .result-row-detail td .tag.error:text-is("FAILED")`).isVisible(), "Jobs are a table, statuses toned");
  await page.click(`${SHOWN} .result-row-summary:has-text("robot-1") .msg`);
  await page.click(`${SHOWN} .result-row-summary:has-text("robot-1") .msg`);
  await page.waitForSelector(`${SHOWN} h3:text-is("Shadows (1)")`);
  check(detailed.length === 1, "Opening it again doesn't fetch it again", JSON.stringify(detailed));

  // ---- 4. another tab of the session opens the same row, and fetches its detail itself (D48)
  await page.waitForTimeout(2000); // the debounced save
  const other = await newPage(browser);
  const otherDetailed = [];
  await mock(other, null, otherDetailed);
  await signIn(other);
  await other.click('.rail-row:has(.rail-row-label:text-is("IoT"))');
  await other.waitForSelector(`${SHOWN} h3:text-is("Shadows (1)")`, { timeout: 15000 });
  check(otherDetailed.length === 1 && otherDetailed[0].thingName === "robot-1",
    "Another tab of the session shows the row open, its detail fetched there", JSON.stringify(otherDetailed));
  await other.close();

  // ---- 5. Saved inputs (the pane's ⋮) keep the mode and the query
  await page.click(`${SHOWN} button:text-is("Certificates")`);
  await page.fill(query, "status:INACTIVE");
  page.once("dialog", (d) => d.accept(NAME));
  await openPaneMenu(page);
  await page.click('.pane-menu-list button:text-is("Save these inputs as…")');
  await page.waitForTimeout(600);
  await page.click(`${SHOWN} button:text-is("Things")`);
  check((await page.inputValue(query)) === "thingName:*", "Back to things, the query is theirs");
  await openPaneMenu(page);
  await page.click(`.pane-menu-list [data-saved-input-item="${NAME}"]`);
  await page.waitForTimeout(300);
  check(
    (await page.inputValue(query)) === "status:INACTIVE" &&
      (await page.locator(`${SHOWN} button:text-is("Certificates")`).getAttribute("class")) === "",
    "Loading the saved search puts back its mode and its own query, not the mode's default",
    await page.inputValue(query),
  );

  // ---- 6. a session the old page saved
  await clearWorkspace(page);
  const put = await api(page, "PUT", "/live-sessions/e2e-old-iot", {
    title: "Old IoT", type: "aggregator", base_version: null,
    state: {
      services: ["iot"], layout: "tabs",
      "iot.selectedEnvironmentIds": { __cwiSet: [env.id] }, "iot.searchMode": "things", "iot.queryString": "thingName:old-*",
      "iot.maxResults": 50, "iot.thingResults": groups(env.id).slice(0, 1), "iot.ranAt": Date.now() - 3600_000, "iot.resultsVersion": 3,
    },
  });
  // Its results move further: into the pane's own record, beside the state (D21).
  check(put.status === 200 && put.body.state["iot.in.connections"]?.__cwiSet?.[0] === env.id
    && put.body.outputs?.iot?.values?.thingResults && !Object.keys(put.body.state).some((k) => k.includes(".out.")),
    "The server moves an old IoT session to the new keys, its results to the pane's record",
    JSON.stringify(Object.keys(put.body?.state ?? {})));
  await page.reload();
  await page.click('.rail-row:has(.rail-row-label:text-is("Old IoT"))');
  await page.waitForSelector(`${SHOWN} .result-row-summary:has-text("robot-1")`);
  check(await page.locator(tick).isChecked(),
    "It opens with its environment ticked");
  check((await page.inputValue(query)) === "thingName:old-*", "…its query");
  check(await page.locator(`${SHOWN} :text("Showing results fetched")`).first().isVisible(), "…and its results, said to be restored");

  await clearWorkspace(page);
  await cleanUp(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
