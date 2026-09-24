import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  PointerEvent as ReactPointerEvent,
} from "react";
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
 * search running, and unmounting it to save some DOM would throw that away.
 * "dashboard" is the freeform one: panes sit at whatever position and size you
 * gave them (see `Rect` below) rather than a fixed row or column. */
type Layout = "columns" | "stacked" | "tabs" | "dashboard";

/** A dashboard pane's position and size, in pixels within the dashboard
 * canvas. Stored per pane id, so it survives closing and reopening a pane. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DASHBOARD_PANE_W = 460;
const DASHBOARD_PANE_H = 340;
const DASHBOARD_MIN_W = 260;
const DASHBOARD_MIN_H = 160;
const DASHBOARD_GAP = 16;

/** Where a pane lands when it has no place of its own yet: the first spot, in
 * reading order (top to bottom, then left to right), where a pane of `size`
 * fits inside the canvas without coming within the standard gap of anything
 * already there. The spots worth trying are the canvas's own top-left corner
 * and the ones just past each existing pane's right and bottom edges (or
 * lined up with its left and top) -- any other free spot could slide up or
 * left onto one of those -- so this finds a real gap between panes that have
 * been moved or resized, not just the next cell of a fixed grid. x=0 is
 * always allowed, so a pane wider than the canvas still gets a row of its
 * own rather than nowhere. */
function firstAvailableRect(taken: Rect[], maxWidth: number, size: { w: number; h: number }): Rect {
  const w = Math.min(size.w, Math.max(DASHBOARD_MIN_W, maxWidth));
  const xs = new Set([0]);
  const ys = new Set([0]);
  for (const t of taken) {
    xs.add(t.x);
    xs.add(t.x + t.w + DASHBOARD_GAP);
    ys.add(t.y);
    ys.add(t.y + t.h + DASHBOARD_GAP);
  }
  const byPosition = (a: number, b: number) => a - b;
  for (const y of [...ys].sort(byPosition)) {
    for (const x of [...xs].sort(byPosition)) {
      if (x > 0 && x + w > maxWidth) continue;
      const candidate = { x, y, w, h: size.h };
      if (!taken.some((t) => rectsOverlap(candidate, t, DASHBOARD_GAP))) return candidate;
    }
  }
  // Not reached -- (0, just below the lowest pane) is always one of the
  // candidates above and always free -- but it is the right answer anyway.
  return { x: 0, y: taken.reduce((m, t) => Math.max(m, t.y + t.h + DASHBOARD_GAP), 0), w, h: size.h };
}

/** Every open pane's rect on a canvas `maxWidth` wide, and which of them had
 * to be given a new place. A pane keeps its stored rect when it has one that
 * doesn't come within the standard gap of a pane accepted before it (in open
 * order, so an established pane beats one just reopened on top of it); one
 * stored past the right edge -- placed in a wider window than this one -- is
 * shown slid back inside, if that spot is free. Everything else (never
 * placed, or colliding) gets `firstAvailableRect` against all of the above,
 * and is listed in `placed` so the caller can store it: a placement that's
 * only ever computed, never kept, is what made an untouched pane jump to a
 * new slot whenever some other pane moved away from the one before it. */
function resolveDashboard(
  ids: ServiceId[],
  stored: Record<ServiceId, Rect>,
  collapsed: Set<ServiceId>,
  maxWidth: number,
): { rects: Record<ServiceId, Rect>; placed: ServiceId[] } {
  const footprintOf = (id: ServiceId, r: Rect): Rect => (collapsed.has(id) ? { ...r, h: DASHBOARD_HEADER_H } : r);
  const rects: Record<ServiceId, Rect> = {};
  const taken: Rect[] = [];
  const placed: ServiceId[] = [];
  for (const id of ids) {
    const r = stored[id];
    if (!r) {
      placed.push(id);
      continue;
    }
    const w = Math.min(r.w, Math.max(DASHBOARD_MIN_W, maxWidth));
    const fitted = r.x + w > maxWidth ? { ...r, x: Math.max(0, maxWidth - w), w } : r;
    const fp = footprintOf(id, fitted);
    if (taken.some((t) => rectsOverlap(fp, t, DASHBOARD_GAP))) {
      placed.push(id);
      continue;
    }
    rects[id] = fitted;
    taken.push(fp);
  }
  for (const id of placed) {
    const size = stored[id] ?? { w: DASHBOARD_PANE_W, h: DASHBOARD_PANE_H };
    const r = firstAvailableRect(taken, maxWidth, size);
    rects[id] = r;
    taken.push(footprintOf(id, r));
  }
  return { rects, placed };
}

