import { useState } from "react";
import { SavedSession } from "../api";
import { PublishForm } from "./PublishedTemplatesPanel";
import { useTemplates } from "../sessions/templates";

// Session templates, their whole state edited as JSON. The per-pane stores
// that once shared this panel -- the HTTP client's requests (3b-2), the MQTT
// tester's topics (3b-5) -- moved into saved inputs, and their forms with them.

interface Props {
  description: string;
  items: SavedSession[];
  onUpdate: (id: number, payload: { name?: string; state?: Record<string, unknown> }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** An admin may publish a template for everyone (§23). */
  canPublish?: boolean;
}

/** A collapsed row is its name alone: a template's state is a whole session,
 * and printing it beside the name filled the row with braces and squeezed the
 * name -- the thing you are looking for -- down to nothing. Expanding the row
 * shows it, in the editor that can also change it. */
export default function SavedSessionEditorPanel({ description, items, onUpdate, onDelete, canPublish }: Props) {
  const [publishing, setPublishing] = useState<number | null>(null);
  // Which of these were published (Add offers the published one instead).
  const { published } = useTemplates();
  const publishedAs = new Map(published.map((t) => [t.from_saved_session_id, t.label]));
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editJsonText, setEditJsonText] = useState("");
  const [editJsonError, setEditJsonError] = useState<string | null>(null);

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startEdit(item: SavedSession) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditJsonText(JSON.stringify(item.state, null, 2));
    setEditJsonError(null);
    setExpanded((prev) => new Set(prev).add(item.id));
  }

  async function saveEdit(id: number) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(editJsonText);
    } catch {
      setEditJsonError("Invalid JSON.");
      return;
    }
    await onUpdate(id, { name: editName, state: parsed });
    setEditingId(null);
  }

  async function remove(id: number) {
    if (!confirm("Delete this saved item?")) return;
    await onDelete(id);
  }

  return (
    <div>
      <p className="muted">{description}</p>
      {items.length === 0 && <p className="muted">None saved yet.</p>}
      {items.map((item) => {
        const isOpen = expanded.has(item.id);
        const isEditing = editingId === item.id;
        return (
          <div className="result-row" key={item.id} style={{ marginBottom: 8 }}>
            <div className="result-row-summary" onClick={() => toggleExpanded(item.id)}>
              <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
              <span className="msg">{item.name}</span>
              {publishedAs.has(item.id) && (
                <span className="tag" title={`Published as "${publishedAs.get(item.id)}": Add offers that one instead`}>
                  Published
                </span>
              )}
            </div>
            {isOpen && (
              <div className="result-row-detail">
                {isEditing ? (
                  <>
                    <span className="field-label">Name</span>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{ width: "100%", marginBottom: 8 }}
                    />
                    <textarea
                      rows={10}
                      value={editJsonText}
                      onChange={(e) => setEditJsonText(e.target.value)}
                      style={{ width: "100%", fontFamily: "monospace", fontSize: 12.5 }}
                    />
                    {editJsonError && <p className="error-text">{editJsonError}</p>}
                    <div className="toolbar" style={{ marginTop: 10 }}>
                      <button onClick={() => saveEdit(item.id)} disabled={!editName.trim()}>
                        Save
                      </button>
                      <button className="secondary" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : publishing === item.id ? (
                  <PublishForm item={item} onDone={() => setPublishing(null)} />
                ) : (
                  <>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {JSON.stringify(item.state, null, 2)}
                    </pre>
                    <div className="toolbar" style={{ marginTop: 10 }}>
                      <button className="secondary" onClick={() => startEdit(item)}>
                        Edit
                      </button>
                      {canPublish && item.page === "aggregator" && (
                        <button className="secondary" onClick={() => setPublishing(item.id)}>
                          Publish…
                        </button>
                      )}
                      <button className="danger" onClick={() => remove(item.id)}>
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
