import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, SavedSession } from "../api";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { decode, encode } from "../sessions/storage";
import { GROUP_ORDER, SESSION_TYPES, sessionType, sessionTypeLabel } from "../sessions/registry";

/** "Logs", then "Logs 2", "Logs 3" -- several sessions of one kind is the
 * point of the strip, so they have to be tellable apart at a glance. */
function nextTitle(label: string, taken: string[]): string {
  if (!taken.includes(label)) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Stamped into every saved session so the reader can tell the current shape
 * (a session's own state bag) from the hand-rolled per-page shapes that came
 * before it. Guessing from the keys doesn't work: a legacy Aggregator save and
 * a current one both have `services`, and guessing threw the rest away. */
const SAVED_STATE_VERSION = 2;
const VERSION_KEY = "__savedStateVersion";

/**
 * Saved sessions written before sessions held their own state used a
 * hand-rolled shape per page. Mapping the ones that existed costs little and
 * beats opening a session that silently ignores everything it was given.
 */
function migrateLegacyState(page: string, state: Record<string, any>): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  if (state[VERSION_KEY] === SAVED_STATE_VERSION) {
    const { [VERSION_KEY]: _version, ...rest } = state;
    // Round-tripped through the workspace codec, which tags Sets and Maps.
    // Plain JSON.stringify flattens a Set to {}, and a page that then calls
    // .has() on it takes the whole app down.
    return decode<Record<string, unknown>>(JSON.stringify(rest));
  }
  if (page === "logs" && Array.isArray(state.environment_ids)) {
    return {
      backend: state.backend ?? "cloudwatch",
      selectedEnvironmentIds: new Set(state.environment_ids),
      logGroupSelection: state.log_group_selection ?? {},
      queryString: state.query_string ?? "",
      limit: state.limit,
      timestampField: state.timestamp_field,
      sortField: state.sort_field,
      sortDirection: state.sort_direction,
      preset: state.preset,
      customStart: state.custom_start,
      customEnd: state.custom_end,
    };
  }
  if (page === "iot" && Array.isArray(state.environment_ids)) {
    return {
      selectedEnvironmentIds: new Set(state.environment_ids),
      searchMode: state.search_mode ?? "things",
      queryString: state.query_string ?? "",
      maxResults: state.max_results,
    };
  }
  if (page === "aggregator" && Array.isArray(state.services)) {
    return { services: state.services, layout: state.layout ?? "columns" };
  }
  return state;
}

export default function SessionTabs() {
  const { user } = useAuth();
  const { sessions, activeId, view, open, close, activate, rename, reorder, captureInputs } = useSessions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [saved, setSaved] = useState<{ entry: SavedSession<Record<string, unknown>>; type: SessionType }[]>([]);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const types = SESSION_TYPES.filter((t) => t.enabledFor(user));
  const active = sessions.find((s) => s.id === activeId);

  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    const withSaved = types.filter((t) => t.savedPage);
    Promise.all(
      withSaved.map((t) =>
        api
          .listSavedSessions<Record<string, unknown>>(t.savedPage!)
          .then((list) => list.map((entry) => ({ entry, type: t.type })))
          .catch(() => []),
      ),
    ).then((lists) => {
      if (!cancelled) setSaved(lists.flat());
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  // The menu is portalled to the body: the strip scrolls horizontally, and an
  // absolutely-positioned child of a scrolling box gets clipped by it -- which
  // is what used to hide the list behind the page.
  useLayoutEffect(() => {
    if (!menuOpen || !addRef.current) return;
    const r = addRef.current.getBoundingClientRect();
    setMenuPos({ left: Math.min(r.left, window.innerWidth - 260), top: r.bottom + 4 });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || addRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", () => setMenuOpen(false), { once: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function startSession(type: SessionType, label: string, state?: Record<string, unknown>) {
    open(type, nextTitle(label, sessions.map((s) => s.title)), state);
    setMenuOpen(false);
  }

  function openSaved(entry: SavedSession<Record<string, unknown>>, type: SessionType) {
    // A saved session is a template: its inputs seed a brand-new session, and
    // nothing about the saved copy changes as you work in it.
    startSession(type, entry.name, migrateLegacyState(entry.page, entry.state as Record<string, any>));
  }

  async function saveActive() {
    if (!active) return;
    const def = sessionType(active.type);
    if (!def?.savedPage) return;
    const name = prompt("Save session as:", active.title);
    if (!name?.trim()) return;
    // Encoded with the tags, then parsed back to a plain object so the API's
    // own JSON.stringify has nothing left to lose.
    const state = JSON.parse(encode(captureInputs(active.id)));
    await api.createSavedSession({ page: def.savedPage, name: name.trim(), state: { ...state, [VERSION_KEY]: SAVED_STATE_VERSION } });
  }

  const canSaveActive = view === "session" && !!active && !!sessionType(active.type)?.savedPage;

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
          there are none -- so an empty strip still shows the one thing to do. */}
      <button
        className="session-add-button"
        ref={addRef}
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="New session"
        aria-expanded={menuOpen}
        title="New session"
      >
        +
      </button>

      {canSaveActive && (
        <button
          className="session-save-button"
          onClick={saveActive}
          title={`Save ${active!.title} as a reusable session`}
        >
          Save session
        </button>
      )}

      {menuOpen &&
        menuPos &&
        createPortal(
          <div className="session-menu" ref={menuRef} style={{ left: menuPos.left, top: menuPos.top }}>
            {GROUP_ORDER.map((group) => {
              const inGroup = types.filter((t) => t.group === group);
              if (inGroup.length === 0) return null;
              return (
                <div key={group}>
                  <div className="session-menu-heading">{group}</div>
                  {inGroup.map((t) => (
                    <button key={t.type} className="session-menu-item" onClick={() => startSession(t.type, t.label)}>
                      {t.label}
                    </button>
                  ))}
                </div>
              );
            })}
            <div className="session-menu-heading">Saved sessions</div>
            {saved.length === 0 && <div className="session-menu-empty">Nothing saved yet.</div>}
            {saved.map(({ entry, type }) => (
              <button
                key={`${entry.page}:${entry.id}`}
                className="session-menu-item"
                onClick={() => openSaved(entry, type)}
              >
                {entry.name}
                <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                  {sessionTypeLabel(type)}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
