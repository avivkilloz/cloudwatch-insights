/**
 * Saved inputs on every manifest pane (PLATFORM_PLAN.md D46, §16.3.4): the
 * pane's inputs under a name, in one store by pane type. It replaces
 * DynamoDB's "Saved tables" and S3's "Saved buckets" cards, whose items moved
 * into the store once (backend/app/panes/saved.py), and gives every other
 * pane the same -- Cognito, Base64 and the API table had none.
 *
 * It lives in the pane's ⋮ menu (PaneSettings.tsx). It started as a row of
 * its own above the cards, which left an almost empty row between two full
 * ones, then moved to a "Saved ▾" beside the first card's title, where
 * auto-refresh joined it; two controls there read as clutter, and the ⋮ has
 * room for whatever a pane's settings grow into.
 *
 * Loading is a person's change to the inputs (`changeInputs`): what it
 * resets is cleared and what runs on a change runs, so a saved table is
 * described and a saved bucket opened, as picking them by hand does.
 * Sensitive inputs are never sent; the server drops them anyway.
 */

import { useCallback, useState } from "react";
import { api, readableError, SavedInput } from "../api";
import { PaneManifest } from "./manifest";
import { PaneApi, Values } from "./paneApi";

export interface SavedInputs {
  /** Null until loaded. */
  saved: SavedInput[] | null;
  error: string | null;
  load: () => void;
  save: () => Promise<void>;
}

export function useSavedInputs(m: PaneManifest, inputs: Values): SavedInputs {
  const [saved, setSaved] = useState<SavedInput[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const type = m.id;

  // Fetched each time the menu opens rather than on mount: an item saved
  // from another pane of this type, or renamed in Settings → Library, is
  // there, and a session full of panes doesn't make a request per pane.
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
    const name = window.prompt(`Save these ${m.label} inputs as:`);
    if (!name?.trim()) return;
    const kept: Values = {};
    for (const input of m.inputs) if (!input.sensitive) kept[input.key] = inputs[input.key];
    try {
      await api.createSavedInputs({ pane_type: type, name: name.trim(), inputs: kept });
      setError(null);
    } catch (e) {
      setError(readableError(e));
    }
  }

  return { saved, error, load, save };
}

/** The saved items, then "Save as…", inside the ⋮ menu. */
export function SavedInputsSection({ pane, saved, close }: { pane: PaneApi; saved: SavedInputs; close: () => void }) {
  return (
    <>
      <div className="pane-menu-heading">Saved inputs</div>
      {saved.saved === null && !saved.error && <div className="pane-menu-note muted">Loading…</div>}
      {saved.saved?.length === 0 && <div className="pane-menu-note muted">Nothing saved yet</div>}
      {saved.saved?.map((s) => (
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
      <button
        onClick={() => {
          close();
          void saved.save();
        }}
      >
        Save these inputs as…
      </button>
    </>
  );
}
