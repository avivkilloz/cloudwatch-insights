import { useEffect, useRef, useState } from "react";
import { api, Account, SavedQuery, QueryResultItem, StartedQuery } from "../api";
import { AWS_REGIONS } from "../regions";
import LogGroupSelector, { SelectionMap, TargetKey, targetKey } from "../components/LogGroupSelector";
import ResultsView from "../components/ResultsView";

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
| sort @timestamp desc
| limit 100`;

const POLL_INTERVAL_MS = 2000;

function toLocalDatetimeInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function InsightsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
  const [logGroupSelection, setLogGroupSelection] = useState<SelectionMap>({});

  const [queryString, setQueryString] = useState(DEFAULT_QUERY);
  const [preset, setPreset] = useState<number | "custom">(15 * 60);
  const now = Math.floor(Date.now() / 1000);
  const [customStart, setCustomStart] = useState(toLocalDatetimeInput(now - 15 * 60));
  const [customEnd, setCustomEnd] = useState(toLocalDatetimeInput(now));

  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);

  const [startedQueries, setStartedQueries] = useState<StartedQuery[]>([]);
  const [results, setResults] = useState<QueryResultItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.listAccounts().then(setAccounts);
    api.listSavedQueries().then(setSavedQueries);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleRegion(region: string) {
    setSelectedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
  }

  const selectedAccounts = accounts.filter((a) => selectedAccountIds.has(a.account_id));
  const targets: TargetKey[] = [];
  selectedAccounts.forEach((a) => {
    selectedRegions.forEach((r) => {
      targets.push({ account_id: a.account_id, account_name: a.name, region: r });
    });
  });

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
      .map(([key, names]) => {
        const [account_id, region] = key.split("|");
        return { account_id, region, log_group_names: Array.from(names) };
      });
    if (queryTargets.length === 0) {
      setRunError("Select at least one log group to query.");
      return;
    }
    const { start_time, end_time } = computeTimeRange();
    if (end_time <= start_time) {
      setRunError("End time must be after start time.");
      return;
    }

    setResults([]);
    setIsRunning(true);
    try {
      const resp = await api.startQueries({ targets: queryTargets, query_string: queryString, start_time, end_time });
      setStartedQueries(resp.queries);

      const immediateErrors: QueryResultItem[] = resp.queries
        .filter((q) => q.error)
        .map((q) => ({
          account_id: q.account_id,
          account_name: q.account_name,
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
    const query = () =>
      runnable.map((q) => ({ account_id: q.account_id, region: q.region, query_id: q.query_id! }));

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
      await api.stopQueries(runnable.map((q) => ({ account_id: q.account_id, region: q.region, query_id: q.query_id! })));
    }
    setIsRunning(false);
  }

  async function saveCurrentQuery() {
    const name = prompt("Save query as:");
    if (!name) return;
    const saved = await api.createSavedQuery({ name, query_string: queryString });
    setSavedQueries((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function deleteSaved(id: number) {
    await api.deleteSavedQuery(id);
    setSavedQueries((prev) => prev.filter((q) => q.id !== id));
  }

  return (
    <div>
      <div className="panel">
        <h2>1. Choose accounts &amp; regions</h2>
        {accounts.length === 0 && <p className="muted">No accounts configured yet — add some under "Accounts &amp; Settings".</p>}
        <div className="grid-2">
          <div>
            <h3>Accounts</h3>
            <div className="checkbox-list" style={{ maxHeight: 160 }}>
              {accounts.map((a) => (
                <label key={a.id} className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.has(a.account_id)}
                    onChange={() => toggleAccount(a.account_id)}
                  />
                  {a.name} ({a.account_id})
                </label>
              ))}
            </div>
          </div>
          <div>
            <h3>Regions</h3>
            <div className="checkbox-list" style={{ maxHeight: 160 }}>
              {AWS_REGIONS.map((r) => (
                <label key={r} className="checkbox-item">
                  <input type="checkbox" checked={selectedRegions.has(r)} onChange={() => toggleRegion(r)} />
                  {r}
                </label>
              ))}
            </div>
          </div>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {targets.length} account/region target(s) selected.
        </p>
      </div>

      <div className="panel">
        <h2>2. Choose log groups</h2>
        <LogGroupSelector targets={targets} selection={logGroupSelection} onSelectionChange={setLogGroupSelection} />
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
        {savedQueries.length > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            {savedQueries.map((q) => (
              <span key={q.id} className="tag">
                {q.name}{" "}
                <button
                  className="danger"
                  style={{ padding: "0 6px", marginLeft: 4, fontSize: 10 }}
                  onClick={() => deleteSaved(q.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
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
        <ResultsView items={results} />
      </div>
    </div>
  );
}
