import { useEffect, useState } from "react";
import {
  api,
  Environment,
  IotCertificateSearchResultItem,
  IotSavedSearch,
  IotSearchMode,
  IotSearchResultItem,
  SavedSession,
} from "../api";
import EnvironmentSelector from "../components/EnvironmentSelector";
import IotResultsList from "../components/IotResultsList";
import IotCertResultsList from "../components/IotCertResultsList";

const SESSION_PAGE = "iot";

interface IotSessionState {
  environment_ids: number[];
  search_mode: IotSearchMode;
  query_string: string;
  max_results: number;
}

const DEFAULT_QUERY: Record<IotSearchMode, string> = {
  things: "thingName:*",
  certificates: "status:ACTIVE",
};
const DEFAULT_MAX_RESULTS = 50;
const MAX_MAX_RESULTS = 500;

const QUERY_EXAMPLES: Record<IotSearchMode, string[]> = {
  things: [
    "thingName:my-thing-*",
    "connectivity.connected:true",
    "attributes.stage:prod AND thingTypeName:sensor",
    "shadow.reported.firmwareVersion:1.2.*",
    "thingGroupNames:my-group",
  ],
  certificates: ["status:ACTIVE", "status:INACTIVE", "certid:abcdef1234", "my-cert-prefix"],
};

export default function IotPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<Set<number>>(new Set());

  const [searchMode, setSearchMode] = useState<IotSearchMode>("things");
  const [queryString, setQueryString] = useState(DEFAULT_QUERY.things);
  const [maxResults, setMaxResults] = useState(DEFAULT_MAX_RESULTS);
  const [showExamples, setShowExamples] = useState(false);

  const [savedSearches, setSavedSearches] = useState<IotSavedSearch[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSession<IotSessionState>[]>([]);

  const [thingResults, setThingResults] = useState<IotSearchResultItem[]>([]);
  const [certResults, setCertResults] = useState<IotCertificateSearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    api.listIotSavedSearches().then(setSavedSearches);
    api.listSavedSessions<IotSessionState>(SESSION_PAGE).then(setSavedSessions);
  }, []);

  function toggleEnvironment(id: number) {
    setSelectedEnvironmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function switchMode(mode: IotSearchMode) {
    if (mode === searchMode) return;
    setSearchMode(mode);
    setQueryString(DEFAULT_QUERY[mode]);
    setThingResults([]);
    setCertResults([]);
    setSearchError(null);
  }

  async function runSearch() {
    setSearchError(null);
    if (selectedEnvironmentIds.size === 0) {
      setSearchError("Select at least one environment to search.");
      return;
    }
    if (!queryString.trim()) {
      setSearchError(`Enter a search query (e.g. ${DEFAULT_QUERY[searchMode]}).`);
      return;
    }
    const clampedMax = Math.min(Math.max(Math.floor(maxResults) || DEFAULT_MAX_RESULTS, 1), MAX_MAX_RESULTS);

    setIsSearching(true);
    try {
      if (searchMode === "things") {
        const resp = await api.searchIotThings({
          environment_ids: Array.from(selectedEnvironmentIds),
          query_string: queryString,
          max_results: clampedMax,
        });
        setThingResults(resp.results);
      } else {
        const resp = await api.searchIotCertificates({
          environment_ids: Array.from(selectedEnvironmentIds),
          query_string: queryString,
          max_results: clampedMax,
        });
        setCertResults(resp.results);
      }
    } catch (e: any) {
      setSearchError(e.message);
    } finally {
      setIsSearching(false);
    }
  }

  async function saveCurrentSearch() {
    const name = prompt("Save search as:");
    if (!name) return;
    const saved = await api.createIotSavedSearch({ name, query_string: queryString, search_mode: searchMode });
    setSavedSearches((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function captureSession(): IotSessionState {
    return {
      environment_ids: Array.from(selectedEnvironmentIds),
      search_mode: searchMode,
      query_string: queryString,
      max_results: maxResults,
    };
  }

  function applySession(state: IotSessionState) {
    setSelectedEnvironmentIds(new Set(state.environment_ids));
    setSearchMode(state.search_mode);
    setQueryString(state.query_string);
    setMaxResults(state.max_results);
  }

  async function saveCurrentSession() {
    const name = prompt("Save session as:");
    if (!name) return;
    const saved = await api.createSavedSession<IotSessionState>({
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
          Unlike a saved search (just the query text), a saved session also captures the selected environments,
          search mode, and max results, so you can resume an investigation later exactly where you left it.
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
        <h2>2. Search</h2>
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <span className="field-label" style={{ marginRight: 4 }}>
            Search for
          </span>
          <button
            className={searchMode === "things" ? "" : "secondary"}
            onClick={() => switchMode("things")}
          >
            Things
          </button>
          <button
            className={searchMode === "certificates" ? "" : "secondary"}
            onClick={() => switchMode("certificates")}
          >
            Certificates
          </button>
        </div>
        <p className="muted">
          {searchMode === "things" ? (
            <>
              Uses AWS IoT Fleet Indexing — the same "Advanced search" syntax as the AWS console. Search by thing
              name, attributes, connectivity, shadow values, group membership, and more. Requires thing indexing to
              be enabled for the account/region.
            </>
          ) : (
            <>
              Fleet Indexing does not cover certificates, so this searches directly against{" "}
              <code>list_certificates</code>/<code>describe_certificate</code>. Use <code>status:ACTIVE</code> or{" "}
              <code>status:INACTIVE</code> to filter by status, <code>certid:&lt;id&gt;</code> for an exact
              certificate ID lookup, or free text to match against certificate IDs.
            </>
          )}
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
              title={`Max ${searchMode} returned per environment`}
            />
          </label>
          <select
            onChange={(e) => {
              const s = savedSearches.find((x) => String(x.id) === e.target.value);
              if (s) {
                setSearchMode(s.search_mode);
                setQueryString(s.query_string);
              }
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved search…
            </option>
            {savedSearches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.search_mode})
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
        {showExamples && (
          <div className="checkbox-list" style={{ marginBottom: 10, maxHeight: 140 }}>
            {QUERY_EXAMPLES[searchMode].map((ex) => (
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
          placeholder={DEFAULT_QUERY[searchMode]}
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
        {searchMode === "things" ? (
          <IotResultsList items={thingResults} />
        ) : (
          <IotCertResultsList items={certResults} />
        )}
      </div>
    </div>
  );
}
