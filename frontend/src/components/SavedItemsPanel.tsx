import { useState } from "react";

export interface SavedItem {
  id: number;
  name: string;
  query_string: string;
}

export interface ExtraSelectField<T> {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue: string;
  getValue: (item: T) => string;
}

interface Props<T extends SavedItem> {
  description: string;
  queryLabel: string;
  items: T[];
  onCreate: (payload: { name: string; query_string: string } & Record<string, string>) => Promise<void>;
  onUpdate: (id: number, payload: { name: string; query_string: string } & Record<string, string>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** Optional extra dropdown field (e.g. a search-mode selector for IoT searches). */
  extra?: ExtraSelectField<T>;
}

export default function SavedItemsPanel<T extends SavedItem>({
  description,
  queryLabel,
  items,
  onCreate,
  onUpdate,
  onDelete,
  extra,
}: Props<T>) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editQuery, setEditQuery] = useState("");
  const [editExtra, setEditExtra] = useState(extra?.defaultValue ?? "");

  const [newName, setNewName] = useState("");
  const [newQuery, setNewQuery] = useState("");
  const [newExtra, setNewExtra] = useState(extra?.defaultValue ?? "");
  const [adding, setAdding] = useState(false);

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startEdit(item: T) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditQuery(item.query_string);
    setEditExtra(extra ? extra.getValue(item) : "");
    setExpanded((prev) => new Set(prev).add(item.id));
  }

  async function saveEdit(id: number) {
    const payload: { name: string; query_string: string } & Record<string, string> = {
      name: editName,
      query_string: editQuery,
    };
    if (extra) payload[extra.key] = editExtra;
    await onUpdate(id, payload);
    setEditingId(null);
  }

  async function addNew() {
    if (!newName.trim() || !newQuery.trim()) return;
    setAdding(true);
    try {
      const payload: { name: string; query_string: string } & Record<string, string> = {
        name: newName.trim(),
        query_string: newQuery,
      };
      if (extra) payload[extra.key] = newExtra;
      await onCreate(payload);
      setNewName("");
      setNewQuery("");
      setNewExtra(extra?.defaultValue ?? "");
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

      <div className="row" style={{ marginBottom: 10, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <span className="field-label">Name</span>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: "100%" }} />
        </div>
        <div style={{ flex: 2, minWidth: 240 }}>
          <span className="field-label">{queryLabel}</span>
          <textarea rows={2} value={newQuery} onChange={(e) => setNewQuery(e.target.value)} style={{ width: "100%" }} />
        </div>
        {extra && (
          <div>
            <span className="field-label">{extra.label}</span>
            <select value={newExtra} onChange={(e) => setNewExtra(e.target.value)}>
              {extra.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <button onClick={addNew} disabled={adding || !newName.trim() || !newQuery.trim()} style={{ marginTop: 18 }}>
          Add
        </button>
      </div>

      {items.length === 0 && <p className="muted">None saved yet.</p>}
      {items.map((item) => {
        const isOpen = expanded.has(item.id);
        const isEditing = editingId === item.id;
        return (
          <div className="result-row" key={item.id} style={{ marginBottom: 8 }}>
            <div className="result-row-summary" onClick={() => toggleExpanded(item.id)}>
              <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
              <span className="msg">{item.name}</span>
              {extra && <span className="tag">{extra.getValue(item)}</span>}
              {!isOpen && <span className="muted">{item.query_string}</span>}
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
                    <span className="field-label">{queryLabel}</span>
                    <textarea
                      rows={3}
                      value={editQuery}
                      onChange={(e) => setEditQuery(e.target.value)}
                      style={{ width: "100%" }}
                    />
                    {extra && (
                      <div style={{ marginTop: 8 }}>
                        <span className="field-label">{extra.label}</span>
                        <select value={editExtra} onChange={(e) => setEditExtra(e.target.value)}>
                          {extra.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="toolbar" style={{ marginTop: 10 }}>
                      <button onClick={() => saveEdit(item.id)} disabled={!editName.trim() || !editQuery.trim()}>
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
                      {item.query_string}
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
