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

export const SESSION_TYPES: SessionTypeDef[] = [
  ...PANE_TYPES.filter((t) => t.group === "Services"),
  ...PANE_TYPES.filter((t) => t.group === "Tools"),
];

/** Panes are grouped this way everywhere they are offered. "Platform" is no
 * longer one of them: what was under it is either the session itself now
 * (the Aggregator) or a page rather than a pane (the agent). */
export const GROUP_ORDER: SessionGroup[] = ["Services", "Tools"];

/** What each group is, for the headings where panes are offered. */
export const GROUP_BLURB: Record<SessionGroup, string> = {
  Platform: "This platform's own features — they work across the pages below rather than wrapping one service.",
  Services: "A window onto an AWS service, across every environment you have access to.",
  Tools: "Self-contained utilities, for the things you would otherwise leave the app to do.",
};

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
