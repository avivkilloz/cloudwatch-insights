import { useEffect, useRef, useState } from "react";
import { api, Environment, SavedQuery, SavedSession, QueryResultItem, StartedQuery } from "../api";
import AiAssistantWidget from "../components/AiAssistantWidget";
import EnvironmentSelector from "../components/EnvironmentSelector";
import LogGroupSelector, { SelectionMap } from "../components/LogGroupSelector";
import ResultsView, { SortDirection } from "../components/ResultsView";

const AI_SAMPLE_ROW_CAP = 40;

function resultsToSampleRows(items: QueryResultItem[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const item of items) {
    for (const row of item.rows) {
      const obj: Record<string, unknown> = { environment: item.environment_name };
      for (const f of row) obj[f.field] = f.value;
      rows.push(obj);
    }
  }
  if (rows.length <= AI_SAMPLE_ROW_CAP) return rows;

  // A single query can span multiple log groups (e.g. correlating two
  // Lambdas via @log), and one of them can be far higher-volume than the
  // other. Taking a flat first-N slice of results sorted by @timestamp
  // would then silently starve the sparser log group out of the AI
  // assistant's sample. Round-robin across distinct @log values instead so
  // every represented source gets a fair share of the capped sample.
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row["@log"] ?? "");
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const groupLists = Array.from(groups.values());
  const sample: Record<string, unknown>[] = [];
  for (let i = 0; sample.length < AI_SAMPLE_ROW_CAP; i++) {
    const before = sample.length;
    for (const list of groupLists) {
      if (i >= list.length) continue;
      sample.push(list[i]);
      if (sample.length >= AI_SAMPLE_ROW_CAP) break;
    }
    if (sample.length === before) break;
  }
  return sample;
}

const SESSION_PAGE = "logs";

interface LogsSessionState {
  environment_ids: number[];
  log_group_selection: Record<string, string[]>;
  query_string: string;
  limit: number;
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

const DEFAULT_QUERY = `fields @timestamp, @message
| sort @timestamp desc`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10000;

const POLL_INTERVAL_MS = 2000;

function toLocalDatetimeInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function InsightsPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<Set<number>>(new Set());
  const [logGroupSelection, setLogGroupSelection] = useState<SelectionMap>({});

  const [queryString, setQueryString] = useState(DEFAULT_QUERY);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
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
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped each time a new query run supersedes the displayed results, so the
  // AI widget can drop a stale "About results" conversation that was talking
  // about a previous result set instead of quietly answering from old data.
  const [resultsVersion, setResultsVersion] = useState(0);

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    api.listSavedQueries().then(setSavedQueries);
    api.listSavedSessions<LogsSessionState>(SESSION_PAGE).then(setSavedSessions);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

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
    results.forEach((item) => item.rows.forEach((row) => row.forEach((f) => seen.add(f.field))));
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

  async function runQuery() {
    setRunError(null);
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

    setResults([]);
    setResultsVersion((v) => v + 1);
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
    const saved = await api.createSavedQuery({ name, query_string: queryString });
    setSavedQueries((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function captureSession(): LogsSessionState {
    return {
      environment_ids: Array.from(selectedEnvironmentIds),
      log_group_selection: Object.fromEntries(
        Object.entries(logGroupSelection).map(([envId, names]) => [envId, Array.from(names)])
      ),
      query_string: queryString,
      limit,
      sort_field: sortField,
      sort_direction: sortDirection,
      preset,
      custom_start: customStart,
      custom_end: customEnd,
    };
  }

  function applySession(state: LogsSessionState) {
    setSelectedEnvironmentIds(new Set(state.environment_ids));
    setLogGroupSelection(
      Object.fromEntries(
        Object.entries(state.log_group_selection).map(([envId, names]) => [Number(envId), new Set(names)])
      )
    );
    setQueryString(state.query_string);
    setLimit(state.limit);
    setSortField(state.sort_field);
    setSortDirection(state.sort_direction);
    setPreset(state.preset);
    setCustomStart(state.custom_start);
    setCustomEnd(state.custom_end);
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

  return (
    <div>
      <div className="panel">
        <h2>Session</h2>
        <p className="muted">
          Unlike a saved query (just the query text), a saved session captures everything on this page — the
          selected environments, log groups, query, time range, limit, and sort — so you can resume an investigation
          later exactly where you left it.
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
        <h2>1. Choose environments</h2>
        <EnvironmentSelector
          environments={environments}
          selectedIds={selectedEnvironmentIds}
          onToggle={toggleEnvironment}
        />
      </div>

      <div className="panel">
        <h2>2. Choose log groups</h2>
        <LogGroupSelector
          environments={selectedEnvironments}
          selection={logGroupSelection}
          onSelectionChange={setLogGroupSelection}
        />
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
              const sq = savedQueries.find((q) => String(q.id) === e.target.value);
              if (sq) setQueryString(sq.query_string);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved query…
            </option>
            {savedQueries.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentQuery}>
            Save query
          </button>
        </div>
        <textarea rows={5} value={queryString} onChange={(e) => setQueryString(e.target.value)} />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button onClick={runQuery} disabled={isRunning}>
            {isRunning ? "Running…" : "Run query"}
          </button>
          <button className="secondary" onClick={stopQuery} disabled={!isRunning}>
            Stop
          </button>
          {runError && <span className="error-text">{runError}</span>}
        </div>
      </div>

      <div className="panel">
        <h2>4. Results</h2>
        <ResultsView items={results} limit={limit} sortField={sortField} sortDirection={sortDirection} />
      </div>

      <AiAssistantWidget
        queryString={queryString}
        onUseQuery={setQueryString}
        sampleRows={resultsToSampleRows(results)}
        rowCount={results.reduce((sum, item) => sum + item.rows.length, 0)}
        resultsVersion={resultsVersion}
      />
    </div>
  );
}
