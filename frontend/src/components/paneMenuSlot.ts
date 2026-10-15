import { createContext, useContext } from "react";

/**
 * Where a pane's ⋮ goes: a spot in its header, or in its tab in the tabs
 * layout (where the tab is the header). The frame (AggregatorPage) owns the
 * header; what the menu holds -- auto-refresh, saved inputs, and later more,
 * such as hiding the inputs on a dashboard -- is the pane's, which portals it
 * here. `el` is null while the pane has no spot on screen (an unselected tab).
 */
export interface PaneMenuSpot {
  el: HTMLElement | null;
  /** The pane's own name ("CloudWatch 2"), which its kind doesn't know. */
  label: string;
}

export const PaneMenuSlot = createContext<PaneMenuSpot>({ el: null, label: "" });

export function usePaneMenuSlot(): PaneMenuSpot {
  return useContext(PaneMenuSlot);
}
