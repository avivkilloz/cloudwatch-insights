import InsightsPage from "../pages/InsightsPage";
import MqttTool from "../components/tools/MqttTool";
import ManifestPane from "../panes/ManifestPane";
import { PaneManifest } from "../panes/manifest";
import { SessionType } from "./SessionContext";

/**
 * The session types that also work as an Aggregator pane -- every service and
 * every tool, but not the Aggregator itself or the agent.
 *
 * Kept apart from the full registry so AggregatorPage can read it: the
 * registry has to import AggregatorPage to render it, so an import back the
 * other way is a cycle that fails at module-evaluation time.
 */

export type SessionGroup = "Platform" | "Services" | "Tools";

export interface SessionTypeDef {
  type: SessionType;
  label: string;
  group: SessionGroup;
  /** One line for the home card. */
  description: string;
  /** A sentence or two shown at the top of the page itself, saying what the
   * page is for. Longer than `description`, which has a card to fit into. */
  help: string;
  render: () => JSX.Element;
  enabledFor: (user: any) => boolean;
  /** The SavedSession.page key this type's saved sessions live under. Types
   * without one simply have no saved sessions. */
  savedPage?: string;
  /** Whether it can be an Aggregator pane. */
  paneable?: boolean;
}

/** The panes still drawn by their own components, until their PRs port them
 * to manifests (PLATFORM_PLAN.md §15). */
const DRAWN: SessionTypeDef[] = [
  {
    type: "logs-cloudwatch",
    label: "CloudWatch",
    group: "Services",
    description: "Query CloudWatch Logs Insights across environments.",
    help:
      "Run one CloudWatch Logs Insights query across several AWS accounts and regions at once and read the merged " +
      "results newest-first. Pick the environments and log groups, write the query in Insights' pipe syntax or have " +
      "the agent write it, then run it.",
    render: () => <InsightsPage backend="cloudwatch" />,
    enabledFor: (u) => !!u?.logs_enabled,
    // Unchanged from when this was the only logs page, so sessions saved
    // before the split still list and open here.
    savedPage: "logs",
    paneable: true,
  },
  {
    type: "logs-opensearch",
    label: "OpenSearch",
    group: "Services",
    description: "Query AWS-provisioned OpenSearch domains across environments.",
    help:
      "Search AWS-provisioned OpenSearch domains across environments using Lucene query_string syntax — the same as " +
      "OpenSearch Dashboards' search bar — and read the merged results newest-first. Each domain's access policy has " +
      "to allow the app's assumed role, and its endpoint has to be reachable from the backend.",
    render: () => <InsightsPage backend="opensearch" />,
    enabledFor: (u) => !!u?.opensearch_enabled,
    savedPage: "logs-opensearch",
    paneable: true,
  },
  {
    type: "tool-mqtt",
    label: "MQTT tester",
    group: "Tools",
    description: "Subscribe and publish on an environment's IoT Core endpoint.",
    help:
      "Connect to an environment's AWS IoT Core endpoint over a presigned WebSocket, subscribe to topic filters and " +
      "publish messages. Everything received is listed newest-first while the connection is open.",
    render: () => <MqttTool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
];

/**
 * Every pane type, in catalogue order: the ones above, and one for each pane
 * the generic renderer draws from its manifest alone (Base64, Diff, JWT, the
 * API table). Empty of the latter until `registerManifestPanes` runs, which
 * App does before any session mounts; the list is filled in place, since the
 * catalogue, the renderer and the pane naming all hold this array.
 */
export const PANE_TYPES: SessionTypeDef[] = [...DRAWN];

/** Where whole-session templates saved from a pane's own page -- before every
 * session was an Aggregator -- live (sessions/templates.tsx), for the panes
 * now drawn from a manifest. */
const LEGACY_SAVED_PAGES: Record<string, string> = {
  tables: "tables-session",
  buckets: "buckets-session",
  cognito: "cognito-session",
  iot: "iot",
};

function fromManifest(m: PaneManifest): SessionTypeDef {
  return {
    // A manifest's id is data, not one of the types this file was written with.
    type: m.id as SessionType,
    label: m.label,
    group: m.group,
    description: m.description,
    help: m.help,
    render: () => <ManifestPane type={m.id} />,
    enabledFor: (u) => !!u?.[m.flag],
    savedPage: LEGACY_SAVED_PAGES[m.id],
    paneable: true,
  };
}

export function registerManifestPanes(list: PaneManifest[]): void {
  const order = new Map(list.map((m) => [m.id, m.order]));
  const drawn = new Set(DRAWN.map((t) => t.type as string));
  const all = [...DRAWN, ...list.filter((m) => m.rendered && !drawn.has(m.id)).map(fromManifest)];
  // Stable, so a hand-drawn pane with no manifest keeps its place among its own.
  all.sort((a, b) => (order.get(a.type) ?? 1000) - (order.get(b.type) ?? 1000));
  PANE_TYPES.splice(0, PANE_TYPES.length, ...all);
}
