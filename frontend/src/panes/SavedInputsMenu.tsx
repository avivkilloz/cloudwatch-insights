/**
 * "Saved ▾" on every manifest pane (PLATFORM_PLAN.md D46, §16.3.4): the
 * pane's inputs under a name, in one store by pane type. It replaces
 * DynamoDB's "Saved tables" and S3's "Saved buckets" cards, whose items moved
 * into the store once (backend/app/panes/saved.py), and gives every other
 * pane the same -- Cognito, Base64 and the API table had none.
 *
 * It sits at the right of the pane's first card's title. It started as a row
 * of its own above the cards (a select and a button), which left a whole
 * almost-empty row between two full ones; a menu in the title row takes no
 * space of its own and works in every layout, tabs included, where a pane
 * has no header of its own to hold it.
 *
 * Loading is a person's change to the inputs (`changeInputs`): what it
 * resets is cleared and what runs on a change runs, so a saved table is
 * described and a saved bucket opened, as picking them by hand does.
 * Sensitive inputs are never sent; the server drops them anyway.
 */

import { useCallback, useState } from "react";
import { api, readableError, SavedInput } from "../api";
import Popover from "../components/Popover";
import { PaneApi, Values } from "./paneApi";

export default function SavedInputsMenu({ pane }: { pane: PaneApi }) {
  const [saved, setSaved] = useState<SavedInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const type = pane.m.id;

  // Fetched each time it's opened rather than on mount: an item saved from
  // another pane of this type, or renamed in Settings → Library, is there,
  // and a session full of panes doesn't make a request per pane to load.
  const load = useCallback(() => {
    api
      .listSavedInputs(type)
      .then((items) => {
        setSaved(items);
        setError(null);
      })
      .catch((e) => setError(readableError(e)));
  }, [type]);

  async function save() {
    const name = window.prompt(`Save these ${pane.m.label} inputs as:`);
    if (!name?.trim()) return;
    const inputs: Values = {};
    for (const input of pane.m.inputs) if (!input.sensitive) inputs[input.key] = pane.inputs[input.key];
    try {
      await api.createSavedInputs({ pane_type: type, name: name.trim(), inputs });
      setError(null);
    } catch (e) {
      setError(readableError(e));
    }
  }

  return (
    <span className="pane-saved">
      {error && <span className="error-text">{error}</span>}
      <Popover
        glyph="Saved ▾"
        label={`Saved ${pane.m.label} inputs`}
        title="Load inputs you saved, or save these"
        buttonClass="secondary"
        menuClass="rail-row-menu pane-saved-menu"
        width={200}
        onOpen={load}
      >
        {(close) => (
          <>
            {saved === null && <div className="pane-saved-note muted">Loading…</div>}
            {saved?.length === 0 && <div className="pane-saved-note muted">Nothing saved yet</div>}
            {saved?.map((s) => (
              <button
                key={s.id}
                data-saved-input-item={s.name}
                onClick={() => {
                  close();
                  pane.changeInputs(s.inputs);
                }}
              >
                {s.name}
              </button>
            ))}
            <div className="pane-saved-sep" />
            <button
              onClick={() => {
                close();
                void save();
              }}
            >
              Save as…
            </button>
          </>
        )}
      </Popover>
    </span>
  );
}
