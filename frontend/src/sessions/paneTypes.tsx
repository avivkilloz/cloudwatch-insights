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

export type SessionGroup = "Services" | "Tools" | "Assistant";

export interface SessionTypeDef {
  type: SessionType;
  label: string;
  group: SessionGroup;
  /** One line for the home card. */
  description: string;
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
    type: "logs",
    label: "Logs",
    group: "Services",
    description: "CloudWatch Logs Insights or OpenSearch, across environments.",
    render: () => <InsightsPage />,
    enabledFor: (u) => !!u?.logs_enabled,
    savedPage: "logs",
    paneable: true,
  },
  {
    type: "iot",
    label: "IoT",
    group: "Services",
    description: "Search things by fleet index, or certificates by status.",
    render: () => <IotPage />,
    enabledFor: (u) => !!u?.iot_enabled,
    savedPage: "iot",
    paneable: true,
  },
  {
    type: "tables",
    label: "Tables",
    group: "Services",
    description: "Scan and filter a DynamoDB table.",
    render: () => <TablesPage />,
    enabledFor: (u) => !!u?.tables_enabled,
    savedPage: "tables-session",
    paneable: true,
  },
  {
    type: "buckets",
    label: "Buckets",
    group: "Services",
    description: "Browse an S3 bucket and search object names.",
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
    render: () => <HttpClientTool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
  {
    type: "tool-mqtt",
    label: "MQTT tester",
    group: "Tools",
    description: "Subscribe and publish on an environment's IoT Core endpoint.",
    render: () => <MqttTool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
  {
    type: "tool-jwt",
    label: "JWT",
    group: "Tools",
    description: "Decode a token, or build and sign a new one.",
    render: () => <JwtTool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
  {
    type: "tool-base64",
    label: "Base64",
    group: "Tools",
    description: "Convert text to and from Base64.",
    render: () => <Base64Tool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
  {
    type: "tool-diff",
    label: "Diff",
    group: "Tools",
    description: "Compare two blocks of text line by line.",
    render: () => <DiffTool />,
    enabledFor: (u) => !!u?.tools_enabled,
    paneable: true,
  },
];
