import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { nextTitle } from "../sessions/naming";
import { GROUP_ORDER, SESSION_TYPES } from "../sessions/registry";

/**
 * The strip above the body: the rail's toggle, what is open, and a + to open
 * more.
 *
 * It sits in the body's column rather than across the top of the window, so it
 * lines up with the cards below it and the rail stands beside both. The rail
 * and this overlap on purpose -- the rail is the whole workspace (what is open,
 * what you closed, your templates, everything you could open), while this is
 * only the sessions in front of you, and closing one lives here. That keeps the
 * rail's ⋮ for the things you do to a session rather than to a tab.
 */
export default function SessionBar({ railOpen, onToggleRail }: { railOpen: boolean; onToggleRail: () => void }) {
  const { user } = useAuth();
  const { sessions, activeId, view, open, close, activate } = useSessions();
  const [adding, setAdding] = useState(false);
  // Portalled and positioned from the + itself, for the reason the rail's ⋮
  // menu is: an absolutely-positioned child of a scrolling box gets clipped by
  // it, and the tab strip scrolls.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const types = SESSION_TYPES.filter((t) => t.enabledFor(user));

  useLayoutEffect(() => {
    const button = addRef.current;
    if (!adding || !button) return;
    const r = button.getBoundingClientRect();
    const width = menuRef.current?.offsetWidth || 220;
    setMenuPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 4 });
  }, [adding]);

  useEffect(() => {
    if (!adding) return;
    function onDown(e: MouseEvent) {
      if ((e.target as HTMLElement).closest(".session-add-menu, .session-bar-add")) return;
      setAdding(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAdding(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [adding]);

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
            <button className="session-tab-label" onClick={() => activate(s.id)} title={s.title}>
              {s.title}
            </button>
            {/* Closing lives here, not in the rail: this strip is the tabs in
                front of you, and a ✕ on a tab is what people reach for. */}
            <button className="session-tab-close" onClick={() => close(s.id)} aria-label={`Close ${s.title}`} title="Close">
              ✕
            </button>
          </div>
        ))}
      </div>

      <button
        className="session-bar-add"
        ref={addRef}
        onClick={() => setAdding((v) => !v)}
        aria-expanded={adding}
        aria-label="Open a new session"
        title="Open a new session"
      >
        ＋
      </button>

      {adding &&
        menuPos &&
        createPortal(
          <div className="session-add-menu" ref={menuRef} style={{ left: menuPos.left, top: menuPos.top }}>
            {GROUP_ORDER.map((group) => {
              const inGroup = types.filter((t) => t.group === group);
              if (inGroup.length === 0) return null;
              return (
                <div key={group}>
                  <div className="session-add-heading">{group}</div>
                  {inGroup.map((t) => (
                    <button
                      key={t.type}
                      className="session-add-item"
                      onClick={() => {
                        open(t.type as SessionType, nextTitle(t.label, sessions.map((s) => s.title)));
                        setAdding(false);
                      }}
                      title={t.description}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
