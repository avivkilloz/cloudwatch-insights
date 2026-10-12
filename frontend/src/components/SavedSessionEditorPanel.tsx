import { useState } from "react";
import { SavedSession } from "../api";

// The HTTP client's saved requests moved into saved inputs (3b-2), and its
// editor with them.
export type SessionEditorKind = "mqtt-topic" | "json";

interface MqttTopicState {
  topic: string;
}

interface Props {
  description: string;
  kind: SessionEditorKind;
  items: SavedSession[];
  onCreate: (name: string, state: Record<string, unknown>) => Promise<void>;
  onUpdate: (id: number, payload: { name?: string; state?: Record<string, unknown> }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

function emptyStateFor(kind: SessionEditorKind): Record<string, unknown> {
  if (kind === "mqtt-topic") return { topic: "" } satisfies MqttTopicState;
  return {};
}

/** The one line beside the name on a collapsed row, or "" for none.
 *
 * A JSON state has no such line: it is a page's whole saved state, and
 * printing it here filled the row with braces and squeezed the name --
 * the thing you are actually looking for -- down to nothing. Expanding the
 * row is what shows it, in the editor that can also change it. */
function summaryFor(kind: SessionEditorKind, state: Record<string, unknown>): string {
  if (kind === "mqtt-topic") {
    return String((state as unknown as MqttTopicState).topic ?? "");
  }
  return "";
}

export default function SavedSessionEditorPanel({ description, kind, items, onCreate, onUpdate, onDelete }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editState, setEditState] = useState<Record<string, unknown>>({});
  const [editJsonText, setEditJsonText] = useState("");
  const [editJsonError, setEditJsonError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newState, setNewState] = useState<Record<string, unknown>>(emptyStateFor(kind));

  const supportsAdd = kind !== "json";

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
    if (kind === "json") {
      setEditJsonText(JSON.stringify(item.state, null, 2));
      setEditJsonError(null);
    } else {
      setEditState(item.state);
    }
    setExpanded((prev) => new Set(prev).add(item.id));
  }

  async function saveEdit(id: number) {
    if (kind === "json") {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(editJsonText);
      } catch {
        setEditJsonError("Invalid JSON.");
        return;
      }
      await onUpdate(id, { name: editName, state: parsed });
    } else {
      await onUpdate(id, { name: editName, state: editState });
    }
    setEditingId(null);
  }

  async function addNew() {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await onCreate(newName.trim(), newState);
      setNewName("");
      setNewState(emptyStateFor(kind));
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this saved item?")) return;
    await onDelete(id);
  }

  return (
    <div>
      <p className="muted">{description}</p>

      {supportsAdd && (
        <div style={{ marginBottom: 14 }}>
          <span className="field-label">Name</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: "100%", maxWidth: 320, marginBottom: 8, display: "block" }}
          />
          {kind === "mqtt-topic" && (
            <input
              type="text"
              placeholder="topic/#"
              value={(newState as unknown as MqttTopicState).topic}
              onChange={(e) => setNewState({ topic: e.target.value })}
              style={{ width: "100%" }}
            />
          )}
          <button onClick={addNew} disabled={adding || !newName.trim()} style={{ marginTop: 8 }}>
            Add
          </button>
        </div>
      )}

      {items.length === 0 && <p className="muted">None saved yet.</p>}
      {items.map((item) => {
        const isOpen = expanded.has(item.id);
        const isEditing = editingId === item.id;
        return (
          <div className="result-row" key={item.id} style={{ marginBottom: 8 }}>
            <div className="result-row-summary" onClick={() => toggleExpanded(item.id)}>
              <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
              <span className="msg">{item.name}</span>
              {!isOpen && summaryFor(kind, item.state) && (
                <span className="muted saved-item-summary">{summaryFor(kind, item.state)}</span>
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
                    {kind === "mqtt-topic" && (
                      <input
                        type="text"
                        value={(editState as unknown as MqttTopicState).topic}
                        onChange={(e) => setEditState({ topic: e.target.value })}
                        style={{ width: "100%" }}
                      />
                    )}
                    {kind === "json" && (
                      <>
                        <textarea
                          rows={10}
                          value={editJsonText}
                          onChange={(e) => setEditJsonText(e.target.value)}
                          style={{ width: "100%", fontFamily: "monospace", fontSize: 12.5 }}
                        />
                        {editJsonError && <p className="error-text">{editJsonError}</p>}
                      </>
                    )}
                    <div className="toolbar" style={{ marginTop: 10 }}>
                      <button onClick={() => saveEdit(item.id)} disabled={!editName.trim()}>
                        Save
                      </button>
                      <button className="secondary" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {JSON.stringify(item.state, null, 2)}
                    </pre>
                    <div className="toolbar" style={{ marginTop: 10 }}>
                      <button className="secondary" onClick={() => startEdit(item)}>
                        Edit
                      </button>
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
