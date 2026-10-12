/**
 * "Load saved…" / "Save as…" on every manifest pane (PLATFORM_PLAN.md D46,
 * §16.3.4): the pane's inputs under a name, in one store by pane type. It
 * replaces DynamoDB's "Saved tables" and S3's "Saved buckets" cards, whose
 * items moved into the store once (backend/app/panes/saved.py), and gives
 * every other pane the same -- Cognito, Base64 and the API table had none.
 *
 * Loading is a person's change to the inputs (`changeInputs`): what it
 * resets is cleared and what runs on a change runs, so a saved table is
 * described and a saved bucket opened, as picking them by hand does.
 * Sensitive inputs are never sent; the server drops them anyway.
 */

import { useCallback, useEffect, useState } from "react";
import { api, readableError, SavedInput } from "../api";
import { PaneApi, Values } from "./paneApi";

export default function SavedInputsBar({ pane }: { pane: PaneApi }) {
  const [saved, setSaved] = useState<SavedInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const type = pane.m.id;

  const load = useCallback(() => {
    api
      .listSavedInputs(type)
      .then(setSaved)
      .catch((e) => setError(readableError(e)));
  }, [type]);

  useEffect(load, [load]);

  async function save() {
    const name = window.prompt(`Save these ${pane.m.label} inputs as:`);
    if (!name?.trim()) return;
    const inputs: Values = {};
    for (const input of pane.m.inputs) if (!input.sensitive) inputs[input.key] = pane.inputs[input.key];
    try {
      await api.createSavedInputs({ pane_type: type, name: name.trim(), inputs });
      setError(null);
      load();
    } catch (e) {
      setError(readableError(e));
    }
  }

  return (
    <div className="pane-saved">
      {error && <span className="error-text">{error}</span>}
      <select
        aria-label={`Load saved ${pane.m.label} inputs`}
        value=""
        // Fetched again whenever it's opened: an item saved from another pane
        // of this type, or renamed in Settings → Library, is there.
        onFocus={load}
        onChange={(e) => {
          const item = saved.find((s) => String(s.id) === e.target.value);
          if (item) pane.changeInputs(item.inputs);
        }}
      >
        <option value="" disabled>
          {saved.length > 0 ? "Load saved…" : "Nothing saved yet"}
        </option>
        {saved.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button className="secondary" onClick={save}>
        Save as…
      </button>
    </div>
  );
}
