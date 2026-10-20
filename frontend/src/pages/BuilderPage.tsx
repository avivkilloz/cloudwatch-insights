import { useCallback, useEffect, useState } from "react";
import { useOfferBuild } from "../agent/buildFocus";
import { api, BuildDraft, BuilderSchema, BuiltPaneType, BuiltStepType, readableError, Workflow, WorkflowProblem } from "../api";
import { useAuth } from "../AuthContext";
import CodeEditor, { problemLines } from "../components/CodeEditor";
import { CardRow } from "../components/SessionCard";
import { StoreBadge } from "../components/settings/StoreSettings";
import { rowProps, Section, ViewHead, ViewSwitch } from "../components/settings/settingsLayout";
import { ActionRunner, ActionRunnerContext } from "../panes/actionRunner";
import BuilderForm from "./BuilderForm";
import ManifestPane from "../panes/ManifestPane";
import { PaneManifest, setManifests } from "../panes/manifest";
import { useCatalogue } from "../sessions/catalogue";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { registerManifestPanes } from "../sessions/paneTypes";
import { useStartSession } from "../sessions/start";
import { DraftStatus, draftTime, useBuildDraft, useDraftList } from "./buildDraft";
import StepEditor from "./StepEditor";
import { WorkflowEditor } from "./WorkflowsPage";
import { takeBuilderAsk, useBuilderAskWaiting } from "../workflowFocus";

/*
 * The Builder, its first part (PLATFORM_PLAN.md §24, D103-D106): pane types
 * made in the platform, as the manifest YAML every pane type is -- checked by
 * the same model, drawn by the same renderer, run through the same actions.
 * Saved, one is its builder's group's at once (and in the store repo); any
 * other group gets it when an admin grants it in Users -> Groups -> Panes.
 * An action may be a request to any AWS read API, as data (D110), so a pane
 * for a service no handler covers needs no code. The agent panel's Building
 * tab is about the editor on screen (5-2, D107):
 * what the agent proposes lands in the editor, unsaved, for its builder to
 * check and save.
 */

// `said`: what to say on arriving -- a type just created opens as itself.
// `what`: which list (pane types, or step types made for workflows, D122).
// `draft`: a new one's draft, opened from the list (D125). Workflows are
// built here too, beside pane and step types (D128).
type What = "pane" | "workflow" | "step";
type Screen =
  | { kind: "list"; what?: What }
  | { kind: "edit"; id: string | null; said?: string; draft?: number }
  | { kind: "workflow"; id: string | null; draft?: number }
  | { kind: "step"; id: string | null; said?: string; draft?: number };

const editorKey = (s: { id: string | null; draft?: number }) => `${s.id ?? "new"}:${s.draft ?? ""}`;

/** After a save: the browser's pane types, the user's grants and the
 * catalogue all change -- loaded again, so the new type can be opened now. */
function useReloadPaneTypes(): () => Promise<void> {
  const { refresh } = useAuth();
  const { replace } = useCatalogue();
  return useCallback(async () => {
    const list = await api.listPaneTypes();
    setManifests(list);
    registerManifestPanes(list);
    await refresh();
    replace(await api.getCatalogue());
  }, [refresh, replace]);
}

export default function BuilderPage() {
  const { view } = useSessions();
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  // Asked from the Workflows page: New workflow, Open in the Builder.
  const asked = useBuilderAskWaiting();
  useEffect(() => {
    if (!asked) return;
    const taken = takeBuilderAsk();
    if (taken) setScreen({ kind: "workflow", id: taken.id });
  }, [asked]);
  if (view !== "builder") return null;
  if (screen.kind === "workflow") {
    return (
      <WorkflowEditor
        key={editorKey(screen)}
        id={screen.id}
        draftId={screen.draft ?? null}
        back={() => setScreen({ kind: "list", what: "workflow" })}
        opened={(id) => setScreen({ kind: "workflow", id })}
      />
    );
  }
  if (screen.kind === "edit") {
    return <Editor key={editorKey(screen)} id={screen.id} said={screen.said} draftId={screen.draft ?? null} open={setScreen} />;
  }
  if (screen.kind === "step") {
    return (
      <StepEditor
        key={editorKey(screen)}
        id={screen.id}
        said={screen.said}
        draftId={screen.draft ?? null}
        back={() => setScreen({ kind: "list", what: "step" })}
        opened={(id, said) => setScreen({ kind: "step", id, said })}
      />
    );
  }
  return <ListView open={setScreen} initial={screen.what ?? "pane"} />;
}

