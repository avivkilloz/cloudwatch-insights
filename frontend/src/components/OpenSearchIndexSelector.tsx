import { useState } from "react";
import { api, Environment, OpenSearchDomainsResultItem, OpenSearchIndexInfo } from "../api";

/** One selected domain's chosen indices, keyed by environment_id -> domain_name.
 * `domain_endpoint` rides along so a search request can be built later without
 * re-resolving it from the domain name. */
export type OpenSearchSelectionMap = Record<number, Record<string, { domain_endpoint: string; indices: Set<string> }>>;

interface Props {
  environments: Environment[];
  selection: OpenSearchSelectionMap;
  onSelectionChange: (next: OpenSearchSelectionMap) => void;
}

export default function OpenSearchIndexSelector({ environments, selection, onSelectionChange }: Props) {
  const [domainResults, setDomainResults] = useState<OpenSearchDomainsResultItem[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Per-domain index listing state, keyed by "environmentId::domainName".
  const [indices, setIndices] = useState<Record<string, OpenSearchIndexInfo[]>>({});
  const [loadingIndices, setLoadingIndices] = useState<Set<string>>(new Set());
  const [indicesError, setIndicesError] = useState<Record<string, string>>({});

  async function loadDomains() {
    if (environments.length === 0) return;
    setLoadingDomains(true);
    setDomainsError(null);
    try {
      const resp = await api.getOpenSearchDomains(environments.map((e) => e.id));
      setDomainResults(resp.results);
    } catch (e: any) {
      setDomainsError(e.message);
    } finally {
      setLoadingDomains(false);
    }
  }

  async function loadIndices(environmentId: number, domainName: string, domainEndpoint: string) {
    const key = `${environmentId}::${domainName}`;
    setLoadingIndices((prev) => new Set(prev).add(key));
    setIndicesError((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const resp = await api.getOpenSearchIndices({ environment_id: environmentId, domain_endpoint: domainEndpoint });
      setIndices((prev) => ({ ...prev, [key]: resp.indices }));
    } catch (e: any) {
      setIndicesError((prev) => ({ ...prev, [key]: e.message }));
    } finally {
      setLoadingIndices((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function toggleIndex(environmentId: number, domainName: string, domainEndpoint: string, indexName: string) {
    const next: OpenSearchSelectionMap = { ...selection, [environmentId]: { ...selection[environmentId] } };
    const current = new Set(next[environmentId][domainName]?.indices ?? []);
    if (current.has(indexName)) current.delete(indexName);
    else current.add(indexName);
    next[environmentId][domainName] = { domain_endpoint: domainEndpoint, indices: current };
    onSelectionChange(next);
  }

  function toggleAllInDomain(environmentId: number, domainName: string, domainEndpoint: string, names: string[], checked: boolean) {
    const next: OpenSearchSelectionMap = { ...selection, [environmentId]: { ...selection[environmentId] } };
    next[environmentId][domainName] = { domain_endpoint: domainEndpoint, indices: new Set(checked ? names : []) };
    onSelectionChange(next);
  }

  const totalSelected = Object.values(selection).reduce(
    (sum, domains) => sum + Object.values(domains).reduce((s, d) => s + d.indices.size, 0),
    0
  );

  return (
    <div>
      <div className="toolbar">
        <button onClick={loadDomains} disabled={environments.length === 0 || loadingDomains}>
          {loadingDomains ? "Loading domains…" : "Load OpenSearch domains"}
        </button>
        <input
          type="text"
          placeholder="Filter indices…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 220 }}
        />
        <span className="muted">{totalSelected} index/indices selected</span>
      </div>
      {domainsError && <p className="error-text">{domainsError}</p>}
      {domainResults.length === 0 && !loadingDomains && (
        <p className="muted">Select environments above, then load OpenSearch domains.</p>
      )}
      <div className="checkbox-list">
        {domainResults.map((r) => (
          <div key={r.environment_id}>
            <div className="group-heading">
              {r.error ? <span className="tag error">error</span> : <span className="tag">{r.domains.length} domain(s)</span>}
              <span>
                {r.environment_name} ({r.account_id} · {r.region})
              </span>
            </div>
            {r.error && <div className="error-text" style={{ marginLeft: 20 }}>{r.error}</div>}
            {r.domains.map((d) => {
              if (!d.endpoint) {
                return (
                  <div key={d.domain_name} style={{ marginLeft: 20 }} className="muted">
                    {d.domain_name} — no reachable endpoint reported for this domain
                  </div>
                );
              }
              const key = `${r.environment_id}::${d.domain_name}`;
              const domainIndices = indices[key];
              const filtered = (domainIndices ?? []).filter((i) => i.index.toLowerCase().includes(filter.toLowerCase()));
              const selectedSet = selection[r.environment_id]?.[d.domain_name]?.indices ?? new Set<string>();
              const allChecked = filtered.length > 0 && filtered.every((i) => selectedSet.has(i.index));
              return (
                <div key={d.domain_name} style={{ marginLeft: 20, marginBottom: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    {domainIndices && !indicesError[key] && (
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={(e) => toggleAllInDomain(r.environment_id, d.domain_name, d.endpoint!, filtered.map((i) => i.index), e.target.checked)}
                      />
                    )}
                    <strong>{d.domain_name}</strong>
                    {d.engine_version && <span className="muted">{d.engine_version}</span>}
                    <button
                      className="secondary"
                      onClick={() => loadIndices(r.environment_id, d.domain_name, d.endpoint!)}
                      disabled={loadingIndices.has(key)}
                    >
                      {loadingIndices.has(key) ? "Loading indices…" : domainIndices ? "Reload indices" : "Load indices"}
                    </button>
                    {domainIndices && <span className="muted">{filtered.length} index/indices</span>}
                  </div>
                  {indicesError[key] && <div className="error-text" style={{ marginLeft: 20 }}>{indicesError[key]}</div>}
                  {filtered.map((i) => (
                    <label key={i.index} className="checkbox-item" style={{ marginLeft: 20 }}>
                      <input
                        type="checkbox"
                        checked={selectedSet.has(i.index)}
                        onChange={() => toggleIndex(r.environment_id, d.domain_name, d.endpoint!, i.index)}
                      />
                      {i.index}
                      {i.docs_count != null && <span className="muted"> ({i.docs_count} docs)</span>}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
