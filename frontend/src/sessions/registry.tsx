import AgentPage from "../pages/AgentPage";
import AggregatorPage from "../pages/AggregatorPage";
import { PANE_TYPES, SessionGroup, SessionTypeDef } from "./paneTypes";

/**
 * Every kind of session the app can open, in one place.
 *
 * The + menu, the home cards and the shell's renderer all read this, so adding
 * a session type is one entry rather than three edits that can drift apart.
 * The pane-able subset lives in ./paneTypes so the Aggregator can read it
 * without importing this module back.
 */

export type { SessionGroup, SessionTypeDef };

export const SESSION_TYPES: SessionTypeDef[] = [
  // Platform first: everything below it is a window onto something that exists
  // outside this app, and these two are the app's own.
  {
    type: "aggregator",
    label: "Aggregator",
    group: "Platform",
    description: "Several pages side by side, with one assistant across them.",
    help:
      "Put several of the pages below side by side in one session and work them together — panes can be added, " +
      "removed and reordered while it runs, and one assistant sees across all of them at once rather than one " +
      "service at a time.",
    render: () => <AggregatorPage />,
    enabledFor: (u) => !!u?.aggregator_enabled,
    savedPage: "aggregator",
  },
  {
    type: "agent",
    label: "Agent",
    group: "Platform",
    description: "Ask across the whole workspace, not one service.",
    help:
      "Ask about anything in the platform and — once it is connected to a model — have it do the work: open the " +
      "sessions you need, run the searches and answer across all of them. It sees the workspace from outside, " +
      "unlike the assistant inside a service session, which only ever sees that session's own query and rows.",
    render: () => <AgentPage />,
    enabledFor: () => true,
  },
  ...PANE_TYPES.filter((t) => t.group === "Services"),
  ...PANE_TYPES.filter((t) => t.group === "Tools"),
];

export const GROUP_ORDER: SessionGroup[] = ["Platform", "Services", "Tools"];

/** What each group is, for the headings on the home page. */
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
