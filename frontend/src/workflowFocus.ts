/**
 * What the Workflows page hands the rest of the app (§22.10):
 * - the run on screen, which the agent panel's "This run" tab is about (D98);
 * - a workflow drafted from a session, waiting for the editor to open it (D96).
 * Small stores, so the page and the panel needn't know each other.
 */

import { useSyncExternalStore } from "react";

export interface RunFocus {
  runId: number;
  title: string;
}

export interface Draft {
  id: string;
  source: string;
}

let focus: RunFocus | null = null;
let draft: Draft | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Set by the run page while a run it may read is on screen; null when it goes. */
export function setRunFocus(next: RunFocus | null) {
  if (focus?.runId === next?.runId && focus?.title === next?.title) return;
  focus = next;
  emit();
}

export function useRunFocus(): RunFocus | null {
  return useSyncExternalStore(subscribe, () => focus);
}

/** A draft for the editor; taken (and cleared) by the Workflows page. */
export function offerDraft(next: Draft) {
  draft = next;
  emit();
}

export function takeDraft(): Draft | null {
  const taken = draft;
  draft = null;
  return taken;
}

export function useDraftWaiting(): boolean {
  return useSyncExternalStore(subscribe, () => draft !== null);
}