// ---- Dashboard: no two panes may occupy the same space or touch -- they
// keep at least the same gap every other layout uses between panes -- and
// moving or resizing one snaps -- to a plain grid, and to whatever it is
// already close to lining up or keeping the usual gap with -- so relocating
// panes feels intentional rather than like placing them freehand pixel by
// pixel. The "cut lines" a drag or resize draws (`dashGhost`, in the render
// below) are that snap target made visible, the same dashed-outline language
// a reorder drag already uses on the pane it would swap with.

/** Coarse alignment for a drag or resize: fine enough that a mouse-pixel nudge
 * doesn't fight it, coarse enough to read as a deliberate snap rather than a
 * coincidence. */
const DASHBOARD_GRID = 20;

/** How close (px) a pane's edge has to come to another's -- flush, or the
 * usual gap past it -- while being dragged or resized, before it snaps onto
 * that line: the "smart guide" a design tool gives you. Landing flush is only
 * ever offered as an alignment guide, not a place to actually stop: the two
 * are only truly touching if they also overlap on the other axis, which
 * `resolveRect` below is what actually forbids. */
const DASHBOARD_SNAP_PX = 10;

/** A minimised pane shrinks to just its header on the dashboard (see the
 * render below, which leaves its height unset while collapsed); this is that
 * header's footprint for collision and snapping, so a pane being dragged
 * doesn't detour around room a collapsed neighbour no longer occupies. */
const DASHBOARD_HEADER_H = 40;

/** True if `a` and `b` overlap, or (with `pad`) come closer than that on any
 * side -- checked by inflating `a` by `pad` before testing, so `pad` reads as
 * "the least gap `a` may leave around `b`". */
function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Whichever candidate (a neighbour's edge, or the canvas's) is nearest to
 * where the pointer actually put things, if one is within snapping distance
 * -- otherwise the plain grid. A candidate wins even when the grid happens to
 * be nearer: lining up with the pane beside you is the point of snapping,
 * and letting the grid win by a pixel or two is what left panes a few
 * pixels out of line with each other. */
function snapAxis(value: number, candidates: number[]): number {
  let best: number | null = null;
  let bestDelta = Infinity;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - value);
    if (delta <= DASHBOARD_SNAP_PX && delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best ?? Math.round(value / DASHBOARD_GRID) * DASHBOARD_GRID;
}

/** Left-edge positions a moving pane's own left edge would snap to: flush
 * against a neighbour's near or far edge -- an alignment guide, not a
 * collision, since the two are only ever touching if they also overlap on
 * the other axis, which `resolveRect` below is what actually forbids -- or
 * the usual gap past either one. */
function xCandidates(neighbors: Rect[], width: number): number[] {
  const out: number[] = [];
  for (const n of neighbors) out.push(n.x, n.x + n.w - width, n.x + n.w + DASHBOARD_GAP, n.x - width - DASHBOARD_GAP);
  return out;
}
function yCandidates(neighbors: Rect[], height: number): number[] {
  const out: number[] = [];
  for (const n of neighbors) out.push(n.y, n.y + n.h - height, n.y + n.h + DASHBOARD_GAP, n.y - height - DASHBOARD_GAP);
  return out;
}

/** Absolute x/y positions a resizing edge would snap to: flush against a
 * neighbour's near or far edge, or the usual gap short of it or past it.
 * Same reasoning as `xCandidates`/`yCandidates` above, but for an edge rather
 * than a whole pane's left/top -- resizing can move any one of the four
 * edges. */
function edgeCandidatesX(neighbors: Rect[]): number[] {
  const out: number[] = [];
  for (const n of neighbors) out.push(n.x, n.x + n.w, n.x - DASHBOARD_GAP, n.x + n.w + DASHBOARD_GAP);
  return out;
}
function edgeCandidatesY(neighbors: Rect[]): number[] {
  const out: number[] = [];
  for (const n of neighbors) out.push(n.y, n.y + n.h, n.y - DASHBOARD_GAP, n.y + n.h + DASHBOARD_GAP);
  return out;
}

