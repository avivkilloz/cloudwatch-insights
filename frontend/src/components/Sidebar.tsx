import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { api, SavedSession } from "../api";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { decode, encode } from "../sessions/storage";
import { GROUP_ORDER, SESSION_TYPES, sessionType, sessionTypeLabel } from "../sessions/registry";

/** "Logs", then "Logs 2", "Logs 3" -- several sessions of one kind is the
 * point, so they have to be tellable apart at a glance. */
function nextTitle(label: string, taken: string[]): string {
  if (!taken.includes(label)) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Stamped into every saved template so the reader can tell the current shape
 * (a session's own state bag) from the hand-rolled per-page shapes that came
 * before it. Guessing from the keys doesn't work: a legacy Aggregator save and
 * a current one both have `services`, and guessing threw the rest away. */
/** Whether the catalogue is folded. A per-browser preference, like the rail itself. */
const CATALOGUE_STORAGE_KEY = "cwi-rail-catalogue";

const SAVED_STATE_VERSION = 2;
const VERSION_KEY = "__savedStateVersion";

/**
 * Templates written before sessions held their own state used a hand-rolled
 * shape per page. Mapping the ones that existed costs little and beats opening
 * a session that silently ignores everything it was given.
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

/**
 * The left rail: where you are, what you have open, and everything you could
 * open next.
 *
 * It replaces the horizontal session strip. Sessions are a list rather than a
 * row of tabs because a row runs out of width at about six, and this app is
 * built around having several open at once. The brand in the header collapses
 * it away entirely when the page needs the room.
 */
export default function Sidebar({ open: expanded }: { open: boolean }) {
  const { user } = useAuth();
  const { sessions, activeId, view, open, close, activate, rename, reorder, show, captureInputs } = useSessions();
  const [saved, setSaved] = useState<{ entry: SavedSession<Record<string, unknown>>; type: SessionType }[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Bumped when a template is written, so the list below refetches. Session
  // count alone doesn't change when you save one, so without this a template
  // you just saved wouldn't appear until something else moved.
  const [savedVersion, setSavedVersion] = useState(0);
  // The catalogue is the old + menu, inlined. Open by default -- the point of
  // the panel is that everything you can reach is in it -- and folded only if
  // you fold it, which is remembered so a long session list stays readable.
  const [catalogue, setCatalogue] = useState(() => {
    try {
      return window.localStorage.getItem(CATALOGUE_STORAGE_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(CATALOGUE_STORAGE_KEY, catalogue ? "open" : "closed");
    } catch {
      // best-effort persistence only
    }
  }, [catalogue]);

  const types = SESSION_TYPES.filter((t) => t.enabledFor(user));

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    Promise.all(
      types
        .filter((t) => t.savedPage)
        .map((t) =>
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
  }, [expanded, sessions.length, savedVersion]);

  // One ⋮ menu at a time, and a click anywhere else closes it.
  useEffect(() => {
    if (!menuFor) return;
    function onDown(e: MouseEvent) {
      if ((e.target as HTMLElement).closest(".rail-row-menu, .rail-row-more")) return;
      setMenuFor(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuFor(null);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  // Sessions reorder by dragging, as they did in the strip this replaced.
  // Pointer events rather than HTML5 drag-and-drop: a native drag hands the
  // mouse to the browser for the whole gesture, and one that never delivers
  // its dragend leaves the page looking frozen until a reload. Vertical here,
  // since the rail is a column.
  const dragRef = useRef<{ id: string; startY: number; moved: boolean; over: string | null; y: number } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const DRAG_THRESHOLD_PX = 5;

  /** Which open session is under a y, hit-tested by geometry so it works the
   * same while the pointer is captured by the row it started on. */
  function rowUnder(y: number): string | null {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-session-id]"))) {
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return el.dataset.sessionId ?? null;
    }
    return null;
  }

  function startDrag(e: ReactPointerEvent<HTMLElement>, id: string) {
    // Left button only, and never from the ⋮ that opens the row's menu.
    if (e.button !== 0 || (e.target as HTMLElement).closest(".rail-row-more")) return;
    suppressClick.current = false;
    dragRef.current = { id, startY: e.clientY, y: e.clientY, moved: false, over: null };
  }

  function moveDrag(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    drag.y = e.clientY;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      // Captured only now: while an element holds the capture the browser
      // retargets the compatibility mouse events to it too, and capturing up
      // front would send the click to the row instead of its label.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(drag.id);
    }
    const over = rowUnder(drag.y);
    const next = over && over !== drag.id ? over : null;
    if (next === drag.over) return;
    drag.over = next;
    setDropTarget(next);
  }

  /** The single exit. `commit` is false when the drag was cancelled rather
   * than released, so the state clears but nothing moves. */
  function endDrag(commit: boolean) {
    const drag = dragRef.current;
    dragRef.current = null;
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
  }

  function openSaved(entry: SavedSession<Record<string, unknown>>, type: SessionType) {
    // A template seeds a brand-new session; nothing about the saved copy
    // changes as you work in it.
    const state = migrateLegacyState(entry.page, entry.state as Record<string, any>);
    // Everything saved from the old combined Logs page lives under "logs",
    // whichever backend it was using. Its own state says which.
    const resolved: SessionType =
      entry.page === "logs" && state.backend === "opensearch" ? "logs-opensearch" : type;
    startSession(resolved, entry.name, state);
  }

  async function saveAsTemplate(id: string) {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    const def = sessionType(session.type);
    if (!def?.savedPage) return;
    const name = prompt("Save as template:", session.title);
    if (!name?.trim()) return;
    // Encoded with the tags, then parsed back to a plain object so the API's
    // own JSON.stringify has nothing left to lose.
    const state = JSON.parse(encode(captureInputs(id)));
    await api.createSavedSession({
      page: def.savedPage,
      name: name.trim(),
      state: { ...state, [VERSION_KEY]: SAVED_STATE_VERSION },
    });
    setSavedVersion((v) => v + 1);
    setMenuFor(null);
  }

  if (!expanded) return null;

  return (
    <nav className="rail" aria-label="Sessions">
      <button
        className={`rail-row${view === "home" ? " active" : ""}`}
        onClick={() => show("home")}
        title="The home page: every service, tool and platform feature"
      >
        <span className="rail-row-label">Home</span>
      </button>

      <div className="rail-heading">Open</div>
      {sessions.length === 0 && <div className="rail-empty">Nothing open yet.</div>}
      {sessions.map((s) => {
        const def = sessionType(s.type);
        return (
          <div
            key={s.id}
            data-session-id={s.id}
            className={
              `rail-row${view === "session" && activeId === s.id ? " active" : ""}` +
              `${dragging === s.id ? " dragging" : ""}${dropTarget === s.id ? " drop-target" : ""}`
            }
            onPointerDown={(e) => startDrag(e, s.id)}
            onPointerMove={moveDrag}
            onPointerUp={() => endDrag(true)}
            onPointerCancel={() => endDrag(false)}
          >
            <button
              className="rail-row-label"
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
              className="rail-row-more"
              onClick={() => setMenuFor((v) => (v === s.id ? null : s.id))}
              aria-label={`More for ${s.title}`}
              aria-expanded={menuFor === s.id}
              title="More"
            >
              ⋮
            </button>
            {menuFor === s.id && (
              <div className="rail-row-menu">
                {def?.savedPage && (
                  <button onClick={() => saveAsTemplate(s.id)}>Save as template…</button>
                )}
                <button
                  onClick={() => {
                    close(s.id);
                    setMenuFor(null);
                  }}
                >
                  Close
                </button>
              </div>
            )}
          </div>
        );
      })}

      {saved.length > 0 && (
        <>
          <div className="rail-heading">Templates</div>
          {saved.map(({ entry, type }) => (
            <button
              key={`${entry.page}:${entry.id}`}
              className="rail-row rail-row-template"
              onClick={() => openSaved(entry, type)}
              title={`Start a ${sessionTypeLabel(type)} session from "${entry.name}"`}
            >
              <span className="rail-row-label">{entry.name}</span>
              <span className="rail-row-kind">{sessionTypeLabel(type)}</span>
            </button>
          ))}
        </>
      )}

      {/* The catalogue is what the + menu used to hold. It lives in the rail
          rather than a popover so everything you can open is in one place. */}
      <button
        className="rail-add"
        onClick={() => setCatalogue((v) => !v)}
        aria-expanded={catalogue}
        title={catalogue ? "Hide what you can open" : "Show everything you can open"}
      >
        <span>＋ Add</span>
        <span className="rail-add-caret">{catalogue ? "▾" : "▸"}</span>
      </button>

      {catalogue &&
        GROUP_ORDER.map((group) => {
          const inGroup = types.filter((t) => t.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group}>
              <div className="rail-heading">{group}</div>
              {inGroup.map((t) => (
                <button
                  key={t.type}
                  className="rail-row rail-row-type"
                  onClick={() => startSession(t.type, t.label)}
                  title={t.description}
                >
                  <span className="rail-row-label">{t.label}</span>
                </button>
              ))}
            </div>
          );
        })}
    </nav>
  );
}
