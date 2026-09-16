import { useState } from "react";
import { SavedSession } from "../api";

interface Props {
  items: SavedSession[];
  onRename: (id: number, name: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

const PAGE_LABELS: Record<string, string> = {
  logs: "Logs",
  iot: "IoT",
};

export default function SavedSessionsPanel({ items, onRename, onDelete }: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

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
    setExpanded((prev) => new Set(prev).add(item.id));
  }

  async function saveEdit(id: number) {
    await onRename(id, editName);
    setEditingId(null);
  }

  async function remove(id: number) {
    if (!confirm("Delete this saved session?")) return;
    await onDelete(id);
  }

  return (
    <div className="panel">
      <h2>Saved sessions</h2>
      <p className="muted">
        A full working-state snapshot from the Logs or IoT page — environments, filters, query, and so on — saved
        via each page's "Save session" button. Rename or delete them here; to change what a session actually
        contains, load it on its page, adjust it, and save it again.
      </p>

      {items.length === 0 && <p className="muted">None saved yet.</p>}
      {items.map((item) => {
        const isOpen = expanded.has(item.id);
        const isEditing = editingId === item.id;
        return (
          <div className="result-row" key={item.id} style={{ marginBottom: 8 }}>
            <div className="result-row-summary" onClick={() => toggleExpanded(item.id)}>
              <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
              <span className="tag">{PAGE_LABELS[item.page] ?? item.page}</span>
              <span className="msg">{item.name}</span>
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
                        Rename
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
