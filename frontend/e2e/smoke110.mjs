// A built pane exports its rows with their detail -- built in, no action of
// its own (the second OTA chat: the Builder's agent wrote an "Export selected
// with details" action whose code read ctx.state, which doesn't exist, because
// the reference never said `detail.include` was there). The recipe's Lambda
// pane, saved as is: list, check a row, tick "Include configuration", export
// JSON -- the row carries the detail's merged fields, fetched by its row
// action. Needs the backend as dev.fake_aws:app (Lambda faked for 0000…).
import { readFileSync } from "node:fs";
import { check, clearWorkspace, launch, openApp, report, SHOT } from "./harness.mjs";

const STAMP = Date.now();
const ENV = `Export ${STAMP}`;
const ACCOUNT = "000066667777";
const RECIPE = readFileSync(new URL("../../backend/app/panes/recipes/rows-that-open/pane.yaml", import.meta.url), "utf8");

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
  const page = await openApp(browser, { acceptDownloads: true });
  page.on("pageerror", (e) => console.log("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());
  let envId = null;
  let typeId = null;
  try {
    await clearWorkspace(page);
    envId = (await api(page, "POST", "/environments", { name: ENV, account_id: ACCOUNT, region: "eu-west-1" })).body.id;
    const fn = { FunctionName: "orders", Runtime: "python3.12", MemorySize: 256, LastModified: "2026-10-01T10:00:00.000+0000" };
    await api(page, "PUT", `/dev/fake-aws?service=lambda&operation=ListFunctions&account=${ACCOUNT}`, { Functions: [fn, { ...fn, FunctionName: "billing" }] });
    await api(page, "PUT", `/dev/fake-aws?service=lambda&operation=GetFunctionConfiguration&account=${ACCOUNT}`, {
      ...fn, Handler: "app.handler", Timeout: 30, Role: "arn:aws:iam::000066667777:role/orders", State: "Active", Layers: [],
    });
    const made = await api(page, "POST", "/builder/panes", { id: `lambdas_${STAMP}`, source: RECIPE });
    check(made.status === 201, "The recipe saves as a pane type", JSON.stringify(made.body).slice(0, 200));
    typeId = made.body.id;
    await api(page, "PUT", `/live-sessions/exp${STAMP}`, {
      type: "aggregator", title: `Export ${STAMP}`, truncated: false,
      state: { services: [typeId], layout: "stacked", [`${typeId}.in.connections`]: [envId] },
    });
    await page.reload();
    await page.click(`.rail-row:has-text("Export ${STAMP}")`);
    const S = ".session-body:not([hidden])";
    await page.click(`${S} button:text-is("List")`);
    await page.waitForSelector(`${S} .manifest-table tbody tr`, { timeout: 20000 });

    check((await page.locator(`${S} label:has-text("Include configuration")`).count()) === 0,
      "Include is offered only once rows are checked");
    const box = page.locator(`${S} .manifest-table tbody tr`).first().locator('input[type="checkbox"]').first();
    await box.check();
    await page.locator(`${S} label:has-text("Include configuration") input`).check();
    // The detail is fetched by the row action as the box is ticked.
    await page.waitForResponse((r) => r.url().includes("/actions/function"), { timeout: 15000 });
    await page.waitForFunction((s) => !document.querySelector(`${s} .manifest-table .toolbar`)?.textContent?.includes("Loading details"), S);
    await page.screenshot({ path: `${SHOT}/smoke110-include.png`, fullPage: true });
    await page.click(`${S} button:has-text("Export 1 selected")`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click(`${S} .icon-popover-item:text-is("JSON")`)]);
    const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
    check(Array.isArray(exported) && exported.length === 1, "Export carries the checked row", JSON.stringify(exported).slice(0, 200));
    const [row] = exported;
    check(row.Name === "orders" && row.Timeout === 30 && row.Handler === "app.handler" && row.State === "Active",
      "…with its detail's merged fields, fetched by the row action", JSON.stringify(row));
    check(!("Layers" in row), "…only the fields `merge` names");
  } finally {
    if (typeId) await api(page, "DELETE", `/builder/panes/${encodeURIComponent(typeId)}`);
    if (envId) await api(page, "DELETE", `/environments/${envId}`);
    await clearWorkspace(page);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
