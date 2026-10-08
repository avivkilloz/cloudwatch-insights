import BucketsPage from "../pages/BucketsPage";
import CognitoPage from "../pages/CognitoPage";
import InsightsPage from "../pages/InsightsPage";
import IotPage from "../pages/IotPage";
import TablesPage from "../pages/TablesPage";
import HttpClientTool from "../components/tools/HttpClientTool";
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
    type: "iot",
    label: "IoT",
    group: "Services",
    description: "Search things by fleet index, or certificates by status.",
    help:
      "Search AWS IoT Core across environments — things by fleet-index query, or certificates by status. Expanding a " +
      "result fetches its detail: shadows, attached certificates and their policies, and recent jobs.",
    render: () => <IotPage />,
    enabledFor: (u) => !!u?.iot_enabled,
    savedPage: "iot",
    paneable: true,
  },
  {
    type: "tables",
    label: "DynamoDB",
    group: "Services",
    description: "Scan and filter a DynamoDB table.",
    help:
      "Browse a DynamoDB table in any environment: see its keys and item count, then scan it with an optional filter " +
      "and page through the items. Expanding a row shows the whole item.",
    render: () => <TablesPage />,
    enabledFor: (u) => !!u?.tables_enabled,
    savedPage: "tables-session",
    paneable: true,
  },
  {
    type: "buckets",
    label: "S3",
    group: "Services",
    description: "Browse an S3 bucket and search object names.",
    help:
      "Browse an S3 bucket like a file tree, walking into folders, or search object names across a prefix. Sizes and " +
      "last-modified times come back with each object.",
    render: () => <BucketsPage />,
    enabledFor: (u) => !!u?.buckets_enabled,
    savedPage: "buckets-session",
    paneable: true,
  },
  {
    type: "cognito",
    label: "Cognito",
    group: "Services",
    description: "Find users in a Cognito user pool.",
    help:
      "Find users in a Cognito user pool by any attribute — email, username, phone — and open one to see its full " +
      "attribute set, status, and group memberships.",
    render: () => <CognitoPage />,
    enabledFor: (u) => !!u?.cognito_enabled,
    savedPage: "cognito-session",
    paneable: true,
  },
  {
    type: "tool-http",
    label: "HTTP client",
    group: "Tools",
    description: "Send a request and inspect the response, Postman-style.",
    help:
      "Send an HTTP request and inspect the whole response — status, headers and body. Requests go out from the " +
      "backend, which refuses private and link-local addresses, so this cannot be used to reach inside the cluster.",
    render: () => <HttpClientTool />,
    enabledFor: (u) => !!u?.tools_enabled,
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
