import { useEffect, useMemo, useState } from "react";
import {
  api,
  Connection,
  ConnectionType,
  Credential,
  EnvironmentRecord,
  readableError,
  UserGroup,
} from "../../api";
import { CardRow } from "../SessionCard";
import { rowProps, Section, TagPicker, ViewHead } from "./settingsLayout";

/*
 * Settings → Environments (PLATFORM_PLAN.md §14.8). An environment is a
 * named place people talk about ("Prod"), holding connections -- where
 * things are: an AWS account and region, a base URL. Who a request runs as
 * there is the group's identity (User groups → Identities), never set here,
 * except as a connection's own fallback credential.
 *
 * Details and Access are saved by the view's Save; each connection is saved
 * on its own, since it is its own record that panes point at.
 */

/** Whether a credential can be an identity on connections of this type (connections.accepts on the backend). */
export function accepts(type: ConnectionType | undefined, cred: Credential): boolean {
  if (!type) return false;
  return type.identity_types.includes(cred.type_id) || (type.identity_types.includes("@inject") && cred.authenticates);
}

function configSummary(c: Connection): string {
  if (c.type_id === "aws") return `${c.config.account_id ?? "?"} · ${c.config.region ?? "?"}`;
  return Object.values(c.config).join(" · ");
}

type ConnDraft = {
  id: number | null;
  type_id: string;
  name: string;
  config: Record<string, string>;
  credential_id: number | null;
};

