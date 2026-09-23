import { useCallback, useEffect, useMemo, useRef, useState, PointerEvent as ReactPointerEvent } from "react";
import { api, SavedSession } from "../api";
import { SessionKeyScope, useSessionState } from "../sessions/SessionContext";
import { useAuth } from "../AuthContext";
import AiAssistantWidget from "../components/AiAssistantWidget";
import {
  AiPane,
  AiPaneRegistryContext,
  AiPaneSummary,
  DOMAIN_LABELS,
  sameSummaries,
  summarizePane,
} from "../components/aiPanes";
import { PANE_TYPES } from "../sessions/paneTypes";

type ServiceId = string;
/** How the open panes are arranged.
 *
 * "tabs" is the odd one out: the others show every pane at once, it shows one.
 * All of them stay mounted either way -- a pane you cannot see may still have a
 * search running, and unmounting it to save some DOM would throw that away. */
type Layout = "columns" | "stacked" | "tabs";

// Panes are session types that make sense side by side -- the registry says
// which, so a new tool or service shows up here without a second list.
const SERVICES = PANE_TYPES.map((t) => ({
  id: t.type as ServiceId,
  label: t.label,
  group: t.group,
  render: t.render,
  enabledFor: t.enabledFor,
}));

export default function AggregatorPage() {
  const { user } = useAuth();
  const [services, setServices] = useSessionState<ServiceId[]>("services", []);
  const [layout, setLayout] = useSessionState<Layout>("layout", "columns");
  // Which pane the tabs layout is showing. Kept even while another layout is
  // in use, so switching back lands where you left it.
  const [activePaneId, setActivePaneId] = useSessionState<ServiceId | null>("activePane", null);
  // Panes collapsed to just their header. Independent per pane -- minimising
  // one says nothing about the others, unlike a single "focused" pane would.
  const [minimized, setMinimized] = useSessionState<Set<ServiceId>>("minimized", () => new Set());

  // Panes register their full context (including the row arrays) here on every
  // render. Keeping it in a ref means that churn never re-renders this page;
  // `summaries` below holds only the small comparable slice the UI needs.
  const panesRef = useRef(new Map<string, AiPane>());
  const [summaries, setSummaries] = useState<AiPaneSummary[]>([]);
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
  }, []);

  const syncSummaries = useCallback(() => {
    const next = Array.from(panesRef.current.values()).map(summarizePane);
    setSummaries((prev) => (sameSummaries(prev, next) ? prev : next));
  }, []);

  const registry = useMemo(
    () => ({
      register(pane: AiPane) {
        panesRef.current.set(pane.id, pane);
        syncSummaries();
      },
      unregister(id: string) {
        panesRef.current.delete(id);
        syncSummaries();
      },
    }),
    [syncSummaries],
  );

  // Reordering by dragging is built on pointer events rather than HTML5
  // drag-and-drop, which went wrong in two ways that both ended in a pane you
  // could only un-stick by reloading. Its dragover handler had to call
  // preventDefault() to accept a drop, but it read which pane was being
  // dragged from React state set during dragstart -- on a page holding six
  // embedded pages that re-render can outlast the whole gesture, so the drop
  // was silently refused; and nothing but a dragend that never came would
  // clear the drag. Pointer events have no browser-level drag session to get
  // stuck in: setPointerCapture guarantees we see the release, and every exit
  // path runs the same cleanup.
  //
  // The live drag lives in a ref so each handler reads what the one before it
  // actually wrote; the state below only drives the CSS.
  const dragRef = useRef<{
    id: ServiceId;
    startX: number;
    startY: number;
    /** False until the pointer passes the threshold -- below it this is a click. */
    moved: boolean;
    /** The pane the pointer is currently over, if any. */
    over: ServiceId | null;
    /** Where the pointer last was, so the auto-scroll tick can re-hit-test. */
    x: number;
    y: number;
  } | null>(null);
  const autoScroll = useRef<number | null>(null);
  // A drag ends with a click on the title bar, which would otherwise minimise
  // the pane it just moved.
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<ServiceId | null>(null);
  const [dropTarget, setDropTarget] = useState<ServiceId | null>(null);

  // The checkbox list keeps its fixed order, but the panes follow `services`,
  // which is what reordering rewrites.
  const available = SERVICES.filter((s) => s.enabledFor(user));
  const open = services
    .map((id) => SERVICES.find((s) => s.id === id))
    .filter((s): s is (typeof SERVICES)[number] => !!s);

  // Falls back to the first rather than showing nothing: the remembered pane
  // may have been closed since, and a session with panes should never look
  // empty because a stored id no longer matches one.
  const shownPane = open.find((s) => s.id === activePaneId) ?? open[0];

  function toggleService(id: ServiceId) {
    setServices((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
    // Opening a pane selects it, which is what you meant by opening it; closing
    // the selected one hands the choice back to the fallback above.
    setActivePaneId((prev) => (prev === id ? null : services.includes(id) ? prev : id));
    // Closing a pane shouldn't leave it minimised for the next time it's opened.
    setMinimized((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** Moves a pane one place earlier (-1) or later (+1) in the order. */
  function moveService(id: ServiceId, delta: number) {
    setServices((prev) => {
      const from = prev.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  /** Drops `id` into the slot `over` currently occupies, shifting the rest. */
  function dropService(id: ServiceId, over: ServiceId) {
    if (id === over) return;
    setServices((prev) => {
      const from = prev.indexOf(id);
      const to = prev.indexOf(over);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  /** How far the pointer has to travel before this is a drag and not a click. */
  const DRAG_THRESHOLD_PX = 5;
  // Holding near the top or bottom edge scrolls, so panes that started off the
  // screen are still reachable -- a native drag does this for you, a
  // pointer-based one has to do it itself.
  const AUTO_SCROLL_EDGE_PX = 70;
  const AUTO_SCROLL_STEP_PX = 18;
  const AUTO_SCROLL_INTERVAL_MS = 16;

  /** The app scrolls inside .content, not the window. */
  function scroller(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".content");
  }

  function autoScrollTick() {
    const drag = dragRef.current;
    const el = scroller();
    if (!drag || !drag.moved || !el) return;
    const r = el.getBoundingClientRect();
    let dy = 0;
    if (drag.y < r.top + AUTO_SCROLL_EDGE_PX) dy = -AUTO_SCROLL_STEP_PX;
    else if (drag.y > r.bottom - AUTO_SCROLL_EDGE_PX) dy = AUTO_SCROLL_STEP_PX;
    if (!dy) return;
    const before = el.scrollTop;
    el.scrollTop += dy;
    // At either end there's nothing left to scroll, so nothing moved under
    // the pointer either.
    if (el.scrollTop !== before) updateDropTarget(drag);
  }

  /** Which pane is under a point, hit-tested by geometry so it works the same
   * whether the panes are in columns or stacked, and while the pointer is
   * captured by the title bar it started on. */
  function paneUnder(x: number, y: number): ServiceId | null {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"))) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return (el.dataset.paneId as ServiceId) ?? null;
      }
    }
    return null;
  }

  /** Re-hit-tests under the pointer and updates the highlight, doing nothing
   * (and so not re-rendering six embedded pages) when it hasn't changed. */
  function updateDropTarget(drag: NonNullable<typeof dragRef.current>) {
    const over = paneUnder(drag.x, drag.y);
    const next = over && over !== drag.id ? over : null;
    if (next === drag.over) return;
    drag.over = next;
    setDropTarget(next);
  }

  function startDrag(e: ReactPointerEvent<HTMLElement>, id: ServiceId) {
    // Left button only, and never from the buttons sitting on the title bar.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    // A drag that ended over another pane never delivers the click it was
    // meant to suppress, so clear it here rather than waiting for one.
    suppressClick.current = false;
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false, over: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveDrag(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
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
    if (commit && drag.over) dropService(drag.id, drag.over);
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

  function toggleMinimized(id: ServiceId) {
    setMinimized((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Rows from every open pane, each tagged with the service it came from so
  // the assistant can tell a log line from a Cognito user once they're pooled.
  function taggedSelection(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const pane of panesRef.current.values()) {
      const label = DOMAIN_LABELS[pane.domain];
      for (const row of pane.selectedRows) out.push({ service: label, ...row });
    }
    return out;
  }

  // Which pane the assistant's "Build for" is aimed at. In tabs there is only
  // one pane on screen, so that is the obvious default; in the other layouts,
  // where they are all visible, the first is as good a guess as any.
  const activeSummary =
    summaries.find((s) => s.id === target) ??
    (layout === "tabs" ? summaries.find((s) => s.id === shownPane?.id) : undefined) ??
    summaries[0];
  const activePane = activeSummary ? panesRef.current.get(activeSummary.id) : undefined;
  const totalSelected = summaries.reduce((n, s) => n + s.selectedCount, 0);
  const contributing = summaries.filter((s) => s.selectedCount > 0);
  // Any pane re-running its search changes the pooled result set, so the
  // "About results" thread should start over.
  const combinedVersion = summaries.reduce((n, s) => n + s.resultsVersion, 0);

  return (
    <>
      <div className="panel">
        {/* "Panes" rather than "Session": this card is not the session, it is
            the controls for which panes are in it and how they are arranged.
            What the Aggregator is for is said once, in the page header. */}
        <h2>Panes</h2>
        {/* Two rows rather than one long one -- ten checkboxes in a single
            line reads as an undifferentiated list, and "a search page" and
            "a tool" are different kinds of thing to reach for. */}
        {[
          { heading: "Services", ids: SERVICES.filter((x) => x.group === "Services") },
          { heading: "Tools", ids: SERVICES.filter((x) => x.group === "Tools") },
        ].map((group) => {
          const shown = group.ids.filter((x) => available.some((a) => a.id === x.id));
          if (shown.length === 0) return null;
          return (
            <div className="toolbar" key={group.heading}>
              <span className="field-label" style={{ minWidth: 62 }}>
                {group.heading}
              </span>
              {shown.map((x) => (
                <label key={x.id} className="checkbox-item">
                  <input type="checkbox" checked={services.includes(x.id)} onChange={() => toggleService(x.id)} />
                  {x.label}
                </label>
              ))}
            </div>
          );
        })}
        <div className="toolbar">
          <span className="muted">Layout</span>
          <button className={layout === "columns" ? "" : "secondary"} onClick={() => setLayout("columns")}>
            Side by side
          </button>
          <button className={layout === "stacked" ? "" : "secondary"} onClick={() => setLayout("stacked")}>
            Stacked
          </button>
          <button className={layout === "tabs" ? "" : "secondary"} onClick={() => setLayout("tabs")}>
            Tabs
          </button>
        </div>
      </div>

      {open.length === 0 && (
        <div className="panel">
          <p className="muted">Choose one or more services or tools above to start a session.</p>
        </div>
      )}

      {/* Only the panes go inside the provider. The shared widget below must
          stay outside it, or it would register itself as a pane and render
          nothing -- leaving the page with no assistant at all. */}
      {/* Minimising only hides a pane's body -- it stays mounted in both
          layouts, so its results and any in-flight search survive, which is the
          whole point of working across services at once. */}
      <AiPaneRegistryContext.Provider value={registry}>
        {/* One tab per pane. Only in this layout: the others show everything at
            once, so there is nothing to choose between. */}
        {layout === "tabs" && open.length > 0 && (
          <div className="aggregator-tabs" role="tablist">
            {open.map((s) => (
              <div key={s.id} className={`aggregator-tab${shownPane?.id === s.id ? " active" : ""}`}>
                <button
                  className="aggregator-tab-label"
                  role="tab"
                  aria-selected={shownPane?.id === s.id}
                  onClick={() => setActivePaneId(s.id)}
                >
                  {s.label}
                </button>
                <button
                  className="aggregator-tab-close"
                  onClick={() => toggleService(s.id)}
                  aria-label={`Close ${s.label}`}
                  title={`Close ${s.label}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={
            layout === "columns" ? "aggregator-columns" : layout === "tabs" ? "aggregator-tabbed" : "aggregator-stack"
          }
        >
          {open.map((s, i) => {
            // In tabs, the tab is the pane's header and its ✕ closes it, so the
            // title bar would only repeat itself; minimising has nothing to
            // mean when one pane fills the view either.
            const tabbed = layout === "tabs";
            const hidden = tabbed ? shownPane?.id !== s.id : false;
            const collapsed = !tabbed && minimized.has(s.id);
            // Which way "earlier" and "later" actually look depends on the
            // layout, so the arrows follow it rather than always saying up/down.
            const back = layout === "columns" ? "left" : "up";
            const forward = layout === "columns" ? "right" : "down";
            return (
              <section
                key={s.id}
                // The drop zone is the whole pane, not just its title bar, so
                // there's something to aim at once a pane is minimised too.
                // paneUnder() hit-tests these.
                data-pane-id={s.id}
                // Hidden rather than unmounted: an unselected pane may have a
                // search running, and its results are half the point of having
                // several open.
                hidden={hidden}
                className={
                  "aggregator-pane" +
                  (tabbed ? " tabbed" : "") +
                  (collapsed ? " collapsed" : "") +
                  (dragging === s.id ? " dragging" : "") +
                  (dropTarget === s.id ? " drop-target" : "")
                }
              >
                {/* The whole title bar toggles, so the buttons on it have to
                    stop their click bubbling -- otherwise minimise would fire
                    twice and cancel itself out, and closing would also toggle.
                    It's also the drag handle: a short press is a click and
                    toggles, anything past the threshold is a drag and the
                    click it ends with is swallowed rather than minimising the
                    pane that was just moved. */}
                {!tabbed && (
                <header
                  className="aggregator-pane-header"
                  onPointerDown={(e) => startDrag(e, s.id)}
                  onPointerMove={moveDrag}
                  onPointerUp={() => endDrag(true)}
                  onPointerCancel={() => endDrag(false)}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    toggleMinimized(s.id);
                  }}
                  title={`${collapsed ? "Expand" : "Minimise"} ${s.label} — drag to reorder`}
                >
                  <span className="aggregator-drag-handle" aria-hidden="true">
                    ⠿
                  </span>
                  <h3>{s.label}</h3>
                  <button
                    className="secondary"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveService(s.id, -1);
                    }}
                    title={`Move ${s.label} ${back}`}
                    aria-label={`Move ${s.label} ${back}`}
                  >
                    {layout === "columns" ? "◀" : "▲"}
                  </button>
                  <button
                    className="secondary"
                    disabled={i === open.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveService(s.id, 1);
                    }}
                    title={`Move ${s.label} ${forward}`}
                    aria-label={`Move ${s.label} ${forward}`}
                  >
                    {layout === "columns" ? "▶" : "▼"}
                  </button>
                  <button
                    className="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMinimized(s.id);
                    }}
                    aria-label={collapsed ? `Expand ${s.label}` : `Minimise ${s.label}`}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? "+" : "−"}
                  </button>
                  <button
                    className="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleService(s.id);
                    }}
                    title={`Close ${s.label}`}
                    aria-label={`Close ${s.label}`}
                  >
                    ✕
                  </button>
                </header>
                )}
                <div className="aggregator-pane-body" hidden={collapsed}>
                  {/* Panes are whole pages, so their state keys have to be
                      kept apart within this one session. */}
                  <SessionKeyScope prefix={s.id}>{s.render()}</SessionKeyScope>
                </div>
              </section>
            );
          })}
        </div>
      </AiPaneRegistryContext.Provider>

      {/* Registered panes, not open ones. A pane registers itself when it has
          something to ask about -- a query to build, or rows to ask about. A
          session holding only a JWT decoder has neither, and an ✦ Ask AI button
          that can do nothing is worse than no button. */}
      {summaries.length > 0 && (
        <AiAssistantWidget
          domain={activePane?.domain ?? "logs-cloudwatch"}
          askDomain="aggregator"
          modes={activePane?.modes ?? ["ask_results"]}
          queryString={activePane?.queryString}
          onUseQuery={activePane?.onUseQuery}
          selectedRows={taggedSelection()}
          resultsVersion={combinedVersion}
          headerExtra={(mode) =>
            // "Build for" picks the one service a generated query is written
            // for, so it only belongs in that mode -- "About results" pools
            // every open service at once and has nothing to target.
            mode === "build_query" ? (
              summaries.length > 1 && (
                <div className="ai-widget-header" style={{ borderBottom: "none", paddingBottom: 0 }}>
                  <label className="row" style={{ gap: 6, fontSize: 11 }}>
                    <span className="muted">Build for</span>
                    <select
                      value={activeSummary?.id ?? ""}
                      onChange={(e) => setTarget(e.target.value)}
                      style={{ fontSize: 11, padding: "2px 6px" }}
                    >
                      {summaries.map((s) => (
                        <option key={s.id} value={s.id}>
                          {DOMAIN_LABELS[s.domain]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )
            ) : contributing.length > 0 ? (
              <p className="muted" style={{ padding: "4px 12px 0", fontSize: 11 }}>
                Across {contributing.map((s) => DOMAIN_LABELS[s.domain]).join(", ")}.
              </p>
            ) : null
          }
        />
      )}
    </>
  );
}
