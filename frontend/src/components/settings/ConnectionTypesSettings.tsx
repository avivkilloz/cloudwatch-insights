import BuildMembers from "../BuildMembers";
import { useAuth } from "../../AuthContext";
import { ReactNode, useEffect, useRef, useState } from "react";
import { api, ConnectionType, ConnectionTypeDraft, readableError } from "../../api";
import { CardRow } from "../SessionCard";
import Icon from "../Icon";
import { rowProps, Section, ViewHead, ViewSwitch } from "./settingsLayout";
import { StoreBadge, useStoreNamespace } from "./StoreSettings";
import TypeYaml, { TypeData, typeText } from "./TypeYaml";
import TypeDraft, { readType } from "./TypeDraft";
import { DraftState, draftTime, useDraftList } from "../../pages/buildDraft";

/*
 * Settings → Environments → Types (PLATFORM_PLAN.md §19.3, D67): the kinds of
 * connection an environment can hold. Besides AWS, every one is an HTTP API
 * of a kind -- a Base URL, then whatever plain fields its connections need --
 * signed with any credential type that knows how to sign a request. A pane's
 * manifest can ship the type it reaches (Prometheus does); it's then the
 * admin's to rename or add fields to, like one made here.
 *
 * The Builder's Connections shows the same editor (D158): builders make types
 * for their own group, and the server says why one is locked to them.
 */

const EDIT_AS = [
  ["form", "Form"],
  ["yaml", "YAML"],
] as const;

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

/** Its definition as the store's file has it: the YAML view and the draft's text (D159). */
function connectionData(d: Draft): TypeData {
  return { id: d.id, label: d.label, description: d.description, fields: d.fields };
}

function withData(draft: Draft, d: TypeData): Draft {
  return {
    ...draft,
    id: draft.existing ? draft.id : String(d.id ?? draft.id ?? ""),
    label: String(d.label ?? ""),
    description: (d.description as string | null | undefined) ?? null,
    fields: ((d.fields as unknown[] | undefined) ?? []).map((f) => ({
      key: "", label: "", help: "", required: false,
      ...(f && typeof f === "object" ? (f as Partial<Draft["fields"][number]>) : {}),
    })),
  };
}

function originText(t: ConnectionType): string {
  if (t.builtin) return "Built in";
  if (t.origin?.startsWith("manifest:")) return `From the ${t.needed_by[0] ?? t.origin.slice(9)} pane`;
  return t.owner ?? "Admins";
}

