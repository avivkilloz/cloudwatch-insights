import { PANE_TYPES, SessionGroup, SessionTypeDef } from "./paneTypes";

/**
 * Every kind of pane a session can hold, in one place.
 *
 * It used to list session *types* -- an Aggregator, an agent, and one per
 * service and tool. There is only one kind of session now: an Aggregator, with
 * whichever of these inside it. So this is the catalogue of panes, which is
 * what the new-session card, the Aggregator's own picker and the pane renderer
 * all read.
 *
 * The list itself lives in ./paneTypes so AggregatorPage can read it without
 * importing this module back -- a cycle that used to fail at
 * module-evaluation time.
 */

export type { SessionGroup, SessionTypeDef };

// The same array, not a copy: panes described by a manifest join it when the
// manifests load. Manifests order services before tools.
export const SESSION_TYPES: SessionTypeDef[] = PANE_TYPES;

/** Panes are grouped this way everywhere they are offered. "Platform" is no
 * longer one of them: what was under it is either the session itself now
 * (the Aggregator) or a page rather than a pane (the agent). */
export const GROUP_ORDER: SessionGroup[] = ["Services", "Tools"];

export function sessionType(type: string): SessionTypeDef | undefined {
  return SESSION_TYPES.find((t) => t.type === type);
}

export function sessionTypeLabel(type: string): string {
  return sessionType(type)?.label ?? type;
}

/** Where a session's own state is saved as a template. Every session is an
 * Aggregator, so there is one key rather than one per page -- the per-page keys
 * that older templates used are migrated on the way in. */
export const SESSION_SAVED_PAGE = "aggregator";
