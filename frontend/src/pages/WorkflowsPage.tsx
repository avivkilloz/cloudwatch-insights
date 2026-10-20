import { useCallback, useEffect, useMemo, useState } from "react";
import { useOfferBuild } from "../agent/buildFocus";
import {
  api,
  BlobRef,
  readableError,
  UserGroup,
  Workflow,
  WorkflowApproval,
  WorkflowParam,
  WorkflowProblem,
  WorkflowRun,
  WorkflowRunStep,
} from "../api";
import CodeEditor, { problemLines } from "../components/CodeEditor";
import { CardRow } from "../components/SessionCard";
import { ParamFields } from "../components/WorkflowParamFields";
import { StoreBadge } from "../components/settings/StoreSettings";
import { rowProps, Section, TagPicker, ViewHead, ViewSwitch } from "../components/settings/settingsLayout";
import { useAuth } from "../AuthContext";
import { DraftStatus, draftTime, useBuildDraft, useDraftList } from "./buildDraft";
import { useSessions } from "../sessions/SessionContext";
import { APPROVALS_EVENT, useWaitingApprovals } from "../workflowApprovals";
import {
  Draft,
  openInBuilder,
  openWorkflowScreen,
  setRunFocus,
  takeDraft,
  takeWorkflowScreen,
  useDraftWaiting,
  useWorkflowScreenWaiting,
} from "../workflowFocus";

/*
 * Workflows (PLATFORM_PLAN.md §20.7, §22): a page of their own, never a
 * session. Three screens: the list (Workflows | Runs), one workflow (Run ▸
 * opens Build with parameters; its history; the definition; who may run it),
 * and one run (its stages, each one's inputs, outputs and error), read again
 * every second or so while it's going. A run's address is `?run=<id>`, so it
 * can be sent to someone; whoever opens it sees it if their group may run the
 * workflow -- and its outputs if they're its starter's group or an admin (D84).
 *
 * 4b-2 (§22.8): a step waiting on an approval shows it at the top of its run,
 * with Approve / Deny for whoever may decide; what waits for you heads the
 * list; a finished run reruns from any stage; artifacts and a step's whole
 * outputs (when the row holds them cut down) download from the blob store.
 */

// `buildDraft`: a new one's draft, opened from the list (D125).
type Screen = { kind: "list" } | { kind: "workflow"; id: string } | { kind: "new"; buildDraft?: number } | { kind: "run"; id: number };

const LIST_VIEWS = [
  ["workflows", "Workflows"],
  ["runs", "Runs"],
] as const;

const NEW_SOURCE = `label: My workflow
description: What it does, in a sentence.
parameters:
  - { key: env, type: connection, connection_type: aws, label: Environment, required: true }
steps:
  - id: tables
    pane: tables
    action: list_tables
    with: { connection: "{{ params.env }}" }
  - id: report
    note: "{{ size(steps.tables.outputs.options) }} tables."
`;

function runParam(): number | null {
  const raw = new URLSearchParams(window.location.search).get("run");
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

/** The run on screen in the address bar, and nothing else of this page's. */
function setRunParam(id: number | null) {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete("run");
  else url.searchParams.set("run", String(id));
  window.history.replaceState(window.history.state, "", url.toString());
}

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function took(run: { started_at: string | null; finished_at: string | null }): string {
  if (!run.started_at) return "";
  const end = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(run.started_at).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function StatusTag({ status }: { status: string }) {
  return (
    <span className={`tag run-status run-status-${status}`} data-status={status}>
      {status}
    </span>
  );
}

export default function WorkflowsPage() {
  const { show, view } = useSessions();
  const [screen, setScreen] = useState<Screen>(() => {
    const run = runParam();
    return run ? { kind: "run", id: run } : { kind: "list" };
  });
  // A workflow drafted from a session (Make repeatable, D96): opened in the
  // editor, unsaved, whatever this page was showing.
  const draftWaiting = useDraftWaiting();
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (!draftWaiting) return;
    const taken = takeDraft();
    if (taken) {
      setDraft(taken);
      setScreen({ kind: "new" });
    }
  }, [draftWaiting]);

  // Asked for from elsewhere: the Workflow pane's link to its run, the
  // agent's open_workflow.
  const screenWaiting = useWorkflowScreenWaiting();
  useEffect(() => {
    if (!screenWaiting) return;
    const taken = takeWorkflowScreen();
    if (taken) setScreen(taken);
  }, [screenWaiting]);

  // Opened at `?run=<id>`: straight to that run, whatever the app would have
  // shown first.
  useEffect(() => {
    if (runParam() !== null) show("workflows");
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view !== "workflows") return;
    setRunParam(screen.kind === "run" ? screen.id : null);
  }, [screen, view]);

  const open = useCallback((s: Screen) => setScreen(s), []);
  // Every page stays mounted; this one draws nothing while it isn't on screen
  // (where it is is kept above), or its Workflows | Runs switch and lists sat
  // hidden in the DOM beside Settings' own, and anything looking for those
  // found two.
  if (view !== "workflows") return null;
  if (screen.kind === "workflow") return <WorkflowView id={screen.id} open={open} />;
  if (screen.kind === "new") {
    return (
      <WorkflowView
        key={`${screen.buildDraft ?? ""}:${draft?.source ?? "new"}`}
        id={null}
        open={open}
        draft={screen.buildDraft === undefined ? draft : null}
        buildDraft={screen.buildDraft ?? null}
      />
    );
  }
  if (screen.kind === "run") return <RunView id={screen.id} open={open} />;
  return <ListView open={open} />;
}

