import { ReactNode, useEffect, useState } from "react";
import { api, ConnectionType, ConnectionTypeDraft, readableError } from "../../api";
import { CardRow } from "../SessionCard";
import Icon from "../Icon";
import { rowProps, Section, ViewHead } from "./settingsLayout";

/*
 * Settings → Environments → Types (PLATFORM_PLAN.md §19.3, D67): the kinds of
 * connection an environment can hold. Besides AWS, every one is an HTTP API
 * of a kind -- a Base URL, then whatever plain fields its connections need --
 * signed with any credential type that knows how to sign a request. A pane's
 * manifest can ship the type it reaches (Prometheus does); it's then the
 * admin's to rename or add fields to, like one made here.
 */

type Draft = ConnectionTypeDraft & { existing: boolean };

function draftOf(t?: ConnectionType): Draft {
  return {
    existing: !!t,
    id: t?.id ?? "",
    label: t?.label ?? "",
    description: t?.description ?? "",
    fields: (t?.fields ?? []).filter((f) => f.key !== "base_url").map((f) => ({ key: f.key, label: f.label, help: f.help, required: f.required })),
  };
}

function originText(t: ConnectionType): string {
  if (t.builtin) return "Built in";
  if (t.origin?.startsWith("manifest:")) return `From the ${t.needed_by[0] ?? t.origin.slice(9)} pane`;
  return "Yours";
}

export default function ConnectionTypesSettings({ switcher }: { switcher: ReactNode }) {
  const [types, setTypes] = useState<ConnectionType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setTypes(await api.listConnectionTypes());
      setLoaded(true);
    } catch (e) {
      setError(readableError(e));
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  const open = draft?.existing ? types.find((t) => t.id === draft.id) ?? null : null;
  const locked = !!open?.builtin;

  function start(t?: ConnectionType) {
    setNotice(null);
    setError(null);
    setDraft(draftOf(t));
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body: ConnectionTypeDraft = { label: draft.label, description: draft.description || null, fields: draft.fields };
      const saved = draft.existing ? await api.updateConnectionType(draft.id!, body) : await api.createConnectionType({ ...body, id: draft.id });
      setNotice(`Saved ${saved.label}.`);
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!open || !window.confirm(`Delete the ${open.label} connection type?`)) return;
    setBusy(true);
    try {
      await api.deleteConnectionType(open.id);
      setNotice(`Deleted ${open.label}.`);
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  const messages = (
    <>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="muted">{notice}</p>}
    </>
  );

  if (draft) {
    const setField = (i: number, patch: Partial<Draft["fields"][number]>) =>
      setDraft({ ...draft, fields: draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
    // Why it can't be deleted, said up front rather than on a refused click.
    const keeps = open && (open.connections > 0 || open.needed_by.length > 0);
    return (
      <div className="panel credential-view connection-type-editor">
        <ViewHead back={() => setDraft(null)} title={draft.existing ? open?.label ?? draft.label : "New connection type"}>
          {open && !locked && (
            <button
              className="danger"
              onClick={remove}
              disabled={busy || !!keeps}
              title={
                keeps
                  ? [open.connections ? `${open.connections} connection${open.connections === 1 ? " is" : "s are"} of it` : "",
                     open.needed_by.length ? `${open.needed_by.join(", ")} reach${open.needed_by.length === 1 ? "es" : ""} it` : ""]
                      .filter(Boolean)
                      .join("; ")
                  : "Delete"
              }
            >
              Delete
            </button>
          )}
        </ViewHead>
        {messages}
        <fieldset disabled={locked} className="credential-fieldset">
          <Section title="Details">
            <CardRow label="Id">
              {draft.existing ? (
                <span className="credential-static">{draft.id}</span>
              ) : (
                <input
                  id="connection-type-id"
                  type="text"
                  value={draft.id}
                  placeholder="e.g. grafana"
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              )}
            </CardRow>
            <CardRow label="Name">
              <input id="connection-type-name" type="text" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </CardRow>
            <CardRow label="Description">
              <input
                type="text"
                value={draft.description ?? ""}
                placeholder="What connections of this type reach"
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </CardRow>
          </Section>
          <Section title="Fields">
            {locked ? (
              open!.fields.map((f) => (
                <CardRow key={f.key} label={f.label}>
                  <span className="credential-static">{f.help || f.key}</span>
                </CardRow>
              ))
            ) : (
              <>
                {/* Always first, and the same for every type: it's what makes
                    one reachable over HTTP. */}
                <CardRow label="Base URL">
                  <span className="credential-static">Always there: where requests go.</span>
                </CardRow>
                {draft.fields.map((f, i) => (
                  <CardRow key={i} label={f.label || f.key || "New field"}>
                    <div className="row connection-type-field">
                      <input type="text" aria-label="Field key" placeholder="key" value={f.key} onChange={(e) => setField(i, { key: e.target.value })} />
                      <input type="text" aria-label="Field label" placeholder="Label" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                      <input type="text" aria-label="Field help" placeholder="Help" value={f.help} onChange={(e) => setField(i, { help: e.target.value })} />
                      <label className="checkbox-item">
                        <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                        Required
                      </label>
                      <button
                        className="secondary icon-btn"
                        aria-label={`Remove ${f.label || f.key || "this field"}`}
                        title="Remove"
                        onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  </CardRow>
                ))}
                <CardRow label="">
                  <button
                    className="secondary"
                    onClick={() => setDraft({ ...draft, fields: [...draft.fields, { key: "", label: "", help: "", required: false }] })}
                  >
                    + Field
                  </button>
                </CardRow>
                <p className="muted connection-type-note">
                  Plain settings only: a secret belongs in a credential, which signs the requests.
                </p>
              </>
            )}
          </Section>
        </fieldset>
        {!locked && (
          <div className="row credential-view-foot">
            <button onClick={save} disabled={busy || !draft.label.trim() || (!draft.existing && !draft.id?.trim())}>
              {draft.existing ? "Save" : "Create"}
            </button>
            <button className="secondary" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="panel credential-list">
      <div className="credential-list-head">
        {switcher}
        <span className="muted">The kinds of connection an environment can hold.</span>
        <button onClick={() => start()}>New connection type</button>
      </div>
      {messages}
      {loaded && (
        <table className="credentials-table connection-types-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Fields</th>
              <th>From</th>
              <th>Connections</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id} data-connection-type={t.id} {...rowProps(() => start(t))}>
                <td>{t.label}</td>
                <td>{t.fields.map((f) => f.label).join(", ")}</td>
                <td>{originText(t)}</td>
                <td>{t.connections}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
