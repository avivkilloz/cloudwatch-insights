import { useEffect, useState } from "react";
import { api, CognitoUserInfo, CognitoUserPoolInfo, Environment } from "../api";

function formatTimestamp(epochSeconds: number | null): string {
  if (epochSeconds == null) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function statusTagClass(status: string | null): string {
  if (status === "CONFIRMED") return "tag ok";
  if (status === "UNCONFIRMED" || status === "RESET_REQUIRED" || status === "FORCE_CHANGE_PASSWORD") return "tag pending";
  return "tag";
}

export default function CognitoPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<number | "">("");

  const [userPools, setUserPools] = useState<CognitoUserPoolInfo[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const [poolsError, setPoolsError] = useState<string | null>(null);

  const [userPoolId, setUserPoolId] = useState("");
  const [queryString, setQueryString] = useState("");

  const [users, setUsers] = useState<CognitoUserInfo[]>([]);
  const [paginationToken, setPaginationToken] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
  }, []);

  async function loadUserPools() {
    if (environmentId === "") return;
    setPoolsLoading(true);
    setPoolsError(null);
    setUserPools([]);
    setUserPoolId("");
    setUsers([]);
    try {
      const resp = await api.listUserPools(environmentId);
      setUserPools(resp.user_pools);
    } catch (e: any) {
      setPoolsError(e.message);
    } finally {
      setPoolsLoading(false);
    }
  }

  function selectPool(id: string) {
    setUserPoolId(id);
    setUsers([]);
    setPaginationToken(null);
    setSearchError(null);
  }

  async function runSearch(loadMore: boolean) {
    if (environmentId === "" || !userPoolId) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const resp = await api.searchCognitoUsers({
        environment_id: environmentId,
        user_pool_id: userPoolId,
        query_string: queryString,
        pagination_token: loadMore ? paginationToken : null,
      });
      setUsers((prev) => (loadMore ? [...prev, ...resp.users] : resp.users));
      setPaginationToken(resp.pagination_token);
      if (!loadMore) setExpanded(new Set());
    } catch (e: any) {
      setSearchError(e.message);
    } finally {
      setIsSearching(false);
    }
  }

  function toggleExpanded(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <div>
      <div className="panel">
        <h2>1. Choose environment and user pool</h2>
        <p className="muted">
          Cognito user pools belong to a single account/region, so pick one environment at a time.
        </p>
        <div className="toolbar">
          <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Choose environment…</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.account_id} · {e.region})
              </option>
            ))}
          </select>
          <button className="secondary" onClick={loadUserPools} disabled={environmentId === "" || poolsLoading}>
            {poolsLoading ? "Loading user pools…" : "Load user pools"}
          </button>
          {userPools.length > 0 && (
            <select value={userPoolId} onChange={(e) => selectPool(e.target.value)}>
              <option value="" disabled>
                Choose user pool…
              </option>
              {userPools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? p.id} ({p.id})
                </option>
              ))}
            </select>
          )}
        </div>
        {poolsError && <p className="error-text">{poolsError}</p>}
      </div>

      {userPoolId && (
        <div className="panel">
          <h2>2. Search users</h2>
          <p className="muted">
            One <code>attribute:value</code> token, matched as a starts-with search (e.g. <code>email:john</code> or{" "}
            <code>username:jdoe</code>). Cognito only supports filtering by a single attribute at a time; leave blank
            to list all users.
          </p>
          <div className="toolbar">
            <input
              type="text"
              value={queryString}
              onChange={(e) => setQueryString(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch(false)}
              placeholder="email:john"
              style={{ width: 280 }}
            />
            <button onClick={() => runSearch(false)} disabled={isSearching}>
              {isSearching ? "Searching…" : "Search"}
            </button>
            {searchError && <span className="error-text">{searchError}</span>}
          </div>

          {users.length === 0 && !isSearching && <p className="muted">No users loaded yet — click Search.</p>}
          {users.map((u, i) => {
            const isOpen = expanded.has(i);
            return (
              <div className="result-row" key={`${u.username}-${i}`}>
                <div className="result-row-summary" onClick={() => toggleExpanded(i)}>
                  <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
                  <span className={statusTagClass(u.status)}>{u.status ?? "unknown"}</span>
                  {u.enabled === false && <span className="tag error">disabled</span>}
                  <span className="msg">{u.username}</span>
                  {u.attributes.email && <span className="muted">{u.attributes.email}</span>}
                </div>
                {isOpen && (
                  <div className="result-row-detail">
                    <table style={{ marginBottom: 10 }}>
                      <tbody>
                        <tr>
                          <td>Created</td>
                          <td>{formatTimestamp(u.created)}</td>
                        </tr>
                        <tr>
                          <td>Last modified</td>
                          <td>{formatTimestamp(u.last_modified)}</td>
                        </tr>
                      </tbody>
                    </table>
                    <h3>Attributes</h3>
                    {Object.keys(u.attributes).length === 0 ? (
                      <p className="muted">No attributes.</p>
                    ) : (
                      <table>
                        <tbody>
                          {Object.entries(u.attributes).map(([k, v]) => (
                            <tr key={k}>
                              <td>{k}</td>
                              <td>{v ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {paginationToken && (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="secondary" onClick={() => runSearch(true)} disabled={isSearching}>
                {isSearching ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
