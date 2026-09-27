/**
 * Hearing about changes to this user's sessions made somewhere else.
 *
 * The server announces every write to a live session on
 * /api/live-sessions/events (a server-sent event stream): which session,
 * what kind of change, the version it is now at, and the writer's origin.
 * No state rides on it -- a change worth having is fetched through the normal
 * GET -- so this is only ever "go and look".
 *
 * An EventSource reconnects by itself after a drop, but anything announced
 * while it was down is gone, so a reconnect is reported too: the caller
 * re-reads the list and catches up on whatever it missed.
 */

import { SYNC_ORIGIN } from "../api";

export interface LiveEvent {
  kind: "upsert" | "close" | "delete" | "reorder";
  client_id: string | null;
  version: number | null;
  /** The writer's X-Sync-Origin: a tab's id, or "agent". */
  origin: string | null;
  /** A reorder's new order, when it fit in the announcement. */
  order?: string[];
}

export function subscribeLiveEvents(onEvent: (event: LiveEvent) => void, onReconnect: () => void): () => void {
  const source = new EventSource("/api/live-sessions/events", { withCredentials: true });
  let opened = false;
  source.onopen = () => {
    if (opened) onReconnect();
    opened = true;
  };
  source.onmessage = (message) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(message.data) as LiveEvent;
    } catch {
      return;
    }
    // This tab's own write, echoed back: it already has it.
    if (event.origin === SYNC_ORIGIN) return;
    onEvent(event);
  };
  return () => source.close();
}
