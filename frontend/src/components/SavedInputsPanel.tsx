/**
 * Settings → Library → Saved inputs (PLATFORM_PLAN.md D46, D50): every pane's
 * "Save as…" items, in one list with the pane they belong to. Renaming and
 * deleting happen here; saving and loading happen in the pane itself.
 */

import { useEffect, useState } from "react";
import { api, readableError, SavedInput } from "../api";
import { manifest, manifests } from "../panes/manifest";

function summary(inputs: Record<string, unknown>): string {
  return Object.entries(inputs)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export default function SavedInputsPanel() {
  const [items, setItems] = useState<SavedInput[] | null>(null);
  const [type, setType] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .listSavedInputs()
      .then(setItems)
      .catch((e) => setError(readableError(e)));
  }
  useEffect(load, []);

  async function rename(item: SavedInput) {
    const name = window.prompt("Rename to:", item.name);
    if (!name?.trim() || name.trim() === item.name) return;
    try {
      await api.updateSavedInputs(item.id, { name: name.trim() });
      load();
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function remove(item: SavedInput) {
    if (!window.confirm(`Delete "${item.name}"?`)) return;
    try {
      await api.deleteSavedInputs(item.id);
      load();
    } catch (e) {
      setError(readableError(e));
    }
  }

  const shown = (items ?? []).filter((i) => !type || i.pane_type === type);
  const types = [...new Set((items ?? []).map((i) => i.pane_type))];
  return (
    <div>
      <p className="muted">
        A pane's inputs under a name, saved and loaded from the Saved ▾ menu on the pane's first card.
        Loading fills the pane you're in; a template starts a new session.
      </p>
      {error && <p className="error-text">{error}</p>}
      <div className="toolbar">
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Pane type">
          <option value="">Every pane</option>
          {manifests()
            .filter((m) => types.includes(m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </select>
      </div>
      {items !== null && shown.length === 0 && <p className="muted">Nothing saved yet.</p>}
      {shown.length > 0 && (
        <table className="saved-inputs-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Pane</th>
              <th>Inputs</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id} data-saved-input={item.name}>
                <td>{item.name}</td>
                <td>{manifest(item.pane_type)?.label ?? item.pane_type}</td>
                <td className="muted">{summary(item.inputs)}</td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="secondary" onClick={() => rename(item)}>
                      Rename
                    </button>
                    <button className="danger" onClick={() => remove(item)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
