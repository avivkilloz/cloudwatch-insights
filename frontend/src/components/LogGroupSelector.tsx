import { useState } from "react";
import { api, Environment, LogGroupsResultItem } from "../api";

export type SelectionMap = Record<number, Set<string>>; // key: environment_id -> set of log group names

interface Props {
  environments: Environment[];
  selection: SelectionMap;
  onSelectionChange: (next: SelectionMap) => void;
}

export default function LogGroupSelector({ environments, selection, onSelectionChange }: Props) {
  const [results, setResults] = useState<LogGroupsResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function loadLogGroups() {
    if (environments.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await api.getLogGroups(environments.map((e) => e.id));
      setResults(resp.results);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleGroup(environmentId: number, name: string) {
    const next: SelectionMap = { ...selection };
    const current = new Set(next[environmentId] ?? []);
    if (current.has(name)) current.delete(name);
    else current.add(name);
    next[environmentId] = current;
    onSelectionChange(next);
  }

  function toggleAllInGroup(environmentId: number, names: string[], checked: boolean) {
    const next: SelectionMap = { ...selection };
    next[environmentId] = new Set(checked ? names : []);
    onSelectionChange(next);
  }

  const totalSelected = Object.values(selection).reduce((sum, s) => sum + s.size, 0);

  return (
    <div>
      <div className="toolbar">
        <button onClick={loadLogGroups} disabled={environments.length === 0 || loading}>
          {loading ? "Loading log groups…" : "Load log groups"}
        </button>
        <input
          type="text"
          placeholder="Filter log groups…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 220 }}
        />
        <span className="muted">{totalSelected} log group(s) selected</span>
      </div>
      {error && <p className="error-text">{error}</p>}
      {results.length === 0 && !loading && (
        <p className="muted">Select environments above, then load log groups.</p>
      )}
      <div className="checkbox-list">
        {results.map((r) => {
          const filtered = r.log_groups.filter((lg) => lg.name.toLowerCase().includes(filter.toLowerCase()));
          const selectedSet = selection[r.environment_id] ?? new Set<string>();
          const allChecked = filtered.length > 0 && filtered.every((lg) => selectedSet.has(lg.name));
          return (
            <div key={r.environment_id}>
              <div className="group-heading">
                {r.error ? (
                  <span className="tag error">error</span>
                ) : (
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => toggleAllInGroup(r.environment_id, filtered.map((lg) => lg.name), e.target.checked)}
                  />
                )}
                <span>
                  {r.environment_name} ({r.account_id} · {r.region})
                </span>
                {!r.error && <span className="muted">{filtered.length} log group(s)</span>}
              </div>
              {r.error && <div className="error-text" style={{ marginLeft: 20 }}>{r.error}</div>}
              {filtered.map((lg) => (
                <label key={lg.name} className="checkbox-item" style={{ marginLeft: 20 }}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(lg.name)}
                    onChange={() => toggleGroup(r.environment_id, lg.name)}
                  />
                  {lg.name}
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
