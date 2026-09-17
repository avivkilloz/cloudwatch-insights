import { useEffect, useRef, useState } from "react";
import { api, ApiError, Environment, Settings, User, UserGroup } from "../api";
import { AWS_REGIONS } from "../regions";
import { useAuth } from "../AuthContext";
import Avatar from "../components/Avatar";
import ThemeGrid from "../components/ThemeGrid";
import { ThemeId } from "../theme";
import SavedItemsPage from "./SavedItemsPage";

const EMPTY_SETTINGS: Settings = { app_title: null, app_logo_url: null };

const TAB_TOGGLES: {
  key: "logs_enabled" | "iot_enabled" | "tables_enabled" | "buckets_enabled" | "cognito_enabled" | "tools_enabled";
  label: string;
}[] = [
  { key: "logs_enabled", label: "Logs" },
  { key: "iot_enabled", label: "IoT" },
  { key: "tables_enabled", label: "Tables" },
  { key: "buckets_enabled", label: "Buckets" },
  { key: "cognito_enabled", label: "Cognito" },
  { key: "tools_enabled", label: "Tools" },
];

// Logos are stored inline as a data: URL in the settings table, which is
// fetched on every page load -- keep uploads small so that stays cheap.
const MAX_LOGO_BYTES = 300 * 1024;
// Avatars are self-service (any logged-in user can upload one, not just an
// admin) -- kept smaller than the app logo, and comfortably under the
// backend's MAX_AVATAR_URL_LENGTH once base64-encoded.
const MAX_AVATAR_BYTES = 200 * 1024;

type Section = "account" | "theme" | "saved" | "app" | "environments" | "groups" | "users";

const BASE_SECTIONS: { id: Section; label: string }[] = [
  { id: "account", label: "My account" },
  { id: "theme", label: "Theme" },
  { id: "saved", label: "Saved" },
];

const ADMIN_SECTIONS: { id: Section; label: string }[] = [
  { id: "app", label: "App settings" },
  { id: "environments", label: "Environments" },
  { id: "groups", label: "User groups" },
  { id: "users", label: "Users" },
];

type GroupDraft = {
  name: string;
  role_name: string;
  environment_ids: number[];
} & Record<(typeof TAB_TOGGLES)[number]["key"], boolean>;

function emptyGroupDraft(): GroupDraft {
  return {
    name: "",
    role_name: "",
    environment_ids: [],
    logs_enabled: true,
    iot_enabled: true,
    tables_enabled: true,
    buckets_enabled: true,
    cognito_enabled: true,
    tools_enabled: true,
  };
}

function groupToDraft(g: UserGroup): GroupDraft {
  return {
    name: g.name,
    role_name: g.role_name ?? "",
    environment_ids: g.environment_ids,
    logs_enabled: g.logs_enabled,
    iot_enabled: g.iot_enabled,
    tables_enabled: g.tables_enabled,
    buckets_enabled: g.buckets_enabled,
    cognito_enabled: g.cognito_enabled,
    tools_enabled: g.tools_enabled,
  };
}

interface Props {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  /** Lets the header (title, logo, favicon) update live as soon as an admin
   * saves app settings here, instead of only after a page reload. */
  onSettingsChange: (settings: Settings) => void;
}