function ListView({ open, initial }: { open: (s: Screen) => void; initial: What }) {
  const [what, setWhat] = useState<What>(initial);
  return (
    <div className="panel builder-list">
      <div className="credential-view-head">
        <h2>Builder</h2>
        <div className="credential-view-actions">
          <ViewSwitch
            views={[
              ["pane", "Pane types"],
              ["workflow", "Workflows"],
              ["step", "Step types"],
            ] as const}
            view={what}
            onChange={setWhat}
          />
          {what === "pane" && <button onClick={() => open({ kind: "edit", id: null })}>New pane type</button>}
          {what === "workflow" && <button onClick={() => open({ kind: "workflow", id: null })}>New workflow</button>}
          {what === "step" && <button onClick={() => open({ kind: "step", id: null })}>New step type</button>}
        </div>
      </div>
      {what === "pane" && <PaneList open={open} />}
      {what === "workflow" && <WorkflowList open={open} />}
      {what === "step" && <StepList open={open} />}
    </div>
  );
}

/** The workflows this person may change (D121), and their drafts of new ones. */
function WorkflowList({ open }: { open: (s: Screen) => void }) {
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drafts = useDraftList("workflow");
  useEffect(() => {
    api.listWorkflows().then((list) => setItems(list.filter((w) => w.can_edit)), (e) => setError(readableError(e)));
  }, []);
  return (
    <>
      <p className="muted" style={{ maxWidth: "80ch" }}>
        Steps run more than once, the same way each time: pane actions, step types, approvals -- written as a
        definition. One you make is your group's to edit and run; they're run, and their runs kept, on the Workflows
        page.
      </p>
      {error && <p className="error-text">{error}</p>}
      {items !== null && items.length === 0 && drafts.fresh.length === 0 && <p className="muted">None made yet.</p>}
      {items !== null && items.length + drafts.fresh.length > 0 && (
        <table className="credentials-table builder-table">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Id</th>
              <th>Steps</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <DraftRows drafts={drafts.fresh} cols={4} open={(d) => open({ kind: "workflow", id: null, draft: d.id })} />
            {items.map((w) => (
              <tr key={w.id} data-workflow={w.id} {...rowProps(() => open({ kind: "workflow", id: w.id }))}>
                <td>
                  {w.label}
                  <ChangedTag draft={drafts.changed.get(w.id)} />
                </td>
                <td className="muted">{w.id}</td>
                <td className="muted">{w.steps}</td>
                <td>
                  <StoreBadge state={w.store_state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function StepList({ open }: { open: (s: Screen) => void }) {
  const [items, setItems] = useState<BuiltStepType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drafts = useDraftList("step");
  useEffect(() => {
    api.listBuiltSteps().then(setItems, (e) => setError(readableError(e)));
  }, []);
  return (
    <>
      <p className="muted" style={{ maxWidth: "80ch" }}>
        Steps for workflows, made here: a request to an HTTP connection -- any method, its path, query, headers and
        body from its inputs -- or a chain of steps used as one. A workflow uses one as <code>step: its id</code>; one
        that changes something waits for a person first. Your group's builders and admins may change it.
      </p>
      {error && <p className="error-text">{error}</p>}
      {items !== null && items.length === 0 && drafts.fresh.length === 0 && <p className="muted">None made yet.</p>}
      {items !== null && items.length + drafts.fresh.length > 0 && (
        <table className="credentials-table builder-table">
          <thead>
            <tr>
              <th>Step type</th>
              <th>Id</th>
              <th>Is</th>
              <th>Last changed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <DraftRows drafts={drafts.fresh} cols={5} open={(d) => open({ kind: "step", id: null, draft: d.id })} />
            {items.map((t) => (
              <tr key={t.id} data-step={t.id} {...rowProps(() => open({ kind: "step", id: t.id }))}>
                <td>
                  {t.label}
                  {!t.loads && <span className="tag error" style={{ marginLeft: 6 }}>Doesn't load</span>}
                  <ChangedTag draft={drafts.changed.get(t.id)} />
                </td>
                <td className="muted">{t.id}</td>
                <td className="muted">
                  {t.kind === "steps" ? "A chain of steps" : "A request"}
                  {t.external ? " · changes something" : ""}
                </td>
                <td className="muted">
                  {t.updated_by ?? ""}
                  {t.updated_at ? ` · ${new Date(t.updated_at).toLocaleString()}` : ""}
                </td>
                <td>
                  <StoreBadge state={t.store_state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** A row per draft of a new one (D125), above what's built: yours alone. */
function DraftRows({ drafts, cols, open }: { drafts: BuildDraft[]; cols: number; open: (d: BuildDraft) => void }) {
  return (
    <>
      {drafts.map((d) => (
        <tr key={`draft-${d.id}`} data-draft={d.id} {...rowProps(() => open(d))}>
          <td>
            {d.label || <span className="muted">Untitled</span>}
            <span className="tag pending builder-draft-tag" title="Not created yet: only you see it">
              Draft
            </span>
          </td>
          <td className="muted">{d.new_id || "—"}</td>
          {cols > 4 && <td className="muted">Not created yet</td>}
          <td className="muted">you · {draftTime(d)}</td>
          <td />
        </tr>
      ))}
    </>
  );
}

/** Beside a built one with changes its builder hasn't saved. */
function ChangedTag({ draft }: { draft?: BuildDraft }) {
  if (!draft) return null;
  return (
    <span className="tag pending builder-draft-tag" title={`Your unsaved changes, from ${draftTime(draft)}`}>
      Draft
    </span>
  );
}

function PaneList({ open }: { open: (s: Screen) => void }) {
  const [items, setItems] = useState<BuiltPaneType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drafts = useDraftList("pane");
  useEffect(() => {
    api.listBuiltPanes().then(setItems, (e) => setError(readableError(e)));
  }, []);
  return (
    <>
      <p className="muted" style={{ maxWidth: "80ch" }}>
        Pane types made here, written as the same definition every pane is: its inputs, the actions that fill its
        outputs -- a request to a connection, or an action the platform already has -- and how it's laid out. One you
        make is your group's to use at once; other groups get it when an admin grants it in Users → Groups → Panes.
      </p>
      {error && <p className="error-text">{error}</p>}
      {items !== null && items.length === 0 && drafts.fresh.length === 0 && <p className="muted">None made yet.</p>}
      {items !== null && items.length + drafts.fresh.length > 0 && (
        <table className="credentials-table builder-table">
          <thead>
            <tr>
              <th>Pane type</th>
              <th>Id</th>
              <th>Last changed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <DraftRows drafts={drafts.fresh} cols={4} open={(d) => open({ kind: "edit", id: null, draft: d.id })} />
            {items.map((t) => (
              <tr key={t.id} data-built={t.id} {...rowProps(() => open({ kind: "edit", id: t.id }))}>
                <td>
                  {t.label}
                  {!t.loads && <span className="tag error" style={{ marginLeft: 6 }}>Doesn't load</span>}
                  <ChangedTag draft={drafts.changed.get(t.id)} />
                </td>
                <td className="muted">{t.id}</td>
                <td className="muted">
                  {t.updated_by ?? ""}
                  {t.updated_at ? ` · ${new Date(t.updated_at).toLocaleString()}` : ""}
                </td>
                <td>
                  <StoreBadge state={t.store_state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Editor({ id, said, draftId, open }: { id: string | null; said?: string; draftId: number | null; open: (s: Screen) => void }) {
  const isNew = id === null;
  const reload = useReloadPaneTypes();
  const { startOne } = useStartSession();
  const [schema, setSchema] = useState<BuilderSchema | null>(null);
  const [item, setItem] = useState<BuiltPaneType | null>(null);
  const [newId, setNewId] = useState("");
  const [source, setSource] = useState("");
  const [problems, setProblems] = useState<WorkflowProblem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(said ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The same text either way (D115): the form edits it in place.
  const [editAs, setEditAs] = useState<"yaml" | "form">("yaml");
  // The draft as the preview draws it: the text it was drawn from (its
  // actions are run with that, not with what's been typed since) and a
  // counter that remounts the pane, whose inputs may have changed.
  const [preview, setPreview] = useState<{ manifest: PaneManifest; source: string; n: number } | null>(null);
  // Kept as it's typed, with the Building chat (D125).
  const base = isNew ? schema?.starter ?? null : item?.source ?? null;
  const kept = useBuildDraft({
    kind: "pane",
    targetId: id,
    draftId,
    base,
    source,
    newId,
    restore: (text, typedId) => {
      setSource(text);
      if (isNew) setNewId(typedId);
    },
  });
  const title = item?.label ?? (isNew ? "New pane type" : id ?? "");
  useOfferBuild("pane", id, title, true, source, (text, summary) => {
    setSource(text);
    setProblems(null);
    setError(null);
    setNotice(`The agent's draft is in the editor, not saved yet${summary ? `: ${summary}` : "."} Check it, then ${isNew ? "Create" : "Save"}.`);
  }, kept.hooks);
  const dirty = base !== null && (source !== base || (isNew && newId.trim() !== ""));

  async function discard() {
    if (!confirm(isNew ? "Discard this draft?" : "Discard your changes and go back to what's saved?")) return;
    await kept.discard();
    if (isNew) open({ kind: "list" });
    else if (base !== null) {
      setSource(base);
      setProblems(null);
      setNotice(null);
    }
  }

  useEffect(() => {
    // One load lands: a second (StrictMode's, or a late one) arriving after
    // the draft was put back would put the saved text over it (D125).
    let cancelled = false;
    api.builderSchema().then(
      (s) => {
        if (cancelled) return;
        setSchema(s);
        if (isNew) setSource((current) => current || s.starter);
      },
      (e) => !cancelled && setError(readableError(e)),
    );
    if (!isNew) {
      api.listBuiltPanes().then(
        (list) => {
          if (cancelled) return;
          const found = list.find((t) => t.id === id) ?? null;
          setItem(found);
          if (found) setSource(found.source);
        },
        (e) => !cancelled && setError(readableError(e)),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  async function check(): Promise<boolean> {
    setNotice(null);
    setError(null);
    try {
      const out = await api.checkBuiltPane(source, isNew ? undefined : id ?? undefined, isNew ? newId.trim() || undefined : undefined);
      setProblems(out.errors);
      if (out.ok) setNotice("No problems found.");
      return out.ok;
    } catch (e) {
      setError(readableError(e));
      return false;
    }
  }

  async function showPreview() {
    setNotice(null);
    setError(null);
    try {
      const out = await api.builderPreview(source, isNew ? undefined : id ?? undefined, isNew ? newId.trim() || undefined : undefined);
      setProblems(out.errors);
      if (out.ok && out.manifest) {
        const drawn = out.manifest;
        setPreview((prev) => ({ manifest: drawn, source, n: (prev?.n ?? 0) + 1 }));
      }
    } catch (e) {
      setError(readableError(e));
    }
  }

  // The draft's actions go to the preview's endpoint with the text it was
  // drawn from, run as the builder; nothing is stored (D112).
  const runPreviewAction = useCallback<ActionRunner>(
    (_type, action, inputs, cursor, extra) =>
      api.builderPreviewAction(preview?.source ?? "", isNew ? undefined : id ?? undefined, action, inputs, cursor, extra?.timezone),
    [preview?.source, isNew, id],
  );

  async function save() {
    setBusy(true);
    try {
      if (!(await check())) return;
      const saved = isNew ? await api.createBuiltPane(newId.trim(), source) : await api.updateBuiltPane(id!, source);
      await kept.finish(saved.id, saved.source);
      await reload();
      setItem(saved);
      setSource(saved.source);
      if (isNew) open({ kind: "edit", id: saved.id, said: `Created ${saved.label} (${saved.id}): your group can use it now.` });
      else setNotice("Saved.");
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item || !confirm(`Delete the pane type "${item.label}"? Sessions holding one will show it as missing.`)) return;
    try {
      await api.deleteBuiltPane(item.id);
      await reload();
      open({ kind: "list" });
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function startFrom(example: string) {
    if (!example) return;
    if (example === "__starter") {
      if (schema) setSource(schema.starter);
      return;
    }
    try {
      // A bundled manifest, as its file says it: its id line goes (this one's is the Id above).
      const { source: text } = await api.builderExample(example);
      setSource(text.replace(/^id: .*\n/m, ""));
      setProblems(null);
    } catch (e) {
      setError(readableError(e));
    }
  }

  return (
    <div className="panel credential-view builder-view">
      <ViewHead back={() => open({ kind: "list" })} title={title}>
        {!isNew && item?.loads && (
          <button className="secondary" onClick={() => startOne(item.id as SessionType)}>
            Open in a session
          </button>
        )}
        {!isNew && item && (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        )}
      </ViewHead>
      <div className="builder-columns">
        <Section title="Definition">
          {isNew && (
            <CardRow label="Id">
              <input id="builder-id" type="text" value={newId} placeholder="e.g. service_status" onChange={(e) => setNewId(e.target.value)} />
              {schema?.namespace && newId.trim() && !newId.includes(":") && (
                <p className="muted builder-saved-as">
                  Saved as <code>{`${schema.namespace}:${newId.trim()}`}</code>, in the store's namespace.
                </p>
              )}
            </CardRow>
          )}
          <CardRow label="Start from">
            <select id="builder-start" value="" onChange={(e) => startFrom(e.target.value)}>
              <option value="">{isNew ? "The starter below, or an example…" : "Replace with an example…"}</option>
              <option value="__starter">The starter</option>
              {(schema?.examples ?? []).map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </CardRow>
          <CardRow label="Edit as">
            <ViewSwitch
              views={[
                ["yaml", "YAML"],
                ["form", "Form"],
              ] as const}
              view={editAs}
              onChange={setEditAs}
            />
          </CardRow>
          {editAs === "yaml" ? (
            <CodeEditor
              id="builder-source"
              minRows={Math.min(34, Math.max(14, source.split("\n").length + 1))}
              value={source}
              marked={problemLines(problems)}
              onChange={(text) => {
                setSource(text);
                setProblems(null);
                setNotice(null);
              }}
            />
          ) : (
            <BuilderForm
              source={source}
              schema={schema}
              onChange={(next) => {
                setSource(next);
                setProblems(null);
                setNotice(null);
              }}
            />
          )}
          {problems && problems.length > 0 && (
            <ul className="error-text workflow-problems builder-problems">
              {problems.map((p, i) => (
                <li key={i}>
                  {p.line ? <strong>Line {p.line}: </strong> : null}
                  {p.message}
                </li>
              ))}
            </ul>
          )}
          {notice && <p className="muted builder-notice">{notice}</p>}
          {error && <p className="error-text">{error}</p>}
          <div className="row credential-view-foot">
            <button onClick={save} disabled={busy || (isNew && !newId.trim())}>
              {busy ? "Saving…" : isNew ? "Create" : "Save"}
            </button>
            <button className="secondary" onClick={check} disabled={busy}>
              Check
            </button>
            <button className="secondary" onClick={showPreview} disabled={busy}>
              Preview
            </button>
            {kept.id !== null && dirty && (
              <button className="secondary" onClick={discard} disabled={busy}>
                Discard
              </button>
            )}
          </div>
          <DraftStatus kept={kept} />
        </Section>
        <Section title="Preview">
          {preview === null ? (
            <p className="muted builder-preview-empty">
              Preview draws the definition as the pane it makes. Its actions run as you, on real connections; nothing is
              saved and no session holds it.
            </p>
          ) : (
            <>
              {preview.source !== source && (
                <p className="muted builder-preview-stale">The definition has changed since this was drawn: Preview again.</p>
              )}
              <ActionRunnerContext.Provider value={runPreviewAction}>
                <div className="builder-preview" key={preview.n}>
                  <ManifestPane type={preview.manifest.id} manifest={preview.manifest} />
                </div>
              </ActionRunnerContext.Provider>
            </>
          )}
        </Section>
      </div>
      {schema && (
        <Section title="What it can name">
          <p className="muted" style={{ marginTop: 0 }}>
            An action is a <code>request</code> -- to a connection of an HTTP type (its path, query and where its
            rows are), or, with a <code>service</code> and <code>operation</code>, any AWS API that reads (Lambda's
            ListFunctions, ECS's DescribeServices…) on an AWS connection -- one of these handlers, what the platform's
            own panes run, or one of these live functions, worked out as you type. Whoever uses the pane runs it as
            themselves.
          </p>
          <CardRow label="Handlers">
            <div className="builder-names">{schema.handlers.join(", ")}</div>
          </CardRow>
          <CardRow label="Live">
            <div className="builder-names">{schema.live.join(", ")}</div>
          </CardRow>
        </Section>
      )}
    </div>
  );
}

