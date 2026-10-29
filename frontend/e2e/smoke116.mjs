// Everyone uses what's built; its owner and members change it, together
// (D160-D163; the user: "builder components ... accessible by everyone ...
// admins ... then the owner, then ... members to a draft/edit, like we do for
// sessions. members can talk in the chat of an edit/draft"). A member of a
// group with no Builder and no environments:
//   - is offered every pane, a pane none of their environments can run said
//     so; the group form has no Panes to tick any more;
//   - opens the Builder, and a pane type an admin made reads only, saying why;
//   - added as a member from the editor's Members, can change it;
//   - both typing in it at once: each sees the other's change, and neither
//     loses their own (merged by lines);
//   - its chat is shared: a plain message reaches the other person, not the
//     agent; @builder makes the Builder change the draft, for both of them.
// Needs the agent and the fake model.
import { check, launch, newPage, openApp, report, SHOT, signIn } from "./harness.mjs";

const STAMP = Date.now();
const USER = `member${STAMP}`;
const GROUP = `Members ${STAMP}`;
const PANE = `shared_${STAMP}`;
const DOCK = ".agent-dock";
const MEMBERS = '.credential-section-head:has(h3:text-is("Members"))';

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

async function openPane(page, label) {
  await page.click('.rail-row-page:has-text("Builder")');
  await page.click(`.builder-list tr:has-text("${label}")`);
  await page.waitForSelector("#builder-source");
}

async function withDock(page) {
  await page.evaluate(() => {
    localStorage.setItem("cwi-agent-open", "open");
    localStorage.setItem("cwi-agent-layout", "dock");
  });
  await page.reload();
  await page.waitForSelector(DOCK);
}

