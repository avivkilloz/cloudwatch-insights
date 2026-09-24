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

/** Where a pane starts out before it has ever been moved or resized: a loose
 * grid, three across, so several panes opened at once don't all land in the
 * same spot on top of each other. */
function defaultRect(index: number): Rect {
  const columns = 3;
  return {
    x: DASHBOARD_GAP + (index % columns) * (DASHBOARD_PANE_W + DASHBOARD_GAP),
    y: DASHBOARD_GAP + Math.floor(index / columns) * (DASHBOARD_PANE_H + DASHBOARD_GAP),
    w: DASHBOARD_PANE_W,
    h: DASHBOARD_PANE_H,
  };
}

// ---- Dashboard: no two panes may occupy the same space, and moving or
// resizing one snaps -- to a plain grid, and to whatever it is already close
// to lining up with -- so relocating panes feels intentional rather than
// like placing them freehand pixel by pixel.

/** Coarse alignment for a drag or resize: fine enough that a mouse-pixel nudge
 * doesn't fight it, coarse enough to read as a deliberate snap rather than a
 * coincidence. */
const DASHBOARD_GRID = 20;

/** How close (px) a pane's edge has to come to another's, while being dragged
 * or resized, before it snaps flush against it or into the usual gap past it
 * -- the "smart guide" a design tool gives you, without drawing the guide. */
const DASHBOARD_SNAP_PX = 10;

/** A minimised pane shrinks to just its header on the dashboard (see the
 * render below, which leaves its height unset while collapsed); this is that
 * header's footprint for collision and snapping, so a pane being dragged
 * doesn't detour around room a collapsed neighbour no longer occupies. */
const DASHBOARD_HEADER_H = 40;

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** The plain grid, or -- if it is close enough -- whichever candidate is
 * nearest to where the pointer actually put things. Falls back to the grid
 * alone once nothing offered is within snapping distance. */
