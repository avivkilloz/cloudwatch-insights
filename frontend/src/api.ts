export interface Environment {
  id: number;
  name: string;
  account_id: string;
  region: string;
  role_name: string | null;
}

export interface Settings {
  default_role_name: string | null;
}

export interface SavedQuery {
  id: number;
  name: string;
  query_string: string;
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
  updateSettings: (payload: Settings) =>
    req<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) }),

  listSavedQueries: () => req<SavedQuery[]>("/saved-queries"),
  createSavedQuery: (payload: { name: string; query_string: string }) =>
    req<SavedQuery>("/saved-queries", { method: "POST", body: JSON.stringify(payload) }),
  updateSavedQuery: (id: number, payload: Partial<{ name: string; query_string: string }>) =>
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
};
