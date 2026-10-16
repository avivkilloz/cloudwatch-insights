import { useState } from "react";
import { api, readableError } from "../../api";
import { useCatalogue } from "../../sessions/catalogue";
import Icon from "../Icon";
import { Section } from "./settingsLayout";

/*
 * Settings → Catalogue (PLATFORM_PLAN.md §19.2, D66): the categories panes
 * are offered under, everywhere they are offered -- the default page, the
 * side panel's Add list, the strip's +, a session's card. Each change is
 * saved as it's made; arranging places a pane (pins it), so a plugin
 * upgrade suggesting another category never moves it back.
 *
 * Up and down rather than drag and drop: one control per move, and usable
 * from a keyboard. Who can use a pane is not here -- that's Users → Groups;
 * moving a pane between categories never changes it.
 */

type Layout = { id: number; pane_types: string[] }[];

export default function CatalogueSettings() {
  const catalogue = useCatalogue();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: number; moveTo: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const categories = catalogue.categories.filter((c) => c.id != null) as { id: number; name: string; types: { type: string; label: string }[] }[];
  const layout = (): Layout => categories.map((c) => ({ id: c.id, pane_types: c.types.map((t) => t.type) }));

  async function run(fn: () => Promise<Parameters<typeof catalogue.replace>[0]>) {
    setBusy(true);
    setError(null);
    try {
      catalogue.replace(await fn());
      return true;
    } catch (e) {
      setError(readableError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function moveCategory(index: number, by: number) {
    const next = layout();
    const [c] = next.splice(index, 1);
    next.splice(index + by, 0, c);
    run(() => api.setCatalogueLayout(next));
  }

  function movePane(categoryIndex: number, paneIndex: number, by: number) {
    const next = layout();
    const types = next[categoryIndex].pane_types;
    const [t] = types.splice(paneIndex, 1);
    types.splice(paneIndex + by, 0, t);
    run(() => api.setCatalogueLayout(next));
  }

  function movePaneTo(type: string, categoryId: number) {
    const next = layout().map((c) => ({ ...c, pane_types: c.pane_types.filter((t) => t !== type) }));
    next.find((c) => c.id === categoryId)?.pane_types.push(type);
    run(() => api.setCatalogueLayout(next));
  }

  return (
    <div className="panel credential-list catalogue-settings">
      <div className="credential-list-head">
        <h2>Catalogue</h2>
        <span className="muted">The categories panes are offered under, and their order, for everyone.</span>
        <button onClick={() => setAdding("")} disabled={adding !== null}>
          New category
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {adding !== null && (
        <form
          className="row catalogue-new"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => api.createCatalogueCategory(adding))) setAdding(null);
          }}
        >
          <input autoFocus type="text" aria-label="New category name" placeholder="e.g. Databases" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button type="submit" disabled={busy || !adding.trim()}>
            Add
          </button>
          <button type="button" className="secondary" onClick={() => setAdding(null)}>
            Cancel
          </button>
        </form>
      )}
      <div className="catalogue-categories">
        {categories.map((c, ci) => (
          <div key={c.id} data-category={c.name}>
            <Section
              title={c.name}
              aside={
                <div className="catalogue-category-actions">
                  <button className="secondary icon-btn" disabled={busy || ci === 0} onClick={() => moveCategory(ci, -1)} aria-label={`Move ${c.name} up`} title="Up">
                    <Icon name="up" />
                  </button>
                  <button
                    className="secondary icon-btn"
                    disabled={busy || ci === categories.length - 1}
                    onClick={() => moveCategory(ci, 1)}
                    aria-label={`Move ${c.name} down`}
                    title="Down"
                  >
                    <Icon name="down" />
                  </button>
                  <button className="secondary icon-btn" onClick={() => setRenaming({ id: c.id, name: c.name })} aria-label={`Rename ${c.name}`} title="Rename">
                    <Icon name="pencil" />
                  </button>
                  <button
                    className="secondary icon-btn"
                    disabled={categories.length < 2}
                    onClick={() => setDeleting({ id: c.id, moveTo: categories.find((o) => o.id !== c.id)!.id })}
                    aria-label={`Delete ${c.name}`}
                    title={categories.length < 2 ? "The last category can't go: panes need somewhere to be" : "Delete"}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              }
            >
              {renaming?.id === c.id && (
                <form
                  className="row catalogue-inline"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => api.renameCatalogueCategory(c.id, renaming.name))) setRenaming(null);
                  }}
                >
                  <input autoFocus type="text" aria-label="Category name" value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                  <button type="submit" disabled={busy || !renaming.name.trim()}>
                    Save
                  </button>
                  <button type="button" className="secondary" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              )}
              {deleting?.id === c.id && (
                <div className="row catalogue-inline">
                  <span>Delete {c.name}, moving its panes to</span>
                  <select
                    aria-label="Move its panes to"
                    value={deleting.moveTo}
                    onChange={(e) => setDeleting({ ...deleting, moveTo: Number(e.target.value) })}
                  >
                    {categories
                      .filter((o) => o.id !== c.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={async () => {
                      if (await run(() => api.deleteCatalogueCategory(c.id, deleting.moveTo))) setDeleting(null);
                    }}
                  >
                    Delete
                  </button>
                  <button className="secondary" onClick={() => setDeleting(null)}>
                    Cancel
                  </button>
                </div>
              )}
              {c.types.length === 0 && <p className="muted catalogue-empty">No panes here yet: move one in from another category.</p>}
              <ul className="catalogue-panes">
                {c.types.map((t, pi) => (
                  <li key={t.type} className="catalogue-pane" data-pane-type={t.type}>
                    <span className="catalogue-pane-label">{t.label}</span>
                    <button className="secondary icon-btn" disabled={busy || pi === 0} onClick={() => movePane(ci, pi, -1)} aria-label={`Move ${t.label} up`} title="Up">
                      <Icon name="up" />
                    </button>
                    <button
                      className="secondary icon-btn"
                      disabled={busy || pi === c.types.length - 1}
                      onClick={() => movePane(ci, pi, 1)}
                      aria-label={`Move ${t.label} down`}
                      title="Down"
                    >
                      <Icon name="down" />
                    </button>
                    <select
                      aria-label={`Category for ${t.label}`}
                      value={c.id}
                      disabled={busy}
                      onChange={(e) => movePaneTo(t.type, Number(e.target.value))}
                    >
                      {categories.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        ))}
      </div>
    </div>
  );
}
