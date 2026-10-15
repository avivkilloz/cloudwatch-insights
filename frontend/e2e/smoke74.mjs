// The answer check (PLATFORM_PLAN.md D55), on the case that prompted it. In a
// session's chat, asked to connect its MQTT tester, the agent fills the topics
// in and says it's connected without running anything:
//   - the platform's check reads the session afterwards, finds the pane isn't
//     running, and says so as a step of its own;
//   - the claim is taken back, the agent connects for real, and its second
//     answer passes the check;
//   - the pane is connected, as the agent's user.
// And what get_session told the agent is the pane's run, not just its inputs.
//
// Needs the agent and the fake model running, and the backend served as
// `uvicorn dev.fake_aws:app` (e2e/README.md): the connection is the fake
// broker's.
import { check, clearWorkspace, launch, newPage, newSession, openApp, report, SHOWN, signIn } from "./harness.mjs";

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const DOCK = ".agent-dock";
const TURN = `${DOCK} .agent-transcript .agent-turn`;

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  let env = (await api(admin, "GET", "/environments")).body.find((e) => e.name === "e2e-fake-aws");
  if (!env) env = (await api(admin, "POST", "/environments", { name: "e2e-fake-aws", account_id: "000000000001", region: "eu-west-1" })).body;
  const user = `e2e-check-${Date.now()}`;
  const group = (await api(admin, "POST", "/user-groups", {
    name: `g-${user}`, role_name: "R", environment_ids: [env.id], tools_enabled: true, agent_enabled: true,
  })).body;
  check((await api(admin, "POST", "/users", { username: user, password: "pw-123456", group_id: group.id })).status === 201,
    "Precondition: a user with the agent and the fake environment");

  const page = await newPage(browser);
  await signIn(page, { username: user, password: "pw-123456" });
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(".rail");
  await newSession(page, "MQTT tester");
  await page.waitForTimeout(800);
  await page.selectOption(`${SHOWN} select[aria-label="Environment"]`, { label: "e2e-fake-aws (000000000001 · eu-west-1)" });
  await page.waitForTimeout(1500); // pushed to the server before the agent reads it
  await page.waitForSelector(DOCK);
  check((await page.locator(`${DOCK} .agent-tab[aria-selected="true"]`).innerText()) === "Session", "Precondition: the session's chat");

  await page.fill(`${DOCK} .agent-compose-input`, "pretend connect");
  await page.click(`${DOCK} button:text-is("Ask")`);
  await page.waitForSelector(`${DOCK} button:text-is("Stop")`, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 60000 });
  const turn = page.locator(TURN).last();

  const steps = await turn.locator(".agent-step-text").allInnerTexts();
  check(steps.includes("Checked the answer: it didn't match what ran") && steps.at(-1) === "Checked the answer against what ran",
    "The platform's check is shown: the claim failed it, the redo passed", JSON.stringify(steps));
  const answer = (await turn.locator(".agent-answer").allInnerTexts()).join("\n");
  check(answer.includes("Connected now") && !answer.includes("is connected and listening"),
    "The unsupported claim was taken back; the answer is the redo's", answer);
  check(!(await turn.locator(".agent-notice").count()), "…with no warning left under it");

  await page.waitForSelector(`${SHOWN} button:text-is("Disconnect"):not([disabled])`, { timeout: 15000 });
  const status = await page.locator(`${SHOWN} .panel:has(h2:text-is("Connection"))`).innerText();
  check(status.includes("Connected to") && status.includes("a/#"), "The pane is connected for real, listening to the topic", status);

  // What the agent reads of the pane now says whether it's running.
  // This user's only session.
  const [session] = (await api(page, "GET", "/live-sessions")).body ?? [];
  const run = session?.state?.["tool-mqtt.out.run"];
  check(run?.status === "running", "The pane's run is going, as the check saw", JSON.stringify(run));

  await page.click(`${SHOWN} button:text-is("Disconnect")`);
  await page.waitForTimeout(800);
  await clearWorkspace(page);
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
