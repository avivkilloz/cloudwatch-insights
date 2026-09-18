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
  ...PANE_TYPES.filter((t) => t.group === "Services"),
  {
    type: "aggregator",
    label: "Aggregator",
    group: "Services",
    description: "Several of the above side by side, with one assistant across them.",
    render: () => <AggregatorPage />,
    enabledFor: (u) => !!u?.aggregator_enabled,
    savedPage: "aggregator",
  },
  ...PANE_TYPES.filter((t) => t.group === "Tools"),
  {
    type: "agent",
    label: "Agent",
    group: "Assistant",
    description: "Ask across the whole workspace, not one service.",
    render: () => <AgentPage />,
    enabledFor: () => true,
  },
];

export const GROUP_ORDER: SessionGroup[] = ["Services", "Tools", "Assistant"];

export function sessionType(type: string): SessionTypeDef | undefined {
  return SESSION_TYPES.find((t) => t.type === type);
}

export function sessionTypeLabel(type: string): string {
  return sessionType(type)?.label ?? type;
}