function snapAxis(value: number, candidates: number[]): number {
  let best = Math.round(value / DASHBOARD_GRID) * DASHBOARD_GRID;
  let bestDelta = Math.abs(best - value);
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - value);
    if (delta <= DASHBOARD_SNAP_PX && delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

/** Left-edge positions a moving pane's own left edge would snap to: flush
 * against a neighbour's near or far edge, or the usual gap past either one. */
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
/** Widths (from a fixed left edge) that put a resizing pane's right edge
 * flush against a neighbour's edge, or the usual gap short of it. */
function widthCandidates(neighbors: Rect[], originX: number): number[] {
  const out: number[] = [];
  for (const n of neighbors) {
    out.push(n.x - originX - DASHBOARD_GAP, n.x - originX, n.x + n.w - originX, n.x + n.w - originX + DASHBOARD_GAP);
  }
  return out;
}
function heightCandidates(neighbors: Rect[], originY: number): number[] {
  const out: number[] = [];
  for (const n of neighbors) {
    out.push(n.y - originY - DASHBOARD_GAP, n.y - originY, n.y + n.h - originY, n.y + n.h - originY + DASHBOARD_GAP);
  }
  return out;
}

/** Applies a drag's desired x/y, but never lets the pane land on top of
 * another. If the full move would overlap, it tries sliding along just one
 * axis -- the way a window bumps a wall but keeps going along it when you
 * drag diagonally past a neighbour -- before giving up and leaving the pane
 * wherever it last legally was. */
function resolveMove(
  prev: { x: number; y: number },
  size: { w: number; h: number },
  target: { x: number; y: number },
  neighbors: Rect[],
): { x: number; y: number } {
  const blocked = (x: number, y: number) => neighbors.some((n) => rectsOverlap({ x, y, ...size }, n));
  if (!blocked(target.x, target.y)) return target;
  if (!blocked(target.x, prev.y)) return { x: target.x, y: prev.y };
  if (!blocked(prev.x, target.y)) return { x: prev.x, y: target.y };
  return prev;
}

/** Same idea for a resize: the top-left corner is fixed, so it is the width
 * and height that give way when the grown rect would overlap a neighbour. */
function resolveResize(
  prev: { w: number; h: number },
  origin: { x: number; y: number },
  target: { w: number; h: number },
  neighbors: Rect[],
): { w: number; h: number } {
  const blocked = (w: number, h: number) => neighbors.some((n) => rectsOverlap({ ...origin, w, h }, n));
  if (!blocked(target.w, target.h)) return target;
  if (!blocked(target.w, prev.h)) return { w: target.w, h: prev.h };
  if (!blocked(prev.w, target.h)) return { w: prev.w, h: target.h };
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

  // ---- Dashboard layout: freeform position and size -------------------

  /** A pane's rect, falling back to its grid slot if it has never been moved
   * or resized -- so a pane opened for the first time still lands somewhere
   * sane without needing to seed `rects` up front. That fallback slot is
   * nudged down past anything already explicitly placed there, so a freshly
   * opened pane never starts life sitting on top of one someone has since
   * dragged into its way -- the grid's own slots never collide with each
   * other by construction, so only explicitly-placed neighbours need checking. */
  function rectFor(id: ServiceId, index: number): Rect {
    const stored = rects[id];
    if (stored) return stored;
    let candidate = defaultRect(index);
    const placed = Object.entries(rects)
      .filter(([placedId]) => placedId !== id)
      .map(([, r]) => r);
    let guard = 0;
    while (placed.some((r) => rectsOverlap(candidate, r)) && guard < 50) {
      candidate = { ...candidate, y: candidate.y + DASHBOARD_PANE_H + DASHBOARD_GAP };
      guard += 1;
    }
    return candidate;
  }

  function updateRect(id: ServiceId, index: number, patch: Partial<Rect>) {
    setRects((prev) => {
      const current = prev[id] ?? defaultRect(index);
      const next = { ...current, ...patch };
      if (next.x === current.x && next.y === current.y && next.w === current.w && next.h === current.h) return prev;
      return { ...prev, [id]: next };
    });
  }

  /** A pane's footprint for collision and snapping purposes: its stored rect,
   * shrunk to just its header while minimised (see the render below), since
   * that is the room it actually occupies on the dashboard. */
  function footprint(id: ServiceId, index: number): Rect {
    const r = rectFor(id, index);
    return minimized.has(id) ? { ...r, h: DASHBOARD_HEADER_H } : r;
  }

  /** Every other open pane's current footprint, for checking one being
   * dragged or resized against. */
  function neighborFootprints(excludeId: ServiceId): Rect[] {
    const out: Rect[] = [];
    open.forEach((s, i) => {
      if (s.id !== excludeId) out.push(footprint(s.id, i));
    });
    return out;
  }

  // Dragging a pane by its header moves it; dragging its corner handle
  // resizes it. Both are pointer-captured on the element the gesture started
  // on, same as the header drag above, so a release anywhere still delivers.
  // `moved` tracks the same thing it does for the header's reorder drag: below
  // the threshold this is a click (toggle minimised), past it the trailing
  // click has to be swallowed via `suppressClick`, or a drag would also
  // minimise the pane it just repositioned.
  //
  // Both also carry a `last*` field alongside their `origin*`: the target
  // position/size is recomputed from the gesture's start plus the pointer's
  // total travel on every move (so a frame that never arrives during a fast
  // drag isn't lost), but when that target is blocked the pane has to stay
  // wherever it last actually got to, not snap back to where the gesture
  // began -- `last*` is that place.
  const dashDragRef = useRef<{
    id: ServiceId;
    index: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    w: number;
    h: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  const dashResizeRef = useRef<{
    id: ServiceId;
    index: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
    lastW: number;
    lastH: number;
  } | null>(null);
  // Raised above the rest while being moved or resized, so it doesn't render
  // underneath a pane it is passing over.
  const [dashActive, setDashActive] = useState<ServiceId | null>(null);

  function startDashDrag(e: ReactPointerEvent<HTMLElement>, id: ServiceId, index: number) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    // A drag that ended without a trailing click (pointer released outside
    // the header) would otherwise leave this set, swallowing the next
    // legitimate one.
    suppressClick.current = false;
    const fp = footprint(id, index);
    dashDragRef.current = {
      id,
      index,
      startX: e.clientX,
      startY: e.clientY,
      originX: fp.x,
      originY: fp.y,
      w: fp.w,
      h: fp.h,
      lastX: fp.x,
      lastY: fp.y,
      moved: false,
    };
    setDashActive(id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveDashDrag(e: ReactPointerEvent<HTMLElement>) {
    const drag = dashDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const neighbors = neighborFootprints(drag.id);
    const size = { w: drag.w, h: drag.h };
    const rawX = Math.max(0, drag.originX + dx);
    const rawY = Math.max(0, drag.originY + dy);
    const target = {
      x: Math.max(0, snapAxis(rawX, xCandidates(neighbors, size.w))),
      y: Math.max(0, snapAxis(rawY, yCandidates(neighbors, size.h))),
    };
    const resolved = resolveMove({ x: drag.lastX, y: drag.lastY }, size, target, neighbors);
    drag.lastX = resolved.x;
    drag.lastY = resolved.y;
    updateRect(drag.id, drag.index, resolved);
  }

  function endDashDrag() {
    const drag = dashDragRef.current;
    dashDragRef.current = null;
    setDashActive(null);
    if (drag?.moved) suppressClick.current = true;
  }

  function startDashResize(e: ReactPointerEvent<HTMLElement>, id: ServiceId, index: number) {
    if (e.button !== 0) return;
    // The handle sits on the pane, not the header, so nothing here needs to
    // stop a minimise/drag from also firing -- but the pane's own drag
    // listener is on the header only, so no propagation guard is needed either.
    // Never rendered while collapsed (see below), so the pane's own footprint
    // is its real rect here, not the collapsed header height.
    const rect = rectFor(id, index);
    dashResizeRef.current = {
      id,
      index,
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.x,
      originY: rect.y,
      originW: rect.w,
      originH: rect.h,
      lastW: rect.w,
      lastH: rect.h,
    };
    setDashActive(id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveDashResize(e: ReactPointerEvent<HTMLElement>) {
    const resize = dashResizeRef.current;
    if (!resize) return;
    const neighbors = neighborFootprints(resize.id);
    const origin = { x: resize.originX, y: resize.originY };
    const rawW = Math.max(DASHBOARD_MIN_W, resize.originW + (e.clientX - resize.startX));
    const rawH = Math.max(DASHBOARD_MIN_H, resize.originH + (e.clientY - resize.startY));
    const target = {
      w: Math.max(DASHBOARD_MIN_W, snapAxis(rawW, widthCandidates(neighbors, origin.x))),
      h: Math.max(DASHBOARD_MIN_H, snapAxis(rawH, heightCandidates(neighbors, origin.y))),
    };
    const resolved = resolveResize({ w: resize.lastW, h: resize.lastH }, origin, target, neighbors);
    resize.lastW = resolved.w;
    resize.lastH = resolved.h;
    updateRect(resize.id, resize.index, resolved);
  }

  function endDashResize() {
    dashResizeRef.current = null;
    setDashActive(null);
  }

  // The canvas has to be at least as big as everything on it, or a pane
  // dragged toward an edge would have nowhere to scroll into.
  const dashboardExtent = open.reduce(
    (acc, s, i) => {
      const r = rectFor(s.id, i);
      return { w: Math.max(acc.w, r.x + r.w + DASHBOARD_GAP), h: Math.max(acc.h, r.y + r.h + DASHBOARD_GAP) };
    },
    { w: 0, h: 400 },
  );

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
          style={layout === "dashboard" ? { minHeight: dashboardExtent.h, minWidth: dashboardExtent.w } : undefined}
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
            const rect = dashboard ? rectFor(s.id, i) : null;
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
                  onPointerDown={(e) => (dashboard ? startDashDrag(e, s.id, i) : startDrag(e, s.id))}
                  onPointerMove={dashboard ? moveDashDrag : moveDrag}
                  onPointerUp={() => (dashboard ? endDashDrag() : endDrag(true))}
                  onPointerCancel={() => (dashboard ? endDashDrag() : endDrag(false))}
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
                    while it's showing a body to resize. */}
                {dashboard && !collapsed && (
                  <div
                    className="aggregator-resize-handle"
                    onPointerDown={(e) => startDashResize(e, s.id, i)}
                    onPointerMove={moveDashResize}
                    onPointerUp={endDashResize}
                    onPointerCancel={endDashResize}
                    title={`Resize ${s.label}`}
                    aria-hidden="true"
                  />
                )}
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
