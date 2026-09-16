import { useEffect, useRef, useState } from "react";
import {
  api,
  Environment,
  LogsBackend,
  OpenSearchResultItem,
  OpenSearchTarget,
  SavedQuery,
  SavedSession,
  QueryResultItem,
  StartedQuery,
} from "../api";
import AiAssistantWidget from "../components/AiAssistantWidget";
import EnvironmentSelector from "../components/EnvironmentSelector";
import LogGroupSelector, { SelectionMap } from "../components/LogGroupSelector";
import OpenSearchIndexSelector, { OpenSearchSelectionMap } from "../components/OpenSearchIndexSelector";
import ResultsView, { ResultsViewItem, SortDirection } from "../components/ResultsView";

/** Flattens every row across all queried targets into plain objects, in
 * their original (query-sorted) order and with no cap -- the AI widget
 * decides how much of this to actually send, per its sampled/all-results
 * toggle. */
function flattenResults(items: ResultsViewItem[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    for (const row of item.rows) {
      const obj: Record<string, unknown> = { environment: item.environment_name };
      for (const f of row) obj[f.field] = f.value;
      rows.push(obj);
    }
  }
  return rows;
}

const SESSION_PAGE = "logs";

interface SerializedOpenSearchSelection {
  [environmentId: string]: {
    [domainName: string]: { domain_endpoint: string; indices: string[] };
  };
}

interface LogsSessionState {
  backend: LogsBackend;
  environment_ids: number[];
  log_group_selection: Record<string, string[]>;
  opensearch_selection: SerializedOpenSearchSelection;
  query_string: string;
  limit: number;
  timestamp_field: string;
  sort_field: string;
  sort_direction: SortDirection;
  preset: number | "custom";
  custom_start: string;
  custom_end: string;
}

