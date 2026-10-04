import { ChangeEvent, Fragment, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  AuditEvent,
  Credential,
  CredentialField,
  CredentialFieldKind,
  CredentialInject,
  CredentialsStatus,
  CredentialType,
  CredentialTypeDraft,
  readableError,
  UserGroup,
} from "../../api";

/*
 * Settings → Credentials and Settings → Credential types (PLATFORM_PLAN.md
 * §13.6). Admin-only, like the sections beside them.
 *
 * Nothing on these screens ever holds a secret the user didn't just type: the
 * backend never sends one back (D25), so a secret field that is set shows
 * "•••• set" and a Replace button, and its input starts empty. Leaving a
 * secret input empty on save keeps the stored value -- the API's own rule --
 * so an edit to a username can't wipe a password by accident.
 */

const KINDS: CredentialFieldKind[] = ["text", "multiline", "number", "bool", "choice", "json", "file"];
const MAX_FILE_BYTES = 1024 * 1024;

function when(iso: string | null): string {
  return iso ? new Date(iso.endsWith("Z") ? iso : `${iso}Z`).toLocaleString() : "—";
}

function OffNotice({ status }: { status: CredentialsStatus | null }) {
  if (!status || status.enabled) return null;
  return (
    <div className="panel">
      <h2>Credentials are off</h2>
      <p className="error-text credentials-off">{status.reason}</p>
      <p className="muted">
        Stored credentials are encrypted with a master key that lives outside the database. Until one is configured,
        nothing can be stored or used; everything else works as before.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ one field's input

function FieldInput({
  field,
  value,
  onChange,
  isSet,
}: {
  field: CredentialField;
  value: unknown;
  onChange: (v: unknown) => void;
  /** For a secret field being edited: whether the stored credential has a value. */
  isSet?: boolean;
}) {
  const [replacing, setReplacing] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const id = `cred-field-${field.key}`;

  if (field.secret && isSet && !replacing) {
    return (
      <div className="row credential-secret-set">
        <span className="tag ok">•••• set</span>
        <button type="button" className="secondary" onClick={() => setReplacing(true)}>
          Replace
        </button>
      </div>
    );
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileNote(`${file.name} is ${file.size} bytes; files are limited to 1 MiB for now.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      onChange(result.slice(result.indexOf(",") + 1));
      setFileNote(`${file.name}, ${file.size} bytes`);
    };
    reader.readAsDataURL(file);
  }

  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  switch (field.kind) {
    case "multiline":
    case "json":
      return (
        <textarea
          id={id}
          rows={field.kind === "json" ? 5 : 4}
          value={text}
          placeholder={field.secret ? "Stored encrypted; never shown again" : field.kind === "json" ? "{ }" : ""}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={field.secret ? "credential-secret-input" : undefined}
        />
      );
    case "number":
      return <input id={id} type="number" value={text} onChange={(e) => onChange(e.target.value)} />;
    case "bool":
      return <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "choice":
      return (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    case "file":
      return (
        <div>
          <input id={id} type="file" onChange={onFile} />
          {fileNote && <span className="muted"> {fileNote}</span>}
        </div>
      );
    default:
      return (
        <input
          id={id}
          type={field.secret ? "password" : "text"}
          autoComplete={field.secret ? "new-password" : "off"}
          value={text}
          placeholder={field.secret ? "Stored encrypted; never shown again" : String(field.default ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

// ------------------------------------------------------------------ credentials

type Draft = {
  id: number | null;
  name: string;
  description: string;
  type_id: string;
  scope: "global" | "group";
  group_id: number | null;
  values: Record<string, unknown>;
};

export function CredentialsSection() {
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [types, setTypes] = useState<CredentialType[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [historyFor, setHistoryFor] = useState<Credential | null>(null);
  const [history, setHistory] = useState<AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [s, t, c, g] = await Promise.all([
        api.credentialsStatus(),
        api.listCredentialTypes(),
        api.listCredentials<Credential>(),
        api.listUserGroups(),
      ]);
      setStatus(s);
      setTypes(t);
      setCredentials(c);
      setGroups(g);
    } catch (e) {
      setError(readableError(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const typeById = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);
  const editing = draft?.id != null ? credentials.find((c) => c.id === draft.id) ?? null : null;
  const draftType = draft ? typeById[draft.type_id] : undefined;
  const nonAdminGroups = groups.filter((g) => !g.is_admin);

  function startNew() {
    const first = types[0];
    setNotice(null);
    setError(null);
    setDraft({ id: null, name: "", description: "", type_id: first?.id ?? "", scope: "global", group_id: null, values: {} });
  }

  function startEdit(c: Credential) {
    setNotice(null);
    setError(null);
    setDraft({
      id: c.id,
      name: c.name,
      description: c.description ?? "",
      type_id: c.type_id,
      scope: c.scope,
      group_id: c.group_id,
      values: { ...c.public_fields },
    });
  }

  function cleanedValues(type: CredentialType, values: Record<string, unknown>): Record<string, unknown> {
    // Empty secret inputs are left out: on an edit they mean "keep it".
    const out: Record<string, unknown> = {};
    for (const f of type.fields) {
      const v = values[f.key];
      if (v === undefined) continue;
      if (f.secret && (v === "" || v === null)) continue;
      out[f.key] = v;
    }
    return out;
  }

  async function save() {
    if (!draft || !draftType) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const values = cleanedValues(draftType, draft.values);
      const saved =
        draft.id == null
          ? await api.createCredential({
              name: draft.name,
              type_id: draft.type_id,
              scope: draft.scope,
              group_id: draft.scope === "group" ? draft.group_id : null,
              description: draft.description || null,
              values,
            })
          : await api.updateCredential(draft.id, { name: draft.name, description: draft.description || null, values });
      // Saved first, tested second: a credential can be right and still fail
      // a test the platform can't complete (a network it can't reach).
      if (draftType.has_test) {
        const result = await api.testCredential(saved.id);
        setNotice(
          result.ok === false ? `Saved, but the test failed: ${result.message}` : `Saved. Test passed: ${result.message}`,
        );
      } else {
        setNotice("Saved.");
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function test(c: Credential) {
    setError(null);
    try {
      const result = await api.testCredential(c.id);
      setNotice(result.ok === false ? `${c.name}: test failed: ${result.message}` : `${c.name}: ${result.message}`);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function remove(c: Credential) {
    if (!confirm(`Delete the credential "${c.name}"? Anything using it will stop working.`)) return;
    try {
      await api.deleteCredential(c.id);
      if (draft?.id === c.id) setDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function toggleGrant(c: Credential, groupId: number, on: boolean) {
    try {
      await (on ? api.grantCredential(c.id, groupId) : api.revokeCredential(c.id, groupId));
      await refresh();
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function showHistory(c: Credential) {
    setHistoryFor(c);
    try {
      setHistory(await api.auditFor("credential", c.id));
    } catch (e) {
      setError(readableError(e));
    }
  }

  const blocks: { title: string; rows: Credential[] }[] = [
    { title: "Global", rows: credentials.filter((c) => c.scope === "global") },
    ...groups
      .map((g) => ({ title: g.name, rows: credentials.filter((c) => c.scope === "group" && c.group_id === g.id) }))
      .filter((b) => b.rows.length > 0),
  ];

  return (
    <div className="credentials-settings">
      <OffNotice status={status} />
      {error && <p className="error-text credentials-error">{error}</p>}
      {notice && <p className="credentials-notice">{notice}</p>}

      {draft && draftType !== undefined && (
        <div className="panel credential-editor">
          <h2>{draft.id == null ? "New credential" : `Edit ${editing?.name ?? "credential"}`}</h2>
          <div className="credential-form">
            <label className="field-label" htmlFor="cred-name">
              Name
            </label>
            <input id="cred-name" type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />

            <label className="field-label" htmlFor="cred-type">
              Type
            </label>
            {draft.id == null ? (
              <select id="cred-type" value={draft.type_id} onChange={(e) => setDraft({ ...draft, type_id: e.target.value, values: {} })}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                    {t.builtin ? "" : " (custom)"}
                  </option>
                ))}
              </select>
            ) : (
              <span className="credential-static">{draftType.label}</span>
            )}

            <label className="field-label" htmlFor="cred-scope">
              Belongs to
            </label>
            {draft.id == null ? (
              <div className="row">
                <select
                  id="cred-scope"
                  value={draft.scope === "global" ? "global" : String(draft.group_id ?? "")}
                  onChange={(e) =>
                    setDraft(
                      e.target.value === "global"
                        ? { ...draft, scope: "global", group_id: null }
                        : { ...draft, scope: "group", group_id: Number(e.target.value) },
                    )
                  }
                >
                  <option value="global">Global (granted to groups explicitly)</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      Group: {g.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <span className="credential-static">
                {draft.scope === "global" ? "Global" : `Group: ${editing?.group_name ?? ""}`}
              </span>
            )}

            <label className="field-label" htmlFor="cred-description">
              Description
            </label>
            <input
              id="cred-description"
              type="text"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />

            {draftType.description && <p className="muted credential-type-help">{draftType.description}</p>}
            {draftType.fields.map((f) => (
              <Fragment key={f.key}>
                <label className="field-label" htmlFor={`cred-field-${f.key}`}>
                  {f.label}
                  {f.required ? " *" : ""}
                  {f.secret ? <span className="tag credential-secret-tag">secret</span> : null}
                </label>
                <div>
                  <FieldInput
                    key={`${draft.type_id}-${f.key}-${draft.id ?? "new"}`}
                    field={f}
                    value={draft.values[f.key]}
                    isSet={f.secret && !!editing?.secret_fields_set.includes(f.key)}
                    onChange={(v) => setDraft({ ...draft, values: { ...draft.values, [f.key]: v } })}
                  />
                  {f.help && <div className="muted credential-field-help">{f.help}</div>}
                </div>
              </Fragment>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={save} disabled={busy || !draft.name.trim() || (draft.scope === "group" && draft.group_id == null)}>
              {draftType.has_test ? "Save and test" : "Save"}
            </button>
            <button className="secondary" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Credentials</h2>
          <button onClick={startNew} disabled={!status?.enabled || types.length === 0}>
            New credential
          </button>
        </div>
        <p className="muted">
          Secrets are encrypted at rest and never shown again, to admins included: replace one to change it. A global
          credential is usable by a group only once granted to it.
        </p>
        {credentials.length === 0 && <p className="muted">No credentials yet.</p>}
        {blocks.map(
          (b) =>
            b.rows.length > 0 && (
              <div key={b.title} className="credential-block">
                <h3>{b.title}</h3>
                <table className="credentials-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Details</th>
                      <th>Test</th>
                      {b.title === "Global" && <th>Granted to</th>}
                      <th>Last used</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((c) => (
                      <tr key={c.id} data-credential={c.name}>
                        <td>
                          <strong>{c.name}</strong>
                          {c.description && <div className="muted">{c.description}</div>}
                        </td>
                        <td>{c.type_label}</td>
                        <td className="credential-details">
                          {Object.entries(c.public_fields).map(([k, v]) => (
                            <div key={k}>
                              <span className="muted">{k}:</span> {typeof v === "string" ? v : JSON.stringify(v)}
                            </div>
                          ))}
                          {c.secret_fields_set.length > 0 && (
                            <div className="muted">{c.secret_fields_set.join(", ")} set</div>
                          )}
                        </td>
                        <td>
                          {c.last_test_ok === true && <span className="tag ok" title={c.last_test_message ?? ""}>✓</span>}
                          {c.last_test_ok === false && <span className="tag error" title={c.last_test_message ?? ""}>✕</span>}
                          {c.last_test_message && <div className="muted credential-test-message">{c.last_test_message}</div>}
                        </td>
                        {b.title === "Global" && (
                          <td className="credential-grants">
                            {/* Granted groups as tags, the rest behind one picker:
                                a checkbox per group made every row as tall as the
                                group list. */}
                            {c.grants.length === 0 && <span className="muted">Nobody yet</span>}
                            {nonAdminGroups
                              .filter((g) => c.grants.includes(g.id))
                              .map((g) => (
                                <span key={g.id} className="tag credential-grant" data-group={g.name}>
                                  {g.name}
                                  <button
                                    type="button"
                                    className="credential-grant-remove"
                                    aria-label={`Revoke from ${g.name}`}
                                    onClick={() => toggleGrant(c, g.id, false)}
                                  >
                                    ✕
                                  </button>
                                </span>
                              ))}
                            {nonAdminGroups.some((g) => !c.grants.includes(g.id)) && (
                              <select
                                aria-label="Grant to a group"
                                className="credential-grant-add"
                                value=""
                                onChange={(e) => e.target.value && toggleGrant(c, Number(e.target.value), true)}
                              >
                                <option value="">Grant to…</option>
                                {nonAdminGroups
                                  .filter((g) => !c.grants.includes(g.id))
                                  .map((g) => (
                                    <option key={g.id} value={g.id}>
                                      {g.name}
                                    </option>
                                  ))}
                              </select>
                            )}
                          </td>
                        )}
                        <td>{when(c.last_used_at)}</td>
                        <td className="credential-actions">
                          <button className="secondary" onClick={() => startEdit(c)} disabled={!status?.enabled}>
                            Edit
                          </button>
                          {typeById[c.type_id]?.has_test && (
                            <button className="secondary" onClick={() => test(c)} disabled={!status?.enabled}>
                              Test
                            </button>
                          )}
                          <button className="secondary" onClick={() => showHistory(c)}>
                            History
                          </button>
                          <button className="danger" onClick={() => remove(c)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
        )}
      </div>

      {historyFor && (
        <div className="panel credential-history">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>History of {historyFor.name}</h2>
            <button className="secondary" onClick={() => setHistoryFor(null)}>
              Close
            </button>
          </div>
          {history.length === 0 && <p className="muted">Nothing recorded yet.</p>}
          {history.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{when(h.at)}</td>
                    <td>{h.actor_name ?? h.actor_kind}</td>
                    <td>{h.action.replace(/^credential\./, "")}</td>
                    <td className="muted">{describeDetail(h.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function describeDetail(detail: Record<string, unknown>): string {
  if (Array.isArray(detail.changed)) return detail.changed.length ? `changed ${detail.changed.join(", ")}` : "no change";
  if (typeof detail.purpose === "string") return detail.purpose;
  if ("ok" in detail) return `${detail.ok === false ? "failed" : "passed"}: ${String(detail.message ?? "")}`;
  if (typeof detail.group === "string") return detail.group;
  return Object.entries(detail)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

// ------------------------------------------------------------------ types

type TypeDraft = CredentialTypeDraft & { isNew: boolean };

function emptyField(): CredentialField {
  return { key: "", label: "", kind: "text", secret: false, required: false, help: "" };
}

export function CredentialTypesSection() {
  const [types, setTypes] = useState<CredentialType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<TypeDraft | null>(null);
  const [example, setExample] = useState("");
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setTypes(await api.listCredentialTypes());
    } catch (e) {
      setError(readableError(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function start(from?: CredentialType, copy = false) {
    setNotice(null);
    setError(null);
    setPreview(null);
    setExample("");
    setSample("");
    setDraft(
      from
        ? {
            isNew: copy,
            id: copy ? `${from.id}_copy` : from.id,
            label: copy ? `${from.label} (copy)` : from.label,
            description: from.description,
            fields: from.fields.map((f) => ({ ...f })),
            output_template: from.output_template,
            inject: from.inject,
            http_test: from.http_test,
          }
        : { isNew: true, id: "", label: "", description: "", fields: [emptyField()], output_template: null, inject: null, http_test: null },
    );
  }

  function setField(i: number, patch: Partial<CredentialField>) {
    if (!draft) return;
    const fields = draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f));
    setDraft({ ...draft, fields });
  }

  async function infer() {
    if (!draft) return;
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(example);
    } catch (e) {
      setError(`That isn't valid JSON: ${(e as Error).message}`);
      return;
    }
    try {
      const out = await api.inferCredentialType(parsed);
      setDraft({ ...draft, fields: out.fields, output_template: out.output_template });
      setNotice(
        `Proposed ${out.fields.length} field${out.fields.length === 1 ? "" : "s"}. Check which are secret before saving.`,
      );
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function runPreview() {
    if (!draft) return;
    setError(null);
    let values: Record<string, unknown> = {};
    if (sample.trim()) {
      try {
        values = JSON.parse(sample);
      } catch (e) {
        setError(`The sample values aren't valid JSON: ${(e as Error).message}`);
        return;
      }
    }
    try {
      const out = await api.previewCredentialType({ fields: draft.fields, output_template: draft.output_template, values });
      setPreview(JSON.stringify(out.output, null, 2));
    } catch (e) {
      setPreview(null);
      setError(readableError(e));
    }
  }

  async function save(confirmRemove = false) {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const body: CredentialTypeDraft = {
      id: draft.id,
      label: draft.label,
      description: draft.description || null,
      fields: draft.fields.map((f) => ({ ...f, default: f.secret || f.default === "" ? undefined : f.default })),
      output_template: draft.output_template || null,
      inject: draft.inject,
      http_test: draft.http_test,
    };
    try {
      if (draft.isNew) await api.createCredentialType(body);
      else await api.updateCredentialType(draft.id, { ...body, confirm_remove: confirmRemove });
      setNotice("Saved.");
      setDraft(null);
      await refresh();
    } catch (e) {
      // Removing a field that holds values asks first, with the list.
      if (e instanceof ApiError && e.status === 409 && !confirmRemove && confirm(`${readableError(e)}\n\nGo ahead?`)) {
        await save(true);
        return;
      }
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: CredentialType) {
    if (!confirm(`Delete the credential type "${t.label}"?`)) return;
    try {
      await api.deleteCredentialType(t.id);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    }
  }

  const keys = draft?.fields.map((f) => f.key).filter(Boolean) ?? [];
  const inject = draft?.inject ?? null;
  const setInject = (patch: Partial<CredentialInject> | null) =>
    draft && setDraft({ ...draft, inject: patch === null ? null : ({ ...(inject ?? { kind: "header" }), ...patch } as CredentialInject) });

  return (
    <div className="credential-types-settings">
      {error && <p className="error-text credentials-error">{error}</p>}
      {notice && <p className="credentials-notice">{notice}</p>}

      {draft && (
        <div className="panel credential-type-editor">
          <h2>{draft.isNew ? "New credential type" : `Edit ${draft.label}`}</h2>
          <div className="credential-form">
            <label className="field-label" htmlFor="type-id">
              Id
            </label>
            {draft.isNew ? (
              <input id="type-id" type="text" value={draft.id} placeholder="acme_api" onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
            ) : (
              <code className="credential-static">{draft.id}</code>
            )}
            <label className="field-label" htmlFor="type-label">
              Label
            </label>
            <input id="type-label" type="text" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            <label className="field-label" htmlFor="type-description">
              Description
            </label>
            <input
              id="type-description"
              type="text"
              value={draft.description ?? ""}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>

          <h3>Paste an example</h3>
          <p className="muted">
            Paste the JSON you want a credential of this type to look like. Each value becomes a field, nested objects
            included, and the pasted shape is kept.
          </p>
          <textarea
            className="credential-type-example"
            rows={4}
            value={example}
            placeholder='{"username": "", "password": "", "region": "eu-west-1"}'
            onChange={(e) => setExample(e.target.value)}
            spellCheck={false}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="secondary" onClick={infer} disabled={!example.trim()}>
              Fill fields from example
            </button>
          </div>

          <h3>Fields</h3>
          <table className="credential-type-fields">
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Kind</th>
                <th>Secret</th>
                <th>Required</th>
                <th>Default</th>
                <th>Help</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {draft.fields.map((f, i) => (
                <tr key={i}>
                  <td>
                    <input aria-label="Key" type="text" value={f.key} onChange={(e) => setField(i, { key: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="Label" type="text" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                  </td>
                  <td>
                    <select aria-label="Kind" value={f.kind} onChange={(e) => setField(i, { kind: e.target.value as CredentialFieldKind })}>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                    {f.kind === "choice" && (
                      <input
                        aria-label="Choices"
                        type="text"
                        placeholder="a, b, c"
                        value={(f.choices ?? []).join(", ")}
                        onChange={(e) => setField(i, { choices: e.target.value.split(",").map((c) => c.trim()).filter(Boolean) })}
                      />
                    )}
                  </td>
                  <td>
                    <input aria-label="Secret" type="checkbox" checked={f.secret} onChange={(e) => setField(i, { secret: e.target.checked })} />
                  </td>
                  <td>
                    <input aria-label="Required" type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                  </td>
                  <td>
                    <input
                      aria-label="Default"
                      type="text"
                      disabled={f.secret}
                      value={f.secret || f.default == null ? "" : String(f.default)}
                      onChange={(e) => setField(i, { default: e.target.value })}
                    />
                  </td>
                  <td>
                    <input aria-label="Help" type="text" value={f.help} onChange={(e) => setField(i, { help: e.target.value })} />
                  </td>
                  <td>
                    <button
                      className="secondary"
                      aria-label="Remove field"
                      onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="secondary" onClick={() => setDraft({ ...draft, fields: [...draft.fields, emptyField()] })}>
            Add field
          </button>

          <h3>Output (optional)</h3>
          <p className="muted">
            What a pane or workflow receives. Empty: an object of the fields. Otherwise a CEL expression over the fields,
            e.g. <code>{'{"auth": {"user": username, "pass": password}}'}</code>.
          </p>
          <textarea
            className="credential-type-template"
            rows={3}
            value={draft.output_template ?? ""}
            onChange={(e) => setDraft({ ...draft, output_template: e.target.value })}
            spellCheck={false}
          />
          <div className="credential-preview">
            <textarea
              rows={3}
              value={sample}
              placeholder={`Sample values, e.g. ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, "…"])))}`}
              onChange={(e) => setSample(e.target.value)}
              spellCheck={false}
            />
            <button className="secondary" onClick={runPreview}>
              Preview
            </button>
            {preview !== null && <pre className="credential-preview-output">{preview}</pre>}
          </div>

          <h3>Authenticating HTTP requests (optional)</h3>
          <div className="credential-form">
            <label className="field-label" htmlFor="inject-kind">
              How
            </label>
            <select
              id="inject-kind"
              value={inject?.kind ?? ""}
              onChange={(e) =>
                setInject(e.target.value === "" ? null : { kind: e.target.value as CredentialInject["kind"] })
              }
            >
              <option value="">Doesn't authenticate requests</option>
              <option value="header">A header</option>
              <option value="basic">Basic authentication</option>
              <option value="query">A query parameter</option>
            </select>
            {inject && inject.kind !== "basic" && (
              <>
                <label className="field-label" htmlFor="inject-name">
                  {inject.kind === "header" ? "Header name" : "Parameter name"}
                </label>
                <input id="inject-name" type="text" value={inject.name ?? ""} placeholder={inject.kind === "header" ? "Authorization" : "api_key"} onChange={(e) => setInject({ name: e.target.value })} />
                <label className="field-label" htmlFor="inject-value">
                  Value (CEL)
                </label>
                <input id="inject-value" type="text" value={inject.value ?? ""} placeholder={'"Bearer " + token'} onChange={(e) => setInject({ value: e.target.value })} />
              </>
            )}
            {inject?.kind === "basic" && (
              <>
                <label className="field-label" htmlFor="inject-username">
                  Username (CEL)
                </label>
                <input id="inject-username" type="text" value={inject.username ?? ""} placeholder="username" onChange={(e) => setInject({ username: e.target.value })} />
                <label className="field-label" htmlFor="inject-password">
                  Password (CEL)
                </label>
                <input id="inject-password" type="text" value={inject.password ?? ""} placeholder="password" onChange={(e) => setInject({ password: e.target.value })} />
              </>
            )}
            <label className="field-label" htmlFor="test-url">
              Test request URL (CEL)
            </label>
            <div className="row">
              <select
                aria-label="Test method"
                value={draft.http_test?.method ?? "GET"}
                onChange={(e) =>
                  setDraft({ ...draft, http_test: draft.http_test ? { ...draft.http_test, method: e.target.value } : null })
                }
                disabled={!draft.http_test}
              >
                {["GET", "POST", "HEAD"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input
                id="test-url"
                type="text"
                value={draft.http_test?.url ?? ""}
                placeholder={'"https://" + host + "/me"   (empty: no test)'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    http_test: e.target.value
                      ? { method: draft.http_test?.method ?? "GET", url: e.target.value, headers: draft.http_test?.headers ?? {} }
                      : null,
                  })
                }
              />
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => save()} disabled={busy || !draft.id.trim() || !draft.label.trim()}>
              Save type
            </button>
            <button className="secondary" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Credential types</h2>
          <button onClick={() => start()}>New type</button>
        </div>
        <p className="muted">
          A type is the shape of a kind of secret: its fields, which are secret, and optionally how it authenticates a
          request. Built-in types are locked; copy one to make your own.
        </p>
        <table className="credential-types-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Fields</th>
              <th>Used by</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id} data-credential-type={t.id}>
                <td>
                  <strong>{t.label}</strong> {t.builtin && <span className="tag">built-in</span>}
                  <div className="muted">
                    <code>{t.id}</code>
                    {t.description ? ` — ${t.description}` : ""}
                  </div>
                </td>
                <td>
                  {t.fields.map((f) => (
                    <span key={f.key} className={`tag${f.secret ? " pending" : ""}`} title={f.secret ? "secret" : undefined}>
                      {f.secret ? "🔒 " : ""}
                      {f.key}
                    </span>
                  ))}
                </td>
                <td>{t.in_use}</td>
                <td className="credential-actions">
                  {!t.builtin && (
                    <button className="secondary" onClick={() => start(t)}>
                      Edit
                    </button>
                  )}
                  <button className="secondary" onClick={() => start(t, true)}>
                    Copy
                  </button>
                  {!t.builtin && (
                    <button className="danger" onClick={() => remove(t)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
