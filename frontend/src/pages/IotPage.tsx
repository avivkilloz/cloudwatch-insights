import { useEffect, useState } from "react";
import { api, Environment, IotSavedSearch, IotSearchResultItem } from "../api";
import EnvironmentSelector from "../components/EnvironmentSelector";
import IotResultsList from "../components/IotResultsList";

const DEFAULT_QUERY = "thingName:*";
const DEFAULT_MAX_RESULTS = 50;
const MAX_MAX_RESULTS = 500;

const QUERY_EXAMPLES = [
  "thingName:my-thing-*",
  "connectivity.connected:true",
  "attributes.stage:prod AND thingTypeName:sensor",
  "shadow.reported.firmwareVersion:1.2.*",
  "thingGroupNames:my-group",
];

export default function IotPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<Set<number>>(new Set());

  const [queryString, setQueryString] = useState(DEFAULT_QUERY);
  const [maxResults, setMaxResults] = useState(DEFAULT_MAX_RESULTS);
  const [showExamples, setShowExamples] = useState(false);

  const [savedSearches, setSavedSearches] = useState<IotSavedSearch[]>([]);

  const [results, setResults] = useState<IotSearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    api.listIotSavedSearches().then(setSavedSearches);
  }, []);

  function toggleEnvironment(id: number) {
    setSelectedEnvironmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runSearch() {
    setSearchError(null);
    if (selectedEnvironmentIds.size === 0) {
      setSearchError("Select at least one environment to search.");
      return;
    }
    if (!queryString.trim()) {
      setSearchError("Enter a search query (e.g. thingName:*).");
      return;
    }
    const clampedMax = Math.min(Math.max(Math.floor(maxResults) || DEFAULT_MAX_RESULTS, 1), MAX_MAX_RESULTS);

    setIsSearching(true);
    try {
      const resp = await api.searchIotThings({
        environment_ids: Array.from(selectedEnvironmentIds),
        query_string: queryString,
        max_results: clampedMax,
      });
      setResults(resp.results);
    } catch (e: any) {
      setSearchError(e.message);
    } finally {
      setIsSearching(false);
    }
  }

  async function saveCurrentSearch() {
    const name = prompt("Save search as:");
    if (!name) return;
    const saved = await api.createIotSavedSearch({ name, query_string: queryString });
    setSavedSearches((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function deleteSaved(id: number) {
    await api.deleteIotSavedSearch(id);
    setSavedSearches((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div>
      <div className="panel">
        <h2>1. Choose environments</h2>
        <EnvironmentSelector
          environments={environments}
          selectedIds={selectedEnvironmentIds}
          onToggle={toggleEnvironment}
        />
      </div>

      <div className="panel">
        <h2>2. Search</h2>
        <p className="muted">
          Uses AWS IoT Fleet Indexing — the same "Advanced search" syntax as the AWS console. Search by thing name,
          attributes, connectivity, shadow values, group membership, and more. Requires thing indexing to be enabled
          for the account/region.
        </p>
        <div className="toolbar">
          <label className="row" style={{ gap: 6 }}>
            <span className="muted">Max results</span>
            <input
              type="number"
              min={1}
              max={MAX_MAX_RESULTS}
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
              style={{ width: 90 }}
              title="Max things returned per environment"
            />
          </label>
          <select
            onChange={(e) => {
              const s = savedSearches.find((x) => String(x.id) === e.target.value);
              if (s) setQueryString(s.query_string);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved search…
            </option>
            {savedSearches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentSearch}>
            Save search
          </button>
          <button className="secondary" onClick={() => setShowExamples((v) => !v)}>
            {showExamples ? "Hide examples" : "Show examples"}
          </button>
        </div>
        {savedSearches.length > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            {savedSearches.map((s) => (
              <span key={s.id} className="tag">
                {s.name}{" "}
                <button
                  className="danger"
                  style={{ padding: "0 6px", marginLeft: 4, fontSize: 10 }}
                  onClick={() => deleteSaved(s.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {showExamples && (
          <div className="checkbox-list" style={{ marginBottom: 10, maxHeight: 140 }}>
            {QUERY_EXAMPLES.map((ex) => (
              <div key={ex} className="row" style={{ justifyContent: "space-between" }}>
                <code style={{ fontSize: 12.5 }}>{ex}</code>
                <button className="secondary" style={{ padding: "2px 8px" }} onClick={() => setQueryString(ex)}>
                  Use
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          type="text"
          value={queryString}
          onChange={(e) => setQueryString(e.target.value)}
          style={{ width: "100%" }}
          placeholder="thingName:*"
        />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button onClick={runSearch} disabled={isSearching}>
            {isSearching ? "Searching…" : "Search"}
          </button>
          {searchError && <span className="error-text">{searchError}</span>}
        </div>
      </div>

      <div className="panel">
        <h2>3. Results</h2>
        <IotResultsList items={results} />
      </div>
    </div>
  );
}