const RELATIVE_PRESETS: { label: string; seconds: number }[] = [
  { label: "Last 5 minutes", seconds: 5 * 60 },
  { label: "Last 15 minutes", seconds: 15 * 60 },
  { label: "Last 30 minutes", seconds: 30 * 60 },
  { label: "Last 1 hour", seconds: 60 * 60 },
  { label: "Last 3 hours", seconds: 3 * 60 * 60 },
  { label: "Last 6 hours", seconds: 6 * 60 * 60 },
  { label: "Last 12 hours", seconds: 12 * 60 * 60 },
  { label: "Last 1 day", seconds: 24 * 60 * 60 },
  { label: "Last 3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "Last 7 days", seconds: 7 * 24 * 60 * 60 },
];

const DEFAULT_QUERY: Record<LogsBackend, string> = {
  cloudwatch: `fields @timestamp, @message
| sort @timestamp desc`,
  opensearch: "",
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10000;
const DEFAULT_TIMESTAMP_FIELD = "@timestamp";

const POLL_INTERVAL_MS = 2000;

function toLocalDatetimeInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function serializeOpenSearchSelection(selection: OpenSearchSelectionMap): SerializedOpenSearchSelection {
  const out: SerializedOpenSearchSelection = {};
  for (const [envId, domains] of Object.entries(selection)) {
    out[envId] = {};
    for (const [domainName, entry] of Object.entries(domains)) {
      out[envId][domainName] = { domain_endpoint: entry.domain_endpoint, indices: Array.from(entry.indices) };
    }
  }
  return out;
}

function deserializeOpenSearchSelection(serialized: SerializedOpenSearchSelection): OpenSearchSelectionMap {
  const out: OpenSearchSelectionMap = {};
  for (const [envId, domains] of Object.entries(serialized ?? {})) {
    out[Number(envId)] = {};
    for (const [domainName, entry] of Object.entries(domains)) {
      out[Number(envId)][domainName] = { domain_endpoint: entry.domain_endpoint, indices: new Set(entry.indices) };
    }
  }
  return out;
}

function openSearchTargets(selection: OpenSearchSelectionMap): OpenSearchTarget[] {
  const targets: OpenSearchTarget[] = [];
  for (const [envId, domains] of Object.entries(selection)) {
    for (const [domainName, entry] of Object.entries(domains)) {
      if (entry.indices.size > 0) {
        targets.push({
          environment_id: Number(envId),
          domain_name: domainName,
          domain_endpoint: entry.domain_endpoint,
          indices: Array.from(entry.indices),
        });
      }
    }
  }
  return targets;
}

export default function InsightsPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<Set<number>>(new Set());
  const [logGroupSelection, setLogGroupSelection] = useState<SelectionMap>({});
  const [openSearchSelection, setOpenSearchSelection] = useState<OpenSearchSelectionMap>({});

  const [backend, setBackend] = useState<LogsBackend>("cloudwatch");
  const [queryString, setQueryString] = useState(DEFAULT_QUERY.cloudwatch);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [timestampField, setTimestampField] = useState(DEFAULT_TIMESTAMP_FIELD);
  const [sortField, setSortField] = useState("@timestamp");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [preset, setPreset] = useState<number | "custom">(15 * 60);
  const now = Math.floor(Date.now() / 1000);
  const [customStart, setCustomStart] = useState(toLocalDatetimeInput(now - 15 * 60));
  const [customEnd, setCustomEnd] = useState(toLocalDatetimeInput(now));

  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSession<LogsSessionState>[]>([]);

  const [startedQueries, setStartedQueries] = useState<StartedQuery[]>([]);
  const [results, setResults] = useState<QueryResultItem[]>([]);
  const [osResults, setOsResults] = useState<OpenSearchResultItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped each time a new query run supersedes the displayed results, so the
  // AI widget can drop a stale "About results" conversation that was talking
  // about a previous result set instead of quietly answering from old data.
  const [resultsVersion, setResultsVersion] = useState(0);

  const activeResults: ResultsViewItem[] = backend === "opensearch" ? osResults : results;

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    api.listSavedQueries().then(setSavedQueries);
    api.listSavedSessions<LogsSessionState>(SESSION_PAGE).then(setSavedSessions);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function switchBackend(next: LogsBackend) {
    if (next === backend) return;
    setBackend(next);
    // Only replace the query text if it's still the other backend's default
    // (or blank) -- a query the user actually wrote is left alone.
    if (!queryString.trim() || queryString === DEFAULT_QUERY[backend]) {
      setQueryString(DEFAULT_QUERY[next]);
    }
    setResults([]);
    setOsResults([]);
    setResultsVersion((v) => v + 1);
  }

  function toggleEnvironment(id: number) {
    setSelectedEnvironmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedEnvironments = environments.filter((e) => selectedEnvironmentIds.has(e.id));

  const availableSortFields = (() => {
    const seen = new Set<string>(["@timestamp"]);
    activeResults.forEach((item) => item.rows.forEach((row) => row.forEach((f) => seen.add(f.field))));
    return Array.from(seen);
  })();

  function computeTimeRange(): { start_time: number; end_time: number } {
    if (preset === "custom") {
      return {
        start_time: Math.floor(new Date(customStart).getTime() / 1000),
        end_time: Math.floor(new Date(customEnd).getTime() / 1000),
      };
    }
    const end = Math.floor(Date.now() / 1000);
    return { start_time: end - preset, end_time: end };
  }

  async function runCloudWatchQuery() {
    const queryTargets = Object.entries(logGroupSelection)
      .filter(([, names]) => names.size > 0)
      .map(([environmentId, names]) => ({
        environment_id: Number(environmentId),
        log_group_names: Array.from(names),
      }));
    if (queryTargets.length === 0) {
      setRunError("Select at least one log group to query.");
      return;
    }
    const { start_time, end_time } = computeTimeRange();
    if (end_time <= start_time) {
      setRunError("End time must be after start time.");
      return;
    }
    const clampedLimit = Math.min(Math.max(Math.floor(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    setIsRunning(true);
    try {
      const resp = await api.startQueries({
        targets: queryTargets,
        query_string: queryString,
        start_time,
        end_time,
        limit: clampedLimit,
      });
      setStartedQueries(resp.queries);

      const immediateErrors: QueryResultItem[] = resp.queries
        .filter((q) => q.error)
        .map((q) => ({
          environment_id: q.environment_id,
          environment_name: q.environment_name,
          account_id: q.account_id,
          region: q.region,
          query_id: "",
          status: "Failed",
          rows: [],
          statistics: null,
          error: q.error,
        }));
      setResults(immediateErrors);

      const runnable = resp.queries.filter((q) => q.query_id);
      if (runnable.length === 0) {
        setIsRunning(false);
        return;
      }
      poll(runnable, immediateErrors);
    } catch (e: any) {
      setRunError(e.message);
      setIsRunning(false);
    }
  }

  async function runOpenSearchSearch() {
    const targets = openSearchTargets(openSearchSelection);
    if (targets.length === 0) {
      setRunError("Select at least one index to search.");
      return;
    }
    const { start_time, end_time } = computeTimeRange();
    if (end_time <= start_time) {
      setRunError("End time must be after start time.");
      return;
    }
    const clampedLimit = Math.min(Math.max(Math.floor(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    setIsRunning(true);
    try {
      // OpenSearch search is a single synchronous request/response -- no
      // start/poll/stop like CloudWatch Logs Insights' async query API.
      const resp = await api.searchOpenSearch({
        targets,
        query_string: queryString,
        start_time,
        end_time,
        timestamp_field: timestampField || DEFAULT_TIMESTAMP_FIELD,
        limit: clampedLimit,
      });
      setOsResults(resp.results);
    } catch (e: any) {
      setRunError(e.message);
    } finally {
      setIsRunning(false);
    }
  }

  async function runQuery() {
    setRunError(null);
    setResults([]);
    setOsResults([]);
    setResultsVersion((v) => v + 1);
    if (backend === "opensearch") {
      await runOpenSearchSearch();
    } else {
      await runCloudWatchQuery();
    }
  }

  function poll(runnable: StartedQuery[], baseErrors: QueryResultItem[]) {
    if (pollRef.current) clearInterval(pollRef.current);
    const query = () => runnable.map((q) => ({ environment_id: q.environment_id, query_id: q.query_id! }));

    const tick = async () => {
      try {
        const resp = await api.getQueryResults(query());
        setResults([...baseErrors, ...resp.results]);
        if (resp.all_done) {
          if (pollRef.current) clearInterval(pollRef.current);
          setIsRunning(false);
        }
      } catch (e: any) {
        setRunError(e.message);
        if (pollRef.current) clearInterval(pollRef.current);
        setIsRunning(false);
      }
    };
    tick();
    pollRef.current = setInterval(tick, POLL_INTERVAL_MS);
  }

  async function stopQuery() {
    if (pollRef.current) clearInterval(pollRef.current);
    const runnable = startedQueries.filter((q) => q.query_id);
    if (runnable.length > 0) {
      await api.stopQueries(runnable.map((q) => ({ environment_id: q.environment_id, query_id: q.query_id! })));
    }
    setIsRunning(false);
  }

  async function saveCurrentQuery() {
    const name = prompt("Save query as:");
    if (!name) return;
    const saved = await api.createSavedQuery({ name, query_string: queryString, backend });
    setSavedQueries((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function captureSession(): LogsSessionState {
    return {
      backend,
      environment_ids: Array.from(selectedEnvironmentIds),
      log_group_selection: Object.fromEntries(
        Object.entries(logGroupSelection).map(([envId, names]) => [envId, Array.from(names)])
      ),
      opensearch_selection: serializeOpenSearchSelection(openSearchSelection),
      query_string: queryString,
      limit,
      timestamp_field: timestampField,
      sort_field: sortField,
      sort_direction: sortDirection,
      preset,
      custom_start: customStart,
      custom_end: customEnd,
    };
  }

  function applySession(state: LogsSessionState) {
    setBackend(state.backend ?? "cloudwatch");
    setSelectedEnvironmentIds(new Set(state.environment_ids));
    setLogGroupSelection(
      Object.fromEntries(
        Object.entries(state.log_group_selection ?? {}).map(([envId, names]) => [Number(envId), new Set(names)])
      )
    );
    setOpenSearchSelection(deserializeOpenSearchSelection(state.opensearch_selection));
    setQueryString(state.query_string);
    setLimit(state.limit);
    setTimestampField(state.timestamp_field || DEFAULT_TIMESTAMP_FIELD);
    setSortField(state.sort_field);
    setSortDirection(state.sort_direction);
    setPreset(state.preset);
    setCustomStart(state.custom_start);
    setCustomEnd(state.custom_end);
    setResults([]);
    setOsResults([]);
    setResultsVersion((v) => v + 1);
  }

  async function saveCurrentSession() {
    const name = prompt("Save session as:");
    if (!name) return;
    const saved = await api.createSavedSession<LogsSessionState>({
      page: SESSION_PAGE,
      name,
      state: captureSession(),
    });
    setSavedSessions((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  const filteredSavedQueries = savedQueries.filter((q) => q.backend === backend);
  const rowCount = activeResults.reduce((sum, item) => sum + item.rows.length, 0);

  return (
    <div>
      <div className="panel">
        <h2>Session</h2>
        <p className="muted">
          Unlike a saved query (just the query text), a saved session captures everything on this page — the
          backend, selected environments, log groups/indices, query, time range, limit, and sort — so you can resume
          an investigation later exactly where you left it.
        </p>
        <div className="toolbar">
          <select
            onChange={(e) => {
              const s = savedSessions.find((x) => String(x.id) === e.target.value);
              if (s) applySession(s.state);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved session…
            </option>
            {savedSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentSession}>
            Save session
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Backend</h2>
        <div className="toolbar">
          <button className={backend === "cloudwatch" ? "" : "secondary"} onClick={() => switchBackend("cloudwatch")}>
            CloudWatch Logs Insights
          </button>
          <button className={backend === "opensearch" ? "" : "secondary"} onClick={() => switchBackend("opensearch")}>
            OpenSearch
          </button>
        </div>
        <p className="muted">
          {backend === "cloudwatch"
            ? "Search CloudWatch Logs Insights log groups using their pipe-based query syntax."
            : "Search AWS-provisioned OpenSearch domains using Lucene query_string syntax (the same as OpenSearch Dashboards' search bar). Requires each domain's access policy to allow the app's assumed role and its endpoint to be reachable from the backend."}
        </p>
      </div>

      <div className="panel">
        <h2>1. Choose environments</h2>
        <EnvironmentSelector
          environments={environments}
          selectedIds={selectedEnvironmentIds}
          onToggle={toggleEnvironment}
        />
      </div>

      <div className="panel">
        <h2>2. Choose {backend === "opensearch" ? "indices" : "log groups"}</h2>
        {backend === "opensearch" ? (
          <OpenSearchIndexSelector
            environments={selectedEnvironments}
            selection={openSearchSelection}
            onSelectionChange={setOpenSearchSelection}
          />
        ) : (
          <LogGroupSelector
            environments={selectedEnvironments}
            selection={logGroupSelection}
            onSelectionChange={setLogGroupSelection}
          />
        )}
      </div>

      <div className="panel">
        <h2>3. Query</h2>
        <div className="toolbar">
          <select
            value={preset === "custom" ? "custom" : preset}
            onChange={(e) => setPreset(e.target.value === "custom" ? "custom" : Number(e.target.value))}
          >
            {RELATIVE_PRESETS.map((p) => (
              <option key={p.seconds} value={p.seconds}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom range…</option>
          </select>
          {preset === "custom" && (
            <>
              <input type="text" value={customStart} onChange={(e) => setCustomStart(e.target.value)} placeholder="YYYY-MM-DDTHH:mm" style={{ width: 170 }} />
              <span className="muted">to</span>
              <input type="text" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} placeholder="YYYY-MM-DDTHH:mm" style={{ width: 170 }} />
            </>
          )}
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">Limit</span>
            <input
              type="number"
              min={1}
              max={MAX_LIMIT}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              style={{ width: 90 }}
              title="Max rows per environment (also applied to the merged, most-recent-first total)"
            />
          </label>
          {backend === "opensearch" && (
            <label className="row" style={{ gap: 6 }}>
              <span className="muted">Timestamp field</span>
              <input
                type="text"
                value={timestampField}
                onChange={(e) => setTimestampField(e.target.value)}
                style={{ width: 120 }}
                title="The date field to filter/sort by, e.g. @timestamp"
              />
            </label>
          )}
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">Sort by</span>
            <select value={sortField} onChange={(e) => setSortField(e.target.value)}>
              <option value="">Original order</option>
              {availableSortFields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select
              value={sortDirection}
              onChange={(e) => setSortDirection(e.target.value as SortDirection)}
              disabled={!sortField}
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </label>
          <select
            onChange={(e) => {
              const sq = filteredSavedQueries.find((q) => String(q.id) === e.target.value);
              if (sq) setQueryString(sq.query_string);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved query…
            </option>
            {filteredSavedQueries.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentQuery}>
            Save query
          </button>
        </div>
        <textarea
          rows={5}
          value={queryString}
          onChange={(e) => setQueryString(e.target.value)}
          placeholder={
            backend === "opensearch"
              ? 'e.g. level:ERROR AND service:checkout (blank matches everything in the time range)'
              : undefined
          }
        />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button onClick={runQuery} disabled={isRunning}>
            {isRunning ? "Running…" : "Run query"}
          </button>
          {backend === "cloudwatch" && (
            <button className="secondary" onClick={stopQuery} disabled={!isRunning}>
              Stop
            </button>
          )}
          {runError && <span className="error-text">{runError}</span>}
        </div>
      </div>

      <div className="panel">
        <h2>4. Results</h2>
        <ResultsView items={activeResults} limit={limit} sortField={sortField} sortDirection={sortDirection} />
      </div>

      <AiAssistantWidget
        queryString={queryString}
        onUseQuery={setQueryString}
        sampleRows={flattenResults(activeResults)}
        rowCount={rowCount}
        resultsVersion={resultsVersion}
        backend={backend}
      />
    </div>
  );
}