const run = async () => {
  const browser = await launch();
  const admin = await openApp(browser);
  admin.on("dialog", (d) => d.accept());
  admin.on("pageerror", (e) => console.log("ADMIN PAGE ERROR:", e.message));
  // No environments, no Builder, no agent of its own: only what an invitation gives.
  const g = (await api(admin, "POST", "/user-groups", { name: GROUP, role_name: null, agent_enabled: true })).body;
  await api(admin, "POST", "/users", { username: USER, password: "pw-123456", group_id: g.id });
  const starter = (await api(admin, "GET", "/builder/schema")).body.starter;
  const source = starter.replace(/^label: .*$/m, `label: Shared ${STAMP}`).replace(/^description: .*$/m, "description: Made by an admin.");
  const made = await api(admin, "POST", "/builder/panes", { id: PANE, source, files: {} });
  const paneId = made.body.id;
  const page = await newPage(browser);
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log("MEMBER PAGE ERROR:", e.message));
  try {
    check(made.status === 201, "An admin makes a pane type", JSON.stringify(made.body).slice(0, 200));

    // ---- 1. every pane is offered; one no environment can run says so
    await signIn(page, { username: USER, password: "pw-123456" });
    const types = (await api(page, "GET", "/pane-types")).body.map((t) => t.id);
    check(types.includes("logs-cloudwatch") && types.includes("tool-base64") && types.includes(paneId),
      "Every pane type is the member's to use, a built one included", JSON.stringify(types));
    const cloudwatch = '.home-card:has(.home-card-title:text-is("CloudWatch"))';
    await page.waitForSelector(`${cloudwatch} .home-card-note`);
    check((await page.locator(`${cloudwatch} .home-card-note`).innerText()) === "No environment for it yet",
      "CloudWatch is offered, saying no environment of theirs has it yet");
    check((await page.locator('.home-card:has(.home-card-title:text-is("Base64")) .home-card-note').count()) === 0,
      "…while Base64, which needs none, says nothing");
    await page.screenshot({ path: `${SHOT}/smoke116-catalogue.png`, fullPage: true });

    await admin.click('[aria-label="Account menu"]');
    await admin.click('.user-menu-popover .icon-popover-item:has-text("Settings")');
    await admin.waitForSelector("text=Profile picture");
    await admin.click('.content .settings-tabs button:text-is("Users")');
    await admin.click('.segmented button:text-is("Groups")');
    await admin.click(`tr:has-text("${GROUP}")`);
    await admin.waitForSelector("#group-name");
    const sections = await admin.locator(".credential-section-head h3").allInnerTexts();
    const named = sections.map((t) => t.toLowerCase());
    check(!named.includes("panes") && named.includes("features"), "A group has no Panes to tick any more", JSON.stringify(sections));

    // ---- 2. the Builder, read only
    await openPane(page, `Shared ${STAMP}`);
    check((await page.locator('.credential-view-foot button:text-is("Save")').count()) === 0,
      "A pane type made by someone else opens without Save");
    const locked = await page.locator(".builder-locked").innerText();
    check(locked.includes("Made by admin"), "…and says whose it is to change", locked);

    // ---- 3. added as a member, from the editor
    await openPane(admin, `Shared ${STAMP}`);
    await admin.waitForSelector(MEMBERS);
    check((await admin.locator(".build-owner .session-member-username").innerText()) === "admin", "The editor's Members names its owner");
    await admin.fill('[aria-label="Username to add"]', USER);
    await admin.click('.session-member-invite button:text-is("Add")');
    await admin.waitForSelector(`.build-members .session-member-username:text-is("${USER}")`);
    check(true, "The owner adds a member there");
    await page.reload();
    await openPane(page, `Shared ${STAMP}`);
    await page.waitForSelector('.credential-view-foot button:text-is("Save")');
    check(true, "The member, Builder or not, can change it now");

    // ---- 4. both typing at once: each sees the other's, neither loses theirs
    const base = await admin.inputValue("#builder-source");
    await admin.fill("#builder-source", base.replace(/^description: .*$/m, "description: The admin's words."));
    await page.fill("#builder-source", base.replace(/^label: .*$/m, `label: Shared by both ${STAMP}`));
    const both = (text) => text.includes("description: The admin's words.") && text.includes(`label: Shared by both ${STAMP}`);
    await admin.waitForFunction((stamp) => {
      const v = document.querySelector("#builder-source")?.value ?? "";
      return v.includes("description: The admin's words.") && v.includes(`label: Shared by both ${stamp}`);
    }, STAMP, { timeout: 15000 });
    await page.waitForFunction((stamp) => {
      const v = document.querySelector("#builder-source")?.value ?? "";
      return v.includes("description: The admin's words.") && v.includes(`label: Shared by both ${stamp}`);
    }, STAMP, { timeout: 15000 });
    check(both(await admin.inputValue("#builder-source")) && both(await page.inputValue("#builder-source")),
      "Typed at once in one draft: both editors end with both changes");
    await page.screenshot({ path: `${SHOT}/smoke116-merged.png`, fullPage: true });

    // ---- 5. the draft's chat is theirs: people talk, @builder changes it
    await withDock(admin);
    await openPane(admin, `Shared ${STAMP}`);
    await withDock(page);
    await openPane(page, `Shared ${STAMP}`);
    await page.waitForSelector(`${DOCK} .agent-tab:text-is("Draft")`, { timeout: 10000 }).catch(() => {});
    const tabs = await page.locator(`${DOCK} .agent-tab`).allInnerTexts();
    check(tabs.map((t) => t.trim()).includes("Draft"), "Beside an editor, the panel's second tab is Draft", JSON.stringify(tabs));
    await page.waitForSelector(`${DOCK} .agent-transcript p:has-text("@builder")`);
    check(true, "…and, shared, it says it's a chat, with @builder to ask the Builder");
    await page.fill(`${DOCK} .agent-compose-input`, "I changed the label, can you check the description?");
    await page.click(`${DOCK} button:text-is("Ask")`);
    await admin.waitForSelector(`${DOCK} .agent-question:has-text("can you check the description?")`, { timeout: 15000 });
    check((await admin.locator(`${DOCK} .agent-answer`).count()) === 0,
      "A plain message reaches the other member live, and no agent answers it");

    await admin.fill(`${DOCK} .agent-compose-input`, `@builder rename Renamed by the Builder ${STAMP}`);
    await admin.click(`${DOCK} button:text-is("Ask")`);
    await admin.waitForSelector(`${DOCK} button:text-is("Ask")`, { timeout: 90000 });
    await admin.waitForFunction((stamp) => (document.querySelector("#builder-source")?.value ?? "").includes(`label: Renamed by the Builder ${stamp}`),
      STAMP, { timeout: 15000 });
    check(true, "@builder: the Builder changes the draft in the asker's editor");
    await page.waitForFunction((stamp) => (document.querySelector("#builder-source")?.value ?? "").includes(`label: Renamed by the Builder ${stamp}`),
      STAMP, { timeout: 15000 });
    check((await page.inputValue("#builder-source")).includes("description: The admin's words."),
      "…and in the member's, live, with what they'd done kept");
    await page.waitForSelector(`${DOCK} .agent-answer`, { timeout: 15000 });
    check(true, "The Builder's answer is in the member's chat too");
    await page.screenshot({ path: `${SHOT}/smoke116-chat.png`, fullPage: true });

    // Saved by the member: the pane is changed, for everyone.
    await page.click('.credential-view-foot button:text-is("Save")');
    await page.waitForSelector('.builder-notice:text-is("Saved.")', { timeout: 15000 });
    const saved = (await api(admin, "GET", `/builder/panes/${encodeURIComponent(paneId)}`)).body;
    check(saved.label === `Renamed by the Builder ${STAMP}`, "The member saves it", saved.label);
  } finally {
    await api(admin, "DELETE", `/builder/panes/${encodeURIComponent(paneId)}`);
  }
  await browser.close();
  report();
};
run().catch((e) => {
  console.log("SMOKE TEST FAILED:", e.message);
  process.exit(1);
});
