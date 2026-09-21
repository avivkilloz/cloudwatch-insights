import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { nextTitle } from "../sessions/naming";
import { encode } from "../sessions/storage";
import { GROUP_ORDER, SESSION_TYPES, sessionType, sessionTypeLabel } from "../sessions/registry";
import {
  SAVED_STATE_VERSION,
  Template,
  VERSION_KEY,
  templateState,
  templateType,
  useTemplates,
} from "../sessions/templates";

/** Stamped into every saved template so the reader can tell the current shape
 * (a session's own state bag) from the hand-rolled per-page shapes that came
 * before it. Guessing from the keys doesn't work: a legacy Aggregator save and
 * a current one both have `services`, and guessing threw the rest away. */
/** Whether the catalogue is folded. A per-browser preference, like the rail itself. */
const CATALOGUE_STORAGE_KEY = "cwi-rail-catalogue";

/** Kept in step with `.rail-row-menu`'s min-width, to keep the menu on screen. */
const MENU_WIDTH_PX = 156;

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
  const { sessions, activeId, view, open, closed, reopen, remove, activate, rename, reorder, show, captureInputs } =
    useSessions();
  const { templates, reload: reloadTemplates } = useTemplates();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Which row is being renamed in place. Closing a session lives in the strip
  // above the body now, so the ⋮ is only what you do to the session itself.
  const [renaming, setRenaming] = useState<string | null>(null);
  // Where to paint the open ⋮ menu. It is portalled to the body: the rail
  // scrolls, and an absolutely-positioned child of a scrolling box is clipped
  // by it -- which is what hid the menu inside the panel.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The catalogue is the old + menu, inlined. Folded by default so the rail
  // opens on what you have rather than everything you could have; unfolding it
  // is remembered, so it stays open once you ask for it.
  const [catalogue, setCatalogue] = useState(() => {
    try {
      return window.localStorage.getItem(CATALOGUE_STORAGE_KEY) === "open";
    } catch {
      return false;
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

  /** Paint the menu just under its ⋮, and keep it inside the window. Measured
   * from the menu itself once it is up, so a menu wider than the rail overhangs
   * the page rather than running off the edge of the screen. */
  const placeMenu = useCallback(() => {
    const button = menuButtonRef.current;
    if (!button) return;
    const r = button.getBoundingClientRect();
    const width = menuRef.current?.offsetWidth || MENU_WIDTH_PX;
    setMenuPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 4 });
  }, []);

  useLayoutEffect(() => {
    if (menuFor) placeMenu();
  }, [menuFor, placeMenu]);

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
    window.addEventListener("resize", placeMenu);
    // The menu is fixed to the viewport, so anything that moves the ⋮ under it
    // has to move it too -- and the rail scrolls the button into view the moment
    // it takes focus, which is every time the menu opens.
    document.addEventListener("scroll", placeMenu, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", placeMenu);
      document.removeEventListener("scroll", placeMenu, true);
    };
  }, [menuFor, placeMenu]);

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
    // Left button only, and never from the row's ⋮ or the menu it opens --
    // the menu is portalled to the body but is still a React child of the row,
    // so its events bubble through here.
    if (e.button !== 0 || (e.target as HTMLElement).closest(".rail-row-more, .rail-row-menu")) return;
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

  function openTemplate({ entry, type }: Template) {
    // A template seeds a brand-new session; nothing about the saved copy
    // changes as you work in it.
    startSession(templateType(entry, type), entry.name, templateState(entry));
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
    reloadTemplates();
    setMenuFor(null);
  }

  if (!expanded) return null;

  return (
    <nav className="rail" aria-label="Sessions">
      <button
        className={`rail-row rail-row-home${view === "home" ? " active" : ""}`}
        onClick={() => show("home")}
        title="The home page: every service, tool and platform feature"
      >
        {/* Every other row in the rail is a session or a session type; the icon
            is what tells this one apart at a glance. */}
        <svg className="rail-row-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M2.5 7 8 2.5 13.5 7v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M6.4 14V9.6h3.2V14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        <span className="rail-row-label">Home</span>
      </button>

      {/* One list: every session you have. The ones on the strip read at full
          strength, the ones you closed are dimmed -- closing takes a session
          off the strip, it does not take it away from you. Only Delete does
          that, which is why it is the one that asks. */}
      <div className="rail-heading">Sessions</div>
      {sessions.length + closed.length === 0 && <div className="rail-empty">No sessions yet.</div>}
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
            {renaming === s.id ? (
              // In place rather than a prompt() box: you can see the row you
              // are naming, and the rest of the panel stays readable.
              <input
                className="rail-row-rename"
                autoFocus
                defaultValue={s.title}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    // Cleared first so the blur below commits nothing.
                    setRenaming(null);
                  }
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
              <button
                className="rail-row-label"
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  activate(s.id);
                }}
                onDoubleClick={() => setRenaming(s.id)}
                title={`${s.title} (${sessionTypeLabel(s.type)}) — double-click to rename`}
              >
                {s.title}
              </button>
            )}
            <button
              className="rail-row-more"
              ref={menuFor === s.id ? menuButtonRef : undefined}
              onClick={(e) => {
                menuButtonRef.current = e.currentTarget;
                setMenuFor((v) => (v === s.id ? null : s.id));
              }}
              aria-label={`More for ${s.title}`}
              aria-expanded={menuFor === s.id}
              title="More"
            >
              ⋮
            </button>
            {menuFor === s.id &&
              menuPos &&
              createPortal(
                <div className="rail-row-menu" ref={menuRef} style={{ left: menuPos.left, top: menuPos.top }}>
                  <button
                    onClick={() => {
                      setMenuFor(null);
                      setRenaming(s.id);
                    }}
                    title="Rename it here in the panel"
                  >
                    Rename
                  </button>
                  {def?.savedPage && <button onClick={() => saveAsTemplate(s.id)}>Save as template…</button>}
                  {/* The only thing in here that loses work, so it says so and
                      asks first -- Close is the one that is meant to be cheap. */}
                  <button
                    className="rail-row-menu-danger"
                    onClick={() => {
                      setMenuFor(null);
                      if (window.confirm(`Delete "${s.title}"? This can't be undone.`)) remove(s.id);
                    }}
                    title="Throw the session away for good"
                  >
                    Delete
                  </button>
                </div>,
                document.body,
              )}
          </div>
        );
      })}

      {/* Closed, in the same list and dimmed. No state loaded until one is
          clicked: nothing trims this, so fetching every session's rows on every
          page load would get slower the longer you had used the app. */}
      {closed.map((s) => (
        <div key={s.client_id} data-closed-session-id={s.client_id} className="rail-row rail-row-closed">
          <button
            className="rail-row-label"
            onClick={() => reopen(s.client_id)}
            title={`${s.title} (${sessionTypeLabel(s.type as SessionType)}) — closed; click to open it again`}
          >
            {s.title}
          </button>
          {/* Its own class rather than the ⋮'s: this one deletes on the spot,
              and anything hunting for "the row's menu button" should not find
              it. */}
          <button
            className="rail-row-forget"
            onClick={() => {
              if (window.confirm(`Delete "${s.title}"? This can't be undone.`)) remove(s.client_id);
            }}
            aria-label={`Delete ${s.title}`}
            title="Throw the session away for good"
          >
            ✕
          </button>
        </div>
      ))}

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

      {catalogue && (
        <>
          {GROUP_ORDER.map((group) => {
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
          {/* Templates belong here rather than in a list of their own: opening
              one starts a new session, exactly like every other thing under
              Add. It is only the seed that differs. */}
          {templates.length > 0 && (
            <div>
              <div className="rail-heading">Templates</div>
              {templates.map(({ entry, type }) => (
                <button
                  key={`${entry.page}:${entry.id}`}
                  className="rail-row rail-row-type rail-row-template"
                  onClick={() => openTemplate({ entry, type })}
                  title={`Start a ${sessionTypeLabel(type)} session from "${entry.name}"`}
                >
                  <span className="rail-row-label">{entry.name}</span>
                  <span className="rail-row-kind">{sessionTypeLabel(type)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </nav>
  );
}