/** Applies a drag or resize's desired rect, but never lets it land within
 * `pad` of another pane. If the full move would, it tries sliding along just
 * one axis -- the way a window bumps a wall but keeps going along it when you
 * drag diagonally past a neighbour -- before giving up and leaving the pane
 * wherever it last legally was. A move only ever changes x/y; a resize can
 * also change w/h (its fixed edges carry over from `prev`), which is why this
 * treats x-and-w and y-and-h as the two axes rather than x and y alone. */
function resolveRect(prev: Rect, target: Rect, neighbors: Rect[], pad: number): Rect {
  const blocked = (r: Rect) => neighbors.some((n) => rectsOverlap(r, n, pad));
  if (!blocked(target)) return target;
  const horizOnly = { ...prev, x: target.x, w: target.w };
  if (!blocked(horizOnly)) return horizOnly;
  const vertOnly = { ...prev, y: target.y, h: target.h };
  if (!blocked(vertOnly)) return vertOnly;
  return prev;
}

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
  const [layout, setLayout] = useSessionState<Layout>("layout", "tabs");
  // Which pane the tabs layout is showing. Kept even while another layout is
  // in use, so switching back lands where you left it.
  const [activePaneId, setActivePaneId] = useSessionState<ServiceId | null>("activePane", null);
  // Panes collapsed to just their header. Independent per pane -- minimising
  // one says nothing about the others, unlike a single "focused" pane would.
  const [minimized, setMinimized] = useSessionState<Set<ServiceId>>("minimized", () => new Set());
  // Where each pane sits on the dashboard canvas. Only meaningful in that
  // layout, but kept regardless of which one is active -- switching to
  // dashboard and back shouldn't forget where things were.
  const [rects, setRects] = useSessionState<Record<ServiceId, Rect>>("dashboardRects", () => ({}));

  // The panes' container, whatever the layout -- measured here rather than
  // looked up with a page-wide selector, because every open session stays
  // mounted: `document.querySelector(".aggregator-dashboard")` found the
  // first session's canvas in the page, which for any other session was a
  // hidden one 0px wide, and clamped every drag and resize there to nothing.
  // A width of 0 means this session is hidden, so it's ignored rather than
  // taken as the canvas having shrunk; null means it hasn't been seen yet.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasW, setCanvasW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setCanvasW(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
    // Nor where it was on the dashboard: that spot may well be taken by the
    // time it's back, and a reopened pane goes to the first free place, the
    // same as one opened for the first time.
    setRects((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
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

  /** How far right a pane's own right edge may go: the canvas's own width,
   * which is the "Panes" card's width too (the canvas sets none of its own,
   * so it fills its container like every other card) -- so a pane pushed all
   * the way right lines up with the card above it, and keeps the same gap
   * from the scrollbar every card does (`.content`'s right padding). The
   * alternative, sizing the canvas to whatever the widest dragged pane
   * needs, is what let a pane get dragged or resized out past the edge of
   * the page in the first place. `.content`'s `scrollbar-gutter: stable` is
   * what keeps this from jumping the moment a vertical scrollbar appears.
   * Unmeasured (this session has never been on screen) nothing can be
   * dragged anyway, and nothing is stored from it -- see the effect below. */
  function dashboardMaxWidth(): number {
    return canvasW === null ? Infinity : Math.max(DASHBOARD_MIN_W, canvasW);
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
    const expanding = minimized.has(id);
    setMinimized((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // While a pane is minimised on the dashboard, others may be moved into the
    // room below its header. Expanding it back over them would overlap, so it
    // goes to the first place its full size fits instead -- the pane you just
    // expanded is the one that moves, never a neighbour you didn't touch.
    if (expanding && layout === "dashboard") {
      const own = dash.rects[id];
      const others = neighborFootprints(id);
      if (own && others.some((o) => rectsOverlap(own, o, DASHBOARD_GAP))) {
        updateRect(id, firstAvailableRect(others, dashboardMaxWidth(), own));
      }
    }
  }

  // ---- Dashboard layout: freeform position and size -------------------

  // Every open pane's rect, resolved once per render (see `resolveDashboard`),
  // so what's drawn, what a drag collides with and what gets stored are all
  // the same answer.
  const dash = resolveDashboard(
    open.map((s) => s.id),
    rects,
    minimized,
    dashboardMaxWidth(),
  );

  // A pane given a new place is stored there straight away, not recomputed on
  // every render -- otherwise it moves whenever anything before it does. Only
  // once the canvas has actually been measured, and only on the dashboard: a
  // placement worked out against a guessed width, or one nobody can see yet,
  // is not one to keep. Stale rects of panes no longer open go at the same
  // time (sessions saved before closing a pane forgot its spot kept them).
  // Depends on what `dash` is derived from rather than on `dash` itself, a new
  // object every render; once stored, the next run finds nothing to place.
  useEffect(() => {
    if (layout !== "dashboard" || canvasW === null) return;
    const openIds = new Set(services);
    const stale = Object.keys(rects).filter((id) => !openIds.has(id));
    if (dash.placed.length === 0 && stale.length === 0) return;
    setRects((prev) => {
      const next = { ...prev };
      for (const id of stale) delete next[id];
      for (const id of dash.placed) next[id] = dash.rects[id];
      return next;
    });
  }, [layout, canvasW, rects, services, minimized]);

  function rectFor(id: ServiceId): Rect {
    return dash.rects[id];
  }

  function updateRect(id: ServiceId, rect: Rect) {
    setRects((prev) => {
      const current = prev[id];
      if (current && current.x === rect.x && current.y === rect.y && current.w === rect.w && current.h === rect.h) {
        return prev;
      }
      return { ...prev, [id]: rect };
    });
  }

  /** A pane's footprint for collision and snapping purposes: its resolved
   * rect, shrunk to just its header while minimised (see the render below),
   * since that is the room it actually occupies on the dashboard. */
  function footprint(id: ServiceId): Rect {
    const r = rectFor(id);
    return minimized.has(id) ? { ...r, h: DASHBOARD_HEADER_H } : r;
  }

  /** Every other open pane's current footprint, for checking one being
   * dragged or resized against. */
  function neighborFootprints(excludeId: ServiceId): Rect[] {
    const out: Rect[] = [];
    for (const [id, rect] of Object.entries(dash.rects)) {
      if (id !== excludeId) out.push(minimized.has(id) ? { ...rect, h: DASHBOARD_HEADER_H } : rect);
    }
    return out;
  }

  /** The eight places a pane can be resized from -- the four corners (so a
   * pane sitting where the floating ✦ Ask AI button covers its bottom-right
   * corner still has three others to grab) plus the four edges, for a
   * one-axis resize without having to line up on a corner. */
  type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

  /** Which edge(s) a handle moves: -1 is the near (west/north) edge, 1 the
   * far (east/south) edge, 0 means that axis doesn't change at all. */
  const RESIZE_HANDLE_AXES: Record<ResizeHandle, { dx: -1 | 0 | 1; dy: -1 | 0 | 1 }> = {
    nw: { dx: -1, dy: -1 },
    n: { dx: 0, dy: -1 },
    ne: { dx: 1, dy: -1 },
    e: { dx: 1, dy: 0 },
    se: { dx: 1, dy: 1 },
    s: { dx: 0, dy: 1 },
    sw: { dx: -1, dy: 1 },
    w: { dx: -1, dy: 0 },
  };

  // Dragging a pane by its header moves it; dragging one of its corner
  // handles resizes it. Both are pointer-captured on the element the gesture
  // started on, same as the header drag above, so a release anywhere still
  // delivers. `moved` tracks the same thing it does for the header's reorder
  // drag: below the threshold this is a click (toggle minimised), past it the
  // trailing click has to be swallowed via `suppressClick`, or a drag would
  // also minimise the pane it just repositioned.
  //
  // Neither writes to `rects` on every move -- the pane you're moving follows
  // the raw pointer (`dashLive`, below) while a separate dashed outline
  // (`dashGhost`) shows where it will actually land, the same "cut lines" a
  // reorder drag shows on the pane it would swap with. Only the release
  // commits `last*`, the most recent resolved (snapped, collision-safe)
  // rect, to `rects` -- which is also why `last*` has to live in the ref
  // rather than be recomputed fresh each move: resolving against a blocked
  // target has to carry over from wherever the previous move actually landed,
  // not snap back to the gesture's start.
  const dashDragRef = useRef<{
    id: ServiceId;
    startX: number;
    startY: number;
    startScrollTop: number;
    originX: number;
    originY: number;
    w: number;
    h: number;
    lastX: number;
    lastY: number;
    lastClientX: number;
    lastClientY: number;
    moved: boolean;
  } | null>(null);
  const dashResizeRef = useRef<{
    id: ServiceId;
    corner: ResizeHandle;
    startX: number;
    startY: number;
    startScrollTop: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
    lastX: number;
    lastY: number;
    lastW: number;
    lastH: number;
    lastClientX: number;
    lastClientY: number;
  } | null>(null);
  // Raised above the rest while being moved or resized, so it doesn't render
  // underneath a pane it is passing over.
  const [dashActive, setDashActive] = useState<ServiceId | null>(null);
  /** The active gesture's pane, drawn at the raw pointer position/size rather
   * than `rects[id]` -- see the comment on the refs above. */
  const [dashLive, setDashLive] = useState<{ id: ServiceId; rect: Rect } | null>(null);
  /** Where the active gesture would actually land if released now -- the
   * dashed "cut lines" outline, drawn separately from the pane itself. */
  const [dashGhost, setDashGhost] = useState<Rect | null>(null);
  const dashAutoScroll = useRef<number | null>(null);

  function startDashAutoScroll() {
    if (dashAutoScroll.current === null) {
      dashAutoScroll.current = window.setInterval(dashAutoScrollTick, AUTO_SCROLL_INTERVAL_MS);
    }
  }

  function stopDashAutoScroll() {
    if (dashAutoScroll.current !== null) {
      window.clearInterval(dashAutoScroll.current);
      dashAutoScroll.current = null;
    }
  }

  // Scrolling the canvas while the pointer stays still has to move the pane
  // by the same amount, in the same direction a native drag would -- the
  // canvas content shifts under a stationary pointer, so the pane's
  // canvas-relative position has to shift with it to stay under it.
  function dashAutoScrollTick() {
    const el = scroller();
    const drag = dashDragRef.current;
    const resize = dashResizeRef.current;
    const clientY = drag ? drag.lastClientY : resize ? resize.lastClientY : null;
    if (!el || clientY === null || (drag && !drag.moved)) return;
    const r = el.getBoundingClientRect();
    let dy = 0;
    if (clientY < r.top + AUTO_SCROLL_EDGE_PX) dy = -AUTO_SCROLL_STEP_PX;
    else if (clientY > r.bottom - AUTO_SCROLL_EDGE_PX) dy = AUTO_SCROLL_STEP_PX;
    if (!dy) return;
    const before = el.scrollTop;
    el.scrollTop += dy;
    if (el.scrollTop === before) return;
    if (drag) updateDashDragPreview(drag);
    else if (resize) updateDashResizePreview(resize);
  }

  function startDashDrag(e: ReactPointerEvent<HTMLElement>, id: ServiceId) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    // A drag that ended without a trailing click (pointer released outside
    // the header) would otherwise leave this set, swallowing the next
    // legitimate one.
    suppressClick.current = false;
    const fp = footprint(id);
    dashDragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      startScrollTop: scroller()?.scrollTop ?? 0,
      originX: fp.x,
      originY: fp.y,
      w: fp.w,
      h: fp.h,
      lastX: fp.x,
      lastY: fp.y,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      moved: false,
    };
    setDashActive(id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function updateDashDragPreview(drag: NonNullable<typeof dashDragRef.current>) {
    const scrolled = (scroller()?.scrollTop ?? 0) - drag.startScrollTop;
    const size = { w: drag.w, h: drag.h };
    // The right edge can't pass the canvas's own right edge -- the left and
    // top edges already can't go negative, which keeps a pane from being
    // dragged up over the "Panes" card above the canvas the same way.
    const maxX = Math.max(0, dashboardMaxWidth() - size.w);
    const liveX = clamp(drag.originX + (drag.lastClientX - drag.startX), 0, maxX);
    const liveY = Math.max(0, drag.originY + (drag.lastClientY - drag.startY) + scrolled);
    setDashLive({ id: drag.id, rect: { x: liveX, y: liveY, ...size } });

    const neighbors = neighborFootprints(drag.id);
    // The canvas's own edges are guides too, so a pane lines up with the
    // cards above it on either side rather than stopping a few pixels short.
    const target = {
      x: clamp(snapAxis(liveX, [0, maxX, ...xCandidates(neighbors, size.w)]), 0, maxX),
      y: Math.max(0, snapAxis(liveY, [0, ...yCandidates(neighbors, size.h)])),
      ...size,
    };
    const resolved = resolveRect({ x: drag.lastX, y: drag.lastY, ...size }, target, neighbors, DASHBOARD_GAP);
    drag.lastX = resolved.x;
    drag.lastY = resolved.y;
    setDashGhost(resolved);
  }

  function moveDashDrag(e: ReactPointerEvent<HTMLElement>) {
    const drag = dashDragRef.current;
    if (!drag) return;
    drag.lastClientX = e.clientX;
    drag.lastClientY = e.clientY;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      startDashAutoScroll();
    }
    updateDashDragPreview(drag);
  }

  /** `commit` is false when the gesture was cancelled (Escape, or the browser
   * cancelling the pointer) rather than released: everything clears, nothing
   * moves -- the same as a cancelled reorder drag. */
  function endDashDrag(commit = true) {
    const drag = dashDragRef.current;
    dashDragRef.current = null;
    stopDashAutoScroll();
    setDashActive(null);
    setDashLive(null);
    setDashGhost(null);
    if (!drag?.moved) return;
    suppressClick.current = true;
    if (!commit) return;
    // The stored height, not `drag.h`: that's the footprint the drag collided
    // with, which for a minimised pane is just its header -- storing it made
    // the pane come back 40px tall the next time it was expanded.
    updateRect(drag.id, { x: drag.lastX, y: drag.lastY, w: drag.w, h: rectFor(drag.id).h });
  }

  function startDashResize(e: ReactPointerEvent<HTMLElement>, id: ServiceId, corner: ResizeHandle) {
    if (e.button !== 0) return;
    // The handle sits on the pane, not the header, so nothing here needs to
    // stop a minimise/drag from also firing -- but the pane's own drag
    // listener is on the header only, so no propagation guard is needed either.
    // Never rendered while collapsed (see below), so the pane's own footprint
    // is its real rect here, not the collapsed header height.
    const rect = rectFor(id);
    dashResizeRef.current = {
      id,
      corner,
      startX: e.clientX,
      startY: e.clientY,
      startScrollTop: scroller()?.scrollTop ?? 0,
      originX: rect.x,
      originY: rect.y,
      originW: rect.w,
      originH: rect.h,
      lastX: rect.x,
      lastY: rect.y,
      lastW: rect.w,
      lastH: rect.h,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
    };
    setDashActive(id);
    startDashAutoScroll();
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function updateDashResizePreview(resize: NonNullable<typeof dashResizeRef.current>) {
    const scrolled = (scroller()?.scrollTop ?? 0) - resize.startScrollTop;
    const { dx: xDir, dy: yDir } = RESIZE_HANDLE_AXES[resize.corner];
    const rightFixed = resize.originX + resize.originW;
    const bottomFixed = resize.originY + resize.originH;
    const maxWidth = dashboardMaxWidth();
    const dx = resize.lastClientX - resize.startX;
    const dy = resize.lastClientY - resize.startY + scrolled;

    // Horizontal: unset (0) leaves the width/x alone; the east edge can't
    // pass the canvas's own right edge, the west edge can't go negative.
    let liveW = resize.originW;
    let liveX = resize.originX;
    if (xDir === 1) {
      liveW = clamp(resize.originW + dx, DASHBOARD_MIN_W, Math.max(DASHBOARD_MIN_W, maxWidth - resize.originX));
    } else if (xDir === -1) {
      liveW = clamp(resize.originW - dx, DASHBOARD_MIN_W, rightFixed);
      liveX = rightFixed - liveW;
    }

    // Vertical: same idea, but there's no ceiling on how far down a pane can
    // grow -- the canvas grows and auto-scrolls with it -- only a floor on
    // how far up, which is the canvas's own top edge, right below the
    // "Panes" card.
    let liveH = resize.originH;
    let liveY = resize.originY;
    if (yDir === 1) {
      liveH = Math.max(DASHBOARD_MIN_H, resize.originH + dy);
    } else if (yDir === -1) {
      liveH = clamp(resize.originH - dy, DASHBOARD_MIN_H, bottomFixed);
      liveY = bottomFixed - liveH;
    }
    setDashLive({ id: resize.id, rect: { x: liveX, y: liveY, w: liveW, h: liveH } });

    const neighbors = neighborFootprints(resize.id);
    const exCandidates = [0, maxWidth, ...edgeCandidatesX(neighbors)];
    const eyCandidates = [0, ...edgeCandidatesY(neighbors)];

    let w = liveW;
    let x = liveX;
    if (xDir === 1) {
      const snapped = snapAxis(resize.originX + liveW, exCandidates);
      w = clamp(snapped - resize.originX, DASHBOARD_MIN_W, Math.max(DASHBOARD_MIN_W, maxWidth - resize.originX));
    } else if (xDir === -1) {
      const snapped = snapAxis(rightFixed - liveW, exCandidates);
      w = clamp(rightFixed - snapped, DASHBOARD_MIN_W, rightFixed);
      x = rightFixed - w;
    }

    let h = liveH;
    let y = liveY;
    if (yDir === 1) {
      h = Math.max(DASHBOARD_MIN_H, snapAxis(resize.originY + liveH, eyCandidates) - resize.originY);
    } else if (yDir === -1) {
      const snapped = snapAxis(bottomFixed - liveH, eyCandidates);
      h = clamp(bottomFixed - snapped, DASHBOARD_MIN_H, bottomFixed);
      y = bottomFixed - h;
    }

    const target = { x, y, w, h };
    const resolved = resolveRect(
      { x: resize.lastX, y: resize.lastY, w: resize.lastW, h: resize.lastH },
      target,
      neighbors,
      DASHBOARD_GAP,
    );
    resize.lastX = resolved.x;
    resize.lastY = resolved.y;
    resize.lastW = resolved.w;
    resize.lastH = resolved.h;
    setDashGhost(resolved);
  }

  function moveDashResize(e: ReactPointerEvent<HTMLElement>) {
    const resize = dashResizeRef.current;
    if (!resize) return;
    resize.lastClientX = e.clientX;
    resize.lastClientY = e.clientY;
    updateDashResizePreview(resize);
  }

  function endDashResize(commit = true) {
    const resize = dashResizeRef.current;
    dashResizeRef.current = null;
    stopDashAutoScroll();
    setDashActive(null);
    setDashLive(null);
    setDashGhost(null);
    if (resize && commit) {
      updateRect(resize.id, { x: resize.lastX, y: resize.lastY, w: resize.lastW, h: resize.lastH });
    }
  }

  // Escape cancels a dashboard move or resize too, not only a reorder drag.
  useEffect(() => {
    if (!dashActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dashDragRef.current) endDashDrag(false);
      else endDashResize(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The canvas has to be at least as tall as everything on it, or a pane
  // dragged toward the bottom would have nowhere to scroll into. Width isn't
  // grown the same way -- the canvas sets no width of its own (it fills its
  // container, the same as the "Panes" card above it), which is also the
  // right edge nothing may be dragged or resized past (see
  // `dashboardMaxWidth`).
  const dashboardExtentH = Object.values(dash.rects).reduce((h, r) => Math.max(h, r.y + r.h + DASHBOARD_GAP), 400);

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
          {/* Tabs first because it is what a new session starts in: the order
              here is the order you are likely to want them. */}
          <button className={layout === "tabs" ? "" : "secondary"} onClick={() => setLayout("tabs")}>
            Tabs
          </button>
          <button className={layout === "columns" ? "" : "secondary"} onClick={() => setLayout("columns")}>
            Side by side
          </button>
          <button className={layout === "stacked" ? "" : "secondary"} onClick={() => setLayout("stacked")}>
            Stacked
          </button>
          <button className={layout === "dashboard" ? "" : "secondary"} onClick={() => setLayout("dashboard")}>
            Dashboard
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
            layout === "columns"
              ? "aggregator-columns"
              : layout === "tabs"
                ? "aggregator-tabbed"
                : layout === "dashboard"
                  ? "aggregator-dashboard"
                  : "aggregator-stack"
          }
          style={layout === "dashboard" ? { minHeight: dashboardExtentH } : undefined}
          ref={canvasRef}
        >
          {open.map((s, i) => {
            // In tabs, the tab is the pane's header and its ✕ closes it, so the
            // title bar would only repeat itself; minimising has nothing to
            // mean when one pane fills the view either.
            const tabbed = layout === "tabs";
            const dashboard = layout === "dashboard";
            const hidden = tabbed ? shownPane?.id !== s.id : false;
            const collapsed = !tabbed && minimized.has(s.id);
            // Which way "earlier" and "later" actually look depends on the
            // layout, so the arrows follow it rather than always saying up/down.
            // Dashboard has neither -- panes don't have neighbours, they have
            // a position -- so it hides them rather than picking one.
            const back = layout === "columns" ? "left" : "up";
            const forward = layout === "columns" ? "right" : "down";
            // While this pane is being dragged or resized, it's drawn at the
            // raw pointer position/size (`dashLive`) rather than its stored
            // rect -- the dashed "cut lines" ghost drawn below the panes
            // shows where it will actually land once released.
            const live = dashLive?.id === s.id ? dashLive.rect : null;
            const rect = dashboard ? (live ?? rectFor(s.id)) : null;
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
                  (dashboard ? " dashboard-pane" : "") +
                  (collapsed ? " collapsed" : "") +
                  (dragging === s.id ? " dragging" : "") +
                  (dropTarget === s.id ? " drop-target" : "") +
                  (dashActive === s.id ? " dashboard-active" : "")
                }
                style={
                  rect
                    ? {
                        left: rect.x,
                        top: rect.y,
                        width: rect.w,
                        // Collapsed panes shrink to their header on the
                        // dashboard too, the way they flow-shrink elsewhere --
                        // the stored height is kept, just not applied, so
                        // expanding it again comes back at the same size.
                        height: collapsed ? undefined : rect.h,
                      }
                    : undefined
                }
              >
                {/* The whole title bar toggles, so the buttons on it have to
                    stop their click bubbling -- otherwise minimise would fire
                    twice and cancel itself out, and closing would also toggle.
                    It's also the drag handle: a short press is a click and
                    toggles, anything past the threshold is a drag and the
                    click it ends with is swallowed rather than minimising the
                    pane that was just moved (or, on the dashboard, repositioned). */}
                {!tabbed && (
                <header
                  className="aggregator-pane-header"
                  onPointerDown={(e) => (dashboard ? startDashDrag(e, s.id) : startDrag(e, s.id))}
                  onPointerMove={dashboard ? moveDashDrag : moveDrag}
                  onPointerUp={() => (dashboard ? endDashDrag() : endDrag(true))}
                  onPointerCancel={() => (dashboard ? endDashDrag(false) : endDrag(false))}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    toggleMinimized(s.id);
                  }}
                  title={`${collapsed ? "Expand" : "Minimise"} ${s.label} — drag to ${dashboard ? "move" : "reorder"}`}
                >
                  <span className="aggregator-drag-handle" aria-hidden="true">
                    ⠿
                  </span>
                  <h3>{s.label}</h3>
                  {!dashboard && (
                    <>
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
                    </>
                  )}
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
                {/* Resize only makes sense once a pane has its own width and
                    height rather than one dictated by the flow layout, and only
                    while it's showing a body to resize. A handle on every
                    corner and every edge: corners so a pane sitting where the
                    floating ✦ Ask AI button covers one corner still has three
                    others to grab, edges so growing just the width or just
                    the height doesn't need lining up on a corner first. */}
                {dashboard &&
                  !collapsed &&
                  (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((corner) => (
                    <div
                      key={corner}
                      className={`aggregator-resize-handle ${corner}`}
                      onPointerDown={(e) => startDashResize(e, s.id, corner)}
                      onPointerMove={moveDashResize}
                      onPointerUp={() => endDashResize()}
                      onPointerCancel={() => endDashResize(false)}
                      title={`Resize ${s.label}`}
                      aria-hidden="true"
                    />
                  ))}
              </section>
            );
          })}
          {/* The active drag or resize's landing spot -- dashed "cut lines",
              the same treatment a reorder drag gives the pane it would swap
              with -- separate from the pane itself, which is following the
              raw pointer (see `dashLive` above) until release commits it here. */}
          {layout === "dashboard" && dashGhost && (
            <div
              className="dashboard-ghost"
              style={{ left: dashGhost.x, top: dashGhost.y, width: dashGhost.w, height: dashGhost.h }}
              aria-hidden="true"
            />
          )}
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
