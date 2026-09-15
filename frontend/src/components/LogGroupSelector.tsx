import { useState } from "react";
import { api, LogGroupsResultItem } from "../api";

export interface TargetKey {
  account_id: string;
  account_name: string;
  region: string;
}

export type SelectionMap = Record<string, Set<string>>; // key: `${account_id}|${region}` -> set of log group names

export function targetKey(account_id: string, region: string) {
  return `${account_id}|${region}`;
}

interface Props {
  targets: TargetKey[];
  selection: SelectionMap;
  onSelectionChange: (next: SelectionMap) => void;
}

export default function LogGroupSelector({ targets, selection, onSelectionChange }: Props) {
  const [results, setResults] = useState<LogGroupsResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function loadLogGroups() {
    if (targets.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await api.getLogGroups(targets.map((t) => ({ account_id: t.account_id, region: t.region })));
      setResults(resp.results);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleGroup(accountId: string, region: string, name: string) {
    const key = targetKey(accountId, region);
    const next: SelectionMap = { ...selection };
    const current = new Set(next[key] ?? []);
    if (current.has(name)) current.delete(name);
    else current.add(name);
    next[key] = current;
    onSelectionChange(next);
  }

  function toggleAllInGroup(accountId: string, region: string, names: string[], checked: boolean) {
    const key = targetKey(accountId, region);
    const next: SelectionMap = { ...selection };
    next[key] = new Set(checked ? names : []);
    onSelectionChange(next);
  }

  const totalSelected = Object.values(selection).reduce((sum, s) => sum + s.size, 0);

  return (
    <div>
      <div className="toolbar">
        <button onClick={loadLogGroups} disabled={targets.length === 0 || loading}>
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
      {results.length === 0 && !loading && <p className="muted">Select accounts/regions above, then load log groups.</p>}
      <div className="checkbox-list">
        {results.map((r) => {
          const key = targetKey(r.account_id, r.region);
          const filtered = r.log_groups.filter((lg) => lg.name.toLowerCase().includes(filter.toLowerCase()));
          const selectedSet = selection[key] ?? new Set<string>();
          const allChecked = filtered.length > 0 && filtered.every((lg) => selectedSet.has(lg.name));
          return (
            <div key={key}>
              <div className="group-heading">
                {r.error ? (
                  <span className="tag error">error</span>
                ) : (
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => toggleAllInGroup(r.account_id, r.region, filtered.map((lg) => lg.name), e.target.checked)}
                  />
                )}
                <span>
                  {r.account_name} ({r.account_id}) · {r.region}
                </span>
                {!r.error && <span className="muted">{filtered.length} log group(s)</span>}
              </div>
              {r.error && <div className="error-text" style={{ marginLeft: 20 }}>{r.error}</div>}
              {filtered.map((lg) => (
                <label key={lg.name} className="checkbox-item" style={{ marginLeft: 20 }}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(lg.name)}
                    onChange={() => toggleGroup(r.account_id, r.region, lg.name)}
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
