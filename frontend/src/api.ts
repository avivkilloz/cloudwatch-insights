export interface Environment {
  id: number;
  name: string;
  account_id: string;
  region: string;
  role_name: string | null;
}

export interface Settings {
  default_role_name: string | null;
  app_title: string | null;
  /** A URL, including a data: URL for an uploaded image, shown right before the app title in the top bar. */
  app_logo_url: string | null;
  logs_enabled: boolean;
  iot_enabled: boolean;
  tables_enabled: boolean;
  buckets_enabled: boolean;
  cognito_enabled: boolean;
}

export interface SavedSession<T = Record<string, unknown>> {
  id: number;
  page: string;
  name: string;
  state: T;
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

// ---- AI assistant ----

export type AiChatRole = "user" | "assistant";

export interface AiChatMessage {
  role: AiChatRole;
  content: string;
}

export type AiAssistMode = "build_query" | "ask_results";

export interface AiAssistResponse {
  reply: string;
  suggested_query: string | null;
}

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
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
    backend?: LogsBackend;
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
};
