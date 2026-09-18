import { useEffect, useRef, useState } from "react";
import { api, SavedSession } from "../api";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";

/** Session types the + menu offers, in the order it lists them. `savedPage` is
 * the SavedSession.page key this type's named sessions are stored under, where
 * the type has any -- that's how a saved session becomes a new open session. */
export const SESSION_TYPES: {
  type: SessionType;
  label: string;
  enabledFor: (u: any) => boolean;
  savedPage?: string;
}[] = [
  { type: "logs", label: "Logs", enabledFor: (u) => !!u?.logs_enabled, savedPage: "logs" },
  { type: "iot", label: "IoT", enabledFor: (u) => !!u?.iot_enabled, savedPage: "iot" },
  { type: "tables", label: "Tables", enabledFor: (u) => !!u?.tables_enabled },
  { type: "buckets", label: "Buckets", enabledFor: (u) => !!u?.buckets_enabled },
  { type: "cognito", label: "Cognito", enabledFor: (u) => !!u?.cognito_enabled },
  { type: "aggregator", label: "Aggregator", enabledFor: (u) => !!u?.aggregator_enabled, savedPage: "aggregator" },
  { type: "tools", label: "Tools", enabledFor: (u) => !!u?.tools_enabled },
];

export function sessionTypeLabel(type: string): string {
  return SESSION_TYPES.find((t) => t.type === type)?.label ?? type;
}

/** "Logs", then "Logs 2", "Logs 3" -- several sessions of one kind is the
 * point of the tab strip, so they have to be tellable apart at a glance. */
function nextTitle(label: string, taken: string[]): string {
  if (!taken.includes(label)) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export default function SessionTabs() {
  const { user } = useAuth();
  const { sessions, activeId, view, open, close, activate, rename, reorder } = useSessions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [saved, setSaved] = useState<SavedSession<Record<string, unknown>>[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const types = SESSION_TYPES.filter((t) => t.enabledFor(user));

  // Saved sessions are fetched when the menu opens rather than on mount, so
  // the list is current each time and costs nothing while it's closed.
  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    const pages = types.filter((t) => t.savedPage).map((t) => t.savedPage!);
    Promise.all(pages.map((page) => api.listSavedSessions<Record<string, unknown>>(page)))
      .then((lists) => {
        if (!cancelled) setSaved(lists.flat());
      })
      .catch(() => {
        if (!cancelled) setSaved([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function startSession(type: SessionType, label: string, state?: Record<string, unknown>) {
    open(type, nextTitle(label, sessions.map((s) => s.title)), state);
    setMenuOpen(false);
  }

  function openSaved(entry: SavedSession<Record<string, unknown>>) {
    const type = types.find((t) => t.savedPage === entry.page);
    if (!type) return;
    // A saved session is a template: its inputs seed a brand-new session, and
    // nothing about the saved copy changes as you work in it.
    startSession(type.type, entry.name, { ...entry.state });
  }

  return (
    <div className="session-bar">
      {sessions.map((s, i) => (
        <div
          key={s.id}
          className={`session-tab${view === "session" && activeId === s.id ? " active" : ""}`}
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/plain", s.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const dragged = e.dataTransfer.getData("text/plain");
            if (dragged && dragged !== s.id) reorder(dragged, i);
          }}
        >
          <button
            className="session-tab-label"
            onClick={() => activate(s.id)}
            onDoubleClick={() => {
              const name = prompt("Rename session:", s.title);
              if (name?.trim()) rename(s.id, name.trim());
            }}
            title={`${s.title} (${sessionTypeLabel(s.type)}) — double-click to rename`}
          >
            {s.title}
          </button>
          <button
            className="session-tab-close"
            onClick={() => close(s.id)}
            aria-label={`Close ${s.title}`}
            title={`Close ${s.title}`}
          >
            ✕
          </button>
        </div>
      ))}

      {/* The + always sits after the last tab, which means the left edge when
          there are none -- so an empty bar still shows the one thing to do. */}
      <div className="session-add" ref={menuRef}>
        <button
          className="session-add-button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="New session"
          aria-expanded={menuOpen}
          title="New session"
        >
          +
        </button>
        {menuOpen && (
          <div className="session-menu">
            <div className="session-menu-heading">New session</div>
            {types.map((t) => (
              <button key={t.type} className="session-menu-item" onClick={() => startSession(t.type, t.label)}>
                {t.label}
              </button>
            ))}
            <div className="session-menu-heading">Saved sessions</div>
            {saved.length === 0 && <div className="session-menu-empty">Nothing saved yet.</div>}
            {saved.map((entry) => (
              <button key={`${entry.page}:${entry.id}`} className="session-menu-item" onClick={() => openSaved(entry)}>
                {entry.name}
                <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                  {sessionTypeLabel(types.find((t) => t.savedPage === entry.page)?.type ?? entry.page)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
