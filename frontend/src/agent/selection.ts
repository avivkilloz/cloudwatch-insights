/**
 * What each open session has checked in its panes, for its agent chat to
 * attach.
 *
 * The rows live in the panes (each session's AggregatorPage collects them
 * from its panes' registrations), but the chat that sends them lives in the
 * agent panel, outside every session. So each Aggregator publishes here --
 * a small summary to render ("3 rows in CloudWatch"), and a way to read the
 * rows themselves when a message is actually sent -- and the chat reads the
 * one for the session on screen.
 */

import { useSyncExternalStore } from "react";

export interface PaneSelectionSummary {
  /** The pane's name, as the session shows it. */
  pane: string;
  count: number;
}

export interface SessionSelection {
  summaries: PaneSelectionSummary[];
  /** The checked rows, each tagged with the service and pane it came from. */
  rows: () => Record<string, unknown>[];
}

const EMPTY: SessionSelection = { summaries: [], rows: () => [] };
const selections = new Map<string, SessionSelection>();
const listeners = new Set<() => void>();

export function publishSelection(sessionId: string, selection: SessionSelection | null): void {
  if (selection) selections.set(sessionId, selection);
  else selections.delete(sessionId);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionSelection(sessionId: string | null): SessionSelection {
  return useSyncExternalStore(subscribe, () => (sessionId ? selections.get(sessionId) ?? EMPTY : EMPTY));
}
