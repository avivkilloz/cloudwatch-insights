import { ReactNode, useState } from "react";
import { BrandInfo, BrandMark } from "./Brand";
import { useAuth } from "../AuthContext";
import { useAgent } from "../agent/AgentContext";
import { useAgentActivity, useSessions } from "../sessions/SessionContext";
import { useCatalogue } from "../sessions/catalogue";
import { useStartSession } from "../sessions/start";
import { useTemplates } from "../sessions/templates";
import { useOpenPublishedFromMenu } from "../sessions/published";
import { useWaitingApprovals } from "../workflowApprovals";
import AgentWorking from "./AgentWorking";
import Icon from "./Icon";
import Popover from "./Popover";
import SessionMenuItems from "./SessionMenuItems";

/**
 * The strip above the body: the panel's toggle, what is open, and a ＋ to open
 * more.
 *
 * It sits in the body's column rather than across the top of the window, so it
 * lines up with the cards below it and the panel stands beside both. The panel
 * and this overlap on purpose -- the panel is the whole workspace (every
 * session you have, plus everything you could open), while this is only the
 * ones in front of you. So closing lives here, on a ✕ per tab; the ⋮ near the
 * end offers the same things the panel's rows do, for the session on screen;
 * and at the very end, mirroring the panel's toggle at the start, is the agent
 * panel's.
 */
