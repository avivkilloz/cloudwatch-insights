import { ReactNode, useMemo } from "react";
import { BuilderSchema } from "../api";
import Icon from "../components/Icon";
import { append, count, deleteIn, parse, Path, setIn, swap } from "./builderYaml";

/*
 * The Builder's form (5-2d, D73, D115): the same definition as the YAML beside
 * it, never a copy. It reads the editor's text and every change is a splice of
 * that text (builderYaml.ts), so switching back to the YAML shows exactly
 * what was there with only the changed lines different -- comments, wrapping
 * and anything the form doesn't cover kept as written. What it covers is what
 * a pane is made of: what it's called, its inputs, the actions that fill its
 * outputs, the outputs, and the cards they're laid out in; the rest (a
 * request's columns and params, `when`, help texts…) stays the YAML's, and the
 * form says when an item has more there.
 */

type Obj = Record<string, unknown>;
type Edit = (source: string) => string;

const CONNECTION_TYPES = ["connection", "connections"];
const ACTION_KINDS = [
  ["handler", "A handler"],
  ["live", "A live function"],
  ["http", "A request (HTTP)"],
  ["aws", "A request (AWS)"],
] as const;
type ActionKind = (typeof ACTION_KINDS)[number][0];
// What the form shows of each: anything else on an item is the YAML's.
const KNOWN = {
  input: ["key", "type", "label", "connection_type"],
  action: ["id", "handler", "live", "request", "main", "run_label"],
  output: ["key", "render", "label"],
  request: ["connection", "service", "operation", "paginate", "path", "fixed_path", "rows"],
};

function list(value: unknown): Obj[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object" && !Array.isArray(v)) as Obj[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function extra(item: Obj, known: string[]): string[] {
  return Object.keys(item).filter((k) => !known.includes(k));
}

function kindOf(action: Obj): ActionKind {
  if (action.live !== undefined) return "live";
  if (action.request && typeof action.request === "object") return "service" in (action.request as Obj) ? "aws" : "http";
  return "handler";
}

/** Every place in the layout and the actions that names `old` as an input,
 * output or action: renamed with it, or the pane would point at nothing. */
function referencesTo(data: Obj, field: "input" | "output" | "action", old: string): Path[] {
  const out: Path[] = [];
  const walk = (items: unknown, at: Path) => {
    list(items).forEach((item, i) => {
      if (item[field] === old) out.push([...at, i, field]);
      for (const nested of ["row", "toolbar", "line"]) if (Array.isArray(item[nested])) walk(item[nested], [...at, i, nested]);
    });
  };
  list(data.layout).forEach((card, c) => {
    walk(card.items, ["layout", c, "items"]);
    walk(card.aside, ["layout", c, "aside"]);
  });
  if (field === "input") {
    list(data.actions).forEach((action, a) => {
      const request = action.request as Obj | undefined;
      for (const key of ["connection", "path", "query", "rows_at"]) {
        if (request && request[key] === old) out.push(["actions", a, "request", key]);
      }
    });
  }
  return out;
}

