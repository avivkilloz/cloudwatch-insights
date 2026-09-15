import { useEffect, useState } from "react";
import { api, Account, Settings } from "../api";
import { AWS_REGIONS } from "../regions";

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettingsState] = useState<Settings>({ default_role_name: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newAccountId, setNewAccountId] = useState("");
  const [newName, setNewName] = useState("");
  const [newRegions, setNewRegions] = useState<string[]>([]);
  const [newRoleOverride, setNewRoleOverride] = useState("");

  const [roleDraft, setRoleDraft] = useState("");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [accts, s] = await Promise.all([api.listAccounts(), api.getSettings()]);
      setAccounts(accts);
      setSettingsState(s);
      setRoleDraft(s.default_role_name ?? "");
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

  async function addAccount() {
    if (!newAccountId.trim() || !newName.trim()) return;
    await api.createAccount({
      account_id: newAccountId.trim(),
      name: newName.trim(),
      regions: newRegions,
      role_name: newRoleOverride.trim() || null,
    });
    setNewAccountId("");
    setNewName("");
    setNewRegions([]);
    setNewRoleOverride("");
    refresh();
  }

  async function removeAccount(id: number) {
    if (!confirm("Remove this account from the list?")) return;
    await api.deleteAccount(id);
    refresh();
  }

  function toggleNewRegion(region: string) {
    setNewRegions((prev) => (prev.includes(region) ? prev.filter((r) => r !== region) : [...prev, region]));
  }

  return (
    <div>
      <div className="panel">
        <h2>Global role name</h2>
        <p className="muted">
          This is the IAM role name the app will attempt to assume in every configured account (via{" "}
          <code>arn:aws:iam::&lt;account_id&gt;:role/&lt;role_name&gt;</code>), unless an account below overrides it.
          The server's own AWS identity must be trusted by that role in each target account.
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
        <h2>Add account</h2>
        <div className="row" style={{ marginBottom: 10 }}>
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
            <span className="field-label">Friendly name</span>
            <input
              type="text"
              placeholder="Production"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ width: 200 }}
            />
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
        <span className="field-label">Default regions for this account</span>
        <div className="row">
          {AWS_REGIONS.map((r) => (
            <label key={r} className="checkbox-item" style={{ padding: "2px 8px" }}>
              <input type="checkbox" checked={newRegions.includes(r)} onChange={() => toggleNewRegion(r)} />
              {r}
            </label>
          ))}
        </div>
        <div style={{ marginTop: 10 }}>
          <button onClick={addAccount} disabled={!newAccountId.trim() || !newName.trim()}>
            Add account
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Configured accounts</h2>
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error-text">{error}</p>}
        {!loading && accounts.length === 0 && <p className="muted">No accounts configured yet.</p>}
        {accounts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Account ID</th>
                <th>Name</th>
                <th>Regions</th>
                <th>Role override</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.account_id}</td>
                  <td>{a.name}</td>
                  <td>{a.regions.join(", ") || <span className="muted">none set</span>}</td>
                  <td>{a.role_name || <span className="muted">(global default)</span>}</td>
                  <td>
                    <button className="danger" onClick={() => removeAccount(a.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
