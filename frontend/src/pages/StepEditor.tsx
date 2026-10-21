import { useEffect, useMemo, useState } from "react";
import { useOfferBuild } from "../agent/buildFocus";
import { api, BuiltStepType, readableError, StepSchema, WorkflowParam, WorkflowProblem } from "../api";
import CodeEditor, { problemLines } from "../components/CodeEditor";
import { CardRow } from "../components/SessionCard";
import { ParamFields } from "../components/WorkflowParamFields";
import { Section, ViewHead } from "../components/settings/settingsLayout";
import { DraftStatus, useBuildDraft } from "./buildDraft";
import { parse, read } from "./builderYaml";

/*
 * A step type's editor (PLATFORM_PLAN.md §7.3, D122): its YAML -- a
 * declarative HTTP request, or a chain of steps a workflow uses as one --
 * checked, saved and kept in the store like a pane type. A request can be
 * tried here, sent once as you: for real, so one that changes something asks
 * first. A chain is tried in a workflow, where its steps run as they will.
 * The agent panel's Building tab works on it as on a pane type's (D123).
 */

export type StepScreen = { id: string | null; said?: string; draftId: number | null };

export default function StepEditor({ id, said, draftId, back, opened }: StepScreen & { back: () => void; opened: (id: string, said: string) => void }) {
  const isNew = id === null;
  const [schema, setSchema] = useState<StepSchema | null>(null);
  const [item, setItem] = useState<BuiltStepType | null>(null);
  const [newId, setNewId] = useState("");
  const [source, setSource] = useState("");
  const [problems, setProblems] = useState<WorkflowProblem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(said ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [tried, setTried] = useState<{ status: number; response: unknown; rows?: Record<string, unknown>[]; logs?: string } | null>(
    null,
  );
  const editable = isNew || !!item?.can_edit;
  // Kept as it's typed, with the Building chat (D125).
  const base = isNew ? schema?.starter ?? null : item?.can_edit ? item.source : null;
  const kept = useBuildDraft({
    kind: "step",
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
  useOfferBuild("step", id, item?.label ?? (isNew ? "New step" : id ?? ""), editable, source, (text, summary) => {
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

  useEffect(() => {
    // One load lands, or a late one puts the saved text over a restored draft.
    let cancelled = false;
    api.stepSchema().then(
      (s) => {
        if (cancelled) return;
        setSchema(s);
        if (isNew) setSource((current) => current || s.starter);
      },
      (e) => !cancelled && setError(readableError(e)),
    );
    if (!isNew) {
      api.listBuiltSteps().then(
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

  // The draft as the Try form reads it: its inputs, and whether it's a
  // request or code (a chain is tried in a workflow) that changes something.
  const draft = useMemo(() => {
    const { doc, errors } = parse(source);
    if (errors.length) return null;
    const inputs = (read(doc, ["inputs"]) as WorkflowParam[] | undefined) ?? [];
    const code = read(doc, ["code"]) !== undefined;
    const method = code ? (read(doc, ["changes"]) === true ? "CHANGES" : "GET") : String(read(doc, ["request", "method"]) ?? "GET").toUpperCase();
    return { inputs: Array.isArray(inputs) ? inputs : [], request: read(doc, ["request"]) !== undefined || code, code, method };
  }, [source]);

  async function check(): Promise<boolean> {
    setNotice(null);
    setError(null);
    try {
      const out = await api.checkBuiltStep(source, isNew ? undefined : id ?? undefined, isNew ? newId.trim() || undefined : undefined);
      setProblems(out.errors);
      if (out.ok) setNotice("No problems found.");
      return out.ok;
    } catch (e) {
      setError(readableError(e));
      return false;
    }
  }

  async function save() {
    setBusy(true);
    try {
      if (!(await check())) return;
      const saved = isNew ? await api.createBuiltStep(newId.trim(), source) : await api.updateBuiltStep(id!, source);
      await kept.finish(saved.id, saved.source);
      setItem(saved);
      setSource(saved.source);
      if (isNew) opened(saved.id, `Created ${saved.label} (${saved.id}): a workflow uses it as step: ${saved.id}.`);
      else setNotice("Saved.");
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!item || !confirm(`Delete the step "${item.label}"?`)) return;
    try {
      await api.deleteBuiltStep(item.id);
      back();
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function tryIt() {
    if (!draft) return;
    const asked = draft.code ? "This code changes something, for real, as you. Run it?" : `This sends a ${draft.method} for real, as you. Send it?`;
    if (draft.method !== "GET" && !confirm(asked)) return;
    setError(null);
    setTried(null);
    setBusy(true);
    try {
      setTried(await api.tryBuiltStep(source, values, isNew ? undefined : id ?? undefined));
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel credential-view builder-view step-view">
      <ViewHead back={back} title={isNew ? "New step" : item?.label ?? id ?? ""}>
        {!isNew && item?.can_edit && (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        )}
      </ViewHead>
      <div className="builder-columns">
        <Section title="Definition">
          {isNew && (
            <CardRow label="Id">
              <input id="step-id" type="text" value={newId} placeholder="e.g. restart_device" onChange={(e) => setNewId(e.target.value)} />
              {schema?.namespace && newId.trim() && !newId.includes(":") && (
                <p className="muted builder-saved-as">
                  Saved as <code>{`${schema.namespace}:${newId.trim()}`}</code>, in the store's namespace.
                </p>
              )}
            </CardRow>
          )}
          {editable && schema && (
            <CardRow label="Start from">
              <select
                id="step-start"
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    const start = { chain: schema.chain_example, code: schema.code_example }[e.target.value as "chain" | "code"];
                    setSource(start ?? schema.starter);
                  }
                  setProblems(null);
                }}
              >
                <option value="">{isNew ? "The request below, or…" : "Replace with…"}</option>
                <option value="request">A request</option>
                <option value="chain">A chain of steps</option>
                <option value="code">Code</option>
              </select>
            </CardRow>
          )}
          <CodeEditor
            id="step-source"
            readOnly={!editable}
            minRows={Math.min(34, Math.max(14, source.split("\n").length + 1))}
            value={source}
            marked={problemLines(problems)}
            onChange={(text) => {
              setSource(text);
              setProblems(null);
              setNotice(null);
            }}
          />
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
          {editable && (
            <div className="row credential-view-foot">
              <button onClick={save} disabled={busy || (isNew && !newId.trim())}>
                {busy ? "Saving…" : isNew ? "Create" : "Save"}
              </button>
              <button className="secondary" onClick={check} disabled={busy}>
                Check
              </button>
              {kept.id !== null && dirty && (
                <button className="secondary" onClick={discard} disabled={busy}>
                  Discard
                </button>
              )}
            </div>
          )}
          <DraftStatus kept={kept} />
        </Section>
        <Section title="Try">
          {draft?.request ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                {draft.code ? "Runs the draft's code once, in the runner, as you" : "Sends the draft once, as you"}, with these
                inputs{draft.method !== "GET" ? " -- for real: it changes something" : ""}.
                {draft.code && schema && !schema.runner ? " No runner is set up here, so code can't run." : ""}
              </p>
              <ParamFields
                workflowId=""
                params={draft.inputs}
                values={values}
                set={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
                idPrefix="step-try"
              />
              <div className="row credential-view-foot">
                <button className="secondary" onClick={tryIt} disabled={busy}>
                  {draft.method === "GET" ? "Try it" : draft.code ? "Run it" : `Send ${draft.method}`}
                </button>
              </div>
              {tried && (
                <div className="step-tried">
                  <p className="muted">{draft.code ? "What it returned" : `HTTP ${tried.status}`}{tried.rows ? ` · ${tried.rows.length} row(s)` : ""}</p>
                  <pre className="workflow-json">{JSON.stringify(tried.rows ?? tried.response, null, 2)}</pre>
                  {tried.logs ? (
                    <>
                      <span className="field-label">The code's log</span>
                      <pre className="workflow-json step-tried-log">{tried.logs}</pre>
                    </>
                  ) : null}
                </div>
              )}
            </>
          ) : (
            <p className="muted step-try-empty">
              {draft ? "A chain of steps is tried in a workflow: save it, then use it as step: its id." : "Fix the YAML to try it."}
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}