function ConnectionEditor({
  draft,
  types,
  credentials,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  draft: ConnDraft;
  types: ConnectionType[];
  credentials: Credential[];
  onChange: (d: ConnDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const type = types.find((t) => t.id === draft.type_id);
  const usable = credentials.filter((c) => accepts(type, c));
  return (
    <div className="connection-editor">
      {draft.id == null && (
        <CardRow label="Type">
          <select
            id="conn-type"
            value={draft.type_id}
            onChange={(e) => onChange({ ...draft, type_id: e.target.value, config: {}, credential_id: null })}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </CardRow>
      )}
      <CardRow label="Name">
        <input
          id="conn-name"
          type="text"
          value={draft.name}
          placeholder="e.g. iot"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </CardRow>
      {(type?.fields ?? []).map((f) => (
        <CardRow key={f.key} label={`${f.label}${f.required ? " *" : ""}`}>
          <div className="credential-value">
            <input
              id={`conn-field-${f.key}`}
              type="text"
              value={draft.config[f.key] ?? ""}
              onChange={(e) => onChange({ ...draft, config: { ...draft.config, [f.key]: e.target.value } })}
            />
            {f.help && <div className="muted">{f.help}</div>}
          </div>
        </CardRow>
      ))}
      <CardRow label="Own credential">
        <div className="credential-value">
          <select
            id="conn-credential"
            value={draft.credential_id ?? ""}
            onChange={(e) => onChange({ ...draft, credential_id: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">None</option>
            {usable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.type_label})
              </option>
            ))}
          </select>
          <div className="muted">
            Used only by a group with no identity of its own here, and only if that group can use it.
          </div>
        </div>
      </CardRow>
      <div className="row connection-editor-foot">
        <button onClick={onSave} disabled={busy || !draft.name.trim()}>
          {draft.id == null ? "Add connection" : "Save connection"}
        </button>
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConnectionRow({
  conn,
  groups,
  onEdit,
  onRemove,
}: {
  conn: Connection;
  groups: UserGroup[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [asGroup, setAsGroup] = useState<number | "">("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  async function test() {
    if (asGroup === "") return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testConnection(conn.id, asGroup));
    } catch (e) {
      setResult({ ok: false, message: readableError(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="connection-row" data-connection={conn.name}>
      <div className="connection-row-main">
        <span className="credential-name">{conn.name}</span>
        <span className="muted">
          {conn.type_label} · {configSummary(conn)}
          {conn.credential_name ? ` · own credential: ${conn.credential_name}` : ""}
        </span>
        <span className="connection-row-actions">
          <button className="secondary" onClick={onEdit}>
            Edit
          </button>
          <button className="secondary" aria-label={`Remove ${conn.name}`} onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      <div className="connection-test">
        <select aria-label="Test as group" value={asGroup} onChange={(e) => setAsGroup(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Test as…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button className="secondary" onClick={test} disabled={asGroup === "" || testing}>
          {testing ? "Testing…" : "Test"}
        </button>
        {result && (
          <span className={`credential-status ${result.ok ? "ok" : "error"} connection-test-result`}>
            <span className="credential-status-dot" />
            {result.message}
          </span>
        )}
      </div>
    </div>
  );
}

type Draft = { id: number | null; name: string; description: string; group_ids: number[] };

export default function EnvironmentsSettings() {
  const [envs, setEnvs] = useState<EnvironmentRecord[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [types, setTypes] = useState<ConnectionType[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [connDraft, setConnDraft] = useState<ConnDraft | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [e, g, t] = await Promise.all([api.listEnvironmentRecords(), api.listUserGroups(), api.listConnectionTypes()]);
      setEnvs(e);
      setGroups(g);
      setTypes(t);
      setLoaded(true);
    } catch (err) {
      setError(readableError(err));
    }
    // Credentials are only for the "own credential" picker; with credentials
    // off the list fails, and connections still work without one.
    api.listCredentials<Credential>().then(setCredentials, () => setCredentials([]));
  }

  useEffect(() => {
    refresh();
  }, []);

  const grantable = useMemo(() => groups.filter((g) => !g.is_admin), [groups]);
  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? `#${id}`;
  const open = draft?.id != null ? envs.find((e) => e.id === draft.id) ?? null : null;

  function close() {
    setDraft(null);
    setConnDraft(null);
    setError(null);
  }

  function start(env?: EnvironmentRecord) {
    setNotice(null);
    setError(null);
    setConnDraft(null);
    setDraft(
      env
        ? { id: env.id, name: env.name, description: env.description ?? "", group_ids: env.group_ids }
        : { id: null, name: "", description: "", group_ids: [] },
    );
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved =
        draft.id == null
          ? await api.createEnvironment({ name: draft.name.trim(), description: draft.description || null })
          : await api.updateEnvironment(draft.id, { name: draft.name.trim(), description: draft.description || null });
      await api.setEnvironmentGroups(saved.id, draft.group_ids);
      await refresh();
      if (draft.id == null) {
        // A new environment stays open: it is nothing until it has a connection.
        setDraft({ ...draft, id: saved.id });
        setNotice(`Created ${saved.name}. Add its connections below.`);
        setConnDraft({ id: null, type_id: types[0]?.id ?? "aws", name: "", config: {}, credential_id: null });
      } else {
        setNotice(`Saved ${saved.name}.`);
        setDraft(null);
      }
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!open) return;
    if (!confirm(`Delete the environment "${open.name}" and its connections? Panes pointed at it will say it isn't configured.`))
      return;
    try {
      await api.deleteEnvironment(open.id);
      setNotice(`Deleted ${open.name}.`);
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function saveConnection() {
    if (!connDraft || !open) return;
    setBusy(true);
    setError(null);
    try {
      if (connDraft.id == null) {
        await api.addConnection(open.id, {
          type_id: connDraft.type_id,
          name: connDraft.name.trim(),
          config: connDraft.config,
          credential_id: connDraft.credential_id,
        });
      } else {
        await api.updateConnection(connDraft.id, {
          name: connDraft.name.trim(),
          config: connDraft.config,
          ...(connDraft.credential_id == null ? { clear_credential: true } : { credential_id: connDraft.credential_id }),
        });
      }
      setConnDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection(c: Connection) {
    if (!confirm(`Remove the connection "${c.label}"? Panes pointed at it will say it isn't configured.`)) return;
    try {
      await api.deleteConnection(c.id);
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
    return (
      <div className="panel credential-view environment-editor">
        <ViewHead back={close} title={draft.id == null ? "New environment" : open?.name ?? draft.name}>
          {open && (
            <button className="danger" onClick={remove}>
              Delete
            </button>
          )}
        </ViewHead>
        {messages}
        <Section title="Details">
          <CardRow label="Name">
            <input id="env-name" type="text" value={draft.name} placeholder="e.g. Prod" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </CardRow>
          <CardRow label="Description">
            <input
              id="env-description"
              type="text"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </CardRow>
        </Section>

        {open && (
          <Section
            title="Connections"
            aside={
              !connDraft && (
                <button
                  className="secondary"
                  onClick={() => setConnDraft({ id: null, type_id: types[0]?.id ?? "aws", name: "", config: {}, credential_id: null })}
                >
                  Add connection
                </button>
              )
            }
          >
            {open.connections.length === 0 && !connDraft && (
              <p className="muted">No connections yet: an environment is where its connections are.</p>
            )}
            {open.connections.map((c) =>
              connDraft?.id === c.id ? (
                <ConnectionEditor
                  key={c.id}
                  draft={connDraft}
                  types={types}
                  credentials={credentials}
                  onChange={setConnDraft}
                  onSave={saveConnection}
                  onCancel={() => setConnDraft(null)}
                  busy={busy}
                />
              ) : (
                <ConnectionRow
                  key={c.id}
                  conn={c}
                  groups={groups}
                  onEdit={() =>
                    setConnDraft({ id: c.id, type_id: c.type_id, name: c.name, config: { ...c.config }, credential_id: c.credential_id })
                  }
                  onRemove={() => removeConnection(c)}
                />
              ),
            )}
            {connDraft?.id === null && (
              <ConnectionEditor
                draft={connDraft}
                types={types}
                credentials={credentials}
                onChange={setConnDraft}
                onSave={saveConnection}
                onCancel={() => setConnDraft(null)}
                busy={busy}
              />
            )}
          </Section>
        )}

        <Section title="Access">
          <CardRow label="Groups">
            <TagPicker
              items={grantable}
              chosen={draft.group_ids.filter((id) => grantable.some((g) => g.id === id))}
              onChange={(ids) => setDraft({ ...draft, group_ids: ids })}
              label="Give a group access"
              addLabel="Add a group…"
              allChosenLabel="Every group sees it"
            />
            <div className="muted credential-access-note">
              Admins see every environment. A group that sees it can use all its connections, each with its own identity.
            </div>
          </CardRow>
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
        <h2>Environments</h2>
        <span className="muted">Named places, each holding the connections people reach there.</span>
        <button onClick={() => start()}>New environment</button>
      </div>
      {messages}
      {loaded && envs.length === 0 && <p className="muted credential-empty">No environments yet.</p>}
      {envs.length > 0 && (
        <table className="credentials-table environments-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Connections</th>
              <th>Groups</th>
            </tr>
          </thead>
          <tbody>
            {envs.map((e) => (
              <tr key={e.id} data-environment={e.name} {...rowProps(() => start(e))}>
                <td>
                  <span className="credential-name">{e.name}</span>
                  {e.description && <div className="muted">{e.description}</div>}
                </td>
                <td>
                  {e.connections.length === 0 && <span className="muted">None yet</span>}
                  {e.connections.map((c) => (
                    <div key={c.id}>
                      {e.connections.length > 1 && <span className="credential-name">{c.name}: </span>}
                      <span className="muted">
                        {c.type_label} {configSummary(c)}
                      </span>
                    </div>
                  ))}
                </td>
                <td>{e.group_ids.length ? e.group_ids.map(groupName).join(", ") : <span className="muted">Admins only</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
