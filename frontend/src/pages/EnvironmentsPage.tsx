import { useEffect, useState } from "react";
import { api, Environment, IotSavedSearch, IotSearchMode, SavedQuery, SavedSession, Settings } from "../api";
import { AWS_REGIONS } from "../regions";
import SavedItemsPanel from "../components/SavedItemsPanel";
import SavedSessionsPanel from "../components/SavedSessionsPanel";

interface Props {
  /** Notified whenever settings change here, so App.tsx (title, tab
   * visibility) stays in sync without re-fetching. */
  onSettingsChange?: (settings: Settings) => void;
}

const EMPTY_SETTINGS: Settings = {
  default_role_name: null,
  app_title: null,
  app_logo_url: null,
  logs_enabled: true,
  iot_enabled: true,
};

// Logos are stored inline as a data: URL in the settings table, which is
// fetched on every page load -- keep uploads small so that stays cheap.
const MAX_LOGO_BYTES = 300 * 1024;

export default function EnvironmentsPage({ onSettingsChange }: Props) {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [settings, setSettingsState] = useState<Settings>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [iotSavedSearches, setIotSavedSearches] = useState<IotSavedSearch[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);

  const [newName, setNewName] = useState("");
  const [newAccountId, setNewAccountId] = useState("");
  const [newRegion, setNewRegion] = useState(AWS_REGIONS[0]);
  const [newRoleOverride, setNewRoleOverride] = useState("");

  const [roleDraft, setRoleDraft] = useState("");
  const [appTitleDraft, setAppTitleDraft] = useState("");
  const [logoDraft, setLogoDraft] = useState("");
  const [logoError, setLogoError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [envs, s, queries, searches, sessions] = await Promise.all([
        api.listEnvironments(),
        api.getSettings(),
        api.listSavedQueries(),
        api.listIotSavedSearches(),
        api.listSavedSessions(),
      ]);
      setEnvironments(envs);
      setSettingsState(s);
      setRoleDraft(s.default_role_name ?? "");
      setAppTitleDraft(s.app_title ?? "");
      setLogoDraft(s.app_logo_url ?? "");
      setSavedQueries(queries);
      setIotSavedSearches(searches);
      setSavedSessions(sessions);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function applySettings(updated: Settings) {
    setSettingsState(updated);
    onSettingsChange?.(updated);
  }

  async function saveRoleName() {
    applySettings(await api.updateSettings({ default_role_name: roleDraft || null }));
  }

  async function saveAppTitle() {
    applySettings(await api.updateSettings({ app_title: appTitleDraft.trim() || null }));
  }

  function handleLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file again later
    if (!file) return;
    setLogoError(null);
    if (!file.type.startsWith("image/")) {
      setLogoError("Please choose an image file.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`Image is too large (max ${Math.round(MAX_LOGO_BYTES / 1024)} KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoDraft(String(reader.result));
    reader.onerror = () => setLogoError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  async function saveLogo() {
    applySettings(await api.updateSettings({ app_logo_url: logoDraft || null }));
  }

  async function removeLogo() {
    setLogoDraft("");
    setLogoError(null);
    applySettings(await api.updateSettings({ app_logo_url: null }));
  }

  async function toggleTab(key: "logs_enabled" | "iot_enabled", value: boolean) {
    applySettings(await api.updateSettings({ [key]: value }));
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

  async function renameSavedSession(id: number, name: string) {
    const updated = await api.updateSavedSession(id, { name });
    setSavedSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }

  async function deleteSavedSession(id: number) {
    await api.deleteSavedSession(id);
    setSavedSessions((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div>
      <div className="panel">
        <h2>App settings</h2>
        <div className="row" style={{ marginBottom: 14, alignItems: "flex-start" }}>
          <div>
            <span className="field-label">App title</span>
            <input
              type="text"
              placeholder="Cloud Insights"
              value={appTitleDraft}
              onChange={(e) => setAppTitleDraft(e.target.value)}
              style={{ width: 260 }}
            />
          </div>
          <button onClick={saveAppTitle} style={{ marginTop: 18 }}>
            Save
          </button>
        </div>

        <div className="row" style={{ marginBottom: 14, alignItems: "flex-start" }}>
          <div>
            <span className="field-label">Logo (shown before the title, top bar)</span>
            <div className="row" style={{ gap: 10 }}>
              {logoDraft && (
                <img
                  src={logoDraft}
                  alt=""
                  style={{
                    height: 32,
                    width: 32,
                    objectFit: "contain",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                  }}
                />
              )}
              <input type="file" accept="image/*" onChange={handleLogoFile} />
            </div>
            {logoError && (
              <p className="error-text" style={{ marginTop: 4 }}>
                {logoError}
              </p>
            )}
          </div>
          <button onClick={saveLogo} style={{ marginTop: 18 }}>
            Save
          </button>
          {settings.app_logo_url && (
            <button className="danger" onClick={removeLogo} style={{ marginTop: 18 }}>
              Remove
            </button>
          )}
        </div>

        <span className="field-label">Visible tabs</span>
        <div className="row">
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={settings.logs_enabled}
              onChange={(e) => toggleTab("logs_enabled", e.target.checked)}
            />
            Logs
          </label>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={settings.iot_enabled}
              onChange={(e) => toggleTab("iot_enabled", e.target.checked)}
            />
            IoT
          </label>
        </div>
      </div>

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

      <SavedSessionsPanel items={savedSessions} onRename={renameSavedSession} onDelete={deleteSavedSession} />
    </div>
  );
}
