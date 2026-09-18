import BucketsPage from "../pages/BucketsPage";
import CognitoPage from "../pages/CognitoPage";
import InsightsPage from "../pages/InsightsPage";
import IotPage from "../pages/IotPage";
import TablesPage from "../pages/TablesPage";
import Base64Tool from "../components/tools/Base64Tool";
import DiffTool from "../components/tools/DiffTool";
import HttpClientTool from "../components/tools/HttpClientTool";
import JwtTool from "../components/tools/JwtTool";
import MqttTool from "../components/tools/MqttTool";
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

export const PANE_TYPES: SessionTypeDef[] = [
  {
    type: "logs-cloudwatch",
    label: "CloudWatch",
    group: "Services",
    description: "Query CloudWatch Logs Insights across environments.",
    help:
      "Run one CloudWatch Logs Insights query across several AWS accounts and regions at once and read the merged " +
      "results newest-first. Pick the environments and log groups, write the query in Insights' pipe syntax or have " +
      "the assistant write it, then run it.",
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
    enabledFor: (u) => !!u?.logs_enabled,
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
  {
    type: "tool-jwt",
    label: "JWT",
    group: "Tools",
    description: "Decode a token, or build and sign a new one.",
    help:
      "Decode a JSON Web Token to read its header and claims, and optionally verify an HMAC signature against a " +
      "secret — or go the other way and build and sign a new token. Everything happens in your browser.",
    render: () => <JwtTool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
  {
    type: "tool-base64",
    label: "Base64",
    group: "Tools",
    description: "Convert text to and from Base64.",
    help: "Convert text to and from Base64, with a URL-safe variant for values that travel in query strings.",
    render: () => <Base64Tool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
  {
    type: "tool-diff",
    label: "Diff",
    group: "Tools",
    description: "Compare two blocks of text line by line.",
    help: "Compare two blocks of text line by line and see exactly what was added, removed and left alone.",
    render: () => <DiffTool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
];
