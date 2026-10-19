// Two reports from use, after 4b-3:
//   - The Workflow pane: picking a workflow showed no parameters to fill in --
//     only name/value rows a person had to know the keys for -- and Run failed
//     with "Fill in Environment.". Now its parameters are the Workflows page's
//     own fields: the environment picked by name, the log groups listed from
//     it (the CloudWatch example, against the faked backend's log groups), and
//     the run gets both.
//   - S3's filename search over a big bucket gave up after a slice of it and
//     said "Nothing here." -- the file was further in. Now it says how far it
//     searched and Load more searches on.
import { readFileSync } from "node:fs";
import { check, clearWorkspace, launch, mockPaneActions, newSession, openApp, report, SHOWN, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const WF = `pane_params_${STAMP}`;
const LABEL = `Errors ${STAMP}`;
const SOURCE = readFileSync(new URL("../../examples/workflows/02-cloudwatch-errors.yaml", import.meta.url), "utf8").replace(
  "label: Errors in a log group",
  `label: ${LABEL}`,
);
const FORM = `${SHOWN} .workflow-pane-params`;
const SEARCH_BOX = `${SHOWN} input[placeholder^="Search names"]`;

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  await clearWorkspace(page);
  let env = (await api(page, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(page, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const wf = (await api(page, "POST", "/workflows", { id: WF, source: SOURCE })).body;

  try {
    // ---- 1. the Workflow pane asks for the chosen workflow's parameters
    await newSession(page, "Workflow");
    await page.waitForSelector(`${SHOWN} select[aria-label="workflow"] option:text-is("${LABEL}")`, { state: "attached", timeout: 10000 });
    await page.selectOption(`${SHOWN} select[aria-label="workflow"]`, { label: LABEL });
    await page.waitForSelector(`${FORM} .session-card-row`, { timeout: 10000 });
    const labels = await page.locator(`${FORM} .session-card-label`).allInnerTexts();
    check(JSON.stringify(labels) === JSON.stringify(["Environment *", "Log groups *", "Matching (a regex)", "Over the last (hours)"]),
      "Picking a workflow shows its parameters, as the Workflows page does", JSON.stringify(labels));
    const pattern = await page.locator(`${FORM} .session-card-row:has-text("Matching") input`).inputValue();
    check(pattern === "ERROR", "…a parameter's default filled in", pattern);
    await page.waitForSelector(`${FORM} .workflow-param-status:has-text("Choose Environment first.")`);
    const envSelect = `${FORM} .session-card-row:has-text("Environment") select`;
    const option = (await page.locator(`${envSelect} option`).allInnerTexts()).find((o) => o.includes("e2e-fake-aws"));
    await page.selectOption(envSelect, { label: option });
    await page.waitForSelector(`${FORM} .workflow-param-status:has-text("2 to choose from")`, { timeout: 15000 });
    check(true, "…the environment picked by name, and the log groups listed from it");
    const groups = `${FORM} .session-card-row:has-text("Log groups") input`;
    await page.fill(groups, "/fake/api");
    await page.waitForSelector(`${FORM} [data-chosen="/fake/api"]`);
    await page.screenshot({ path: `${SHOT}/smoke89-workflow-pane.png` });
    await page.waitForTimeout(400);
    await page.click(`${SHOWN} button:text-is("Run")`);
    await page.waitForSelector(`${SHOWN} :text("${LABEL} #1: succeeded")`, { timeout: 30000 });
    const [made] = (await api(page, "GET", `/workflows/${encodeURIComponent(wf.id)}/runs`)).body;
    check(made.params.env === env.id && JSON.stringify(made.params.groups) === JSON.stringify(["/fake/api"]) && made.params.pattern === "ERROR",
      "Run starts it with what was filled in, and the defaults", JSON.stringify(made.params));
    const stages = await page.locator(`${SHOWN} table tbody tr`).allInnerTexts();
    check(stages.length === 3 && stages[0].includes("succeeded"), "…and follows it to the end", JSON.stringify(stages));

    // ---- 2. S3's search says how far it got, and searches on
    const asked = [];
    await mockPaneActions(page, "buckets", {
      list_buckets: { options: [{ value: "big-bucket", label: "big-bucket" }] },
      browse: ({ inputs, cursor }) => {
        asked.push({ search: inputs.search, cursor: cursor ?? null });
        const base = { bucketRegion: "eu-west-1", activeSearch: inputs.search, folders: [] };
        if (!inputs.search) return { ...base, folders: [{ name: "a", prefix: "a/" }], files: [], continuationToken: "c1", searched: 0, searchGoesOn: null };
        if (!cursor) return { ...base, files: [], continuationToken: "after:a/49999.log", searched: 50000, searchGoesOn: true };
        const found = [{ key: "z/wanted-report.csv", name: "wanted-report.csv", size: 9, last_modified: 1700000000, storage_class: null }];
        return { ...base, files: found, continuationToken: null, searched: 1200, searchGoesOn: null };
      },
    });
    await newSession(page, "S3");
    const card = `${SHOWN} .panel:has-text("Choose environment and bucket")`;
    await page.selectOption(`${card} select >> nth=0`, { index: 1 });
    await page.click(`${SHOWN} button:has-text("Load buckets")`);
    await page.waitForSelector(`${SHOWN} option[value="big-bucket"]`, { state: "attached" });
    await page.selectOption(`${card} select >> nth=1`, "big-bucket");
    await page.waitForSelector(`${SHOWN} .result-row-summary:has-text("a/")`);
    check((await page.locator(`${SHOWN} :text("so far and the bucket has more")`).count()) === 0, "Browsing a folder says nothing of searching");
    await page.fill(SEARCH_BOX, "wanted");
    await page.press(SEARCH_BOX, "Enter");
    const note = await page.locator(`${SHOWN} :text("so far and the bucket has more")`).innerText({ timeout: 10000 });
    check(note.startsWith("Searched 50000 file(s) so far"), "A search that hasn't reached the end says how far it got", note);
    await page.locator(`${SHOWN} .panel:has-text("2. Browse")`).screenshot({ path: `${SHOT}/smoke89-s3-search.png` });
    await page.click(`${SHOWN} button:text-is("Load more")`);
    await page.waitForSelector(`${SHOWN} .result-row-summary:has-text("z/wanted-report.csv")`, { timeout: 10000 });
    check(asked.at(-1).cursor === "after:a/49999.log" && asked.at(-1).search === "wanted", "Load more searches on from there",
      JSON.stringify(asked));
    check((await page.locator(`${SHOWN} :text("so far and the bucket has more")`).count()) === 0, "…and finds it, at the end of the bucket");
  } finally {
    await api(page, "DELETE", `/workflows/${encodeURIComponent(wf.id)}`);
  }
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
