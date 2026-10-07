import { useEffect, useRef, useState } from "react";
import { api, ApiError, Settings, User, UserGroup } from "../api";
import { useAuth } from "../AuthContext";
import Avatar from "../components/Avatar";
import ThemeGrid from "../components/ThemeGrid";
import { ThemeId } from "../theme";
import SavedItemsPage from "./SavedItemsPage";
import CredentialsSettings from "../components/settings/CredentialsSettings";
import EnvironmentsSettings from "../components/settings/EnvironmentsSettings";
import UserGroupsSettings from "../components/settings/UserGroupsSettings";

const EMPTY_SETTINGS: Settings = { app_title: null, app_logo_url: null };

// Logos are stored inline as a data: URL in the settings table, which is
// fetched on every page load -- keep uploads small so that stays cheap.
const MAX_LOGO_BYTES = 300 * 1024;
// Avatars are self-service (any logged-in user can upload one, not just an
// admin) -- kept smaller than the app logo, and comfortably under the
// backend's MAX_AVATAR_URL_LENGTH once base64-encoded.
const MAX_AVATAR_BYTES = 200 * 1024;

type Section =
  | "account"
  | "theme"
  | "saved"
  | "app"
  | "environments"
  | "groups"
  | "users"
  | "credentials";

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
  // Credentials and their types are one tab, switched inside it: a ninth tab
  // wrapped "Credential types" onto two lines.
  { id: "credentials", label: "Credentials" },
];


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
      const [s, g, u] = await Promise.all([
        api.getSettings(),
        api.listUserGroups(),
        api.listUsers(),
      ]);
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
      <div className="tabs settings-tabs" style={{ marginBottom: 14 }}>
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

      {/* Each fetches its own data: nothing else on this page needs it. */}
      {isAdmin && section === "credentials" && <CredentialsSettings />}

      {isAdmin && section === "environments" && <EnvironmentsSettings />}

      {isAdmin && section === "groups" && <UserGroupsSettings />}

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
