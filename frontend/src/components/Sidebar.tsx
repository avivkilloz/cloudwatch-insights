import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { nextTitle } from "../sessions/naming";
import { Template, templateState, useTemplates } from "../sessions/templates";
import Popover from "./Popover";
import SessionMenuItems from "./SessionMenuItems";

/** Whether the catalogue is folded. A per-browser preference, like the rail itself. */
const CATALOGUE_STORAGE_KEY = "cwi-rail-catalogue";

/** Kept in step with `.rail-row-menu`'s min-width, so the menu stays on screen
 * before it has been measured. */
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

  const { sessions, activeId, view, open, closed, reopen, remove, activate, rename, reorder, show, captureInputs } =
    useSessions();
  const { templates } = useTemplates();

  // Which row is being renamed in place. Started from the row's ⋮ or from a
  // double-click on its name.
  const [renaming, setRenaming] = useState<string | null>(null);

  // The catalogue is the old + menu, inlined. Folded by default so the panel
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

  function openTemplate({ entry }: Template) {
    // A template seeds a brand-new session; nothing about the saved copy
    // changes as you work in it.
    open(nextTitle(entry.name, sessions.map((s) => s.title)), templateState(entry));
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
                title={`${s.title} — double-click to rename`}
              >
                {s.title}
              </button>
            )}
            <Popover
              glyph="⋮"
              label={`More for ${s.title}`}
              title="More"
              buttonClass="rail-row-more"
              menuClass="rail-row-menu"
              width={MENU_WIDTH_PX}
            >
              {(close) => <SessionMenuItems session={s} onRename={() => setRenaming(s.id)} close={close} />}
            </Popover>
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
            title={`${s.title} — closed; click to open it again`}
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
          {/* Starting a session means choosing what goes in it and naming it,
              which is the card on the home page -- so this goes there rather
              than growing a second, smaller version of the same form. */}
          <button className="rail-row rail-row-type rail-row-new" onClick={() => show("home")}>
            <span className="rail-row-label">Start new session…</span>
          </button>
          {templates.length > 0 && (
            <div>
              <div className="rail-heading">Templates</div>
              {templates.map(({ entry, type }) => (
                <button
                  key={`${entry.page}:${entry.id}`}
                  className="rail-row rail-row-type rail-row-template"
                  onClick={() => openTemplate({ entry, type })}
                  title={`Start a session from "${entry.name}"`}
                >
                  <span className="rail-row-label">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </nav>
  );
}
