// The list and file-browser outputs of the ported panes (PLATFORM_PLAN.md
// §16.3), driven the way a user would:
//   - S3: picking a bucket opens it; a folder opens it; the breadcrumbs go
//     back up; a search runs recursively and Clear search undoes it -- each
//     one run with exactly the inputs the pane shows;
//   - Copy S3 URI / Copy object URL copy the row's own address, the URL with
//     each path segment encoded, and say so where the old page did;
//   - Load more appends and keeps the rows you checked checked;
//   - an expanded row is session state (D48): another tab of the same
//     session shows it expanded too;
//   - Cognito's tags take their tones from the row.
import { check, clearWorkspace, launch, mockPaneActions, newPage, newSession, openApp, report, SHOWN, signIn } from "./harness.mjs";

const FILES = [
  { key: "logs/a b.txt", name: "a b.txt", size: 42, last_modified: 1700000000, storage_class: null },
  { key: "logs/bravo.bin", name: "bravo.bin", size: 4300000, last_modified: 1700000600, storage_class: null },
];
const MORE = [{ key: "logs/zulu.txt", name: "zulu.txt", size: 1, last_modified: 1700000700, storage_class: null }];

const run = async () => {
  const browser = await launch();
  const page = await openApp(browser);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  const browsed = [];
  await mockPaneActions(page, "buckets", {
    list_buckets: { options: [{ value: "demo-bucket", label: "demo-bucket" }] },
    browse: ({ inputs, cursor }) => {
      browsed.push({ prefix: inputs.prefix, search: inputs.search, cursor: cursor ?? null });
      if (cursor) return { bucketRegion: "eu-west-1", activeSearch: inputs.search, folders: [], files: MORE, continuationToken: null };
      return {
        bucketRegion: "eu-west-1",
        activeSearch: inputs.search,
        folders: inputs.search ? [] : [{ name: "2024", prefix: `${inputs.prefix}2024/` }],
        files: FILES,
        continuationToken: "c1",
      };
    },
  });
  await mockPaneActions(page, "tables", {
    list_tables: { options: [{ value: "T", label: "T" }] },
    describe: { tableInfo: { table_name: "T", status: "ACTIVE", item_count: 2, size_bytes: 1, partition_key: "id", sort_key: null } },
    scan: { items: [{ id: "1", name: "Alice" }, { id: "2", name: "Bob" }], scannedCount: 2, lastEvaluatedKey: null },
  });
  await mockPaneActions(page, "cognito", {
    list_user_pools: { options: [{ value: "p1", label: "Pool (p1)" }] },
    search: {
      users: [
        { username: "alice", status: "CONFIRMED", enabled: true, created: null, last_modified: null, attributes: {} },
        { username: "bob", status: "FORCE_CHANGE_PASSWORD", enabled: false, created: null, last_modified: null, attributes: {} },
      ],
      paginationToken: null,
    },
  });
  await clearWorkspace(page);

  // ---- 1. S3: open, walk in, go back up, search, clear
  await newSession(page, "S3");
  const card = `${SHOWN} .panel:has-text("Choose environment and bucket")`;
  await page.selectOption(`${card} select >> nth=0`, { index: 1 });
  await page.click(`${SHOWN} button:has-text("Load buckets")`);
  await page.waitForSelector(`${SHOWN} option[value="demo-bucket"]`, { state: "attached" });
  await page.selectOption(`${card} select >> nth=1`, "demo-bucket");
  await page.waitForSelector(`${SHOWN} .result-row-summary:has-text("2024/")`);
  check(JSON.stringify(browsed[0]) === JSON.stringify({ prefix: "", search: "", cursor: null }), "Picking a bucket opens it at the top",
    JSON.stringify(browsed));
  await page.fill(`${SHOWN} input[placeholder="Search filenames under this folder…"]`, "typed but not run");
  await page.click(`${SHOWN} .result-row-summary:has-text("2024/")`);
  await page.waitForFunction(() => document.querySelectorAll(".session-body:not([hidden]) .row button.secondary").length >= 2);
  check(browsed.at(-1).prefix === "2024/" && browsed.at(-1).search === "", "A folder opens it, leaving the search box",
    JSON.stringify(browsed.at(-1)));
  check((await page.inputValue(`${SHOWN} input[placeholder="Search filenames under this folder…"]`)) === "",
    "…which is emptied, as before");
  const crumbs = await page.locator(`${SHOWN} .panel:has(h2:text-is("2. Browse")) > .row:not(:has(h2)) button`).allInnerTexts();
  check(JSON.stringify(crumbs) === JSON.stringify(["demo-bucket", "2024"]), "The breadcrumbs show where you are", JSON.stringify(crumbs));
  await page.click(`${SHOWN} .panel:has(h2:text-is("2. Browse")) > .row:not(:has(h2)) button:text-is("demo-bucket")`);
  await page.waitForFunction((n) => true, browsed.length);
  await page.waitForTimeout(300);
  check(browsed.at(-1).prefix === "", "…and take you back up", JSON.stringify(browsed.at(-1)));

  await page.fill(`${SHOWN} input[placeholder="Search filenames under this folder…"]`, "bravo");
  await page.press(`${SHOWN} input[placeholder="Search filenames under this folder…"]`, "Enter");
  await page.waitForSelector(`${SHOWN} button:text-is("Clear search")`);
  check(browsed.at(-1).search === "bravo", "Enter runs the search", JSON.stringify(browsed.at(-1)));
  const searching = await page.locator(`${SHOWN} p.muted:has-text("Searching recursively")`).innerText();
  check(searching === 'Searching recursively under "/" for filenames containing "bravo".', "…and says what it searched", searching);
  check((await page.locator(`${SHOWN} .result-row .msg`).first().innerText()) === "logs/a b.txt",
    "While searching, a file shows its whole key");
  await page.click(`${SHOWN} button:text-is("Clear search")`);
  await page.waitForSelector(`${SHOWN} button:text-is("Clear search")`, { state: "detached" });
  check(browsed.at(-1).search === "", "Clear search runs it again without", JSON.stringify(browsed.at(-1)));

  // ---- 2. row copy
  await page.click(`${SHOWN} .result-row:has-text("a b.txt") button:text-is("Copy S3 URI")`);
  check((await page.evaluate(() => navigator.clipboard.readText())) === "s3://demo-bucket/logs/a b.txt", "Copy S3 URI copies the row's URI");
  check(await page.locator(`${SHOWN} .toolbar .muted:text-is("S3 URI copied to clipboard")`).isVisible(), "…and says so");
  await page.click(`${SHOWN} .result-row:has-text("a b.txt") button:text-is("Copy object URL")`);
  check((await page.evaluate(() => navigator.clipboard.readText())) === "https://demo-bucket.s3.eu-west-1.amazonaws.com/logs/a%20b.txt",
    "Copy object URL encodes each path segment, with the bucket's region");

  // ---- 3. Load more keeps the selection
  await page.click(`${SHOWN} .result-row:has-text("bravo.bin") input[type=checkbox]`);
  await page.click(`${SHOWN} button:text-is("Load more")`);
  await page.waitForSelector(`${SHOWN} .result-row:has-text("zulu.txt")`);
  check(browsed.at(-1).cursor === "c1", "Load more sends the cursor", JSON.stringify(browsed.at(-1)));
  check(await page.locator(`${SHOWN} .result-row:has-text("bravo.bin") input[type=checkbox]`).isChecked(),
    "…appends, and the checked file stays checked");
  check((await page.locator(`${SHOWN} .toolbar .muted:has-text("file(s)")`).innerText()).startsWith("1 folder(s), 3 file(s)"),
    "…and the count includes what it added");
  check(!(await page.locator(`${SHOWN} button:text-is("Load more")`).isVisible()), "With nothing more, Load more goes");

  // ---- 4. an expanded row reaches another tab of the session (D48)
  await newSession(page, "DynamoDB");
  const tables = `${SHOWN} .panel:has-text("Choose environment and table")`;
  await page.selectOption(`${tables} select >> nth=0`, { index: 1 });
  await page.click(`${SHOWN} button:has-text("Load tables")`);
  await page.waitForSelector(`${SHOWN} option[value="T"]`, { state: "attached" });
  await page.selectOption(`${tables} select >> nth=1`, "T");
  await page.click(`${SHOWN} button:text-is("Scan")`);
  await page.waitForSelector(`${SHOWN} >> text=2 item(s) loaded`);
  await page.click(`${SHOWN} .result-row-summary .msg:text-is("2")`);
  await page.waitForSelector(`${SHOWN} .result-row-detail`);
  await page.waitForTimeout(2000); // the debounced save
  const other = await newPage(browser);
  await signIn(other);
  await other.click('.rail-row:has(.rail-row-label:text-is("DynamoDB"))');
  await other.waitForSelector(`${SHOWN} .result-row-detail`, { timeout: 15000 });
  const opened = await other.locator(`${SHOWN} .result-row-detail pre`).innerText();
  check(opened.includes('"Bob"'), "Another tab of the session shows the same row expanded", opened.slice(0, 60));
  await other.close();

  // ---- 5. Cognito's tags
  await newSession(page, "Cognito");
  const pools = `${SHOWN} .panel:has-text("Choose environment and user pool")`;
  await page.selectOption(`${pools} select >> nth=0`, { index: 1 });
  await page.click(`${SHOWN} button:has-text("Load user pools")`);
  await page.waitForSelector(`${SHOWN} option[value="p1"]`, { state: "attached" });
  await page.selectOption(`${pools} select >> nth=1`, "p1");
  await page.click(`${SHOWN} button:text-is("Search")`);
  await page.waitForSelector(`${SHOWN} >> text=2 user(s) loaded`);
  const tags = await page.locator(`${SHOWN} .result-row-summary .tag`).evaluateAll((els) => els.map((e) => `${e.className}=${e.textContent}`));
  check(JSON.stringify(tags) === JSON.stringify(["tag ok=CONFIRMED", "tag pending=FORCE_CHANGE_PASSWORD", "tag error=disabled"]),
    "Status tags take their tone from the row, and a disabled user says so", JSON.stringify(tags));

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