// ------------------------------------------------------------------- the list

function ListView({ open }: { open: (s: Screen) => void }) {
  const [view, setView] = useState<(typeof LIST_VIEWS)[number][0]>("workflows");
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [mine, setMine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { view: appView } = useSessions();
  const drafts = useDraftList("workflow");

  useEffect(() => {
    if (appView !== "workflows") return;
    setError(null);
    if (view === "workflows") api.listWorkflows().then(setWorkflows).catch((e) => setError(readableError(e)));
    else api.recentWorkflowRuns(mine).then(setRuns).catch((e) => setError(readableError(e)));
  }, [view, mine, appView]);

  const switcher = <ViewSwitch views={LIST_VIEWS} view={view} onChange={setView} />;
  return (
    <div className="panel credential-list workflows-list">
      <div className="credential-list-head">
        {switcher}
        <span className="muted">
          {view === "workflows" ? "Steps you run more than once, the same way each time." : "Recent runs, newest first."}
        </span>
        {view === "workflows" && <NewWorkflowButton />}
        {view === "runs" && (
          <label className="checkbox-item">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine only
          </label>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      <WaitingForYou open={open} />
      {view === "workflows" && workflows && (
        <table className="credentials-table workflows-table">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {drafts.fresh.map((d) => (
              <tr key={`draft-${d.id}`} data-draft={d.id} {...rowProps(() => open({ kind: "new", buildDraft: d.id }))}>
                <td>
                  <span className="credential-name">{d.label || "Untitled"}</span>{" "}
                  <span className="tag pending builder-draft-tag" title="Not created yet: only you see it">
                    Draft
                  </span>
                </td>
                <td>
                  <span className="muted">Not created yet · {draftTime(d)}</span>
                </td>
                <td />
              </tr>
            ))}
            {workflows.length === 0 && drafts.fresh.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No workflows you can run yet.
                </td>
              </tr>
            )}
            {workflows.map((w) => (
              <tr key={w.id} data-workflow={w.id} {...rowProps(() => open({ kind: "workflow", id: w.id }))}>
                <td>
                  <span className="credential-name">{w.label}</span> <StoreBadge state={w.store_state} />
                  {drafts.changed.has(w.id) && (
                    <span className="tag pending builder-draft-tag" title={`Your unsaved changes, from ${draftTime(drafts.changed.get(w.id)!)}`}>
                      Draft
                    </span>
                  )}
                  {w.description && <div className="muted">{w.description}</div>}
                </td>
                <td>
                  {w.last_run ? (
                    <>
                      <StatusTag status={w.last_run.status} /> <span className="muted">{when(w.last_run.created_at)}</span>
                    </>
                  ) : (
                    <span className="muted">Never run</span>
                  )}
                </td>
                <td className="workflows-run-cell">{w.can_run && <span className="muted">Run ▸</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view === "runs" && runs && <RunsTable runs={runs} open={open} showWorkflow />}
    </div>
  );
}

/** The approvals that wait for this person, each a way to its run (D88). */
function WaitingForYou({ open }: { open: (s: Screen) => void }) {
  const waiting = useWaitingApprovals();
  if (waiting.length === 0) return null;
  return (
    <div className="workflow-waiting" data-waiting={waiting.length}>
      <div className="workflow-waiting-head">Waiting for your approval</div>
      <ul>
        {waiting.map((a) => (
          <li key={a.id} data-approval={a.id} {...rowProps(() => a.run_id && open({ kind: "run", id: a.run_id }))}>
            <span className="credential-name">
              {a.workflow_label} #{a.run_number}
            </span>
            <span className="workflow-waiting-message">{a.message}</span>
            <span className="muted">
              {a.started_by} · {when(a.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Admins and builders (D121): a builder's is their group's to edit and run.
 * Made in the Builder's Workflows, beside pane and step types (D128). */
function NewWorkflowButton() {
  const { user } = useAuth();
  const { show } = useSessions();
  if (!user?.is_admin && !user?.builder_enabled) return null;
  return (
    <button
      onClick={() => {
        openInBuilder({ what: "workflow", id: null });
        show("builder");
      }}
    >
      New workflow
    </button>
  );
}

function RunsTable({ runs, open, showWorkflow }: { runs: WorkflowRun[]; open: (s: Screen) => void; showWorkflow?: boolean }) {
  if (runs.length === 0) return <p className="muted">No runs yet.</p>;
  return (
    <table className="credentials-table workflow-runs-table">
      <thead>
        <tr>
          {showWorkflow && <th>Workflow</th>}
          <th>#</th>
          <th>Status</th>
          <th>Started by</th>
          <th>When</th>
          <th>Took</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} data-run={r.id} {...rowProps(() => open({ kind: "run", id: r.id }))}>
            {showWorkflow && <td>{r.workflow_label}</td>}
            <td>{r.number}</td>
            <td>
              <StatusTag status={r.status} />
            </td>
            <td>
              {r.started_by}
              {r.trigger !== "manual" && <span className="muted"> · {r.trigger}</span>}
            </td>
            <td>{when(r.created_at)}</td>
            <td>{took(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------- one workflow

function WorkflowView({
  id,
  open,
  draft,
  buildDraft = null,
}: {
  id: string | null;
  open: (s: Screen) => void;
  draft?: Draft | null;
  buildDraft?: number | null;
}) {
  const { user } = useAuth();
  const { show } = useSessions();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [newId, setNewId] = useState(draft?.id ?? "");
  const isNew = id === null;

  const load = useCallback(async () => {
    if (id === null) return;
    try {
      const [w, r] = await Promise.all([api.getWorkflow(id), api.listWorkflowRuns(id)]);
      setWorkflow(w);
      setRuns(r);
    } catch (e) {
      setError(readableError(e));
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  async function start(params: Record<string, unknown>) {
    if (!workflow) return;
    setError(null);
    try {
      const run = await api.startWorkflowRun(workflow.id, params, Intl.DateTimeFormat().resolvedOptions().timeZone);
      open({ kind: "run", id: run.id });
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function remove() {
    if (!workflow || !window.confirm(`Delete ${workflow.label}, and its runs?`)) return;
    try {
      await api.deleteWorkflow(workflow.id);
      open({ kind: "list" });
    } catch (e) {
      setError(readableError(e));
    }
  }

  if (!isNew && !workflow) {
    return (
      <div className="panel">{error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>}</div>
    );
  }
  return (
    <div className="panel credential-view workflow-view">
      <ViewHead back={() => open({ kind: "list" })} title={isNew ? "New workflow" : workflow!.label}>
        {workflow?.can_run && !running && (
          <button className="workflow-run-button" onClick={() => setRunning(true)}>
            Run ▸
          </button>
        )}
        {workflow?.can_edit && (
          <button className="secondary" onClick={() => (openInBuilder({ what: "workflow", id: workflow.id }), show("builder"))}>
            Open in the Builder
          </button>
        )}
        {workflow?.can_edit && (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        )}
      </ViewHead>
      {error && <p className="error-text">{error}</p>}
      {workflow?.description && <p className="muted workflow-description">{workflow.description}</p>}
      {running && workflow && (
        <Section title="Build with parameters">
          <ParamsForm workflowId={workflow.id} params={workflow.parameters} onRun={start} onCancel={() => setRunning(false)} />
        </Section>
      )}
      {!isNew && (
        <Section title="Runs">
          <RunsTable runs={runs} open={open} />
        </Section>
      )}
      {(isNew || workflow?.can_edit || workflow?.source) && (
        <DefinitionSection
          workflow={workflow}
          initialSource={isNew ? draft?.source : undefined}
          draftId={buildDraft}
          back={() => open({ kind: "list" })}
          isNew={isNew}
          newId={newId}
          setNewId={setNewId}
          saved={(w) => (isNew ? open({ kind: "workflow", id: w.id }) : (setWorkflow(w), load()))}
        />
      )}
      {/* Granting other groups stays an admin's (D121, as for built panes). */}
      {workflow?.can_edit && user?.is_admin && <AccessSection workflow={workflow} saved={setWorkflow} />}
    </div>
  );
}

/**
 * A workflow in the Builder (D128): its definition and who may run it --
 * built beside pane and step types; its runs are the Workflows page's
 * ("Runs ▸"). The Workflows page's New workflow opens this.
 */
export function WorkflowEditor({
  id,
  draftId,
  back,
  opened,
}: {
  id: string | null;
  draftId: number | null;
  back: () => void;
  opened: (id: string) => void;
}) {
  const { user } = useAuth();
  const { show } = useSessions();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const isNew = id === null;
  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    api.getWorkflow(id).then(
      (w) => !cancelled && setWorkflow(w),
      (e) => !cancelled && setError(readableError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function remove() {
    if (!workflow || !window.confirm(`Delete ${workflow.label}, and its runs?`)) return;
    try {
      await api.deleteWorkflow(workflow.id);
      back();
    } catch (e) {
      setError(readableError(e));
    }
  }

  if (!isNew && !workflow) {
    return <div className="panel">{error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>}</div>;
  }
  return (
    <div className="panel credential-view builder-view workflow-view">
      <ViewHead back={back} title={isNew ? "New workflow" : workflow!.label}>
        {workflow && (
          <button
            className="secondary"
            onClick={() => (openWorkflowScreen({ kind: "workflow", id: workflow.id }), show("workflows"))}
          >
            Runs ▸
          </button>
        )}
        {workflow?.can_edit && (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        )}
      </ViewHead>
      {error && <p className="error-text">{error}</p>}
      <DefinitionSection
        workflow={workflow}
        draftId={draftId}
        back={back}
        isNew={isNew}
        newId={newId}
        setNewId={setNewId}
        saved={(w) => (isNew ? opened(w.id) : setWorkflow(w))}
      />
      {workflow?.can_edit && user?.is_admin && <AccessSection workflow={workflow} saved={setWorkflow} />}
    </div>
  );
}

function ParamsForm({
  workflowId,
  params,
  onRun,
  onCancel,
  initial,
}: {
  workflowId: string;
  params: WorkflowParam[];
  onRun: (values: Record<string, unknown>) => void;
  onCancel: () => void;
  initial?: Record<string, unknown>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      params.map((p) => [p.key, initial?.[p.key] ?? p.default ?? (p.type === "connections" || p.multiple ? [] : "")]),
    ),
  );
  const set = (key: string, value: unknown) => setValues((cur) => ({ ...cur, [key]: value }));
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="workflow-params"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onRun(values);
        } finally {
          setBusy(false);
        }
      }}
    >
      {params.length === 0 && <p className="muted">It takes no parameters.</p>}
      {params.length > 0 && (
        <ParamFields workflowId={workflowId} params={params} values={values} set={set} idPrefix="param" />
      )}
      <div className="row credential-view-foot">
        <button type="submit" disabled={busy}>
          {busy ? "Starting…" : "Run"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DefinitionSection({
  workflow,
  initialSource,
  draftId,
  back,
  isNew,
  newId,
  setNewId,
  saved,
}: {
  workflow: Workflow | null;
  initialSource?: string;
  draftId: number | null;
  back: () => void;
  isNew: boolean;
  newId: string;
  setNewId: (v: string) => void;
  saved: (w: Workflow) => void;
}) {
  const editable = isNew || !!workflow?.can_edit;
  const [source, setSource] = useState(workflow?.source ?? initialSource ?? NEW_SOURCE);
  const [problems, setProblems] = useState<WorkflowProblem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (workflow?.source !== undefined) setSource(workflow.source);
  }, [workflow?.source]);
  // Kept as it's typed, with the Building chat (D125). A new one's base is
  // the starter, so one drafted from a session (Make repeatable) is kept too.
  const base = isNew ? NEW_SOURCE : editable && workflow ? workflow.source ?? null : null;
  const kept = useBuildDraft({
    kind: "workflow",
    targetId: isNew ? null : workflow?.id ?? null,
    draftId,
    base,
    source,
    newId,
    restore: (text, typedId) => {
      setSource(text);
      if (isNew) setNewId(typedId);
    },
  });
  // The agent panel's Building tab (D107): its proposal replaces the text, unsaved.
  useOfferBuild("workflow", workflow?.id ?? null, workflow?.label ?? (newId.trim() || "New workflow"), editable && (isNew || !!workflow), source, (text, summary) => {
    setSource(text);
    setProblems(null);
    setError(null);
    setNotice(`The agent's draft is in the editor, not saved yet${summary ? `: ${summary}` : "."} Check it, then ${isNew ? "Create" : "Save"}.`);
  }, kept.hooks);
  const dirty = base !== null && (source !== base || (isNew && newId.trim() !== ""));

  async function discard() {
    if (!confirm(isNew ? "Discard this draft?" : "Discard your changes and go back to what's saved?")) return;
    await kept.discard();
    if (isNew) back();
    else if (base !== null) {
      setSource(base);
      setProblems(null);
      setNotice(null);
    }
  }

  async function validate() {
    setNotice(null);
    setError(null);
    try {
      const out = await api.validateWorkflow(source);
      setProblems(out.errors);
      if (out.ok) setNotice("No problems found.");
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const out = await api.validateWorkflow(source);
      setProblems(out.errors);
      if (!out.ok) return;
      const w = isNew ? await api.createWorkflow(newId, source) : await api.updateWorkflow(workflow!.id, source);
      await kept.finish(w.id, w.source ?? source);
      setNotice("Saved.");
      saved(w);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Definition">
      {isNew && (
        <CardRow label="Id">
          <input id="workflow-id" type="text" value={newId} placeholder="e.g. table_check" onChange={(e) => setNewId(e.target.value)} />
        </CardRow>
      )}
      {editable ? (
        <CodeEditor
          id="workflow-source"
          minRows={Math.min(30, Math.max(12, source.split("\n").length + 1))}
          value={source}
          marked={problemLines(problems)}
          onChange={(text) => {
            setSource(text);
            setProblems(null);
          }}
        />
      ) : (
        <CodeEditor id="workflow-source" readOnly minRows={Math.min(30, source.split("\n").length + 1)} value={source} />
      )}
      {problems && problems.length > 0 && (
        <ul className="error-text workflow-problems">
          {problems.map((p, i) => (
            <li key={i}>
              {p.line ? <strong>Line {p.line}: </strong> : null}
              {p.message}
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="muted">{notice}</p>}
      {error && <p className="error-text">{error}</p>}
      {editable && (
        <div className="row credential-view-foot">
          <button onClick={save} disabled={busy || (isNew && !newId.trim())}>
            {isNew ? "Create" : "Save"}
          </button>
          <button className="secondary" onClick={validate} disabled={busy}>
            Check
          </button>
          {kept.id !== null && dirty && (
            <button className="secondary" onClick={discard} disabled={busy}>
              Discard
            </button>
          )}
        </div>
      )}
      {editable && <DraftStatus kept={kept} />}
    </Section>
  );
}

function AccessSection({ workflow, saved }: { workflow: Workflow; saved: (w: Workflow) => void }) {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listUserGroups()
      .then((all) => setGroups(all.filter((g) => !g.is_admin)))
      .catch((e) => setError(readableError(e)));
  }, []);
  async function change(ids: number[]) {
    try {
      saved(await api.setWorkflowGrants(workflow.id, ids));
    } catch (e) {
      setError(readableError(e));
    }
  }
  return (
    <Section title="Access">
      <CardRow label="Who may run it">
        <TagPicker
          items={groups}
          chosen={workflow.group_ids ?? []}
          onChange={change}
          label="Let a group run it"
          addLabel="+ A group…"
          allChosenLabel="Every group may"
          emptyLabel="Admins only"
        />
      </CardRow>
      <p className="muted connection-type-note">
        A run acts as whoever starts it. Its outputs are seen by them, their group and admins.
      </p>
      {error && <p className="error-text">{error}</p>}
    </Section>
  );
}

// ------------------------------------------------------------------- one run

function RunView({ id, open }: { id: number; open: (s: Screen) => void }) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [investigating, setInvestigating] = useState(false);
  const { view, openFromServer } = useSessions();

  // The agent panel's second tab is this run's chat while it's on screen
  // (D98) -- for whoever may read it; anyone else has nothing to ask about.
  const focusTitle = run?.readable ? `${run.workflow_label} #${run.number}` : null;
  useEffect(() => {
    setRunFocus(focusTitle ? { runId: id, title: focusTitle } : null);
  }, [id, focusTitle]);
  useEffect(() => () => setRunFocus(null), []);

  // Investigate (D95): what the run found, as panes in a new session.
  async function investigate() {
    setInvestigating(true);
    setError(null);
    try {
      const made = await api.investigateRun(id);
      await openFromServer(made.session_id);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setInvestigating(false);
    }
  }

  const load = useCallback(() => {
    api
      .getWorkflowRun(id)
      .then(setRun)
      .catch((e) => setError(readableError(e)));
  }, [id]);
  useEffect(() => {
    setRun(null);
    setSelected(null);
    load();
  }, [load]);

  // Read again while it's going: everyone watching sees it move.
  const live = run?.status === "queued" || run?.status === "running";
  const waiting = run?.status === "waiting";
  useEffect(() => {
    if (!live || view !== "workflows") return;
    const timer = window.setTimeout(load, 1000);
    return () => window.clearTimeout(timer);
  }, [live, run, load, view]);
  // Waiting, it moves only when someone decides -- which the stream says.
  useEffect(() => {
    if (!waiting) return;
    window.addEventListener(APPROVALS_EVENT, load);
    return () => window.removeEventListener(APPROVALS_EVENT, load);
  }, [waiting, load]);

  // The stage to show: the one picked, else the one running, else the first that failed, else the last.
  const steps = run?.steps ?? [];
  const shown = useMemo(() => {
    if (selected !== null) return steps.find((s) => s.position === selected) ?? null;
    return (
      steps.find((s) => s.status === "running") ??
      steps.find((s) => s.status === "waiting") ??
      steps.find((s) => s.status === "failed") ??
      [...steps].reverse().find((s) => s.status !== "pending" && s.status !== "cancelled") ??
      steps[0] ??
      null
    );
  }, [steps, selected]);

  async function act(fn: () => Promise<WorkflowRun>, next?: (r: WorkflowRun) => void) {
    setError(null);
    try {
      const r = await fn();
      if (next) next(r);
      else setRun(r);
    } catch (e) {
      setError(readableError(e));
    }
  }

  if (!run) {
    return <div className="panel">{error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>}</div>;
  }
  const hasPaneStages = (run.definition?.steps ?? []).some((s) => !!s.pane);
  return (
    <div className="panel credential-view workflow-run">
      <ViewHead back={() => open({ kind: "workflow", id: run.workflow_id })} title={`${run.workflow_label} #${run.number}`}>
        <StatusTag status={run.status} />
        {(live || waiting) && run.readable && (
          <button className="secondary" onClick={() => act(() => api.cancelWorkflowRun(run.id))} disabled={run.cancel_requested}>
            {run.cancel_requested ? "Cancelling…" : "Cancel"}
          </button>
        )}
        {!live && !waiting && run.readable && (
          <button onClick={() => act(() => api.rerunWorkflowRun(run.id), (r) => open({ kind: "run", id: r.id }))}>Rerun</button>
        )}
        {run.readable && hasPaneStages && (
          <button
            className="secondary"
            onClick={investigate}
            disabled={investigating || live}
            title="Open what this run found as panes in a new session, to sort, chart, look into and run again"
          >
            {investigating ? "Opening…" : "Investigate in a session"}
          </button>
        )}
        <button
          className="secondary"
          onClick={() => {
            const url = new URL(window.location.href);
            url.searchParams.set("run", String(run.id));
            navigator.clipboard?.writeText(url.toString()).then(
              () => setCopied(true),
              () => undefined,
            );
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </ViewHead>
      <p className="muted workflow-run-meta">
        Started by {run.started_by ?? "someone"} · {when(run.created_at)}
        {run.started_at && ` · ${live ? "running for" : "took"} ${took(run)}`}
        {run.trigger !== "manual" && ` · ${run.trigger}`}
        {run.rerun_from && ` from ${run.rerun_from}`}
      </p>
      {error && <p className="error-text">{error}</p>}
      {run.error && <p className="error-text workflow-run-error">{run.error}</p>}
      {!run.readable ? (
        <p className="muted">
          Its parameters and what it found are seen by {run.started_by ?? "its starter"}, their group and admins.
        </p>
      ) : (
        <>
          {run.params && Object.keys(run.params).length > 0 && <RunParams run={run} />}
          {steps
            .filter((s) => s.approval?.status === "pending")
            .map((s) => (
              <ApprovalCard key={s.approval!.id} approval={s.approval!} step={s} decided={setRun} />
            ))}
          <div className="workflow-stages">
            <ol className="workflow-stage-list">
              {steps.map((s) => (
                <li
                  key={s.position}
                  {...rowProps(() => setSelected(s.position))}
                  className={`workflow-stage${shown?.position === s.position ? " selected" : ""}`}
                  data-stage={s.id}
                  data-status={s.status}
                >
                  <span className={`stage-dot stage-${s.status}`} aria-hidden />
                  <span className="workflow-stage-name">{s.label || s.id}</span>
                  {s.reused && (
                    <span className="muted workflow-stage-mark" title="Copied from the run this one reran from">
                      reused
                    </span>
                  )}
                  <span className="muted workflow-stage-time">
                    {s.status === "waiting" ? "waiting" : s.started_at ? took(s) : s.status === "pending" ? "" : s.status}
                  </span>
                </li>
              ))}
            </ol>
            {shown && (
              <StageDetail
                step={shown}
                artifacts={(run.artifacts ?? []).filter((a) => a.position === shown.position)}
                rerun={
                  !live && !waiting
                    ? () => act(() => api.rerunWorkflowRun(run.id, undefined, shown.id), (r) => open({ kind: "run", id: r.id }))
                    : undefined
                }
              />
            )}
          </div>
          {(run.artifacts ?? []).length > 0 && <Artifacts artifacts={run.artifacts ?? []} />}
        </>
      )}
    </div>
  );
}

/** A run's parameters by their labels, a connection by its name rather than its id. */
function RunParams({ run }: { run: WorkflowRun }) {
  const defs = run.definition?.parameters ?? [];
  const [names, setNames] = useState<Record<number, string>>({});
  useEffect(() => {
    const types = [...new Set(defs.filter((p) => p.connection_type).map((p) => p.connection_type!))];
    types.forEach((t) =>
      api
        .listTargets(t)
        .then((list) => setNames((cur) => ({ ...cur, ...Object.fromEntries(list.map((x) => [x.id, x.label])) })))
        .catch(() => undefined),
    );
    // The definition is fixed for a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);
  const shown = (p: WorkflowParam | undefined, v: unknown): string => {
    if (p?.type === "connection" && typeof v === "number") return names[v] ?? String(v);
    if (p?.type === "connections" && Array.isArray(v)) return v.map((x) => names[x as number] ?? String(x)).join(", ");
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  return (
    <p className="workflow-run-params">
      {Object.entries(run.params ?? {}).map(([k, v]) => {
        const p = defs.find((d) => d.key === k);
        return (
          <span key={k} className="tag" data-param={k}>
            {p?.label || k}: {shown(p, v)}
          </span>
        );
      })}
    </p>
  );
}

function StageDetail({ step, artifacts, rerun }: { step: WorkflowRunStep; artifacts: BlobRef[]; rerun?: () => void }) {
  const outputs = step.outputs ?? null;
  const approval = step.approval;
  return (
    <div className="workflow-stage-detail" data-stage-detail={step.id}>
      <div className="workflow-stage-head">
        <h3>{step.label || step.id}</h3>
        <StatusTag status={step.status} />
        {step.attempts > 1 && <span className="muted">{step.attempts} attempts</span>}
        {step.reused && <span className="muted">reused from the run it reran</span>}
        {rerun && step.status !== "pending" && (
          <button className="secondary workflow-rerun-from" onClick={rerun} title="A new run: the stages before this one copied, this one and the rest run again">
            Rerun from here
          </button>
        )}
      </div>
      {step.error && <p className="error-text">{step.error}</p>}
      {approval && approval.status !== "pending" && (
        <p className="muted workflow-approval-said" data-approval-status={approval.status}>
          {approval.status === "approved" && `Approved by ${approval.decided_by}`}
          {approval.status === "denied" && `Denied by ${approval.decided_by}`}
          {approval.status === "expired" && "No one decided in time"}
          {approval.status === "cancelled" && "Its approval was cancelled with the run"}
          {approval.decided_at && ` · ${when(approval.decided_at)}`}
          {approval.comment && `: “${approval.comment}”`}
        </p>
      )}
      {step.inputs !== undefined && step.inputs !== null && (
        <details className="workflow-stage-inputs">
          <summary>Inputs</summary>
          <pre>{JSON.stringify(step.inputs, null, 2)}</pre>
        </details>
      )}
      {artifacts.map((a) => (
        <p key={a.id} className="workflow-artifact-line">
          <a href={api.blobUrl(a.id)} download={a.name} data-artifact={a.name}>
            {a.name}
          </a>{" "}
          <span className="muted">{size(a.size)}</span>
        </p>
      ))}
      {outputs && !step.outputs?.artifact && <Outputs outputs={outputs} />}
      {step.trimmed && (
        <p className="muted">
          Long lists were cut down to fit here.{" "}
          {step.outputs_blob && (
            <a href={api.blobUrl(step.outputs_blob)} download={`${step.id}-outputs.json`} data-outputs-blob={step.id}>
              Download all of them
            </a>
          )}
        </p>
      )}
      {!outputs && !step.error && step.status !== "waiting" && (
        <p className="muted">{step.status === "skipped" ? "Skipped: its if was false." : "No outputs yet."}</p>
      )}
      {step.status === "waiting" && <p className="muted">Waiting for approval (above).</p>}
    </div>
  );
}

const DECIDE_BY: Record<WorkflowApproval["by"], string> = {
  anyone: "whoever started the run, their group or an admin",
  others: "someone other than whoever started the run: their group or an admin",
  admins: "an admin",
};

/** A step waiting for a person (D88): what it will do, and Approve / Deny for whoever may decide. */
function ApprovalCard({
  approval,
  step,
  decided,
}: {
  approval: WorkflowApproval;
  step: WorkflowRunStep;
  decided: (r: WorkflowRun) => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const details = approval.details ?? {};
  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      decided(await api.decideApproval(approval.id, approve, comment));
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-approval" data-approval={approval.id}>
      <div className="workflow-approval-head">
        <strong>Waiting for approval</strong>
        <span className="muted">
          {step.label || step.id} · until {when(approval.expires_at)}
        </span>
      </div>
      <p className="workflow-approval-message">{approval.message}</p>
      {details.inputs && <ApprovalInputs inputs={details.inputs} />}
      {details.items && (
        <>
          <p className="muted">
            {details.count} time{details.count === 1 ? "" : "s"}
            {(details.count ?? 0) > details.items.length ? `, the first ${details.items.length} shown` : ""}:
          </p>
          {details.items.map((inputs, i) => (
            <ApprovalInputs key={i} inputs={inputs} />
          ))}
        </>
      )}
      {approval.can_decide ? (
        <div className="row workflow-approval-actions">
          <input
            type="text"
            className="workflow-approval-comment"
            placeholder="A comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button onClick={() => decide(true)} disabled={busy}>
            Approve
          </button>
          <button className="danger" onClick={() => decide(false)} disabled={busy}>
            Deny
          </button>
        </div>
      ) : (
        <p className="muted">It waits for {DECIDE_BY[approval.by]}.</p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function ApprovalInputs({ inputs }: { inputs: Record<string, unknown> }) {
  const shown = Object.entries(inputs).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
  return (
    <dl className="workflow-approval-inputs">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A run's artifacts (D92): files it hands on, from the blob store. */
function Artifacts({ artifacts }: { artifacts: BlobRef[] }) {
  return (
    <div className="workflow-artifacts">
      <div className="workflow-output-key">Artifacts</div>
      <ul>
        {artifacts.map((a) => (
          <li key={a.id}>
            <a href={api.blobUrl(a.id)} download={a.name}>
              {a.name}
            </a>{" "}
            <span className="muted">{size(a.size)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Row = Record<string, unknown>;
const isRows = (v: unknown): v is Row[] =>
  Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));

/** A step's outputs: a note's text as text, a list of rows as a table, the
 * rest as JSON. The pane renderers come with Investigate in a session (4b-3). */
function Outputs({ outputs }: { outputs: Record<string, unknown> }) {
  const entries = Object.entries(outputs).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 1 && entries[0][0] === "text" && typeof entries[0][1] === "string") {
    return <p className="workflow-note">{entries[0][1] as string}</p>;
  }
  return (
    <div className="workflow-outputs">
      {entries.map(([key, value]) => (
        <div key={key} className="workflow-output" data-output={key}>
          <div className="workflow-output-key">{key}</div>
          {isRows(value) ? <RowsTable rows={value} /> : <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>}
        </div>
      ))}
    </div>
  );
}

function RowsTable({ rows }: { rows: Row[] }) {
  const columns = useMemo(() => {
    const seen: string[] = [];
    rows.slice(0, 200).forEach((r) => Object.keys(r).forEach((k) => !seen.includes(k) && seen.push(k)));
    return seen.slice(0, 12);
  }, [rows]);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div className="workflow-rows">
      <div className="muted">
        {rows.length} row{rows.length === 1 ? "" : "s"}
        {rows.length > 100 ? ", the first 100 shown" : ""}
      </div>
      <table className="credentials-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{cell(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