export default function ConnectionTypesSettings({ switcher, intro, make }: { switcher: ReactNode; intro?: string; make?: string }) {
  // Making a new one is a Builder's (D161); changing one, its owner's and members'.
  const maker = !!useAuth().user?.builder_enabled;
  const [types, setTypes] = useState<ConnectionType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [editAs, setEditAs] = useState<"form" | "yaml">("form");
  // The open editor's draft (D159): as for a credential type's.
  const [fromDraft, setFromDraft] = useState<number | null>(null);
  const [baseText, setBaseText] = useState("");
  const [opened, setOpened] = useState(0);
  const [yamlKey, setYamlKey] = useState(0);
  const drafts = useDraftList("connection", opened * 2 + (draft ? 1 : 0));
  const keeper = useRef<DraftState | null>(null);
  // The open editor's draft id: a new one's members are kept on it (D161).
  const [keptId, setKeptId] = useState<number | null>(null);
  const namespace = useStoreNamespace();

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
    // "Make it" from a draft's Needs line (D159): a new type of that id, open.
    if (make) {
      start();
      setDraft((d) => (d ? { ...d, id: make } : d));
    }
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = draft?.existing ? types.find((t) => t.id === draft.id) ?? null : null;
  // Built in, or another group's (D158): the server says which.
  const lockedWhy = open?.builtin ? null : open?.locked ?? null;
  const locked = !!open?.builtin || !!lockedWhy;

  function start(t?: ConnectionType, draftId: number | null = null) {
    setNotice(null);
    setError(null);
    setEditAs("form");
    setFromDraft(draftId);
    setOpened((n) => n + 1);
    const next = draftOf(t);
    setDraft(next);
    setBaseText(typeText(connectionData(next)));
  }

  /** Text read into the form: a draft put back, a change made elsewhere, a proposal. */
  function takeText(text: string, newId?: string) {
    const data = readType(text);
    if (!data) return;
    setDraft((d) => (d ? withData({ ...d, id: !d.existing && newId ? newId : d.id }, data) : d));
    setYamlKey((k) => k + 1);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const body: ConnectionTypeDraft = { label: draft.label, description: draft.description || null, fields: draft.fields };
      const saved = draft.existing ? await api.updateConnectionType(draft.id!, body) : await api.createConnectionType({ ...body, id: draft.id });
      // The draft keeps only its chat, now the saved one's (D125).
      await keeper.current?.finish(saved.id, typeText(connectionData({ ...draft, id: saved.id })));
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
    const asData = connectionData(draft);
    const fromData = (d: TypeData) => setDraft(withData(draft, d));
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
          {!open?.builtin && <ViewSwitch views={EDIT_AS} view={editAs} onChange={setEditAs} />}
        </ViewHead>
        {lockedWhy && <p className="muted credential-locked">{lockedWhy}</p>}
        {messages}
        {!open?.builtin && (
          <TypeDraft
            key={opened}
            kind="connection"
            targetId={draft.existing ? draft.id ?? null : null}
            draftId={fromDraft}
            base={baseText}
            source={typeText(asData)}
            newId={draft.existing ? "" : draft.id ?? ""}
            title={draft.label || "New connection type"}
            editable={!locked}
            onText={takeText}
            onProposed={(text, summary) => {
              takeText(text);
              setNotice(`The agent's version is in the editor, unsaved: ${summary}`);
            }}
            keeper={keeper}
            onDraftId={setKeptId}
          />
        )}
        {editAs === "yaml" && (
          <TypeYaml key={yamlKey} id="connection-type-yaml" data={asData} onData={fromData} readOnly={locked} />
        )}
        <fieldset disabled={locked} className="credential-fieldset" hidden={editAs === "yaml"}>
          <Section title="Details">
            <CardRow label="Id">
              {draft.existing ? (
                <span className="credential-static">{draft.id}</span>
              ) : (
                <div className="store-id">
                  {/* What's made here is named in the store's namespace (D78). */}
                  {namespace && <span className="store-id-prefix">{namespace}:</span>}
                  <input
                    id="connection-type-id"
                    type="text"
                    value={draft.id}
                    placeholder="e.g. grafana"
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  />
                </div>
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
        {/* Who changes it (D161): its owner, the members they add, admins. */}
        {!locked && (
          <BuildMembers kind="connection" target={draft.existing ? draft.id ?? null : keptId !== null ? `draft:${keptId}` : null} />
        )}
      </div>
    );
  }

  return (
    <div className="panel credential-list">
      <div className="credential-list-head">
        {switcher}
        <span className="muted">{intro ?? "The kinds of connection an environment can hold."}</span>
        {maker && <button onClick={() => start()}>New connection type</button>}
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
            {drafts.fresh.map((d) => (
              <tr key={`draft-${d.id}`} data-draft={d.id} {...rowProps(() => start(undefined, d.id))}>
                <td colSpan={4}>
                  {d.label || <span className="muted">Untitled</span>}
                  <span className="tag pending builder-draft-tag" title="Not made yet: only you see it">
                    Draft
                  </span>{" "}
                  <span className="muted">you · {draftTime(d)}</span>
                </td>
              </tr>
            ))}
            {types.map((t) => (
              <tr key={t.id} data-connection-type={t.id} {...rowProps(() => start(t))}>
                <td>
                  {t.label} <StoreBadge state={t.store_state} />
                  {drafts.changed.has(t.id) && (
                    <span className="tag pending builder-draft-tag" title={`Your unsaved changes, from ${draftTime(drafts.changed.get(t.id)!)}`}>
                      Draft
                    </span>
                  )}
                </td>
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
