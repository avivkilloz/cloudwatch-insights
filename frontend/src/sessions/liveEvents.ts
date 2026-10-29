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
  /** "access": this user's permission on a shared session changed. */
  /** "outputs": one pane's outputs changed (`pane`; `version` is that pane's). */
  /** "approvals": what waits for this user's decision changed (D88). */
  /** "draft": a Builder draft this user works in changed (D157, D161; `draft_id`). */
  /** "build_members": who works on something built changed (D161). */
  kind: "upsert" | "close" | "delete" | "reorder" | "access" | "outputs" | "approvals" | "draft" | "build_members";
  client_id: string | null;
  version: number | null;
  /** The writer's X-Sync-Origin: a tab's id, or "agent". */
  origin: string | null;
  /** A reorder's new order, when it fit in the announcement. */
  order?: string[];
  /** The pane whose outputs an "outputs" event is about. */
  pane?: string;
  /** A "draft" event's draft, what it's of, who changed it ("“laptop”", "the
   * agent"), and the tab whose editor should take it (open_draft on screen). */
  draft_id?: number;
  build_kind?: "pane" | "workflow" | "step" | "credential" | "connection";
  target_id?: string | null;
  by?: string;
  for_tab?: string;
}

/** A "draft" event, passed on to the editors (pages/buildDraft.tsx). */
export const DRAFT_EVENT = "cwi:draft";

/** A "build_members" event, passed on to the members sections and the draft
 * lists (components/BuildMembers.tsx): someone was added, left or handed on. */
export const BUILD_MEMBERS_EVENT = "cwi:build-members";

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
