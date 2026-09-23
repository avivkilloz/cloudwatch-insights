export interface Environment {
  id: number;
  name: string;
  account_id: string;
  region: string;
}

export interface Settings {
  app_title: string | null;
  /** A URL, including a data: URL for an uploaded image, shown right before the app title in the top bar. */
  app_logo_url: string | null;
}

/** A user belongs to exactly one group; the group is the sole unit of
 * access control -- which IAM role to assume, which tabs are visible, and
 * (for non-admin groups) which environments are visible. */
export interface UserGroup {
  id: number;
  name: string;
  role_name: string | null;
  is_admin: boolean;
  logs_enabled: boolean;
  opensearch_enabled: boolean;
  iot_enabled: boolean;
  tables_enabled: boolean;
  buckets_enabled: boolean;
  cognito_enabled: boolean;
  aggregator_enabled: boolean;
  tools_enabled: boolean;
  /** Ignored for the Admin group, which always sees every environment. */
  environment_ids: number[];
  user_count: number;
}

export interface User {
  id: number;
  username: string;
  group_id: number;
  group_name: string;
  is_admin: boolean;
  avatar_url: string | null;
  logs_enabled: boolean;
  opensearch_enabled: boolean;
  iot_enabled: boolean;
  tables_enabled: boolean;
  buckets_enabled: boolean;
  cognito_enabled: boolean;
  aggregator_enabled: boolean;
  tools_enabled: boolean;
}

export interface SavedSession<T = Record<string, unknown>> {
  id: number;
  page: string;
  name: string;
  state: T;
}

/**
 * One of the sessions open in the side panel, as the server last heard about
 * it. A SavedSession above is a named template you start a session *from*;
 * this is the live working state of a session already open, autosaved.
 *
 * `state` is a page's own bag, tag-encoded by sessions/storage before it is
 * sent: pages keep Sets and Maps, and plain JSON turns those into `{}`
 * silently -- handing the page back a selection it can no longer read. The
 * backend stores it as opaque JSON either way.
 */
/** A closed session as the side panel lists it. No `state`: nothing trims the
 * closed list, so sending every session's rows on every page load would make
 * the app slower the longer you had used it. The rows arrive with
 * `getLiveSession` when one is actually reopened. */
export interface LiveSessionSummary {
  client_id: string;
  type: string;
  title: string;
  truncated: boolean;
  closed_at: string | null;
}

export interface LiveSession {
  client_id: string;
  type: string;
  title: string;
  position: number;
  state: Record<string, unknown>;
  /** The browser dropped this session's results to stay under its size cap,
   * so the page can say so rather than looking like it found nothing. */
  truncated: boolean;
  /** Null while it is open; set once it is closed but still reopenable. */
  closed_at: string | null;
}

/** Which Logs-page backend a saved query/search is written for -- CloudWatch
 * Logs Insights' pipe syntax and OpenSearch's Lucene query_string syntax
 * aren't interchangeable. */
export type LogsBackend = "cloudwatch" | "opensearch";

export interface SavedQuery {
  id: number;
  name: string;
  query_string: string;
  backend: LogsBackend;
}

export interface LogGroupInfo {
  name: string;
  stored_bytes: number | null;
  creation_time: number | null;
}

export interface LogGroupsResultItem {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  log_groups: LogGroupInfo[];
  error: string | null;
}

export interface StartedQuery {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  query_id: string | null;
  error: string | null;
}

export interface ResultField {
  field: string;
  value: string;
}

export interface QueryResultItem {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  query_id: string;
  status: string;
  rows: ResultField[][];
  statistics: Record<string, number> | null;
  error: string | null;
}

export type IotSearchMode = "things" | "certificates";

export interface IotSavedSearch {
  id: number;
  name: string;
  query_string: string;
  search_mode: IotSearchMode;
}

export interface IotThingSummary {
  thing_name: string;
  thing_id: string | null;
  thing_type_name: string | null;
  thing_group_names: string[];
  attributes: Record<string, string>;
  connected: boolean | null;
  connectivity_timestamp: number | null;
}

export interface IotSearchResultItem {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  things: IotThingSummary[];
  error: string | null;
}

export interface IotPolicyInfo {
  policy_name: string;
  policy_arn: string | null;
  policy_document: Record<string, unknown> | null;
}

export interface IotCertificateInfo {
  certificate_id: string;
  certificate_arn: string;
  status: string;
  creation_date: number | null;
  policies: IotPolicyInfo[];
}

export interface IotCertificateSearchResultItem {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  certificates: IotCertificateInfo[];
  error: string | null;
}

export interface IotCertificateDetail {
  certificate_id: string;
  certificate_arn: string | null;
  status: string;
  creation_date: number | null;
  policies: IotPolicyInfo[];
  thing_names: string[];
  warnings: string[];
}

