export interface Account {
  id: number;
  account_id: string;
  name: string;
  regions: string[];
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
  account_id: string;
  account_name: string;
  region: string;
  log_groups: LogGroupInfo[];
  error: string | null;
}

export interface StartedQuery {
  account_id: string;
  account_name: string;
  region: string;
  query_id: string | null;
  error: string | null;
}

export interface ResultField {
  field: string;
  value: string;
}

export interface QueryResultItem {
  account_id: string;
  account_name: string;
  region: string;
  query_id: string;
  status: string;
  rows: ResultField[][];
  statistics: Record<string, number> | null;
  error: string | null;
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
  listAccounts: () => req<Account[]>("/accounts"),
  createAccount: (payload: Omit<Account, "id">) =>
    req<Account>("/accounts", { method: "POST", body: JSON.stringify(payload) }),
  updateAccount: (id: number, payload: Partial<Omit<Account, "id">>) =>
    req<Account>(`/accounts/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteAccount: (id: number) => req<void>(`/accounts/${id}`, { method: "DELETE" }),

  getSettings: () => req<Settings>("/settings"),
  updateSettings: (payload: Settings) =>
    req<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) }),

  listSavedQueries: () => req<SavedQuery[]>("/saved-queries"),
  createSavedQuery: (payload: { name: string; query_string: string }) =>
    req<SavedQuery>("/saved-queries", { method: "POST", body: JSON.stringify(payload) }),
  deleteSavedQuery: (id: number) => req<void>(`/saved-queries/${id}`, { method: "DELETE" }),

  getLogGroups: (targets: { account_id: string; region: string }[]) =>
    req<{ results: LogGroupsResultItem[] }>("/log-groups", {
      method: "POST",
      body: JSON.stringify({ targets }),
    }),

  startQueries: (payload: {
    targets: { account_id: string; region: string; log_group_names: string[] }[];
    query_string: string;
    start_time: number;
    end_time: number;
    limit?: number;
  }) =>
    req<{ queries: StartedQuery[] }>("/queries/start", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getQueryResults: (queries: { account_id: string; region: string; query_id: string }[]) =>
    req<{ results: QueryResultItem[]; all_done: boolean }>("/queries/results", {
      method: "POST",
      body: JSON.stringify({ queries }),
    }),

  stopQueries: (queries: { account_id: string; region: string; query_id: string }[]) =>
    req<void>("/queries/stop", { method: "POST", body: JSON.stringify({ queries }) }),
};