export default function SessionBar({
  railOpen,
  onToggleRail,
  brand,
  account,
}: {
  railOpen: boolean;
  onToggleRail: () => void;
  brand: BrandInfo;
  /** The account's picture, unless the docked agent panel's header has it. */
  account: ReactNode;
}) {
  const { sessions, activeId, view, close, activate, rename, show } = useSessions();
  const agent = useAgent();
  const agentActive = useAgentActivity();
  const { templates, published } = useTemplates();
  const openPublished = useOpenPublishedFromMenu();
  const { startOne, startFromTemplate } = useStartSession();
  const { user } = useAuth();
  const { groups: catalogueGroups, noEnvironment } = useCatalogue();
  const waiting = useWaitingApprovals();
  // Set when the current tab is being renamed in place, from the ⋮ below.
  const [renaming, setRenaming] = useState(false);

  // Only ever the tab you are looking at: the ⋮ here is about what is on
  // screen, and the panel is where you reach the rest.
  const current = view === "session" ? sessions.find((s) => s.id === activeId) : undefined;

  return (
    /* The dock is what sticks and what carries the page background; the
       strip inside it is a plain card, the same width as the cards below. */
    <div className="session-bar-dock">
      <div className="session-bar">
        {/* With the side panel hidden, what heads it comes here: the logo, the
            way home. Shown, it's in the panel instead. */}
        {!railOpen && (
          <button className="session-bar-brand" onClick={() => show("home")} title={`${brand.title} — home`}>
            <BrandMark brand={brand} size={20} />
          </button>
        )}
        <button
          className="session-bar-rail"
          onClick={onToggleRail}
          aria-expanded={railOpen}
          aria-label={railOpen ? "Hide the side panel" : "Show the side panel"}
          title={railOpen ? "Hide the side panel" : "Show the side panel"}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <line x1="6.5" y1="2.5" x2="6.5" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
            {railOpen && <rect x="2.5" y="3.5" width="3" height="9" fill="currentColor" opacity="0.5" />}
          </svg>
        </button>
        {/* The platform's own pages, as the hidden panel would show them: an
            icon each, after its toggle -- with the panel hidden they were out
            of reach but for showing it again. */}
        {!railOpen && (
          <>
            <button
              className={`session-bar-page${view === "workflows" ? " active" : ""}`}
              data-page="workflows"
              onClick={() => show("workflows")}
              aria-label="Workflows"
              title={waiting.length ? `Workflows: ${waiting.length} waiting for your approval` : "Workflows"}
            >
              <Icon name="workflow" />
              {waiting.length > 0 && <span className="session-bar-page-dot" aria-hidden="true" />}
            </button>
            {user && (
              <button
                className={`session-bar-page${view === "builder" ? " active" : ""}`}
                data-page="builder"
                onClick={() => show("builder")}
                aria-label="Builder"
                title="Builder"
              >
                <Icon name="builder" />
              </button>
            )}
          </>
        )}

        <div className="session-bar-tabs">
          {sessions.length === 0 && <span className="session-bar-empty">Nothing open yet.</span>}
          {sessions.map((s) => (
            <div
              key={s.id}
              data-bar-session-id={s.id}
              className={
                `session-tab${view === "session" && activeId === s.id ? " active" : ""}` +
                `${agentActive.has(s.id) ? " agent-active" : ""}`
              }
            >
              {renaming && current?.id === s.id ? (
                <input
                  className="session-tab-rename"
                  autoFocus
                  defaultValue={s.title}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    // Cleared first, so the blur that follows commits nothing.
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  onBlur={(e) => {
                    if (!renaming) return;
                    const name = e.target.value.trim();
                    if (name && name !== s.title) rename(s.id, name);
                    setRenaming(false);
                  }}
                  aria-label={`Rename ${s.title}`}
                />
              ) : (
                <button
                  className="session-tab-label"
                  onClick={() => activate(s.id)}
                  // As a pane's tab renames on double-click in the tabs layout.
                  onDoubleClick={() => {
                    activate(s.id);
                    setRenaming(true);
                  }}
                  title={`${s.title} — double-click to rename`}
                >
                  {s.title}
                </button>
              )}
              {agentActive.has(s.id) && <AgentWorking />}
              {/* Closing lives here, not in the panel: this strip is the tabs in
                  front of you, and a ✕ on a tab is what people reach for. */}
              <button className="session-tab-close" onClick={() => close(s.id)} aria-label={`Close ${s.title}`} title="Close">
                ✕
              </button>
            </div>
          ))}
        </div>

        <Popover
          glyph="＋"
          label="Open a new session"
          buttonClass="session-bar-add"
          menuClass="session-add-menu"
          width={220}
        >
          {(closeMenu) => (
            <>
              {/* A session is named and filled on the home page, so this is the
                  way there rather than a second copy of that form in a menu. */}
              <button
                className="session-add-item"
                onClick={() => {
                  show("home");
                  closeMenu();
                }}
              >
                Start new session…
              </button>
              {/* The same offer the panel's Add list makes, for when the panel
                  is hidden: one click for a session on that one service or tool. */}
              {catalogueGroups().map(({ name, types }) => {
                return (
                  <div key={name}>
                    <div className="session-add-heading">{name}</div>
                    {types.map((t) => (
                      <button
                        key={t.type}
                        className={`session-add-item${noEnvironment[t.type] ? " no-environment" : ""}`}
                        onClick={() => {
                          startOne(t.type);
                          closeMenu();
                        }}
                        title={`Start a session on ${t.label} — ${t.description}${noEnvironment[t.type] ? ` (${noEnvironment[t.type]})` : ""}`}
                      >
                        <span className="session-add-name">{t.label}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
              {templates.length + published.length > 0 && (
                <div>
                  <div className="session-add-heading">Templates</div>
                  {published.map((t) => (
                    <button
                      key={`published:${t.id}`}
                      className="session-add-item session-add-template session-add-published"
                      onClick={() => {
                        openPublished(t);
                        closeMenu();
                      }}
                      title={t.description || `Start a session from "${t.label}"`}
                    >
                      <span className="session-add-name">{t.label}</span>
                    </button>
                  ))}
                  {templates.map((template) => (
                    <button
                      key={`${template.entry.page}:${template.entry.id}`}
                      className="session-add-item session-add-template"
                      onClick={() => {
                        startFromTemplate(template);
                        closeMenu();
                      }}
                      title={`Start a session from "${template.entry.name}"`}
                    >
                      <span className="session-add-name">{template.entry.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Popover>

        <div className="session-bar-end">
          {/* Only when a session is showing: it acts on that one. The panel's
              ⋮ reaches any of them. (Tried as a ⋮ on every tab instead, and
              put back: one menu for the session in front of you, and a ✕ on
              each tab, read better.) */}
          {current && (
            <Popover
              glyph="⋮"
              label={`More for ${current.title}`}
              title="More"
              buttonClass="session-bar-more"
              menuClass="rail-row-menu"
              width={156}
            >
              {(closeMenu) => (
                <SessionMenuItems session={current} onRename={() => setRenaming(true)} close={closeMenu} />
              )}
            </Popover>
          )}
          {/* At the very end, the agent panel's toggle, as the side panel's
              own is at the start -- whichever way the agent panel is laid out. */}
          <button
            className={`session-bar-agent${agent.running && !agent.open ? " busy" : ""}`}
            onClick={() => agent.setOpen(!agent.open)}
            aria-expanded={agent.open}
            aria-label={agent.open ? "Hide the agent panel" : "Show the agent panel"}
            title={
              agent.open
                ? "Hide the agent panel"
                : agent.running
                  ? "The agent is still answering — show the agent panel"
                  : "Show the agent panel"
            }
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <line x1="9.5" y1="2.5" x2="9.5" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
              {agent.open && <rect x="10.5" y="3.5" width="3" height="9" fill="currentColor" opacity="0.5" />}
            </svg>
          </button>
          {account}
        </div>
      </div>
    </div>
  );
}