export interface IotShadowInfo {
  name: string;
  reported: Record<string, unknown>;
  desired: Record<string, unknown>;
  version: number | null;
  last_updated: number | null;
}

export interface IotJobExecutionInfo {
  job_id: string;
  status: string;
  queued_at: number | null;
  started_at: number | null;
  last_updated_at: number | null;
}

export interface IotThingDetail {
  thing_name: string;
  thing_id: string | null;
  thing_arn: string | null;
  thing_type_name: string | null;
  attributes: Record<string, string>;
  version: number | null;
  connected: boolean | null;
  connectivity_timestamp: number | null;
  certificates: IotCertificateInfo[];
  shadows: IotShadowInfo[];
  jobs: IotJobExecutionInfo[];
  warnings: string[];
}

// ---- Tables (DynamoDB) ----

export interface DynamoTableInfo {
  table_name: string;
  status: string | null;
  item_count: number | null;
  size_bytes: number | null;
  partition_key: string | null;
  sort_key: string | null;
}

export interface DynamoScanResult {
  items: Record<string, unknown>[];
  scanned_count: number;
  count: number;
  last_evaluated_key: string | null;
}

// ---- Buckets (S3) ----

export interface S3BucketInfo {
  name: string;
  creation_date: number | null;
}

export interface S3FolderInfo {
  name: string;
  prefix: string;
}

export interface S3FileInfo {
  key: string;
  name: string;
  size: number | null;
  last_modified: number | null;
  storage_class: string | null;
}

export interface S3BrowseResult {
  bucket: string;
  bucket_region: string;
  prefix: string;
  folders: S3FolderInfo[];
  files: S3FileInfo[];
  continuation_token: string | null;
}

// ---- Cognito ----

export interface CognitoUserPoolInfo {
  id: string;
  name: string | null;
}

export interface CognitoUserInfo {
  username: string | null;
  status: string | null;
  enabled: boolean | null;
  created: number | null;
  last_modified: number | null;
  attributes: Record<string, string | null>;
}

export interface CognitoUserSearchResult {
  users: CognitoUserInfo[];
  pagination_token: string | null;
}

// ---- OpenSearch (Logs tab: OpenSearch backend) ----

export interface OpenSearchDomainInfo {
  domain_name: string;
  endpoint: string | null;
  engine_version: string | null;
}

export interface OpenSearchDomainsResultItem {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  domains: OpenSearchDomainInfo[];
  error: string | null;
}

export interface OpenSearchIndexInfo {
  index: string;
  docs_count: number | null;
  store_size: string | null;
}

export interface OpenSearchTarget {
  environment_id: number;
  domain_name: string;
  domain_endpoint: string;
  indices: string[];
}

export interface OpenSearchResultItem {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  domain_name: string;
  indices: string[];
  status: string;
  rows: ResultField[][];
  total_hits: number | null;
  error: string | null;
}

// ---- Tools page ----

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface ToolHeader {
  key: string;
  value: string;
}

export interface HttpToolResponse {
  status_code: number;
  status_text: string;
  headers: ToolHeader[];
  body: string;
  body_truncated: boolean;
  elapsed_ms: number;
}

export interface MqttPresignedUrlResponse {
  endpoint: string;
  url: string;
  expires_in: number;
  diagnostic_status_code: number | null;
  diagnostic_body: string | null;
  diagnostic_headers: string[];
}

// ---- AI assistant ----

export type AiChatRole = "user" | "assistant";

export interface AiChatMessage {
  role: AiChatRole;
  content: string;
}

export type AiAssistMode = "build_query" | "ask_results";

/** Which page/service the assistant is being asked about. Picks the query
 * syntax build_query writes, and tells ask_results what the rows are. */
export type AiDomain =
  | "logs-cloudwatch"
  | "logs-opensearch"
  | "iot-things"
  | "iot-certificates"
  | "tables"
  | "buckets"
  | "cognito"
  /** The Aggregator page asking about rows pooled from several services. */
  | "aggregator"
  /** The Tools page's HTTP client, where a "query" is a whole request
   * (method, URL, headers, body) expressed as JSON rather than a search
   * string, and the "rows" are the single exchange that came back. */
  | "tools-http";

