import { useEffect, useMemo, useState } from "react";
import { api, ApiError, ConnectionType, Credential, EnvironmentRecord, GroupIdentity, readableError, UserGroup } from "../../api";
import { CardRow } from "../SessionCard";
import { accepts } from "./EnvironmentsSettings";
import { rowProps, Section, TagPicker, ViewHead } from "./settingsLayout";

/*
 * Settings → User groups (PLATFORM_PLAN.md §14.8). A group is the unit of
 * access: which pages it has, which environments it sees, and -- new in
 * Phase 2 -- who it is on each kind of connection (D31). The IAM role used
 * to be a field on the group; it is the group's AWS identity now, an "AWS
 * role" credential, so a group can be a different role in one account, and
 * the same mechanism serves any other kind of connection.
 */

const PAGE_FLAGS: {
  key:
    | "logs_enabled"
    | "opensearch_enabled"
    | "iot_enabled"
    | "tables_enabled"
    | "buckets_enabled"
    | "cognito_enabled"
    | "tools_enabled"
    | "agent_enabled";
  label: string;
}[] = [
  // Two pages, two sets of credentials: a group can be given one without the
  // other, which one flag covering both could not say.
  { key: "logs_enabled", label: "CloudWatch" },
  { key: "opensearch_enabled", label: "OpenSearch" },
  { key: "iot_enabled", label: "IoT" },
  { key: "tables_enabled", label: "DynamoDB" },
  { key: "buckets_enabled", label: "S3" },
  { key: "cognito_enabled", label: "Cognito" },
  // No Aggregator switch: every session is one now, so it would mean "this
  // group gets no sessions at all". The column stays, unused.
  { key: "tools_enabled", label: "Tools" },
  // Not a page but the same kind of yes/no: the agent acts with everything
  // else this group has, so it is its own switch, and off for a new group.
  { key: "agent_enabled", label: "Platform agent" },
];

type Flags = Record<(typeof PAGE_FLAGS)[number]["key"], boolean>;

type Draft = Flags & {
  id: number | null;
  name: string;
  environment_ids: number[];
  /** Identities as they will be saved; a new AWS role is created on Save (credential_id < 0, newRole set). */
  identities: (GroupIdentity & { newRole?: string })[];
};

const NEW_ROLE = "new-role";

function flagsOf(g?: UserGroup): Flags {
  return {
    logs_enabled: g?.logs_enabled ?? true,
    opensearch_enabled: g?.opensearch_enabled ?? true,
    iot_enabled: g?.iot_enabled ?? true,
    tables_enabled: g?.tables_enabled ?? true,
    buckets_enabled: g?.buckets_enabled ?? true,
    cognito_enabled: g?.cognito_enabled ?? true,
    tools_enabled: g?.tools_enabled ?? true,
    agent_enabled: g?.agent_enabled ?? false,
  };
}

/** Credentials a group can use (D15): its own, global ones granted to it, or any for the Admin group. */
function usableBy(group: { id: number | null; is_admin?: boolean }, c: Credential): boolean {
  if (group.is_admin) return true;
  if (c.scope === "group") return group.id != null && c.group_id === group.id;
  return group.id != null && c.grants.includes(group.id);
}