export default function SettingsPage({ theme, onThemeChange, onSettingsChange }: Props) {
  const { user: currentUser, refresh: refreshAuth } = useAuth();
  const isAdmin = !!currentUser?.is_admin;
  const sections = isAdmin ? [...BASE_SECTIONS, ...ADMIN_SECTIONS] : BASE_SECTIONS;
  const [section, setSection] = useState<Section>("account");

  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [settings, setSettingsState] = useState<Settings>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(isAdmin);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [appTitleDraft, setAppTitleDraft] = useState("");
  const [logoDraft, setLogoDraft] = useState("");
  const [logoFileName, setLogoFileName] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoFileInputRef = useRef<HTMLInputElement>(null);

  const [newName, setNewName] = useState("");
  const [newAccountId, setNewAccountId] = useState("");
  const [newRegion, setNewRegion] = useState(AWS_REGIONS[0]);

  const [groupDraft, setGroupDraft] = useState<GroupDraft>(emptyGroupDraft());
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserGroupId, setNewUserGroupId] = useState<number | "">("");
  const [userGroupDrafts, setUserGroupDrafts] = useState<Record<number, number>>({});
  const [userPasswordDrafts, setUserPasswordDrafts] = useState<Record<number, string>>({});

  async function refresh() {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const [envs, s, g, u] = await Promise.all([
        api.listEnvironments(),
        api.getSettings(),
        api.listUserGroups(),
        api.listUsers(),
      ]);
      setEnvironments(envs);
      applySettings(s);
      setAppTitleDraft(s.app_title ?? "");
      setLogoDraft(s.app_logo_url ?? "");
      setGroups(g);
      setUsers(u);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function withActionError<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setActionError(null);
    try {
      return await fn();
    } catch (e: any) {
      setActionError(e.message ?? "Something went wrong.");
      return undefined;
    }
  }

  function applySettings(updated: Settings) {
    setSettingsState(updated);
    onSettingsChange(updated);
  }

  async function saveAppTitle() {
    await withActionError(async () => applySettings(await api.updateSettings({ app_title: appTitleDraft.trim() || null })));
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
    setLogoFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setLogoDraft(String(reader.result));
    reader.onerror = () => setLogoError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  async function saveLogo() {
    await withActionError(async () => applySettings(await api.updateSettings({ app_logo_url: logoDraft || null })));
  }

  async function removeLogo() {
    setLogoDraft("");
    setLogoFileName(null);
    setLogoError(null);
    await withActionError(async () => applySettings(await api.updateSettings({ app_logo_url: null })));
  }

  async function addEnvironment() {
    if (!newName.trim() || !newAccountId.trim()) return;
    await withActionError(async () => {
      await api.createEnvironment({ name: newName.trim(), account_id: newAccountId.trim(), region: newRegion });
      setNewName("");
      setNewAccountId("");
      setNewRegion(AWS_REGIONS[0]);
      await refresh();
    });
  }

  async function removeEnvironment(id: number) {
    if (!confirm("Remove this environment from the list?")) return;
    await withActionError(async () => {
      await api.deleteEnvironment(id);
      await refresh();
    });
  }

  function toggleGroupTab(key: (typeof TAB_TOGGLES)[number]["key"], value: boolean) {
    setGroupDraft((d) => ({ ...d, [key]: value }));
  }

  function toggleGroupEnvironment(id: number, checked: boolean) {
    setGroupDraft((d) => ({
      ...d,
      environment_ids: checked ? [...d.environment_ids, id] : d.environment_ids.filter((e) => e !== id),
    }));
  }

  function startEditGroup(g: UserGroup) {
    setEditingGroupId(g.id);
    setGroupDraft(groupToDraft(g));
    setActionError(null);
  }

  function cancelGroupEdit() {
    setEditingGroupId(null);
    setGroupDraft(emptyGroupDraft());
    setActionError(null);
  }

  async function saveGroup() {
    if (!groupDraft.name.trim()) return;
    const payload = { ...groupDraft, name: groupDraft.name.trim(), role_name: groupDraft.role_name.trim() || null };
    await withActionError(async () => {
      if (editingGroupId != null) {
        await api.updateUserGroup(editingGroupId, payload);
      } else {
        await api.createUserGroup(payload);
      }
      cancelGroupEdit();
      await refresh();
    });
  }

  async function deleteGroup(id: number) {
    if (!confirm("Delete this user group?")) return;
    await withActionError(async () => {
      await api.deleteUserGroup(id);
      if (editingGroupId === id) cancelGroupEdit();
      await refresh();
    });
  }

  async function addUser() {
    if (!newUsername.trim() || !newUserPassword || newUserGroupId === "") return;
    await withActionError(async () => {
      await api.createUser({ username: newUsername.trim(), password: newUserPassword, group_id: newUserGroupId });
      setNewUsername("");
      setNewUserPassword("");
      setNewUserGroupId("");
      await refresh();
    });
  }

  async function changeUserGroup(id: number) {
    const groupId = userGroupDrafts[id];
    if (!groupId) return;
    await withActionError(async () => {
      await api.updateUser(id, { group_id: groupId });
      await refresh();
    });
  }

  async function resetUserPassword(id: number) {
    const password = userPasswordDrafts[id];
    if (!password) return;
    await withActionError(async () => {
      await api.updateUser(id, { password });
      setUserPasswordDrafts((d) => ({ ...d, [id]: "" }));
    });
  }

  async function removeUser(id: number) {
    if (!confirm("Delete this user?")) return;
    await withActionError(async () => {
      await api.deleteUser(id);
      await refresh();
    });
  }

  return (
    <div>
      <div className="tabs" style={{ justifySelf: "start", marginBottom: 14, flexWrap: "wrap" }}>
        {sections.map((s) => (
          <button key={s.id} className={`tab ${section === s.id ? "active" : ""}`} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      {actionError && (
        <p className="error-text" style={{ marginBottom: 12 }}>
          {actionError}
        </p>
      )}

      {section === "account" && currentUser && <AccountSection user={currentUser} onProfileSaved={refreshAuth} />}

      {section === "theme" && (
        <div className="panel">
          <h2>Theme</h2>
          <p className="muted" style={{ marginBottom: 14 }}>
            Pick a theme -- each card previews the real colors it uses. Remembered per browser.
          </p>
          <ThemeGrid theme={theme} onChange={onThemeChange} />
        </div>
      )}

      {section === "saved" && <SavedItemsPage />}

      {isAdmin && loading && <p className="muted">Loading…</p>}
      {isAdmin && error && <p className="error-text">{error}</p>}

      {isAdmin && !loading && !error && section === "app" && (
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

          <div>
            <span className="field-label">Logo (shown before the title, top bar)</span>
            <div className="row" style={{ gap: 10, marginBottom: 8 }}>
              {logoDraft && (
                <img
                  src={logoDraft}
                  alt=""
                  style={{ height: 32, width: 32, objectFit: "contain", borderRadius: 4, border: "1px solid var(--border)" }}
                />
              )}
              <input ref={logoFileInputRef} type="file" accept="image/*" onChange={handleLogoFile} style={{ display: "none" }} />
              <button type="button" className="secondary" onClick={() => logoFileInputRef.current?.click()}>
                Choose file
              </button>
              <span className="muted">{logoFileName ?? "No file chosen"}</span>
            </div>
            {logoError && (
              <p className="error-text" style={{ marginTop: 4, marginBottom: 8 }}>
                {logoError}
              </p>
            )}
            <div className="row">
              <button onClick={saveLogo}>Save</button>
              {settings.app_logo_url && (
                <button className="danger" onClick={removeLogo}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {isAdmin && !loading && !error && section === "environments" && (
        <>
          <div className="panel">
            <h2>Add environment</h2>
            <p className="muted">
              An environment is one AWS account paired with one region — the unit you'll pick from on the Logs page. The
              IAM role assumed in it comes from the user's group (see User groups).
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
            </div>
            <button onClick={addEnvironment} disabled={!newName.trim() || !newAccountId.trim()}>
              Add environment
            </button>
          </div>

          <div className="panel">
            <h2>Configured environments</h2>
            {environments.length === 0 && <p className="muted">No environments configured yet.</p>}
            {environments.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Account ID</th>
                    <th>Region</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {environments.map((e) => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>{e.account_id}</td>
                      <td>{e.region}</td>
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
        </>
      )}

      {isAdmin && !loading && !error && section === "groups" && (
        <>
          <div className="panel">
            <h2>{editingGroupId != null ? "Edit user group" : "Create user group"}</h2>
            <div className="row" style={{ marginBottom: 12, alignItems: "flex-start" }}>
              <div>
                <span className="field-label">Name</span>
                <input
                  type="text"
                  value={groupDraft.name}
                  onChange={(e) => setGroupDraft((d) => ({ ...d, name: e.target.value }))}
                  style={{ width: 200 }}
                />
              </div>
              <div>
                <span className="field-label">IAM role name</span>
                <input
                  type="text"
                  placeholder="e.g. CloudWatchInsightsReadOnlyRole"
                  value={groupDraft.role_name}
                  onChange={(e) => setGroupDraft((d) => ({ ...d, role_name: e.target.value }))}
                  style={{ width: 280 }}
                />
              </div>
            </div>
            <p className="muted" style={{ marginTop: -6, marginBottom: 12 }}>
              The role this group's members assume in every environment they can see (via{" "}
              <code>arn:aws:iam::&lt;account_id&gt;:role/&lt;role_name&gt;</code>).
            </p>

            <span className="field-label">Visible tabs</span>
            <div className="row" style={{ marginBottom: 12 }}>
              {TAB_TOGGLES.map((t) => (
                <label className="checkbox-item" key={t.key}>
                  <input
                    type="checkbox"
                    checked={groupDraft[t.key]}
                    onChange={(e) => toggleGroupTab(t.key, e.target.checked)}
                  />
                  {t.label}
                </label>
              ))}
            </div>

            <span className="field-label">Visible environments</span>
            {environments.length === 0 && <p className="muted">No environments configured yet.</p>}
            {environments.length > 0 && (
              <div className="checkbox-list" style={{ marginBottom: 12 }}>
                {environments.map((e) => (
                  <label className="checkbox-item" key={e.id}>
                    <input
                      type="checkbox"
                      checked={groupDraft.environment_ids.includes(e.id)}
                      onChange={(ev) => toggleGroupEnvironment(e.id, ev.target.checked)}
                    />
                    {e.name} ({e.account_id} / {e.region})
                  </label>
                ))}
              </div>
            )}

            <div className="row">
              <button onClick={saveGroup} disabled={!groupDraft.name.trim()}>
                {editingGroupId != null ? "Save changes" : "Create group"}
              </button>
              {editingGroupId != null && (
                <button className="secondary" onClick={cancelGroupEdit}>
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="panel">
            <h2>User groups</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Environments</th>
                  <th>Users</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id}>
                    <td>
                      {g.name} {g.is_admin && <span className="tag ok">Admin</span>}
                    </td>
                    <td>{g.role_name || <span className="muted">(none configured)</span>}</td>
                    <td>{g.is_admin ? <span className="muted">all</span> : g.environment_ids.length}</td>
                    <td>{g.user_count}</td>
                    <td>
                      <div className="row">
                        <button className="secondary" onClick={() => startEditGroup(g)}>
                          Edit
                        </button>
                        {!g.is_admin && (
                          <button className="danger" onClick={() => deleteGroup(g.id)}>
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {isAdmin && !loading && !error && section === "users" && (
        <>
          <div className="panel">
            <h2>Add user</h2>
            <div className="row" style={{ marginBottom: 10 }}>
              <div>
                <span className="field-label">Username</span>
                <input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} style={{ width: 180 }} />
              </div>
              <div>
                <span className="field-label">Password</span>
                <input
                  type="password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  style={{ width: 180 }}
                />
              </div>
              <div>
                <span className="field-label">Group</span>
                <select
                  value={newUserGroupId}
                  onChange={(e) => setNewUserGroupId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">Choose a group…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button onClick={addUser} disabled={!newUsername.trim() || !newUserPassword || newUserGroupId === ""}>
              Add user
            </button>
          </div>

          <div className="panel">
            <h2>Users</h2>
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Group</th>
                  <th>Change group</th>
                  <th>Reset password</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.username} {u.is_admin && <span className="tag ok">Admin</span>}
                      {currentUser?.id === u.id && <span className="tag">you</span>}
                    </td>
                    <td>{u.group_name}</td>
                    <td>
                      <div className="row">
                        <select
                          value={userGroupDrafts[u.id] ?? u.group_id}
                          onChange={(e) => setUserGroupDrafts((d) => ({ ...d, [u.id]: Number(e.target.value) }))}
                        >
                          {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="secondary"
                          disabled={(userGroupDrafts[u.id] ?? u.group_id) === u.group_id}
                          onClick={() => changeUserGroup(u.id)}
                        >
                          Save
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="row">
                        <input
                          type="password"
                          placeholder="New password"
                          value={userPasswordDrafts[u.id] ?? ""}
                          onChange={(e) => setUserPasswordDrafts((d) => ({ ...d, [u.id]: e.target.value }))}
                          style={{ width: 150 }}
                        />
                        <button className="secondary" disabled={!userPasswordDrafts[u.id]} onClick={() => resetUserPassword(u.id)}>
                          Set
                        </button>
                      </div>
                    </td>
                    <td>
                      <button className="danger" disabled={currentUser?.id === u.id} onClick={() => removeUser(u.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function AccountSection({ user, onProfileSaved }: { user: User; onProfileSaved: () => Promise<void> }) {
  const [avatarDraft, setAvatarDraft] = useState(user.avatar_url ?? "");
  const [avatarFileName, setAvatarFileName] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);

  function handleAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAvatarError(null);
    if (!file.type.startsWith("image/")) {
      setAvatarError("Please choose an image file.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError(`Image is too large (max ${Math.round(MAX_AVATAR_BYTES / 1024)} KB).`);
      return;
    }
    setAvatarFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setAvatarDraft(String(reader.result));
    reader.onerror = () => setAvatarError("Could not read that file.");
    reader.readAsDataURL(file);
  }

  async function saveAvatar(url: string | null) {
    setAvatarSaving(true);
    setAvatarError(null);
    try {
      await api.updateOwnProfile(url);
      await onProfileSaved();
    } catch (e: any) {
      setAvatarError(e.message ?? "Could not save picture.");
    } finally {
      setAvatarSaving(false);
    }
  }

  async function removeAvatar() {
    setAvatarDraft("");
    setAvatarFileName(null);
    await saveAvatar(null);
  }

  async function submitPasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);
    setPasswordSaving(true);
    try {
      await api.changeOwnPassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordSuccess(true);
    } catch (e: any) {
      setPasswordError(e instanceof ApiError && e.status === 400 ? "Current password is incorrect." : e.message);
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Profile picture</h2>
        <div className="row" style={{ gap: 14, marginBottom: 8 }}>
          <Avatar username={user.username} avatarUrl={avatarDraft || null} size={56} />
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <input
                ref={avatarFileInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarFile}
                style={{ display: "none" }}
              />
              <button type="button" className="secondary" onClick={() => avatarFileInputRef.current?.click()}>
                Choose file
              </button>
              <span className="muted">{avatarFileName ?? "No file chosen"}</span>
            </div>
            <div className="row">
              <button disabled={avatarSaving || !avatarDraft} onClick={() => saveAvatar(avatarDraft)}>
                Save
              </button>
              {user.avatar_url && (
                <button className="danger" disabled={avatarSaving} onClick={removeAvatar}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
        {avatarError && <p className="error-text">{avatarError}</p>}
      </div>

      <div className="panel">
        <h2>Change password</h2>
        <form onSubmit={submitPasswordChange}>
          <div className="row" style={{ marginBottom: 10, alignItems: "flex-start" }}>
            <div>
              <span className="field-label">Current password</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                style={{ width: 200 }}
              />
            </div>
            <div>
              <span className="field-label">New password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                style={{ width: 200 }}
              />
            </div>
          </div>
          {passwordError && (
            <p className="error-text" style={{ marginBottom: 8 }}>
              {passwordError}
            </p>
          )}
          {passwordSuccess && (
            <p className="muted" style={{ marginBottom: 8 }}>
              Password updated.
            </p>
          )}
          <button type="submit" disabled={passwordSaving || !currentPassword || !newPassword}>
            Update password
          </button>
        </form>
      </div>
    </>
  );
}
