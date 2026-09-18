import { PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const barRef = useRef<HTMLDivElement | null>(null);

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

  // Reordering tabs runs on pointer events, not HTML5 drag-and-drop.
  // A native drag hands the mouse to the browser for the whole gesture, and
  // any drag that never delivers its dragend -- one whose source element
  // re-renders away mid-gesture, say, which a polling page does on its own --
  // leaves that session live, so every later click goes to a drag that isn't
  // there and the page looks frozen until a reload. Pointer events have no
  // such session to get stuck in: setPointerCapture guarantees the release is
  // seen, and every exit path runs the same cleanup. This is the same trade
  // the Aggregator's pane reordering already made.
  //
  // The live drag lives in a ref so each handler reads what the one before it
  // wrote; the state below only drives the CSS.
  const dragRef = useRef<{ id: string; startX: number; moved: boolean; over: string | null; x: number } | null>(null);
  const autoScroll = useRef<number | null>(null);
  // A drag ends with a click on the tab it started from, which would
  // otherwise activate it.
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** How far the pointer travels before this is a drag and not a click. */
  const DRAG_THRESHOLD_PX = 5;
  // The strip scrolls horizontally, so a tab off the edge has to be reachable
  // mid-drag -- a native drag scrolls for you, a pointer one has to do it.
  const AUTO_SCROLL_EDGE_PX = 48;
  const AUTO_SCROLL_STEP_PX = 14;
  const AUTO_SCROLL_INTERVAL_MS = 16;

  /** Which tab is under an x, hit-tested by geometry so it works the same
   * while the pointer is captured by the tab it started on. */
  function tabUnder(x: number): string | null {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-tab-id]"))) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return el.dataset.tabId ?? null;
    }
    return null;
  }

  function updateDropTarget(drag: NonNullable<typeof dragRef.current>) {
    const over = tabUnder(drag.x);
    const next = over && over !== drag.id ? over : null;
    if (next === drag.over) return;
    drag.over = next;
    setDropTarget(next);
  }

  function autoScrollTick() {
    const drag = dragRef.current;
    const el = barRef.current;
    if (!drag || !drag.moved || !el) return;
    const r = el.getBoundingClientRect();
    let dx = 0;
    if (drag.x < r.left + AUTO_SCROLL_EDGE_PX) dx = -AUTO_SCROLL_STEP_PX;
    else if (drag.x > r.right - AUTO_SCROLL_EDGE_PX) dx = AUTO_SCROLL_STEP_PX;
    if (!dx) return;
    const before = el.scrollLeft;
    el.scrollLeft += dx;
    // At either end nothing scrolled, so nothing moved under the pointer.
    if (el.scrollLeft !== before) updateDropTarget(drag);
  }

  function startDrag(e: ReactPointerEvent<HTMLElement>, id: string) {
    // Left button only, and never from the close button on the tab.
    if (e.button !== 0 || (e.target as HTMLElement).closest(".session-tab-close")) return;
    // A drag released over another tab never delivers the click it was meant
    // to suppress, so clear it here rather than waiting for one.
    suppressClick.current = false;
    dragRef.current = { id, startX: e.clientX, x: e.clientX, moved: false, over: null };
  }

  function moveDrag(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    drag.x = e.clientX;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      // Captured only now, not on pointerdown. While an element holds the
      // capture the browser retargets the compatibility mouse events to it
      // too, so capturing up front sent the click to the tab's wrapper and
      // the label's own handler never ran -- clicking a tab stopped
      // activating it. Below the threshold the pointer is still over the tab
      // anyway, so nothing is lost by waiting.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(drag.id);
      autoScroll.current = window.setInterval(autoScrollTick, AUTO_SCROLL_INTERVAL_MS);
    }
    updateDropTarget(drag);
  }

  /** The single exit. `commit` is false when the drag was cancelled rather
   * than released, so the state still clears but nothing moves. */
  function endDrag(commit: boolean) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (autoScroll.current !== null) {
      window.clearInterval(autoScroll.current);
      autoScroll.current = null;
    }
    setDragging(null);
    setDropTarget(null);
    if (!drag?.moved) return;
    suppressClick.current = true;
    if (commit && drag.over) {
      const to = sessions.findIndex((s) => s.id === drag.over);
      if (to >= 0) reorder(drag.id, to);
    }
  }

  // Escape cancels a drag in progress, the way a native one would.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") endDrag(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
    <div className="session-bar" ref={barRef}>
      {sessions.map((s) => (
        <div
          key={s.id}
          data-tab-id={s.id}
          className={
            `session-tab${view === "session" && activeId === s.id ? " active" : ""}` +
            `${dragging === s.id ? " dragging" : ""}${dropTarget === s.id ? " drop-target" : ""}`
          }
          onPointerDown={(e) => startDrag(e, s.id)}
          onPointerMove={moveDrag}
          onPointerUp={() => endDrag(true)}
          onPointerCancel={() => endDrag(false)}
        >
          <button
            className="session-tab-label"
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              activate(s.id);
            }}
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
