import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "../AuthContext";
import { useSessions } from "../sessions/SessionContext";
import { PersistedSession } from "../sessions/storage";
import { GROUP_ORDER, SESSION_TYPES } from "../sessions/registry";
import { useStartSession } from "../sessions/start";
import { useTemplates } from "../sessions/templates";
import Popover from "./Popover";
import SessionMenuItems from "./SessionMenuItems";

/** Whether the catalogue is folded. A per-browser preference, like the rail itself. */
const CATALOGUE_STORAGE_KEY = "cwi-rail-catalogue";

/** Which categories are collapsed. A per-browser preference too: what you
 * have expanded is about how you like to look at the panel, not something
 * worth following you to another machine. */
const COLLAPSED_CATEGORIES_STORAGE_KEY = "cwi-rail-collapsed-categories";

/** A drop target is either a session (drop onto it to sit next to it, and
 * take on its category) or a category header, including the "no category"
 * heading at the top -- dropping there is how a session leaves a category. */
type DropTarget = { kind: "session"; id: string } | { kind: "category"; id: number | null };

function dropKey(target: DropTarget): string {
  return target.kind === "session" ? `session:${target.id}` : `category:${target.id ?? "none"}`;
}

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

  const {
    sessions,
    activeId,
    view,
    closed,
    reopen,
    remove,
    activate,
    rename,
    reorder,
    show,
    categories,
    createCategory,
    renameCategory,
    deleteCategory,
    reorderCategories,
    setSessionCategory,
  } = useSessions();
  const { templates } = useTemplates();
  const { startOne, startFromTemplate } = useStartSession();
  const { user } = useAuth();

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

  // Sessions reorder by dragging, as they did in the strip this replaced --
  // and, now that sessions can belong to a category, dropping one onto another
  // session or onto a category's header also moves it into that category (or,
  // dropped on the "Sessions" heading, out of any category). Pointer events
  // rather than HTML5 drag-and-drop: a native drag hands the mouse to the
  // browser for the whole gesture, and one that never delivers its dragend
  // leaves the page looking frozen until a reload. Vertical here, since the
  // rail is a column.
  const dragRef = useRef<{ id: string; startY: number; moved: boolean; over: DropTarget | null; y: number } | null>(
    null,
  );
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const DRAG_THRESHOLD_PX = 5;

  /** Which drop target is under a y, hit-tested by geometry so it works the
   * same while the pointer is captured by the row it started on. Sessions and
   * category headers (including the "no category" heading) are both
   * droppable, so both are matched by the one selector. */
  function rowUnder(y: number): DropTarget | null {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-session-id], [data-category-drop]"))) {
      const r = el.getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      if (el.dataset.sessionId) return { kind: "session", id: el.dataset.sessionId };
      const raw = el.dataset.categoryDrop;
      return { kind: "category", id: raw === "none" ? null : Number(raw) };
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
    const next = over && !(over.kind === "session" && over.id === drag.id) ? over : null;
    const nextKey = next ? dropKey(next) : null;
    if (nextKey === (drag.over ? dropKey(drag.over) : null)) return;
    drag.over = next;
    setDropTarget(nextKey);
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
    if (!commit || !drag.over) return;
    if (drag.over.kind === "category") {
      setSessionCategory(drag.id, drag.over.id);
      return;
    }
    const target = sessions.find((s) => s.id === drag.over!.id);
    const to = sessions.findIndex((s) => s.id === drag.over!.id);
    if (to >= 0) reorder(drag.id, to);
    // Landing among another category's sessions takes on that category, the
    // way dragging a channel into a different section in Slack does.
    if (target) setSessionCategory(drag.id, target.categoryId ?? null);
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

  // Which categories are folded to just their header. Remembered per browser,
  // like the catalogue -- expanded by default, since a category you just made
  // should show what you put in it.
  const [collapsedCategories, setCollapsedCategories] = useState<Set<number>>(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
      return raw ? new Set(JSON.parse(raw) as number[]) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_CATEGORIES_STORAGE_KEY, JSON.stringify(Array.from(collapsedCategories)));
    } catch {
      // best-effort persistence only
    }
  }, [collapsedCategories]);

  function toggleCollapsed(id: number) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function moveCategory(id: number, delta: number) {
    const from = categories.findIndex((c) => c.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= categories.length) return;
    const ids = categories.map((c) => c.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    reorderCategories(ids);
  }

  async function addCategory() {
    const name = window.prompt("New category:");
    if (!name?.trim()) return;
    try {
      await createCategory(name.trim());
    } catch (e: any) {
      window.alert(e?.message ?? "Couldn't create the category.");
    }
  }

  // Grouped for rendering, in the sessions' own relative order within each
  // group -- categorizing a session never reorders it among its new
  // neighbours.
  const byCategory = new Map<number, PersistedSession[]>();
  const uncategorized: PersistedSession[] = [];
  for (const s of sessions) {
    if (s.categoryId == null) {
      uncategorized.push(s);
      continue;
    }
    const list = byCategory.get(s.categoryId);
    if (list) list.push(s);
    else byCategory.set(s.categoryId, [s]);
  }

  /** One row, open or being renamed -- shared by the uncategorized list and
   * every category's own list, so a session reads and behaves the same way
   * wherever it sits. */
  function renderSessionRow(s: PersistedSession) {
    return (
      <div
        key={s.id}
        data-session-id={s.id}
        className={
          `rail-row${view === "session" && activeId === s.id ? " active" : ""}` +
          `${dragging === s.id ? " dragging" : ""}${dropTarget === dropKey({ kind: "session", id: s.id }) ? " drop-target" : ""}`
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
          {(close) => (
            <SessionMenuItems
              session={s}
              categories={categories}
              onRename={() => setRenaming(s.id)}
              onMoveToCategory={(id) => setSessionCategory(s.id, id)}
              close={close}
            />
          )}
        </Popover>
      </div>
    );
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
          that, which is why it is the one that asks. Categories group this
          list the way channels are grouped in Slack: this heading doubles as
          the "no category" drop zone, since a session dragged here leaves
          whichever category it was in. */}
      <div
        className={`rail-heading rail-category-drop${dropTarget === "category:none" ? " drop-target" : ""}`}
        data-category-drop="none"
      >
        Sessions
      </div>
      {sessions.length + closed.length === 0 && <div className="rail-empty">No sessions yet.</div>}
      {uncategorized.map(renderSessionRow)}

      {categories.map((category) => {
        const collapsed = collapsedCategories.has(category.id);
        const inCategory = byCategory.get(category.id) ?? [];
        return (
          <div key={category.id} className="rail-category">
            <div
              className={`rail-category-header${dropTarget === `category:${category.id}` ? " drop-target" : ""}`}
              data-category-drop={category.id}
            >
              <button
                className="rail-category-toggle"
                onClick={() => toggleCollapsed(category.id)}
                aria-expanded={!collapsed}
                title={`${collapsed ? "Expand" : "Collapse"} "${category.name}"`}
              >
                <span className="rail-category-caret" aria-hidden="true">
                  {collapsed ? "▸" : "▾"}
                </span>
                <span className="rail-category-label">{category.name}</span>
                {collapsed && inCategory.length > 0 && (
                  <span className="rail-category-count">{inCategory.length}</span>
                )}
              </button>
              <Popover
                glyph="⋮"
                label={`More for ${category.name}`}
                title="More"
                buttonClass="rail-row-more"
                menuClass="rail-row-menu"
                width={MENU_WIDTH_PX}
              >
                {(close) => (
                  <>
                    <button
                      onClick={() => {
                        close();
                        const name = window.prompt("Rename category:", category.name);
                        const trimmed = name?.trim();
                        if (trimmed && trimmed !== category.name) {
                          renameCategory(category.id, trimmed).catch((e: any) =>
                            window.alert(e?.message ?? "Couldn't rename the category."),
                          );
                        }
                      }}
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => {
                        close();
                        moveCategory(category.id, -1);
                      }}
                    >
                      Move up
                    </button>
                    <button
                      onClick={() => {
                        close();
                        moveCategory(category.id, 1);
                      }}
                    >
                      Move down
                    </button>
                    <button
                      className="rail-row-menu-danger"
                      onClick={() => {
                        close();
                        if (
                          window.confirm(
                            `Delete category "${category.name}"? Its sessions stay -- they just won't be grouped any more.`,
                          )
                        ) {
                          deleteCategory(category.id).catch((e: any) =>
                            window.alert(e?.message ?? "Couldn't delete the category."),
                          );
                        }
                      }}
                      title="The category only -- its sessions are kept, ungrouped"
                    >
                      Delete
                    </button>
                  </>
                )}
              </Popover>
            </div>
            {!collapsed && (
              <div className="rail-category-sessions">
                {inCategory.length === 0 ? (
                  <div className="rail-empty">Drag a session here.</div>
                ) : (
                  inCategory.map(renderSessionRow)
                )}
              </div>
            )}
          </div>
        );
      })}

      <button className="rail-category-add" onClick={addCategory} title="Group sessions under a name">
        <span>＋ New category</span>
      </button>

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
          {/* One click for the common case: a session holding the one service
              or tool you clicked, named after it. Anything more -- several
              panes, or a name of your own -- is the card on the home page,
              which is what the row above goes to. */}
          {GROUP_ORDER.map((group) => {
            const inGroup = SESSION_TYPES.filter((t) => t.group === group && t.enabledFor(user));
            if (inGroup.length === 0) return null;
            return (
              <div key={group}>
                <div className="rail-heading">{group}</div>
                {inGroup.map((t) => (
                  <button
                    key={t.type}
                    className="rail-row rail-row-type"
                    onClick={() => startOne(t.type)}
                    title={`Start a session on ${t.label} — ${t.description}`}
                  >
                    <span className="rail-row-label">{t.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {templates.length > 0 && (
            <div>
              <div className="rail-heading">Templates</div>
              {templates.map((template) => (
                <button
                  key={`${template.entry.page}:${template.entry.id}`}
                  className="rail-row rail-row-type rail-row-template"
                  onClick={() => startFromTemplate(template)}
                  title={`Start a session from "${template.entry.name}"`}
                >
                  <span className="rail-row-label">{template.entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </nav>
  );
}
