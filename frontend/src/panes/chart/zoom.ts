/**
 * Zooming into a time range by dragging across a chart (§4.3, "brushing a
 * time range on a chart sets the pane's time inputs and re-runs"): the
 * histogram, or a time series in a pane with a time range. The range becomes
 * the pane's custom start and end -- to the second, so a zoom into a burst
 * isn't rounded back out to whole minutes -- and the pane's main action runs
 * again, as the person did it.
 *
 * Undo goes back to the range before, one zoom at a time. That history is
 * this tab's (like a picker's loaded options, D47): the range itself is
 * session state, but which ranges you came through isn't anyone else's.
 */

import { useSyncExternalStore } from "react";
import { LayoutItem, PaneManifest } from "../manifest";
import { PaneApi, Values } from "../paneApi";

type Spec = { preset: string; start: string; end: string };

/** The pane's time range inputs, from its layout's `time_range` item. */
export function timeRangeOf(m: PaneManifest): Spec | null {
  const walk = (items: LayoutItem[]): Spec | null => {
    for (const item of items) {
      if (item.time_range) return item.time_range;
      const inner = walk([...(item.toolbar ?? []), ...(item.row ?? []), ...(item.line ?? [])]);
      if (inner) return inner;
    }
    return null;
  };
  for (const card of m.layout) {
    const found = walk([...card.aside, ...card.items]);
    if (found) return found;
  }
  return null;
}

/** Local wall-clock time as the time range's text takes it, with seconds. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

const history = new Map<string, Values[]>();
const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** How many zooms this tab can undo in the pane at `key`. */
export function useZoomDepth(key: string): number {
  return useSyncExternalStore(subscribe, () => history.get(key)?.length ?? 0);
}

function rerun(pane: PaneApi, changes: Values) {
  pane.changeInputs(changes);
  const main = pane.m.actions.find((a) => a.main);
  if (main) pane.run(main, { inputs: { ...pane.inputs, ...changes } });
}

/** Zooms the pane at `key` into [start, end] (epoch ms) and runs it again. */
export function zoomTo(pane: PaneApi, key: string, start: number, end: number) {
  const spec = timeRangeOf(pane.m);
  if (!spec) return;
  const from = Math.floor(start / 1000) * 1000;
  // At least a second wide: a click-sized drag is still a range.
  const to = Math.max(Math.ceil(end / 1000) * 1000, from + 1000);
  const before = { [spec.preset]: pane.inputs[spec.preset], [spec.start]: pane.inputs[spec.start], [spec.end]: pane.inputs[spec.end] };
  history.set(key, [...(history.get(key) ?? []), before]);
  changed();
  rerun(pane, { [spec.preset]: "custom", [spec.start]: localInput(from), [spec.end]: localInput(to) });
}

/** Back to the range before the last zoom, run again. */
export function undoZoom(pane: PaneApi, key: string) {
  const stack = history.get(key) ?? [];
  const before = stack[stack.length - 1];
  if (!before) return;
  history.set(key, stack.slice(0, -1));
  changed();
  rerun(pane, before);
}