export interface AiAssistResponse {
  reply: string;
  suggested_query: string | null;
}

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Set by AuthContext so that a 401 from ANY api call (not just the initial
// /auth/me check) -- e.g. a session that expired while a background page was
// still open -- immediately drops the app back to the login page, instead of
// each page having to handle it individually.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...init,
  });
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") onUnauthorized?.();
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) =>
    req<User>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => req<void>("/auth/logout", { method: "POST" }),
  me: () => req<User>("/auth/me"),
  changeOwnPassword: (current_password: string, new_password: string) =>
    req<User>("/auth/password", { method: "PUT", body: JSON.stringify({ current_password, new_password }) }),
  updateOwnProfile: (avatar_url: string | null) =>
    req<User>("/auth/profile", { method: "PUT", body: JSON.stringify({ avatar_url }) }),

  listUsers: () => req<User[]>("/users"),
  createUser: (payload: { username: string; password: string; group_id: number }) =>
    req<User>("/users", { method: "POST", body: JSON.stringify(payload) }),
  updateUser: (id: number, payload: Partial<{ group_id: number; password: string }>) =>
    req<User>(`/users/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteUser: (id: number) => req<void>(`/users/${id}`, { method: "DELETE" }),

  listUserGroups: () => req<UserGroup[]>("/user-groups"),
  createUserGroup: (payload: Omit<UserGroup, "id" | "is_admin" | "user_count">) =>
    req<UserGroup>("/user-groups", { method: "POST", body: JSON.stringify(payload) }),
  updateUserGroup: (id: number, payload: Partial<Omit<UserGroup, "id" | "is_admin" | "user_count">>) =>
    req<UserGroup>(`/user-groups/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteUserGroup: (id: number) => req<void>(`/user-groups/${id}`, { method: "DELETE" }),

  listEnvironments: () => req<Environment[]>("/environments"),
  createEnvironment: (payload: Omit<Environment, "id">) =>
    req<Environment>("/environments", { method: "POST", body: JSON.stringify(payload) }),
  updateEnvironment: (id: number, payload: Partial<Omit<Environment, "id">>) =>
    req<Environment>(`/environments/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteEnvironment: (id: number) => req<void>(`/environments/${id}`, { method: "DELETE" }),

  getSettings: () => req<Settings>("/settings"),
  updateSettings: (payload: Partial<Settings>) =>
    req<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) }),

  listSavedQueries: () => req<SavedQuery[]>("/saved-queries"),
  createSavedQuery: (payload: { name: string; query_string: string; backend?: LogsBackend }) =>
    req<SavedQuery>("/saved-queries", { method: "POST", body: JSON.stringify(payload) }),
  updateSavedQuery: (id: number, payload: Partial<{ name: string; query_string: string; backend: LogsBackend }>) =>
    req<SavedQuery>(`/saved-queries/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteSavedQuery: (id: number) => req<void>(`/saved-queries/${id}`, { method: "DELETE" }),

  getLogGroups: (environmentIds: number[]) =>
    req<{ results: LogGroupsResultItem[] }>("/log-groups", {
      method: "POST",
      body: JSON.stringify({ environment_ids: environmentIds }),
    }),

  startQueries: (payload: {
    targets: { environment_id: number; log_group_names: string[] }[];
    query_string: string;
    start_time: number;
    end_time: number;
    limit?: number;
  }) =>
    req<{ queries: StartedQuery[] }>("/queries/start", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getQueryResults: (queries: { environment_id: number; query_id: string }[]) =>
    req<{ results: QueryResultItem[]; all_done: boolean }>("/queries/results", {
      method: "POST",
      body: JSON.stringify({ queries }),
    }),

  stopQueries: (queries: { environment_id: number; query_id: string }[]) =>
    req<void>("/queries/stop", { method: "POST", body: JSON.stringify({ queries }) }),

  searchIotThings: (payload: { environment_ids: number[]; query_string: string; max_results?: number }) =>
    req<{ results: IotSearchResultItem[] }>("/iot/search", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getIotThingDetail: (payload: { environment_id: number; thing_name: string }) =>
    req<IotThingDetail>("/iot/things/detail", { method: "POST", body: JSON.stringify(payload) }),

  listIotSavedSearches: () => req<IotSavedSearch[]>("/iot/saved-searches"),
  createIotSavedSearch: (payload: { name: string; query_string: string; search_mode: IotSearchMode }) =>
    req<IotSavedSearch>("/iot/saved-searches", { method: "POST", body: JSON.stringify(payload) }),
  updateIotSavedSearch: (
    id: number,
    payload: Partial<{ name: string; query_string: string; search_mode: IotSearchMode }>
  ) => req<IotSavedSearch>(`/iot/saved-searches/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteIotSavedSearch: (id: number) => req<void>(`/iot/saved-searches/${id}`, { method: "DELETE" }),

  searchIotCertificates: (payload: { environment_ids: number[]; query_string: string; max_results?: number }) =>
    req<{ results: IotCertificateSearchResultItem[] }>("/iot/certificates/search", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getIotCertificateDetail: (payload: { environment_id: number; certificate_id: string }) =>
    req<IotCertificateDetail>("/iot/certificates/detail", { method: "POST", body: JSON.stringify(payload) }),

  listSavedSessions: <T = Record<string, unknown>>(page?: string) =>
    req<SavedSession<T>[]>(`/saved-sessions${page ? `?page=${encodeURIComponent(page)}` : ""}`),
  createSavedSession: <T = Record<string, unknown>>(payload: { page: string; name: string; state: T }) =>
    req<SavedSession<T>>("/saved-sessions", { method: "POST", body: JSON.stringify(payload) }),
  updateSavedSession: <T = Record<string, unknown>>(id: number, payload: Partial<{ name: string; state: T }>) =>
    req<SavedSession<T>>(`/saved-sessions/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteSavedSession: (id: number) => req<void>(`/saved-sessions/${id}`, { method: "DELETE" }),

  listLiveSessions: () => req<LiveSession[]>("/live-sessions"),
  listClosedLiveSessions: () => req<LiveSessionSummary[]>("/live-sessions/closed"),
  getLiveSession: (clientId: string) => req<LiveSession>(`/live-sessions/${encodeURIComponent(clientId)}`),
  putLiveSession: (clientId: string, payload: Omit<LiveSession, "client_id" | "closed_at">) =>
    req<LiveSession>(`/live-sessions/${encodeURIComponent(clientId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  reorderLiveSessions: (client_ids: string[]) =>
    req<LiveSession[]>("/live-sessions/reorder", { method: "POST", body: JSON.stringify({ client_ids }) }),
  closeLiveSession: (clientId: string) =>
    req<LiveSession>(`/live-sessions/${encodeURIComponent(clientId)}/close`, { method: "POST" }),
  deleteLiveSession: (clientId: string) =>
    req<void>(`/live-sessions/${encodeURIComponent(clientId)}`, { method: "DELETE" }),

  listTables: (environmentId: number) =>
    req<{ tables: string[] }>(`/tables/list?environment_id=${environmentId}`),
  describeTable: (payload: { environment_id: number; table_name: string }) =>
    req<DynamoTableInfo>("/tables/describe", { method: "POST", body: JSON.stringify(payload) }),
  scanTable: (payload: {
    environment_id: number;
    table_name: string;
    query_string?: string;
    limit?: number;
    exclusive_start_key?: string | null;
  }) => req<DynamoScanResult>("/tables/scan", { method: "POST", body: JSON.stringify(payload) }),

  listBuckets: (environmentId: number) =>
    req<{ buckets: S3BucketInfo[] }>(`/buckets/list?environment_id=${environmentId}`),
  browseBucket: (payload: {
    environment_id: number;
    bucket: string;
    prefix?: string;
    search?: string;
    max_results?: number;
    continuation_token?: string | null;
  }) => req<S3BrowseResult>("/buckets/browse", { method: "POST", body: JSON.stringify(payload) }),

  listUserPools: (environmentId: number) =>
    req<{ user_pools: CognitoUserPoolInfo[] }>(`/cognito/user-pools?environment_id=${environmentId}`),
  searchCognitoUsers: (payload: {
    environment_id: number;
    user_pool_id: string;
    query_string?: string;
    limit?: number;
    pagination_token?: string | null;
  }) => req<CognitoUserSearchResult>("/cognito/users", { method: "POST", body: JSON.stringify(payload) }),

  getAiStatus: () => req<{ configured: boolean }>("/ai/status"),
  aiAssist: (payload: {
    mode: AiAssistMode;
    messages: AiChatMessage[];
    query_string?: string;
    sample_rows?: Record<string, unknown>[];
    row_count?: number;
    domain?: AiDomain;
  }) => req<AiAssistResponse>("/ai/assist", { method: "POST", body: JSON.stringify(payload) }),

  getOpenSearchDomains: (environmentIds: number[]) =>
    req<{ results: OpenSearchDomainsResultItem[] }>("/opensearch/domains", {
      method: "POST",
      body: JSON.stringify({ environment_ids: environmentIds }),
    }),

  getOpenSearchIndices: (payload: { environment_id: number; domain_endpoint: string }) =>
    req<{ indices: OpenSearchIndexInfo[] }>("/opensearch/indices", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  searchOpenSearch: (payload: {
    targets: OpenSearchTarget[];
    query_string?: string;
    start_time: number;
    end_time: number;
    timestamp_field?: string;
    limit?: number;
  }) =>
    req<{ results: OpenSearchResultItem[] }>("/opensearch/search", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  sendHttpToolRequest: (payload: { method: HttpMethod; url: string; headers?: ToolHeader[]; body?: string | null }) =>
    req<HttpToolResponse>("/tools/http-request", { method: "POST", body: JSON.stringify(payload) }),

  getMqttPresignedUrl: (environmentId: number) =>
    req<MqttPresignedUrlResponse>("/tools/mqtt/presigned-url", {
      method: "POST",
      body: JSON.stringify({ environment_id: environmentId }),
    }),
};
