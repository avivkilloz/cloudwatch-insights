import { useEffect, useState } from "react";
import { api, Environment, IotSavedSearch, IotSearchMode, SavedQuery, Settings } from "../api";
import { AWS_REGIONS } from "../regions";
import SavedItemsPanel from "../components/SavedItemsPanel";

export default function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [settings, setSettingsState] = useState<Settings>({ default_role_name: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [iotSavedSearches, setIotSavedSearches] = useState<IotSavedSearch[]>([]);

  const [newName, setNewName] = useState("");
  const [newAccountId, setNewAccountId] = useState("");
  const [newRegion, setNewRegion] = useState(AWS_REGIONS[0]);
  const [newRoleOverride, setNewRoleOverride] = useState("");

  const [roleDraft, setRoleDraft] = useState("");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [envs, s, queries, searches] = await Promise.all([
        api.listEnvironments(),
        api.getSettings(),
        api.listSavedQueries(),
        api.listIotSavedSearches(),
      ]);
      setEnvironments(envs);
      setSettingsState(s);
      setRoleDraft(s.default_role_name ?? "");
      setSavedQueries(queries);
      setIotSavedSearches(searches);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function saveRoleName() {
    const updated = await api.updateSettings({ default_role_name: roleDraft || null });
    setSettingsState(updated);
  }

  async function addEnvironment() {
    if (!newName.trim() || !newAccountId.trim()) return;
    await api.createEnvironment({
      name: newName.trim(),
      account_id: newAccountId.trim(),
      region: newRegion,
      role_name: newRoleOverride.trim() || null,
    });
    setNewName("");
    setNewAccountId("");
    setNewRegion(AWS_REGIONS[0]);
    setNewRoleOverride("");
    refresh();
  }

  async function removeEnvironment(id: number) {
    if (!confirm("Remove this environment from the list?")) return;
    await api.deleteEnvironment(id);
    refresh();
  }

  async function createSavedQuery(payload: { name: string; query_string: string }) {
    const saved = await api.createSavedQuery(payload);
    setSavedQueries((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function updateSavedQueryItem(id: number, payload: { name: string; query_string: string }) {
    const updated = await api.updateSavedQuery(id, payload);
    setSavedQueries((prev) => prev.map((q) => (q.id === id ? updated : q)));
  }

  async function deleteSavedQueryItem(id: number) {
    await api.deleteSavedQuery(id);
    setSavedQueries((prev) => prev.filter((q) => q.id !== id));
  }

  async function createIotSavedSearchItem(payload: { name: string; query_string: string; search_mode?: string }) {
    const saved = await api.createIotSavedSearch({
      name: payload.name,
      query_string: payload.query_string,
      search_mode: (payload.search_mode as IotSearchMode) || "things",
    });
    setIotSavedSearches((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function updateIotSavedSearchItem(id: number, payload: { name: string; query_string: string; search_mode?: string }) {
    const updated = await api.updateIotSavedSearch(id, {
      name: payload.name,
      query_string: payload.query_string,
      search_mode: payload.search_mode as IotSearchMode | undefined,
    });
    setIotSavedSearches((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }

  async function deleteIotSavedSearchItem(id: number) {
    await api.deleteIotSavedSearch(id);
    setIotSavedSearches((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div>
      <div className="panel">
        <h2>Global role name</h2>
        <p className="muted">
          This is the IAM role name the app will attempt to assume in every configured environment (via{" "}
          <code>arn:aws:iam::&lt;account_id&gt;:role/&lt;role_name&gt;</code>), unless an environment below overrides
          it. The server's own AWS identity must be trusted by that role in each target account.
        </p>
        <div className="row">
          <input
            type="text"
            placeholder="e.g. CloudWatchInsightsReadOnlyRole"
            value={roleDraft}
            onChange={(e) => setRoleDraft(e.target.value)}
            style={{ width: 320 }}
          />
          <button onClick={saveRoleName}>Save</button>
          {settings.default_role_name && <span className="tag ok">current: {settings.default_role_name}</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Add environment</h2>
        <p className="muted">
          An environment is one AWS account paired with one region — the unit you'll pick from on the Logs page.
        </p>
        <div className="row" style={{ marginBottom: 10 }}>
          <div>
            <span className="field-label">Name</span>
            <input
              type="text"
              placeholder="Production us-east-1"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ width: 200 }}
            />
          </div>
          <div>
            <span className="field-label">AWS Account ID</span>
            <input
              type="text"
              placeholder="111122223333"
              value={newAccountId}
              onChange={(e) => setNewAccountId(e.target.value)}
              style={{ width: 160 }}
            />
          </div>
          <div>
            <span className="field-label">Region</span>
            <select value={newRegion} onChange={(e) => setNewRegion(e.target.value)}>
              {AWS_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="field-label">Role override (optional)</span>
            <input
              type="text"
              placeholder="uses global role name if blank"
              value={newRoleOverride}
              onChange={(e) => setNewRoleOverride(e.target.value)}
              style={{ width: 240 }}
            />
          </div>
        </div>
        <button onClick={addEnvironment} disabled={!newName.trim() || !newAccountId.trim()}>
          Add environment
        </button>
      </div>

      <div className="panel">
        <h2>Configured environments</h2>
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error-text">{error}</p>}
        {!loading && environments.length === 0 && <p className="muted">No environments configured yet.</p>}
        {environments.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Account ID</th>
                <th>Region</th>
                <th>Role override</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {environments.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.account_id}</td>
                  <td>{e.region}</td>
                  <td>{e.role_name || <span className="muted">(global default)</span>}</td>
                  <td>
                    <button className="danger" onClick={() => removeEnvironment(e.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <SavedItemsPanel
        title="Saved Insights queries"
        description="Manage the Logs Insights queries available from the Logs page's &quot;Load saved query&quot; dropdown."
        queryLabel="Query"
        items={savedQueries}
        onCreate={createSavedQuery}
        onUpdate={updateSavedQueryItem}
        onDelete={deleteSavedQueryItem}
      />

      <SavedItemsPanel
        title="Saved IoT searches"
        description="Manage the IoT searches available from the IoT page's &quot;Load saved search&quot; dropdown."
        queryLabel="Search query"
        items={iotSavedSearches}
        onCreate={createIotSavedSearchItem}
        onUpdate={updateIotSavedSearchItem}
        onDelete={deleteIotSavedSearchItem}
        extra={{
          key: "search_mode",
          label: "Search mode",
          options: [
            { value: "things", label: "Things" },
            { value: "certificates", label: "Certificates" },
          ],
          defaultValue: "things",
          getValue: (item) => item.search_mode,
        }}
      />
    </div>
  );
}
