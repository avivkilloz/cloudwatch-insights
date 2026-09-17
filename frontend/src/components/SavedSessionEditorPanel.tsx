import { useState } from "react";
import { SavedSession, ToolHeader } from "../api";

export type SessionEditorKind = "http" | "mqtt-topic" | "json";

interface HttpRequestState {
  method: string;
  url: string;
  headers: ToolHeader[];
  body: string;
}

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

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function emptyStateFor(kind: SessionEditorKind): Record<string, unknown> {
  if (kind === "http") return { method: "GET", url: "", headers: [], body: "" } satisfies HttpRequestState;
  if (kind === "mqtt-topic") return { topic: "" } satisfies MqttTopicState;
  return {};
}

function summaryFor(kind: SessionEditorKind, state: Record<string, unknown>): string {
  if (kind === "http") {
    const s = state as unknown as HttpRequestState;
    return `${s.method ?? "GET"} ${s.url ?? ""}`;
  }
  if (kind === "mqtt-topic") {
    return String((state as unknown as MqttTopicState).topic ?? "");
  }
  return JSON.stringify(state);
}

function HttpStateEditor({ value, onChange }: { value: HttpRequestState; onChange: (next: HttpRequestState) => void }) {
  function updateHeader(i: number, field: "key" | "value", v: string) {
    onChange({ ...value, headers: value.headers.map((h, idx) => (idx === i ? { ...h, [field]: v } : h)) });
  }
  function addHeader() {
    onChange({ ...value, headers: [...value.headers, { key: "", value: "" }] });
  }
  function removeHeader(i: number) {
    onChange({ ...value, headers: value.headers.filter((_, idx) => idx !== i) });
  }
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={value.method} onChange={(e) => onChange({ ...value, method: e.target.value })}>
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={value.url}
          onChange={(e) => onChange({ ...value, url: e.target.value })}
          placeholder="https://api.example.com/resource"
          style={{ flex: 1, minWidth: 200 }}
        />
      </div>
      <span className="field-label">Headers</span>
      {value.headers.map((h, i) => (
        <div className="row" key={i} style={{ marginBottom: 6 }}>
          <input
            type="text"
            placeholder="Header name"
            value={h.key}
            onChange={(e) => updateHeader(i, "key", e.target.value)}
            style={{ width: 200 }}
          />
          <input
            type="text"
            placeholder="Value"
            value={h.value}
            onChange={(e) => updateHeader(i, "value", e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <button className="danger" onClick={() => removeHeader(i)}>
            Remove
          </button>
        </div>
      ))}
      <button className="secondary" onClick={addHeader} style={{ marginBottom: 8 }}>
        Add header
      </button>
      <span className="field-label">Body</span>
      <textarea
        rows={4}
        value={value.body}
        onChange={(e) => onChange({ ...value, body: e.target.value })}
        style={{ width: "100%" }}
      />
    </>
  );
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
          {kind === "http" && (
            <HttpStateEditor
              value={newState as unknown as HttpRequestState}
              onChange={(s) => setNewState(s as unknown as Record<string, unknown>)}
            />
          )}
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
              {!isOpen && <span className="muted">{summaryFor(kind, item.state)}</span>}
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
                    {kind === "http" && (
                      <HttpStateEditor
                        value={editState as unknown as HttpRequestState}
                        onChange={(s) => setEditState(s as unknown as Record<string, unknown>)}
                      />
                    )}
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
