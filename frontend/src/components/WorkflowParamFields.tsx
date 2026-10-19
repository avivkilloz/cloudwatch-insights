import { useEffect, useMemo, useState } from "react";
import { api, readableError, Target, WorkflowParam, WorkflowParamOptions } from "../api";
import { CardRow } from "./SessionCard";

/**
 * A workflow's parameters as fields (§22.9): an environment picked by name,
 * choices listed by a pane input's loader, several values as chips. Drawn by
 * the Workflows page's Build with parameters and by the Workflow pane (a
 * manifest input of type `workflow_params`), so the two never ask for a
 * workflow's parameters two different ways -- the pane's name/value rows left
 * a person to know each key and type an environment's name.
 *
 * Controlled: `values` holds what was set; a parameter left unset shows its
 * default, which is what the run uses for it.
 */
export function ParamFields({
  workflowId,
  params,
  values,
  set,
  idPrefix,
}: {
  workflowId: string;
  params: WorkflowParam[];
  values: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
  idPrefix: string;
}) {
  const [targets, setTargets] = useState<Record<string, Target[]>>({});
  useEffect(() => {
    const types = [...new Set(params.filter((p) => p.connection_type).map((p) => p.connection_type!))];
    types.forEach((t) =>
      api
        .listTargets(t)
        .then((list) => setTargets((cur) => ({ ...cur, [t]: list })))
        .catch(() => undefined),
    );
  }, [params]);
  const shown = useMemo(
    () =>
      Object.fromEntries(
        params.map((p) => [p.key, values[p.key] ?? p.default ?? (p.type === "connections" || p.multiple ? [] : "")]),
      ),
    [params, values],
  );
  return (
    <>
      {params.map((p) => {
        const label = `${p.label || p.key}${p.required ? " *" : ""}`;
        const id = `${idPrefix}-${p.key}`;
        const value = shown[p.key];
        let control;
        if (p.type === "bool") {
          control = <input id={id} type="checkbox" checked={!!value} onChange={(e) => set(p.key, e.target.checked)} />;
        } else if (p.type === "choice") {
          control = (
            <select id={id} value={String(value ?? "")} onChange={(e) => set(p.key, e.target.value)}>
              <option value="">Choose…</option>
              {(p.choices ?? []).map((c) => (
                <option key={String(c)} value={String(c)}>
                  {String(c)}
                </option>
              ))}
            </select>
          );
        } else if (p.type === "connection") {
          control = (
            <select id={id} value={String(value ?? "")} onChange={(e) => set(p.key, e.target.value ? Number(e.target.value) : "")}>
              <option value="">Choose…</option>
              {(targets[p.connection_type ?? ""] ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          );
        } else if (p.type === "connections") {
          const chosen = Array.isArray(value) ? (value as number[]) : [];
          control = (
            <div className="workflow-param-multi" id={id}>
              {(targets[p.connection_type ?? ""] ?? []).map((t) => (
                <label key={t.id} className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={chosen.includes(t.id)}
                    onChange={(e) => set(p.key, e.target.checked ? [...chosen, t.id] : chosen.filter((c) => c !== t.id))}
                  />
                  {t.label}
                </label>
              ))}
            </div>
          );
        } else if (p.type === "text" && (p.multiple || p.options_from)) {
          control = <TextParam id={id} workflowId={workflowId} param={p} values={shown} set={(v) => set(p.key, v)} />;
        } else {
          control = (
            <input
              id={id}
              type={p.type === "int" ? "number" : "text"}
              value={String(value ?? "")}
              onChange={(e) => set(p.key, p.type === "int" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
            />
          );
        }
        return (
          <CardRow key={p.key} label={label}>
            <div className="workflow-param" title={p.help || undefined}>
              {control}
              {p.help && <div className="muted workflow-param-help">{p.help}</div>}
            </div>
          </CardRow>
        );
      })}
    </>
  );
}

/** The parameters an options source reads (`params.env` in its `with`). */
function optionDeps(p: WorkflowParam): string[] {
  const text = JSON.stringify(p.options_from?.with ?? {});
  return [...new Set([...text.matchAll(/params\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
}

/**
 * A parameter's choices, listed by its pane input's loader (D94) -- listed
 * again whenever a parameter it reads changes (the environment above), a
 * moment after the last change rather than on every keystroke.
 */
function useParamOptions(workflowId: string, p: WorkflowParam, values: Record<string, unknown>) {
  const deps = useMemo(() => optionDeps(p), [p]);
  const given = JSON.stringify(Object.fromEntries(deps.map((d) => [d, values[d] ?? null])));
  const [state, setState] = useState<{ loading: boolean; result: WorkflowParamOptions | null; error: string | null }>({
    loading: false,
    result: null,
    error: null,
  });
  useEffect(() => {
    if (!p.options_from) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = window.setTimeout(() => {
      api
        .workflowParamOptions(workflowId, p.key, JSON.parse(given))
        .then((result) => live && setState({ loading: false, result, error: null }))
        .catch((e) => live && setState({ loading: false, result: null, error: readableError(e) }));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [workflowId, p.key, p.options_from, given]);
  return state;
}

/**
 * A text parameter with listed choices and/or several values. Typing stays
 * possible: a loader can fail or not know a name, and the list is a help, not
 * a rule. Several values are chips; a pick from the list, or Enter, adds one.
 */
export function TextParam({
  id,
  workflowId,
  param: p,
  values,
  set,
}: {
  id: string;
  workflowId: string;
  param: WorkflowParam;
  values: Record<string, unknown>;
  set: (value: unknown) => void;
}) {
  const listed = useParamOptions(workflowId, p, values);
  const [draft, setDraft] = useState("");
  const options = listed.result?.options ?? [];
  const listId = `${id}-options`;
  const chosen = p.multiple ? (Array.isArray(values[p.key]) ? (values[p.key] as string[]) : []) : [];
  const add = (text: string) => {
    const v = text.trim();
    if (v && !chosen.includes(v)) set([...chosen, v]);
    setDraft("");
  };
  let status: JSX.Element | null = null;
  if (p.options_from) {
    if (listed.loading) status = <span className="muted">Listing…</span>;
    else if (listed.error || listed.result?.error) {
      status = <span className="error-text">{listed.error || listed.result?.error}</span>;
    } else if (listed.result?.needs?.length) status = <span className="muted">Choose {listed.result.needs.join(", ")} first.</span>;
    else if (listed.result) {
      const left = options.filter((o) => !chosen.includes(o.value)).length;
      status = <span className="muted">{options.length === 0 ? "Nothing to choose from" : `${left} to choose from`}</span>;
    }
  }
  return (
    <>
      {p.multiple && chosen.length > 0 && (
        <div className="credential-grants workflow-param-chosen">
          {chosen.map((v) => (
            <span key={v} className="tag credential-grant" data-chosen={v}>
              {v}
              <button
                type="button"
                className="credential-grant-remove"
                aria-label={`Remove ${v}`}
                onClick={() => set(chosen.filter((c) => c !== v))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        id={id}
        type="text"
        list={p.options_from ? listId : undefined}
        placeholder={p.multiple ? (p.options_from ? "Pick or type, then Enter" : "Type, then Enter") : undefined}
        value={p.multiple ? draft : String(values[p.key] ?? "")}
        onChange={(e) => {
          if (!p.multiple) return set(e.target.value);
          // A pick from the list adds it at once; typing waits for Enter.
          if (options.some((o) => o.value === e.target.value)) add(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (p.multiple && e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
      />
      {p.options_from && (
        <datalist id={listId}>
          {options
            .filter((o) => !chosen.includes(o.value))
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label !== o.value ? o.label : undefined}
              </option>
            ))}
        </datalist>
      )}
      {status && <div className="workflow-param-status">{status}</div>}
      {(listed.result?.errors ?? []).map((e) => (
        <div key={e} className="error-text workflow-param-status">
          {e}
        </div>
      ))}
    </>
  );
}

