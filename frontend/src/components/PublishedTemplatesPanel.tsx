import { useEffect, useState } from "react";
import { api, PublishedTemplate, readableError, SavedSession } from "../api";
import { useTemplates } from "../sessions/templates";
import { StoreBadge } from "./settings/StoreSettings";

/*
 * Published templates (PLATFORM_PLAN.md §23, D99-D102): a saved template made
 * plugin content -- an admin's to publish, offered to every group that may use
 * each of its panes, kept in the store repo. Publishing makes it portable and
 * says, in words, what that changed: whoever opens it chooses the
 * environment, so nothing of this platform's own connections, credentials or
 * secrets goes with it.
 */

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(s) ? s.slice(0, 60) : `t_${s}`.slice(0, 60);
}

/** Publish… under a saved template: its id, name and description, then what
 * making it portable changed. */
export function PublishForm({ item, onDone }: { item: SavedSession; onDone: () => void }) {
  const { reload } = useTemplates();
  const [id, setId] = useState(slug(item.name));
  const [label, setLabel] = useState(item.name);
  const [description, setDescription] = useState(typeof item.state.description === "string" ? item.state.description : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<(PublishedTemplate & { changes: string[] }) | null>(null);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.publishTemplate({ saved_session_id: item.id, id, label, description });
      setPublished(out);
      reload();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  if (published) {
    return (
      <div className="publish-form" data-published={published.id}>
        <p>
          Published as <strong>{published.label}</strong> ({published.id}): offered to every group that may use each of
          its panes.
        </p>
        {published.changes.length > 0 && (
          <>
            <span className="field-label">Made to work anywhere</span>
            <ul className="publish-changes">
              {published.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
        <div className="toolbar">
          <button className="secondary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="publish-form">
      <p className="muted">
        Publishing makes a copy anyone may start from, whose groups have its panes. It's made to work in any
        environment: its AWS panes follow the session's Environment variable, chosen when it's opened, and what names
        this platform's own connections, credentials or secrets is left out -- you'll see what.
      </p>
      <label className="field-label" htmlFor={`publish-id-${item.id}`}>
        Id
      </label>
      <input id={`publish-id-${item.id}`} type="text" value={id} onChange={(e) => setId(e.target.value)} />
      <label className="field-label" htmlFor={`publish-label-${item.id}`}>
        Name
      </label>
      <input id={`publish-label-${item.id}`} type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      <label className="field-label" htmlFor={`publish-description-${item.id}`}>
        Description
      </label>
      <textarea
        id={`publish-description-${item.id}`}
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && <p className="error-text">{error}</p>}
      <div className="toolbar">
        <button onClick={publish} disabled={busy || !id.trim() || !label.trim()}>
          {busy ? "Publishing…" : "Publish"}
        </button>
        <button className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The Library's Published tab: every published template, to rename or unpublish. */
export default function PublishedTemplatesPanel() {
  const { reload } = useTemplates();
  const [items, setItems] = useState<PublishedTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string; description: string } | null>(null);

  const load = () =>
    api
      .listPublishedTemplates()
      .then(setItems)
      .catch((e) => setError(readableError(e)));
  useEffect(() => {
    load();
  }, []);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setEditing(null);
      await load();
      reload();
    } catch (e) {
      setError(readableError(e));
    }
  }

  return (
    <div>
      <p className="muted">
        Templates published for everyone: offered on the default page and in Add to every group that may use each of
        their panes, and kept in the store repo when one is set up. Publish one from Templates.
      </p>
      {error && <p className="error-text">{error}</p>}
      {items !== null && items.length === 0 && <p className="muted">None published yet.</p>}
      {(items ?? []).map((t) => (
        <div className="result-row" key={t.id} style={{ marginBottom: 8 }} data-published={t.id}>
          <div className="result-row-summary">
            <span className="msg">{t.label}</span>
            <span className="muted">{t.id}</span>
            <StoreBadge state={t.store_state} />
          </div>
          <div className="result-row-detail">
            {editing?.id === t.id ? (
              <>
                <span className="field-label">Name</span>
                <input type="text" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
                <span className="field-label">Description</span>
                <textarea
                  rows={2}
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
                <div className="toolbar" style={{ marginTop: 10 }}>
                  <button
                    onClick={() =>
                      act(() => api.updatePublishedTemplate(t.id, { label: editing.label, description: editing.description }))
                    }
                    disabled={!editing.label.trim()}
                  >
                    Save
                  </button>
                  <button className="secondary" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                {t.description && <p style={{ margin: "0 0 6px" }}>{t.description}</p>}
                <p className="muted" style={{ margin: 0 }}>
                  Panes: {t.pane_types.join(", ")}
                  {t.needs_environment ? " · asks for an environment when opened" : ""}
                </p>
                <div className="toolbar" style={{ marginTop: 10 }}>
                  <button
                    className="secondary"
                    onClick={() => setEditing({ id: t.id, label: t.label, description: t.description ?? "" })}
                  >
                    Edit
                  </button>
                  <button
                    className="danger"
                    onClick={() => confirm(`Unpublish "${t.label}"? Nobody will be offered it any more.`) && act(() => api.unpublishTemplate(t.id))}
                  >
                    Unpublish
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