export default function BuilderForm({
  source,
  onChange,
  schema,
}: {
  source: string;
  onChange: (source: string) => void;
  schema: BuilderSchema | null;
}) {
  const { doc, errors } = useMemo(() => parse(source), [source]);
  if (errors.length > 0) {
    return (
      <p className="error-text builder-form-unreadable">
        The YAML doesn't read as YAML ({errors[0]}). Fix it in the YAML view and the form comes back.
      </p>
    );
  }
  const data = (doc.toJS() ?? {}) as Obj;
  const inputs = list(data.inputs);
  const actions = list(data.actions);
  const outputs = list(data.outputs);
  const cards = list(data.layout);
  const connectionInputs = inputs.filter((i) => CONNECTION_TYPES.includes(str(i.type))).map((i) => str(i.key));
  const textInputs = inputs.filter((i) => str(i.type) === "text").map((i) => str(i.key));

  const apply = (...edits: Edit[]) => onChange(edits.reduce((text, edit) => edit(text), source));
  const set = (path: Path, value: unknown): Edit => (text) => setIn(text, path, value);
  // An optional field left empty is no field at all, not `label: ""`.
  const setOptional = (path: Path, value: string): Edit => set(path, value === "" ? undefined : value);

  function rename(field: "input" | "output" | "action", path: Path, old: string, next: string) {
    // Renamed as typed, a letter at a time -- through "" when the old name is
    // cleared first, so references at "" are followed too.
    const refs = referencesTo(data, field, old);
    apply(set(path, next), ...refs.map((ref) => set(ref, next)));
  }

  function changeKind(a: number, kind: ActionKind) {
    const clear = (["handler", "live", "request"] as const).map((k) => set(["actions", a, k], undefined));
    const connection = connectionInputs[0] ?? "connection";
    const fresh: Record<ActionKind, Edit> = {
      handler: set(["actions", a, "handler"], schema?.handlers[0] ?? ""),
      live: set(["actions", a, "live"], schema?.live[0] ?? ""),
      http: set(["actions", a, "request"], { connection, path: textInputs[0] ?? "path" }),
      aws: set(["actions", a, "request"], { connection, service: "lambda", operation: "ListFunctions" }),
    };
    apply(...clear, fresh[kind]);
  }

  function setMain(a: number, on: boolean) {
    // One main action: what run_pane runs and refresh repeats.
    apply(...actions.map((_, i) => set(["actions", i, "main"], i === a && on ? true : undefined)));
  }

  return (
    <div className="builder-form">
      <FormSection title="About">
        <Field label="Label" value={str(data.label)} onChange={(v) => apply(set(["label"], v))} />
        <Field label="Description" value={str(data.description)} onChange={(v) => apply(setOptional(["description"], v))} />
        <Field label="Category" value={str(data.category)} placeholder="Services, Tools, or one of your own" onChange={(v) => apply(setOptional(["category"], v))} />
      </FormSection>

      <FormSection title="Inputs" add={["Input", () => apply((t) => append(t, ["inputs"], { key: `input${inputs.length + 1}`, type: "text", label: `Input ${inputs.length + 1}` }))]}>
        {inputs.length === 0 && <p className="muted builder-form-empty">No inputs: what the person using the pane fills in.</p>}
        {inputs.map((input, i) => (
          <Item key={i} path={["inputs", i]} index={i} total={inputs.length} apply={apply} more={extra(input, KNOWN.input)}>
            <Field label="Key" value={str(input.key)} onChange={(v) => rename("input", ["inputs", i, "key"], str(input.key), v)} />
            <Select label="Type" value={str(input.type)} options={schema?.input_types ?? [str(input.type)]} onChange={(v) => apply(set(["inputs", i, "type"], v))} />
            <Field label="Label" value={str(input.label)} onChange={(v) => apply(setOptional(["inputs", i, "label"], v))} />
            {CONNECTION_TYPES.includes(str(input.type)) && (
              <Field label="Connection type" value={str(input.connection_type)} placeholder="aws" onChange={(v) => apply(setOptional(["inputs", i, "connection_type"], v))} />
            )}
          </Item>
        ))}
      </FormSection>

      <FormSection title="Actions" add={["Action", () => apply((t) => append(t, ["actions"], { id: `action${actions.length + 1}`, run_label: "Run", request: { connection: connectionInputs[0] ?? "connection", service: "lambda", operation: "ListFunctions" } }))]}>
        {actions.length === 0 && <p className="muted builder-form-empty">No actions: what fills the outputs.</p>}
        {actions.map((action, a) => {
          const kind = kindOf(action);
          const request = (action.request ?? {}) as Obj;
          const at: Path = ["actions", a];
          return (
            <Item key={a} path={at} index={a} total={actions.length} apply={apply} more={[...extra(action, KNOWN.action), ...extra(request, KNOWN.request).map((k) => `request.${k}`)]}>
              <Field label="Id" value={str(action.id)} onChange={(v) => rename("action", [...at, "id"], str(action.id), v)} />
              <Select label="Runs" value={kind} options={ACTION_KINDS.map(([k]) => k)} labels={Object.fromEntries(ACTION_KINDS)} onChange={(v) => changeKind(a, v as ActionKind)} />
              {kind === "handler" && (
                <Select label="Handler" value={str(action.handler)} options={schema?.handlers ?? []} onChange={(v) => apply(set([...at, "handler"], v))} />
              )}
              {kind === "live" && <Select label="Function" value={str(action.live)} options={schema?.live ?? []} onChange={(v) => apply(set([...at, "live"], v))} />}
              {(kind === "http" || kind === "aws") && (
                <Select label="Connection" value={str(request.connection)} options={connectionInputs} onChange={(v) => apply(set([...at, "request", "connection"], v))} />
              )}
              {kind === "aws" && (
                <>
                  <Field label="Service" value={str(request.service)} placeholder="lambda" onChange={(v) => apply(set([...at, "request", "service"], v))} />
                  <Field label="Operation" value={str(request.operation)} placeholder="ListFunctions" onChange={(v) => apply(set([...at, "request", "operation"], v))} />
                  <Check label="Every page" value={request.paginate === true} onChange={(v) => apply(set([...at, "request", "paginate"], v ? true : undefined))} />
                </>
              )}
              {kind === "http" && (
                <>
                  <Select label="Path from" value={str(request.path)} options={["", ...textInputs]} labels={{ "": "— a fixed path —" }} onChange={(v) => apply(setOptional([...at, "request", "path"], v))} />
                  {!request.path && <Field label="Fixed path" value={str(request.fixed_path)} placeholder="/status" onChange={(v) => apply(setOptional([...at, "request", "fixed_path"], v))} />}
                </>
              )}
              {(kind === "http" || kind === "aws") && (
                <Field label="Rows at" value={str((request.rows as Obj | undefined)?.at)} placeholder="Functions" onChange={(v) => apply(setOptional([...at, "request", "rows", "at"], v))} />
              )}
              <Field label="Button" value={str(action.run_label)} onChange={(v) => apply(setOptional([...at, "run_label"], v))} />
              <Check label="Main" value={action.main === true} onChange={(v) => setMain(a, v)} />
            </Item>
          );
        })}
      </FormSection>

      <FormSection title="Outputs" add={["Output", () => apply((t) => append(t, ["outputs"], { key: `output${outputs.length + 1}`, render: "table" }))]}>
        {outputs.length === 0 && <p className="muted builder-form-empty">No outputs: what the actions fill and the cards show.</p>}
        {outputs.map((output, o) => (
          <Item key={o} path={["outputs", o]} index={o} total={outputs.length} apply={apply} more={extra(output, KNOWN.output)}>
            <Field label="Key" value={str(output.key)} onChange={(v) => rename("output", ["outputs", o, "key"], str(output.key), v)} />
            <Select label="Shown as" value={str(output.render)} options={schema?.renders ?? [str(output.render)]} onChange={(v) => apply(set(["outputs", o, "render"], v))} />
            <Field label="Label" value={str(output.label)} onChange={(v) => apply(setOptional(["outputs", o, "label"], v))} />
          </Item>
        ))}
      </FormSection>

      <FormSection title="Layout" add={["Card", () => apply((t) => append(t, ["layout"], { title: `Card ${cards.length + 1}`, items: [] }))]}>
        {cards.length === 0 && <p className="muted builder-form-empty">No cards: nothing is drawn.</p>}
        {cards.map((card, c) => (
          <Item key={c} path={["layout", c]} index={c} total={cards.length} apply={apply} more={extra(card, ["title", "items"])}>
            {typeof card.title === "object" && card.title !== null ? (
              <span className="muted builder-form-note">Its title depends on an input: set in the YAML.</span>
            ) : (
              <Field label="Title" value={str(card.title)} onChange={(v) => apply(setOptional(["layout", c, "title"], v))} />
            )}
            <div className="builder-form-chips" aria-label={`What card ${c + 1} holds`}>
              {list(card.items).map((item, i) => (
                <span key={i} className="tag builder-form-chip">
                  {chipText(item)}
                  <button
                    type="button"
                    className="link-button"
                    aria-label={`Take ${chipText(item)} out of the card`}
                    onClick={() => apply((t) => deleteIn(t, ["layout", c, "items", i]))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <select
                aria-label={`Add to card ${c + 1}`}
                value=""
                onChange={(e) => {
                  const [what, key] = e.target.value.split(":");
                  const item = what === "action" ? { toolbar: [{ action: key }] } : { [what]: key };
                  apply((t) => append(t, ["layout", c, "items"], item));
                }}
              >
                <option value="">+ Add…</option>
                {inputs.map((i) => <option key={`i${str(i.key)}`} value={`input:${str(i.key)}`}>Input: {str(i.key)}</option>)}
                {actions.map((a) => <option key={`a${str(a.id)}`} value={`action:${str(a.id)}`}>Button: {str(a.id)}</option>)}
                {outputs.map((o) => <option key={`o${str(o.key)}`} value={`output:${str(o.key)}`}>Output: {str(o.key)}</option>)}
              </select>
            </div>
          </Item>
        ))}
      </FormSection>
      <p className="muted builder-form-note">
        {count(doc, ["inputs"])} input(s), {count(doc, ["actions"])} action(s), {count(doc, ["outputs"])} output(s),{" "}
        {count(doc, ["layout"])} card(s). Everything else — a request's columns and params, when a card shows, help
        texts — is in the YAML, which the form never rewrites.
      </p>
    </div>
  );
}

function chipText(item: Obj): string {
  if (typeof item.input === "string") return `Input: ${item.input}`;
  if (typeof item.output === "string") return `Output: ${item.output}`;
  if (typeof item.action === "string") return `Button: ${item.action}`;
  const bar = list(item.toolbar);
  if (bar.length && bar.every((b) => typeof b.action === "string")) return `Buttons: ${bar.map((b) => b.action).join(", ")}`;
  return `${Object.keys(item)[0] ?? "Item"} (in the YAML)`;
}

function FormSection({ title, add, children }: { title: string; add?: [string, () => void]; children: ReactNode }) {
  return (
    <div className="builder-form-section">
      <div className="builder-form-head">
        <h4>{title}</h4>
        {add && (
          <button type="button" className="secondary" onClick={add[1]}>
            + {add[0]}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Item({
  path,
  index,
  total,
  apply,
  more,
  children,
}: {
  path: Path;
  index: number;
  total: number;
  apply: (...edits: Edit[]) => void;
  more: string[];
  children: ReactNode;
}) {
  const at = path.slice(0, -1);
  return (
    <div className="builder-form-item">
      <div className="builder-form-fields">{children}</div>
      <div className="builder-form-item-actions">
        {more.length > 0 && <span className="muted builder-form-more" title={more.join(", ")}>+{more.length} in the YAML</span>}
        <button type="button" className="secondary icon-btn" aria-label="Move up" disabled={index === 0} onClick={() => apply((t) => swap(t, at, index, index - 1))}>
          <Icon name="up" />
        </button>
        <button type="button" className="secondary icon-btn" aria-label="Move down" disabled={index === total - 1} onClick={() => apply((t) => swap(t, at, index, index + 1))}>
          <Icon name="down" />
        </button>
        <button type="button" className="secondary icon-btn" aria-label="Remove" onClick={() => apply((t) => deleteIn(t, path))}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label className="builder-form-field">
      <span>{label}</span>
      <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  labels?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  // A value the lists don't hold (a handler the group can't use, a typo) is
  // shown as it is rather than silently replaced by the first choice.
  const all = options.includes(value) ? options : [value, ...options];
  return (
    <label className="builder-form-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {all.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? (o || "—")}
          </option>
        ))}
      </select>
    </label>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="builder-form-field builder-form-check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

