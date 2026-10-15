// The MQTT tester drawn from its manifest, its connection held by the server
// (PLATFORM_PLAN.md §16.13, D54), driven the way a user would:
//   - Connect as the person, and the status says where and as whom;
//   - adding a topic while connected reconnects and messages stream in, the
//     ones already shown kept;
//   - Publish arrives back on a matching subscription;
//   - a second tab of the session sees the same stream, connected;
//   - a reload while connected finds it still connected and streaming;
//   - Disconnect from the other tab ends it in both, saying who, and the
//     "Connected to" line goes;
//   - Saved ▾ keeps the topics.
//
// Needs the backend served as `uvicorn dev.fake_aws:app` (e2e/README.md): its
// in-process broker sends fake/robot-1/telemetry every second and delivers
// what is published.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, ROW, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const CONNECTION = `${SHOWN} .panel:has(h2:text-is("Connection"))`;
const MESSAGES = `${SHOWN} .stream-message`;
const DISCONNECT = `${SHOWN} button:text-is("Disconnect")`;

async function count(page, selector) {
  return page.locator(selector).count();
}

async function grows(page) {
  const before = await count(page, MESSAGES);
  await page.waitForTimeout(3000);
  return (await count(page, MESSAGES)) > before;
}

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  let env = (await api(admin, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(admin, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const user = `e2e-mqtt-${Date.now()}`;
  const group = (await api(admin, "POST", "/user-groups", { name: `g-${user}`, role_name: "R", environment_ids: [env.id], tools_enabled: true })).body;
  check((await api(admin, "POST", "/users", { username: user, password: "pw-123456", group_id: group.id })).status === 201,
    "Precondition: a user whose group reaches the fake environment");

  const page = await newPage(browser);
  await signIn(page, { username: user, password: "pw-123456" });

  // ---- 1. Connect, as the person
  await newSession(page, "MQTT tester");
  await page.waitForTimeout(800);
  await page.selectOption(`${SHOWN} select[aria-label="Environment"]`, { label: "e2e-fake-aws (000000000001 · eu-west-1)" });
  await page.click(`${SHOWN} button:text-is("Connect")`);
  await page.waitForSelector(`${DISCONNECT}:not([disabled])`, { timeout: 15000 });
  const status = await page.locator(CONNECTION).innerText();
  check(/Connected to fake-ats\.iot\.eu-west-1\.amazonaws\.com as cloudwatch-insights-/.test(status) && status.includes("add a topic"),
    "Connected, it says where and as whom, and that it listens to nothing yet", status);
  check(await page.locator(`${SHOWN} button:text-is("Connected")`).isDisabled(), "…and Connect reads Connected");

  // ---- 2. a topic added while connected: messages stream in
  await page.fill(`${SHOWN} [aria-label="Add to topics"]`, "fake/#");
  await page.press(`${SHOWN} [aria-label="Add to topics"]`, "Enter");
  await page.waitForSelector(`${CONNECTION} :text("listening to fake/#")`, { timeout: 10000 });
  check(true, "Adding a topic while connected reconnects with it");
  await page.waitForSelector(MESSAGES, { timeout: 10000 });
  check(await grows(page), "Messages stream in as the broker sends them");
  const firstSeq = await page.locator(`${MESSAGES} pre`).last().innerText();

  await page.fill(`${SHOWN} [aria-label="Add to topics"]`, "other/#");
  await page.press(`${SHOWN} [aria-label="Add to topics"]`, "Enter");
  await page.waitForSelector(`${CONNECTION} :text("listening to fake/#, other/#")`, { timeout: 10000 });
  await page.waitForTimeout(1500);
  check((await page.locator(`${MESSAGES} pre`).last().innerText()) === firstSeq,
    "…and another topic reconnects again, the messages already shown kept");

  // ---- 3. publish, received back
  await page.fill(`${SHOWN} input[aria-label="Topic"]`, "fake/robot-1/commands");
  await page.fill(`${SHOWN} textarea[aria-label="Message"]`, '{"command":"ping"}');
  await page.click(`${SHOWN} button:text-is("Publish")`);
  await page.waitForSelector(`${SHOWN} :text("Published 18 bytes to fake/robot-1/commands")`, { timeout: 10000 });
  await page.waitForSelector(`${MESSAGES}:has-text("fake/robot-1/commands")`, { timeout: 10000 });
  check((await page.locator(`${MESSAGES}:has-text("fake/robot-1/commands") pre`).first().innerText()).includes('"command": "ping"'),
    "Publish is received back on the matching subscription, its JSON indented");

  // ---- 4. a second tab sees the same stream
  const other = await newPage(browser);
  await signIn(other, { username: user, password: "pw-123456" });
  await other.click(ROW("MQTT tester"));
  await other.waitForSelector(`${DISCONNECT}:not([disabled])`, { timeout: 10000 });
  check(await grows(other), "A second tab of the session shows it connected, the same messages streaming in");

  // ---- 5. a reload while connected
  await page.reload();
  await page.waitForSelector(`${DISCONNECT}:not([disabled])`, { timeout: 15000 });
  check(await grows(page), "Reloaded while connected, it's still connected and streaming");

  // ---- 6. Disconnect from the other tab
  await other.click(DISCONNECT);
  await page.waitForSelector(`${SHOWN} :text("Stopped by ${user}.")`, { timeout: 10000 });
  check(true, "Disconnect in one tab ends it in both, saying who");
  check(!(await page.locator(`${CONNECTION} :text("Connected to")`).count()), "…the Connected-to line goes");
  const stoppedAt = await count(page, MESSAGES);
  await page.waitForTimeout(2500);
  check((await count(page, MESSAGES)) === stoppedAt, "…and nothing more arrives");
  await other.close();

  // ---- 7. Saved ▾ keeps the topics
  page.once("dialog", (d) => d.accept("e2e telemetry"));
  await page.click(`${SHOWN} .pane-saved button:text-is("Saved ▾")`);
  await page.click('.pane-saved-menu button:text-is("Save as…")');
  await page.waitForTimeout(800);
  const saved = (await api(page, "GET", "/saved-inputs?pane_type=tool-mqtt")).body ?? [];
  const mine = saved.find((s) => s.name === "e2e telemetry");
  check(mine && JSON.stringify(mine.inputs.topics) === JSON.stringify(["fake/#", "other/#"]), "Saved ▾ keeps the topics", JSON.stringify(saved));
  for (const s of saved) await api(page, "DELETE", `/saved-inputs/${s.id}`);

  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
