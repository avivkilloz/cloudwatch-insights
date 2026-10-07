import { ChangeEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useState } from "react";
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
import { CardRow, CardSection } from "../SessionCard";

/*
 * Settings → Credentials (PLATFORM_PLAN.md §13.6): one tab, switching between
 * the credentials and their types. Admin-only, like the tabs beside it.
 *
 * Each list is a plain table whose rows open the item; everything you can do
 * to one (edit, test, grant, read its history, delete) is in the opened view,
 * laid out in the session card's sections -- a row of four buttons per line
 * made the lists ragged and noisy, and "Credential types" was a ninth Settings
 * tab that wrapped onto two lines.
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

type View = "credentials" | "types";

/** Credentials | Types, at the head of either list. */
function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Show">
      {(
        [
          ["credentials", "Credentials"],
          ["types", "Types"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          className={view === value ? "" : "secondary"}
          aria-pressed={view === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** A section of an opened credential or type: the session card's bordered card, with a title. */
function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <CardSection>
      <div className="credential-section-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </CardSection>
  );
}

/** An opened item's header: back to the list, its name, and what can be done to it. */
function ViewHead({ back, title, children }: { back: () => void; title: string; children?: ReactNode }) {
  return (
    <div className="credential-view-head">
      <button className="secondary" onClick={back}>
        ← Back
      </button>
      <h2>{title}</h2>
      <div className="credential-view-actions">{children}</div>
    </div>
  );
}

/** A table row that opens its item, by click or by Enter. */
function rowProps(open: () => void) {
  return {
    className: "credential-row",
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter") open();
    },
  };
}

export default function CredentialsSettings() {
  const [view, setView] = useState<View>("credentials");
  return (
    <div className="credentials-settings">
      {view === "credentials" ? <CredentialsView switcher={<ViewSwitch view={view} onChange={setView} />} /> : null}
      {view === "types" ? <TypesView switcher={<ViewSwitch view={view} onChange={setView} />} /> : null}
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
        <span className="credential-secret-mark">•••• set</span>
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
  /** Part of the draft like everything else, so Access is saved by Save, not on the spot. */
  grants: number[];
};

/** Who can use a credential, in a few words. Admin groups always can, so they're never listed. */
function accessSummary(c: Credential, grantable: UserGroup[]): string {
  if (c.scope === "group") return `${c.group_name ?? "Its group"} only`;
  const granted = grantable.filter((g) => c.grants.includes(g.id));
  if (granted.length === 0) return "Admins only";
  if (granted.length === grantable.length) return "All groups";
  return granted.map((g) => g.name).join(", ");
}

function TestStatus({ c, hasTest }: { c: Credential; hasTest: boolean }) {
  if (!hasTest) return <span className="muted">—</span>;
  const [state, word] = c.last_test_ok === true ? ["ok", "Passed"] : c.last_test_ok === false ? ["error", "Failed"] : ["none", "Not tested"];
  return (
    <span className={`credential-status ${state}`} title={c.last_test_message ?? undefined}>
      <span className="credential-status-dot" />
      {word}
    </span>
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

function CredentialsView({ switcher }: { switcher: ReactNode }) {
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [types, setTypes] = useState<CredentialType[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
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
      setLoaded(true);
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
  // Admin groups can use every credential already; granting to one would mean nothing.
  const grantable = groups.filter((g) => !g.is_admin);
  const enabled = !!status?.enabled;

  function close() {
    setDraft(null);
    setError(null);
  }

  function startNew() {
    const first = types[0];
    setNotice(null);
    setError(null);
    setHistory([]);
    setDraft({ id: null, name: "", description: "", type_id: first?.id ?? "", scope: "global", group_id: null, values: {}, grants: [] });
  }

  async function open(c: Credential) {
    setNotice(null);
    setError(null);
    setHistory([]);
    setDraft({
      id: c.id,
      name: c.name,
      description: c.description ?? "",
      type_id: c.type_id,
      scope: c.scope,
      group_id: c.group_id,
      values: { ...c.public_fields },
      grants: c.grants.filter((id) => grantable.some((g) => g.id === id)),
    });
    try {
      setHistory(await api.auditFor("credential", c.id));
    } catch (e) {
      setError(readableError(e));
    }
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
      if (draft.scope === "global") {
        const before = editing?.grants ?? [];
        for (const id of draft.grants.filter((g) => !before.includes(g))) await api.grantCredential(saved.id, id);
        for (const id of before.filter((g) => !draft.grants.includes(g) && grantable.some((x) => x.id === g)))
          await api.revokeCredential(saved.id, id);
      }
      // Saved first, tested second: a credential can be right and still fail
      // a test the platform can't complete (a network it can't reach).
      if (draftType.has_test) {
        const result = await api.testCredential(saved.id);
        setNotice(
          result.ok === false
            ? `Saved ${saved.name}, but the test failed: ${result.message}`
            : `Saved ${saved.name}. Test passed: ${result.message}`,
        );
      } else {
        setNotice(`Saved ${saved.name}.`);
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!editing) return;
    setError(null);
    setNotice(null);
    try {
      const result = await api.testCredential(editing.id);
      setNotice(result.ok === false ? `Test failed: ${result.message}` : `Test passed: ${result.message}`);
      await refresh();
      setHistory(await api.auditFor("credential", editing.id));
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function remove() {
    if (!editing) return;
    if (!confirm(`Delete the credential "${editing.name}"? Anything using it will stop working.`)) return;
    try {
      await api.deleteCredential(editing.id);
      setNotice(`Deleted ${editing.name}.`);
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

  if (draft && draftType !== undefined) {
    const ungranted = grantable.filter((g) => !draft.grants.includes(g.id));
    return (
      <div className="panel credential-view credential-editor">
        <ViewHead back={close} title={draft.id == null ? "New credential" : editing?.name ?? "Credential"}>
          {editing && draftType.has_test && (
            <button className="secondary" onClick={test} disabled={!enabled}>
              Test
            </button>
          )}
          {editing && (
            <button className="danger" onClick={remove}>
              Delete
            </button>
          )}
        </ViewHead>
        {messages}

        <Section title="Details">
          <CardRow label="Name">
            <input id="cred-name" type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </CardRow>
          <CardRow label="Description">
            <input
              id="cred-description"
              type="text"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </CardRow>
          <CardRow label="Type">
            {draft.id == null ? (
              <select id="cred-type" value={draft.type_id} onChange={(e) => setDraft({ ...draft, type_id: e.target.value, values: {} })}>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="credential-static">{draftType.label}</span>
            )}
          </CardRow>
          <CardRow label="Belongs to">
            {draft.id == null ? (
              <select
                id="cred-scope"
                value={draft.scope === "global" ? "global" : String(draft.group_id ?? "")}
                onChange={(e) =>
                  setDraft(
                    e.target.value === "global"
                      ? { ...draft, scope: "global", group_id: null }
                      : { ...draft, scope: "group", group_id: Number(e.target.value), grants: [] },
                  )
                }
              >
                <option value="global">Everyone it's granted to</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    Only {g.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="credential-static">
                {draft.scope === "global" ? "Everyone it's granted to" : `Only ${editing?.group_name ?? "its group"}`}
              </span>
            )}
          </CardRow>
        </Section>

        <Section title="Values">
          {draftType.fields.map((f) => (
            <CardRow key={f.key} label={`${f.label}${f.required ? " *" : ""}`}>
              <div className="credential-value">
                <FieldInput
                  key={`${draft.type_id}-${f.key}-${draft.id ?? "new"}`}
                  field={f}
                  value={draft.values[f.key]}
                  isSet={f.secret && !!editing?.secret_fields_set.includes(f.key)}
                  onChange={(v) => setDraft({ ...draft, values: { ...draft.values, [f.key]: v } })}
                />
                {f.help && <div className="muted">{f.help}</div>}
              </div>
            </CardRow>
          ))}
        </Section>

        {draft.scope === "global" && (
          <Section title="Access">
            <CardRow label="Groups">
              <div className="credential-grants">
                {grantable
                  .filter((g) => draft.grants.includes(g.id))
                  .map((g) => (
                    <span key={g.id} className="tag credential-grant" data-group={g.name}>
                      {g.name}
                      <button
                        type="button"
                        className="credential-grant-remove"
                        aria-label={`Remove ${g.name}`}
                        onClick={() => setDraft({ ...draft, grants: draft.grants.filter((id) => id !== g.id) })}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                {/* Always shown, even with nothing left to add: a picker that
                    vanished once every group had it read as a limit of two. */}
                <select
                  aria-label="Grant to a group"
                  className="credential-grant-add"
                  value=""
                  disabled={ungranted.length === 0}
                  onChange={(e) => e.target.value && setDraft({ ...draft, grants: [...draft.grants, Number(e.target.value)] })}
                >
                  <option value="">{ungranted.length === 0 ? "Every group has it" : "Add a group…"}</option>
                  {ungranted.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="muted credential-access-note">Admins can always use it.</div>
            </CardRow>
          </Section>
        )}

        {editing && (
          <Section title="History">
            {history.length === 0 ? (
              <p className="muted">Nothing recorded yet.</p>
            ) : (
              <table className="credential-history">
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="muted">{when(h.at)}</td>
                      <td>{h.actor_name ?? h.actor_kind}</td>
                      <td>{h.action.replace(/^credential\./, "")}</td>
                      <td className="muted">{describeDetail(h.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        )}

        <div className="row credential-view-foot">
          <button onClick={save} disabled={busy || !enabled || !draft.name.trim() || (draft.scope === "group" && draft.group_id == null)}>
            {draftType.has_test ? "Save and test" : "Save"}
          </button>
          <button className="secondary" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <OffNotice status={status} />
      <div className="panel credential-list">
        <div className="credential-list-head">
          {switcher}
          <span className="muted">Encrypted, and never shown again once saved.</span>
          <button onClick={startNew} disabled={!enabled || types.length === 0}>
            New credential
          </button>
        </div>
        {messages}
        {loaded && credentials.length === 0 && <p className="muted credential-empty">No credentials yet.</p>}
        {credentials.length > 0 && (
          <table className="credentials-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Access</th>
                <th>Test</th>
                <th>Last used</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.id} data-credential={c.name} {...rowProps(() => open(c))}>
                  <td>
                    <span className="credential-name">{c.name}</span>
                    {c.description && <div className="muted">{c.description}</div>}
                  </td>
                  <td>{c.type_label}</td>
                  <td className="credential-access">{accessSummary(c, grantable)}</td>
                  <td>
                    <TestStatus c={c} hasTest={!!typeById[c.type_id]?.has_test} />
                  </td>
                  <td className="muted">{when(c.last_used_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ types

type TypeDraft = CredentialTypeDraft & { isNew: boolean; builtin: boolean; in_use: number };

function emptyField(): CredentialField {
  return { key: "", label: "", kind: "text", secret: false, required: false, help: "" };
}

/** What a type's Advanced section holds, for its folded header. */
function advancedSummary(d: CredentialTypeDraft): string {
  const parts: string[] = [];
  if (d.output_template) parts.push("output template");
  if (d.inject) parts.push(`HTTP: ${d.inject.kind === "basic" ? "Basic" : d.inject.kind === "header" ? "header" : "query parameter"}`);
  if (d.http_test) parts.push("test request");
  return parts.length ? parts.join(" · ") : "nothing set";
}

function FieldNames({ fields }: { fields: CredentialField[] }) {
  return (
    <span className="credential-field-names">
      {fields.map((f, i) => (
        <span key={f.key}>
          {i > 0 && ", "}
          {f.key}
          {f.secret && (
            <span className="credential-lock" title="secret" aria-label="secret">
              {" "}
              🔒
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

function TypesView({ switcher }: { switcher: ReactNode }) {
  const [types, setTypes] = useState<CredentialType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<TypeDraft | null>(null);
  const [showBuiltins, setShowBuiltins] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [example, setExample] = useState("");
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setTypes(await api.listCredentialTypes());
      setLoaded(true);
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
    setExampleOpen(!from);
    setAdvancedOpen(false);
    setDraft(
      from
        ? {
            isNew: copy,
            builtin: from.builtin && !copy,
            in_use: copy ? 0 : from.in_use,
            id: copy ? `${from.id}_copy` : from.id,
            label: copy ? `${from.label} (copy)` : from.label,
            description: from.description,
            fields: from.fields.map((f) => ({ ...f })),
            output_template: from.output_template,
            inject: from.inject,
            http_test: from.http_test,
          }
        : {
            isNew: true,
            builtin: false,
            in_use: 0,
            id: "",
            label: "",
            description: "",
            fields: [emptyField()],
            output_template: null,
            inject: null,
            http_test: null,
          },
    );
  }

  function close() {
    setDraft(null);
    setError(null);
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
      setExampleOpen(false);
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
      setNotice(`Saved ${draft.label}.`);
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

  async function remove() {
    if (!draft) return;
    if (!confirm(`Delete the credential type "${draft.label}"?`)) return;
    try {
      await api.deleteCredentialType(draft.id);
      setNotice(`Deleted ${draft.label}.`);
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
    const locked = draft.builtin;
    const keys = draft.fields.map((f) => f.key).filter(Boolean);
    const inject = draft.inject;
    const setInject = (patch: Partial<CredentialInject> | null) =>
      setDraft({ ...draft, inject: patch === null ? null : ({ ...(inject ?? { kind: "header" }), ...patch } as CredentialInject) });
    const source = types.find((t) => t.id === draft.id);
    return (
      <div className="panel credential-view credential-type-editor">
        <ViewHead back={close} title={draft.isNew ? "New credential type" : draft.label}>
          {!draft.isNew && source && (
            <button className="secondary" onClick={() => start(source, true)}>
              Copy
            </button>
          )}
          {!draft.isNew && !locked && (
            <button className="danger" onClick={remove} disabled={draft.in_use > 0} title={draft.in_use > 0 ? "In use" : undefined}>
              Delete
            </button>
          )}
        </ViewHead>
        {locked && <p className="muted credential-locked">Built-in types can't be changed. Copy it to make your own.</p>}
        {messages}

        {/* A disabled fieldset is how a built-in type is shown read-only: every input inside goes with it. */}
        <fieldset className="credential-fieldset" disabled={locked}>
          <Section title="Details">
            <CardRow label="Id">
              {draft.isNew ? (
                <input id="type-id" type="text" value={draft.id} placeholder="acme_api" onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
              ) : (
                <code className="credential-static">{draft.id}</code>
              )}
            </CardRow>
            <CardRow label="Label">
              <input id="type-label" type="text" value={draft.label} placeholder="Acme API" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </CardRow>
            <CardRow label="Description">
              <input
                id="type-description"
                type="text"
                value={draft.description ?? ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </CardRow>
          </Section>

          <Section
            title="Fields"
            aside={
              !locked && (
                <button className="secondary" onClick={() => setExampleOpen(!exampleOpen)} aria-expanded={exampleOpen}>
                  Fill from an example…
                </button>
              )
            }
          >
            {exampleOpen && !locked && (
              <div className="credential-example">
                <textarea
                  className="credential-type-example"
                  rows={3}
                  value={example}
                  placeholder='Paste JSON shaped like the credential, e.g. {"username": "", "password": "", "region": "eu-west-1"}'
                  onChange={(e) => setExample(e.target.value)}
                  spellCheck={false}
                />
                <button onClick={infer} disabled={!example.trim()}>
                  Fill fields
                </button>
              </div>
            )}
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
                  {!locked && <th></th>}
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
                    <td className="credential-check">
                      <input aria-label="Secret" type="checkbox" checked={f.secret} onChange={(e) => setField(i, { secret: e.target.checked })} />
                    </td>
                    <td className="credential-check">
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
                    {!locked && (
                      <td>
                        <button
                          className="secondary"
                          aria-label="Remove field"
                          onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}
                        >
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!locked && (
              <div>
                <button className="secondary" onClick={() => setDraft({ ...draft, fields: [...draft.fields, emptyField()] })}>
                  Add field
                </button>
              </div>
            )}
          </Section>
        </fieldset>

        {/* Folded: most types never need any of it. What credentials of a
            type are used for belongs to whatever uses them (PLATFORM_PLAN.md
            D30); authenticating an HTTP request is only the commonest case,
            so it is an option here rather than the shape of the form. */}
        <CardSection>
          <button
            type="button"
            className="credential-advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            <span className={`chevron${advancedOpen ? " open" : ""}`}>▶</span>
            <h3>Advanced</h3>
            <span className="muted">{advancedSummary(draft)}</span>
          </button>
          {advancedOpen && (
            <fieldset className="credential-fieldset credential-advanced-body" disabled={locked}>
              <CardRow label="Output">
                <div className="credential-value">
                  <textarea
                    className="credential-type-template"
                    rows={3}
                    value={draft.output_template ?? ""}
                    placeholder='Empty: an object of the fields. Or CEL, e.g. {"auth": {"user": username, "pass": password}}'
                    onChange={(e) => setDraft({ ...draft, output_template: e.target.value })}
                    spellCheck={false}
                  />
                  <div className="muted">What a pane or workflow receives from a credential of this type.</div>
                </div>
              </CardRow>
              <CardRow label="Preview">
                <div className="credential-preview">
                  <textarea
                    rows={2}
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
              </CardRow>
              <CardRow label="HTTP requests">
                <select
                  id="inject-kind"
                  value={inject?.kind ?? ""}
                  onChange={(e) => setInject(e.target.value === "" ? null : { kind: e.target.value as CredentialInject["kind"] })}
                >
                  <option value="">Not used to sign requests</option>
                  <option value="header">Sends a header</option>
                  <option value="basic">Basic authentication</option>
                  <option value="query">Adds a query parameter</option>
                </select>
              </CardRow>
              {inject && inject.kind !== "basic" && (
                <>
                  <CardRow label={inject.kind === "header" ? "Header" : "Parameter"}>
                    <input
                      id="inject-name"
                      type="text"
                      value={inject.name ?? ""}
                      placeholder={inject.name_from ? `from the field ${inject.name_from}` : inject.kind === "header" ? "Authorization" : "api_key"}
                      onChange={(e) => setInject({ name: e.target.value })}
                    />
                  </CardRow>
                  <CardRow label="Value">
                    <input id="inject-value" type="text" value={inject.value ?? ""} placeholder={'"Bearer " + token'} onChange={(e) => setInject({ value: e.target.value })} />
                  </CardRow>
                </>
              )}
              {inject?.kind === "basic" && (
                <>
                  <CardRow label="Username">
                    <input id="inject-username" type="text" value={inject.username ?? ""} placeholder="username" onChange={(e) => setInject({ username: e.target.value })} />
                  </CardRow>
                  <CardRow label="Password">
                    <input id="inject-password" type="text" value={inject.password ?? ""} placeholder="password" onChange={(e) => setInject({ password: e.target.value })} />
                  </CardRow>
                </>
              )}
              <CardRow label="Test request">
                <div className="credential-value">
                  <div className="credential-test-request">
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
                      placeholder={'"https://" + host + "/me"'}
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
                  <div className="muted">
                    Sent on save; any 2xx passes. Empty: no test. The values above are CEL over the fields: text goes in
                    double quotes.
                  </div>
                </div>
              </CardRow>
            </fieldset>
          )}
        </CardSection>

        <div className="row credential-view-foot">
          {!locked && (
            <button onClick={() => save()} disabled={busy || !draft.id.trim() || !draft.label.trim()}>
              Save type
            </button>
          )}
          <button className="secondary" onClick={close}>
            {locked ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    );
  }

  const own = types.filter((t) => !t.builtin);
  const builtins = types.filter((t) => t.builtin);
  const row = (t: CredentialType) => (
    <tr key={t.id} data-credential-type={t.id} {...rowProps(() => start(t))}>
      <td>
        <span className="credential-name">{t.label}</span>
        {t.description && <div className="muted">{t.description}</div>}
      </td>
      <td>
        <FieldNames fields={t.fields} />
      </td>
      <td className="credential-count">{t.in_use}</td>
    </tr>
  );
  return (
    <div className="panel credential-list">
      <div className="credential-list-head">
        {switcher}
        <span className="muted">The fields a kind of credential has, and which are secret.</span>
        <button onClick={() => start()}>New type</button>
      </div>
      {messages}
      {loaded && (
        <table className="credential-types-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Fields</th>
              <th className="credential-count">Credentials</th>
            </tr>
          </thead>
          <tbody>
            {own.map(row)}
            {own.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  None of your own yet: start one with New type, or open a built-in one and copy it.
                </td>
              </tr>
            )}
            <tr className="credential-builtins-toggle">
              <td colSpan={3}>
                <button className="link-button" onClick={() => setShowBuiltins(!showBuiltins)} aria-expanded={showBuiltins}>
                  <span className={`chevron${showBuiltins ? " open" : ""}`}>▶</span> Built-in types ({builtins.length})
                </button>
              </td>
            </tr>
            {showBuiltins && builtins.map(row)}
          </tbody>
        </table>
      )}
    </div>
  );
}