export default function UserGroupsSettings() {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [envs, setEnvs] = useState<EnvironmentRecord[]>([]);
  const [types, setTypes] = useState<ConnectionType[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adding, setAdding] = useState<{ scope: string; credential: string; role: string }>({ scope: "", credential: "", role: "" });
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [g, e, t] = await Promise.all([api.listUserGroups(), api.listEnvironmentRecords(), api.listConnectionTypes()]);
      setGroups(g);
      setEnvs(e);
      setTypes(t);
      setLoaded(true);
    } catch (err) {
      setError(readableError(err));
    }
    api.listCredentials<Credential>().then(setCredentials, () => setCredentials([]));
  }

  useEffect(() => {
    refresh();
  }, []);

  const open = draft?.id != null ? groups.find((g) => g.id === draft.id) ?? null : null;
  const isAdminGroup = !!open?.is_admin;
  const envItems = useMemo(() => envs.map((e) => ({ id: e.id, name: e.name })), [envs]);
  const typeById = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);

  function close() {
    setDraft(null);
    setError(null);
  }

  async function start(g?: UserGroup) {
    setNotice(null);
    setError(null);
    setAdding({ scope: "", credential: "", role: "" });
    const base: Draft = { id: g?.id ?? null, name: g?.name ?? "", environment_ids: g?.environment_ids ?? [], identities: [], ...flagsOf(g) };
    setDraft(base);
    if (g) {
      try {
        setDraft({ ...base, identities: await api.listGroupIdentities(g.id) });
      } catch (e) {
        setError(readableError(e));
      }
    }
  }

  // What an identity can be for: each type's default, and each connection
  // the group can see (an override).
  const scopes = useMemo(() => {
    if (!draft) return [];
    const seen = isAdminGroup ? envs : envs.filter((e) => draft.environment_ids.includes(e.id));
    const out: { key: string; type: string; connection: number | null; label: string }[] = types.map((t) => ({
      key: `${t.id}:`,
      type: t.id,
      connection: null,
      label: `${t.label} (default)`,
    }));
    for (const e of seen)
      for (const c of e.connections)
        out.push({ key: `${c.type_id}:${c.id}`, type: c.type_id, connection: c.id, label: `${c.type_label} · ${c.label}` });
    return out;
  }, [draft, envs, types, isAdminGroup]);

  const scopeLabel = (i: GroupIdentity) =>
    scopes.find((s) => s.key === `${i.connection_type_id}:${i.connection_id ?? ""}`)?.label ??
    `${typeById[i.connection_type_id]?.label ?? i.connection_type_id}${i.connection_label ? ` · ${i.connection_label}` : " (default)"}`;

  function credentialOptions(type: string) {
    if (!draft) return [];
    const group = { id: draft.id, is_admin: isAdminGroup };
    return credentials.filter((c) => accepts(typeById[type], c) && usableBy(group, c));
  }

  function addIdentity() {
    if (!draft) return;
    const scope = scopes.find((s) => s.key === adding.scope);
    if (!scope || !adding.credential) return;
    const isNew = adding.credential === NEW_ROLE;
    if (isNew && !adding.role.trim()) return;
    const cred = credentials.find((c) => c.id === Number(adding.credential));
    setDraft({
      ...draft,
      identities: [
        ...draft.identities,
        {
          connection_type_id: scope.type,
          connection_id: scope.connection,
          credential_id: isNew ? -1 : Number(adding.credential),
          credential_name: isNew ? `new AWS role ${adding.role.trim()}` : cred?.name,
          newRole: isNew ? adding.role.trim() : undefined,
        },
      ],
    });
    setAdding({ scope: "", credential: "", role: "" });
  }

  function uniqueRoleName(groupName: string): string {
    const taken = new Set(credentials.map((c) => c.name));
    let name = `${groupName} AWS role`;
    for (let n = 2; taken.has(name); n++) name = `${groupName} AWS role ${n}`;
    return name;
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const flags = Object.fromEntries(PAGE_FLAGS.map((f) => [f.key, draft[f.key]])) as Flags;
      const payload = { name: draft.name.trim(), environment_ids: draft.environment_ids, ...flags };
      const saved = draft.id == null ? await api.createUserGroup({ ...payload, role_name: null, aggregator_enabled: true }) : await api.updateUserGroup(draft.id, payload);
      const identities: GroupIdentity[] = [];
      for (const i of draft.identities) {
        if (i.newRole) {
          // An AWS role is just a name: nothing secret, so this works with credentials off too (D35).
          const cred = await api.createCredential({
            name: uniqueRoleName(saved.name),
            type_id: "aws_role",
            scope: "group",
            group_id: saved.id,
            description: "The role this group assumes in AWS accounts.",
            values: { role_name: i.newRole },
          });
          identities.push({ ...i, credential_id: cred.id });
        } else identities.push(i);
      }
      await api.setGroupIdentities(saved.id, identities);
      setNotice(`Saved ${saved.name}.`);
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? readableError(e) : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!open) return;
    if (!confirm(`Delete the user group "${open.name}"?`)) return;
    try {
      await api.deleteUserGroup(open.id);
      setNotice(`Deleted ${open.name}.`);
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    }
  }

  const messages = (
    <>
      {error && <p className="error-text credentials-error">{error}</p>}
      {notice && <p className="credentials-notice">{notice}</p>}
    </>
  );

  if (draft) {
    const addScope = scopes.find((s) => s.key === adding.scope);
    const freeScopes = scopes.filter(
      (s) => !draft.identities.some((i) => `${i.connection_type_id}:${i.connection_id ?? ""}` === s.key),
    );
    return (
      <div className="panel credential-view group-editor">
        <ViewHead back={close} title={draft.id == null ? "New user group" : open?.name ?? draft.name}>
          {open && !open.is_admin && (
            <button className="danger" onClick={remove}>
              Delete
            </button>
          )}
        </ViewHead>
        {messages}
        <Section title="Details">
          <CardRow label="Name">
            <input id="group-name" type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </CardRow>
        </Section>

        <Section title="Pages">
          <CardRow label="Turned on">
            <div className="row group-flags">
              {PAGE_FLAGS.map((f) => (
                <label className="checkbox-item" key={f.key}>
                  <input type="checkbox" checked={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })} />
                  {f.label}
                </label>
              ))}
            </div>
          </CardRow>
        </Section>

        <Section title="Environments">
          <CardRow label="Sees">
            {isAdminGroup ? (
              <span className="credential-static">Every environment</span>
            ) : (
              <TagPicker
                items={envItems}
                chosen={draft.environment_ids}
                onChange={(ids) => setDraft({ ...draft, environment_ids: ids })}
                label="Give access to an environment"
                addLabel="Add an environment…"
                allChosenLabel="Sees every environment"
                emptyLabel="None yet"
              />
            )}
          </CardRow>
        </Section>

        <Section title="Identities">
          <p className="muted group-identities-help">
            Who this group is where it connects: a default per kind of connection, and overrides for single connections.
          </p>
          {draft.identities.map((i, n) => (
            <CardRow key={`${i.connection_type_id}:${i.connection_id ?? ""}`} label={scopeLabel(i)}>
              <div className="group-identity" data-identity={`${i.connection_type_id}:${i.connection_id ?? ""}`}>
                {i.newRole ? (
                  <span className="credential-static">New AWS role: {i.newRole}</span>
                ) : (
                  <select
                    aria-label={`Identity for ${scopeLabel(i)}`}
                    value={i.credential_id}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        identities: draft.identities.map((x, m) => (m === n ? { ...x, credential_id: Number(e.target.value) } : x)),
                      })
                    }
                  >
                    {!credentialOptions(i.connection_type_id).some((c) => c.id === i.credential_id) && (
                      <option value={i.credential_id}>{i.credential_name ?? `#${i.credential_id}`}</option>
                    )}
                    {credentialOptions(i.connection_type_id).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.type_id === "aws_role" && c.public_fields.role_name ? ` (${String(c.public_fields.role_name)})` : ` (${c.type_label})`}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="secondary"
                  aria-label={`Remove the identity for ${scopeLabel(i)}`}
                  onClick={() => setDraft({ ...draft, identities: draft.identities.filter((_, m) => m !== n) })}
                >
                  ✕
                </button>
              </div>
            </CardRow>
          ))}
          {freeScopes.length > 0 && (
            <CardRow label="Add">
              <div className="group-identity-add">
                <select aria-label="Identity for" value={adding.scope} onChange={(e) => setAdding({ scope: e.target.value, credential: "", role: "" })}>
                  <option value="">For…</option>
                  {freeScopes.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {addScope && (
                  <select aria-label="Identity credential" value={adding.credential} onChange={(e) => setAdding({ ...adding, credential: e.target.value })}>
                    <option value="">As…</option>
                    {addScope.type === "aws" && <option value={NEW_ROLE}>A new AWS role…</option>}
                    {credentialOptions(addScope.type).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.type_label})
                      </option>
                    ))}
                  </select>
                )}
                {adding.credential === NEW_ROLE && (
                  <input
                    aria-label="Role name"
                    type="text"
                    placeholder="Role name, e.g. ReadOnly"
                    value={adding.role}
                    onChange={(e) => setAdding({ ...adding, role: e.target.value })}
                  />
                )}
                <button
                  className="secondary"
                  onClick={addIdentity}
                  disabled={!addScope || !adding.credential || (adding.credential === NEW_ROLE && !adding.role.trim())}
                >
                  Add
                </button>
              </div>
            </CardRow>
          )}
        </Section>

        <div className="row credential-view-foot">
          <button onClick={save} disabled={busy || !draft.name.trim()}>
            {draft.id == null ? "Create" : "Save"}
          </button>
          <button className="secondary" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel credential-list">
      <div className="credential-list-head">
        <h2>User groups</h2>
        <span className="muted">What each group sees, and who it is where it connects.</span>
        <button onClick={() => start()}>New group</button>
      </div>
      {messages}
      {loaded && (
        <table className="credentials-table groups-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Environments</th>
              <th>AWS role</th>
              <th className="credential-count">Users</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id} data-group={g.name} {...rowProps(() => start(g))}>
                <td>
                  <span className="credential-name">{g.name}</span> {g.is_admin && <span className="tag ok">Admin</span>}
                </td>
                <td>
                  {g.is_admin
                    ? "All"
                    : g.environment_ids.map((id) => envs.find((e) => e.id === id)?.name ?? `#${id}`).join(", ") || (
                        <span className="muted">None</span>
                      )}
                </td>
                <td>{g.role_name ?? <span className="muted">—</span>}</td>
                <td className="credential-count">{g.user_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
