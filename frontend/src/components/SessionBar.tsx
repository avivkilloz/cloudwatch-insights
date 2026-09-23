import { useState } from "react";
import { useSessions } from "../sessions/SessionContext";
import { nextTitle } from "../sessions/naming";
import { templateState, useTemplates } from "../sessions/templates";
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
 * ones in front of you. So closing lives here, on a ✕ per tab; and the ⋮ at the
 * end offers the same things the panel's rows do, for the session on screen.
 */
export default function SessionBar({ railOpen, onToggleRail }: { railOpen: boolean; onToggleRail: () => void }) {
  const { sessions, activeId, view, open, close, activate, rename, show } = useSessions();
  const { templates } = useTemplates();
  // Set when the current tab is being renamed in place, from the ⋮ below.
  const [renaming, setRenaming] = useState(false);

  // Only ever the tab you are looking at: the ⋮ here is about what is on
  // screen, and the panel is where you reach the rest.
  const current = view === "session" ? sessions.find((s) => s.id === activeId) : undefined;

  return (
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
            className={`session-tab${view === "session" && activeId === s.id ? " active" : ""}`}
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
              <button className="session-tab-label" onClick={() => activate(s.id)} title={s.title}>
                {s.title}
              </button>
            )}
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
            {templates.length > 0 && (
              <div>
                <div className="session-add-heading">Templates</div>
                {templates.map(({ entry }) => (
                  <button
                    key={`${entry.page}:${entry.id}`}
                    className="session-add-item session-add-template"
                    onClick={() => {
                      open(nextTitle(entry.name, sessions.map((s) => s.title)), templateState(entry));
                      closeMenu();
                    }}
                    title={`Start a session from "${entry.name}"`}
                  >
                    <span className="session-add-name">{entry.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Popover>

      {/* At the far end, and only when a session is showing: it acts on that
          one. The panel's ⋮ reaches any of them. */}
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
    </div>
  );
}
