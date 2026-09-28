import { useState } from "react";
import { useAuth } from "../AuthContext";
import { useAgent } from "../agent/AgentContext";
import { useAgentActivity, useSessions } from "../sessions/SessionContext";
import { GROUP_ORDER, SESSION_TYPES } from "../sessions/registry";
import { useStartSession } from "../sessions/start";
import { useTemplates } from "../sessions/templates";
import AgentWorking from "./AgentWorking";
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
 * ones in front of you. Each tab's ⋮ offers what the panel's rows do, plus
 * closing it. At the far end, mirroring the panel's toggle at the start, is
 * the agent panel's.
 */
export default function SessionBar({ railOpen, onToggleRail }: { railOpen: boolean; onToggleRail: () => void }) {
  const { sessions, activeId, view, close, activate, rename, show } = useSessions();
  const agent = useAgent();
  const agentActive = useAgentActivity();
  const { templates } = useTemplates();
  const { startOne, startFromTemplate } = useStartSession();
  const { user } = useAuth();
  // The tab being renamed in place, from its ⋮.
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    /* The dock is what sticks and what carries the page background; the
       strip inside it is a plain card, the same width as the cards below. */
    <div className="session-bar-dock">
      <div className="session-bar">
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
              {renaming === s.id ? (
                <input
                  className="session-tab-rename"
                  autoFocus
                  defaultValue={s.title}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    // Cleared first, so the blur that follows commits nothing.
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={(e) => {
                    if (renaming !== s.id) return;
                    const name = e.target.value.trim();
                    if (name && name !== s.title) rename(s.id, name);
                    setRenaming(null);
                  }}
                  aria-label={`Rename ${s.title}`}
                />
              ) : (
                <button className="session-tab-label" onClick={() => activate(s.id)} title={s.title}>
                  {s.title}
                </button>
              )}
              {agentActive.has(s.id) && <AgentWorking />}
              <Popover
                glyph="⋮"
                label={`More for ${s.title}`}
                title="More"
                buttonClass="session-tab-more"
                menuClass="rail-row-menu"
                width={170}
              >
                {(closeMenu) => (
                  <SessionMenuItems
                    session={s}
                    onRename={() => setRenaming(s.id)}
                    onClose={() => close(s.id)}
                    close={closeMenu}
                  />
                )}
              </Popover>
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
              {GROUP_ORDER.map((group) => {
                const inGroup = SESSION_TYPES.filter((t) => t.group === group && t.enabledFor(user));
                if (inGroup.length === 0) return null;
                return (
                  <div key={group}>
                    <div className="session-add-heading">{group}</div>
                    {inGroup.map((t) => (
                      <button
                        key={t.type}
                        className="session-add-item"
                        onClick={() => {
                          startOne(t.type);
                          closeMenu();
                        }}
                        title={`Start a session on ${t.label} — ${t.description}`}
                      >
                        <span className="session-add-name">{t.label}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
              {templates.length > 0 && (
                <div>
                  <div className="session-add-heading">Templates</div>
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

        {/* At the far end, the agent panel's toggle, as the panel's own is at
            the start -- whichever way the agent panel is laid out. */}
        <button
          className="session-bar-agent"
          onClick={() => agent.setOpen(!agent.open)}
          aria-expanded={agent.open}
          aria-label={agent.open ? "Hide the agent panel" : "Show the agent panel"}
          title={agent.open ? "Hide the agent panel" : "Show the agent panel"}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <line x1="9.5" y1="2.5" x2="9.5" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
            {agent.open && <rect x="10.5" y="3.5" width="3" height="9" fill="currentColor" opacity="0.5" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
