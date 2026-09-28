import { useSyncExternalStore } from "react";

/**
 * Where a session's card (SessionCard: its name, description, adds and
 * layout) is drawn: at the top of the body (the default), or in the side panel.
 * It stays where it was put -- in the side panel even while the panel is
 * hidden, so it's out of sight then -- until it's moved back.
 *
 * Two small stores, since the card belongs to each session's own page while
 * the place it can move to belongs to the shell: the preference (per browser,
 * like the panel's width; the key predates the card's merge with the page-info
 * card, and is kept so the choice survives), and the slot element the shell
 * renders in the side panel while the panel is open. The session on screen
 * portals its card into the slot.
 */

const KEY = "cwi-panes-in-rail";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "rail";
  } catch {
    return false;
  }
}

let inRail = read();
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce() {
  for (const listener of listeners) listener();
}

export function setPanesInRail(next: boolean): void {
  inRail = next;
  try {
    window.localStorage.setItem(KEY, next ? "rail" : "body");
  } catch {
    // best-effort persistence only
  }
  announce();
}

export function usePanesInRail(): boolean {
  return useSyncExternalStore(subscribe, () => inRail);
}

/** A ref callback for the shell's slot: set while it's mounted, null after. */
export function setRailSlot(el: HTMLElement | null): void {
  if (el === slot) return;
  slot = el;
  announce();
}

export function useRailSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot);
}
