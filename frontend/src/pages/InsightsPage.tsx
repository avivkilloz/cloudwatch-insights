import { useEffect, useRef, useState } from "react";
import { useSessionState } from "../sessions/SessionContext";
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
import RestoredResultsNote from "../components/RestoredResultsNote";
import ResultsView, { ResultsViewItem, SortDirection } from "../components/ResultsView";



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
  cloudwatch: `fields @timestamp, @log, @message
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
  // useSessionState is useState that survives a reload, keyed within this
  // session. Everything the user chose or is looking at uses it; anything
  // refetched on mount (environments, saved lists) or only true right now
  // (isRunning, runError, in-flight query ids) deliberately does not -- coming
  // back to "Running…" from yesterday, or polling query ids CloudWatch has
  // long since forgotten, would be worse than starting clean.
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useSessionState<Set<number>>(
    "selectedEnvironmentIds",
    () => new Set(),
  );
  const [logGroupSelection, setLogGroupSelection] = useSessionState<SelectionMap>("logGroupSelection", {});
  const [openSearchSelection, setOpenSearchSelection] = useSessionState<OpenSearchSelectionMap>(
    "openSearchSelection",
    {},
  );

  const [backend, setBackend] = useSessionState<LogsBackend>("backend", "cloudwatch");
  const [queryString, setQueryString] = useSessionState("queryString", DEFAULT_QUERY.cloudwatch);
  const [limit, setLimit] = useSessionState("limit", DEFAULT_LIMIT);
  const [timestampField, setTimestampField] = useSessionState("timestampField", DEFAULT_TIMESTAMP_FIELD);
  const [sortField, setSortField] = useSessionState("sortField", "@timestamp");
  const [sortDirection, setSortDirection] = useSessionState<SortDirection>("sortDirection", "desc");
  const [preset, setPreset] = useSessionState<number | "custom">("preset", 15 * 60);
  const now = Math.floor(Date.now() / 1000);
  const [customStart, setCustomStart] = useSessionState("customStart", () => toLocalDatetimeInput(now - 15 * 60));
  const [customEnd, setCustomEnd] = useSessionState("customEnd", () => toLocalDatetimeInput(now));

  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  const [startedQueries, setStartedQueries] = useState<StartedQuery[]>([]);
  const [results, setResults] = useSessionState<QueryResultItem[]>("results", []);
  const [osResults, setOsResults] = useSessionState<OpenSearchResultItem[]>("osResults", []);
  // When the results came back, so restored rows can say how old they are
  // rather than passing yesterday's logs off as current.
  const [ranAt, setRanAt] = useSessionState<number | null>("ranAt", null);
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped each time a new query run supersedes the displayed results, so the
  // AI widget can drop a stale "About results" conversation that was talking
  // about a previous result set instead of quietly answering from old data.
  const [resultsVersion, setResultsVersion] = useSessionState("resultsVersion", 0);

  const activeResults: ResultsViewItem[] = backend === "opensearch" ? osResults : results;

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    api.listSavedQueries().then(setSavedQueries);
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
    setRanAt(Date.now());
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




  const filteredSavedQueries = savedQueries.filter((q) => q.backend === backend);

  return (
    <div>
      <div className="panel">
        <h2>Backend</h2>
        <div className="toolbar">
          <button className={backend === "cloudwatch" ? "" : "secondary"} onClick={() => switchBackend("cloudwatch")}>
            CloudWatch
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
        <RestoredResultsNote ranAt={ranAt} onRerun={runQuery} />
        <ResultsView
          items={activeResults}
          limit={limit}
          sortField={sortField}
          sortDirection={sortDirection}
          onSelectionChange={setSelectedRows}
        />
      </div>

      <AiAssistantWidget
        queryString={queryString}
        onUseQuery={setQueryString}
        selectedRows={selectedRows}
        resultsVersion={resultsVersion}
        domain={backend === "opensearch" ? "logs-opensearch" : "logs-cloudwatch"}
      />
    </div>
  );
}
