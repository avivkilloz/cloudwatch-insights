/**
 * The generic pane renderer (PLATFORM_PLAN.md §15.5): draws a pane from its
 * manifest alone -- cards of inputs, outputs and action buttons, in the
 * layout the YAML gives. Base64, Diff and JWT are drawn by it, looking and
 * behaving as their hand-written components did; the API table exists only
 * as a manifest.
 *
 * Where each value lives:
 * - an input under "<pane>.in.<key>" in session state (so it syncs, the agent
 *   can set it, a template keeps it) -- unless it is `sensitive`, which stays
 *   in this component's memory and nowhere else, as JWT's token always has;
 * - a live action's outputs (D43) are worked out here from the inputs on
 *   every change and never stored: the inputs are, and they come back the
 *   same. A `run_on: click` one keeps its last result in memory too;
 * - a server action's outputs (a declarative request) under "<pane>.out.<key>",
 *   with `ranAt`/`resultsVersion` beside them, as every run's results are.
 */

import { Dispatch, ReactNode, SetStateAction, useEffect, useMemo, useState } from "react";
import { api, readableError, Target } from "../api";
import ExportMenu from "../components/ExportMenu";
import { PaneSelectionShare } from "../components/paneSelection";
import { HideSelectedButtons, SelectAllCheckbox, useRowSelection } from "../components/rowSelection";
import { useSessionState } from "../sessions/SessionContext";
import DiffView, { DiffViewMode } from "./DiffView";
import { DiffRow, LIVE_FUNCTIONS, Outputs } from "./live";
import {
  Card,
  defaultOf,
  LayoutItem,
  manifest as findManifest,
  ManifestAction,
  ManifestInput,
  ManifestOutput,
  PaneManifest,
  textOf,
  When,
} from "./manifest";

type Values = Record<string, unknown>;

/** Where an item is drawn, which decides its markup: a card's own column, a
 * toolbar line, a row of equal columns, beside the card's title, or "bare" --
 * an input whose label its row has already drawn. */
type Place = "card" | "toolbar" | "row" | "aside" | "bare";

interface Pane {
  m: PaneManifest;
  inputs: Values;
  setInput: (key: string, value: unknown) => void;
  outputs: Values;
  run: (action: ManifestAction) => void;
  busy: Record<string, boolean>;
  errors: Record<string, string | null>;
  resultsVersion: number;
}

export default function ManifestPane({ type }: { type: string }) {
  const m = findManifest(type);
  if (!m) {
    return (
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          This pane's type ({type}) isn't available to you.
        </p>
      </div>
    );
  }
  return <Rendered m={m} />;
}

/** One stored input: a hook per key, so it reads and writes "<pane>.in.<key>". */
function useStoredInput(input: ManifestInput): [unknown, Dispatch<SetStateAction<unknown>>] {
  return useSessionState<unknown>(`in.${input.key}`, () => defaultOf(input));
}

function useStoredOutput(output: ManifestOutput): [unknown, Dispatch<SetStateAction<unknown>>] {
  return useSessionState<unknown>(`out.${output.key}`, undefined);
}

function Rendered({ m }: { m: PaneManifest }) {
  // A manifest never changes while its pane is mounted, so the number of
  // hooks below is fixed for the component's life.
  const stored = m.inputs.filter((i) => !i.sensitive).map((i) => [i, useStoredInput(i)] as const);
  const [secret, setSecret] = useState<Values>(() =>
    Object.fromEntries(m.inputs.filter((i) => i.sensitive).map((i) => [i.key, defaultOf(i)])),
  );
  const inputs: Values = { ...secret };
  for (const [i, [value]] of stored) inputs[i.key] = value;

  function setInput(key: string, value: unknown) {
    const found = stored.find(([i]) => i.key === key);
    if (found) found[1][1](value);
    else setSecret((prev) => ({ ...prev, [key]: value }));
  }

  const storedOutputs = m.outputs.map((o) => [o, useStoredOutput(o)] as const);
  // Undefined until a run, so a pane that never runs anything on the server
  // (Base64) adds nothing to its session.
  const [resultsVersion, setResultsVersion] = useSessionState<number | undefined>("out.resultsVersion", undefined);
  const [, setRanAt] = useSessionState<number | undefined>("out.ranAt", undefined);

  const live = useLiveOutputs(m, inputs);
  const [clicked, setClicked] = useState<Outputs>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const outputs: Values = {};
  for (const [o, [value]] of storedOutputs) if (value !== undefined) outputs[o.key] = value;
  Object.assign(outputs, live, clicked);

  async function run(action: ManifestAction) {
    setBusy((b) => ({ ...b, [action.id]: true }));
    setErrors((e) => ({ ...e, [action.id]: null }));
    try {
      if (action.live) {
        const result = await LIVE_FUNCTIONS[action.live]?.(inputs);
        setClicked(result ?? {});
      } else if (action.request) {
        const result = await api.runPaneAction(m.id, action.id, inputs);
        for (const [o, [, set]] of storedOutputs) set(result[o.key]);
        setRanAt(Date.now());
        setResultsVersion((v) => (v || 0) + 1);
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [action.id]: readableError(e) }));
    } finally {
      setBusy((b) => ({ ...b, [action.id]: false }));
    }
  }

  const pane: Pane = { m, inputs, setInput, outputs, run, busy, errors, resultsVersion: resultsVersion ?? 0 };
  return (
    <div>
      {m.layout.map((card, i) =>
        shown(card.when, pane) ? <CardView key={i} card={card} pane={pane} /> : null,
      )}
    </div>
  );
}

/**
 * The outputs of the pane's live actions, worked out from its inputs on every
 * change. A synchronous function answers in the same render, as the tools
 * always did (no flicker as you type); an asynchronous one (an HMAC through
 * WebCrypto) keeps showing its last answer until the new one arrives.
 */
function useLiveOutputs(m: PaneManifest, inputs: Values): Outputs {
  const key = JSON.stringify(inputs);
  const { now, later } = useMemo(() => {
    const now: Outputs = {};
    const later: Promise<Outputs>[] = [];
    for (const action of m.actions) {
      if (!action.live || action.run_on !== "change") continue;
      const fn = LIVE_FUNCTIONS[action.live];
      if (!fn) continue;
      const result = fn(inputs);
      if (result instanceof Promise) later.push(result);
      else Object.assign(now, result);
    }
    return { now, later };
    // `inputs` is rebuilt every render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, key]);
  const [awaited, setAwaited] = useState<Outputs>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(later).then((results) => {
      if (!cancelled) setAwaited(Object.assign({}, ...results));
    });
    return () => {
      cancelled = true;
    };
  }, [later]);
  return { ...awaited, ...now };
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function shown(when: When | undefined, pane: Pane): boolean {
  if (!when) return true;
  if (when.input !== undefined && pane.inputs[when.input] !== when.equals) return false;
  if (when.output !== undefined && present(pane.outputs[when.output]) !== (when.present ?? true)) return false;
  return true;
}

function CardView({ card, pane }: { card: Card; pane: Pane }) {
  const title = textOf(card.title, pane.inputs);
  const aside = card.aside.filter((item) => shown(item.when, pane));
  return (
    <div className="panel">
      {/* By whether the card has an aside at all, not whether it's showing:
          the title keeps one place as the aside comes and goes. */}
      {card.aside.length > 0 ? (
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {aside.map((item, i) => (
            <Item key={i} item={item} pane={pane} place="aside" />
          ))}
        </div>
      ) : (
        <h2>{title}</h2>
      )}
      {card.items
        .filter((item) => shown(item.when, pane))
        .map((item, i) => (
          <Item key={i} item={item} pane={pane} place="card" first={i === 0} />
        ))}
    </div>
  );
}

function Item({ item, pane, place, first }: { item: LayoutItem; pane: Pane; place: Place; first?: boolean }) {
  const children = (list: LayoutItem[], inner: Place) =>
    list
      .filter((child) => shown(child.when, pane))
      .map((child, i) => <Item key={i} item={child} pane={pane} place={inner} />);

  if (item.toolbar) {
    // Beside a title a toolbar is a tight row; in a card, the app's toolbar
    // line, set off from whatever is above it.
    return place === "aside" ? (
      <div className="row" style={{ gap: 8 }}>
        {children(item.toolbar, "toolbar")}
      </div>
    ) : (
      <div className="toolbar" style={place === "card" && !first ? { marginTop: 10 } : undefined}>
        {children(item.toolbar, "toolbar")}
      </div>
    );
  }
  if (item.row) return <RowView items={item.row.filter((child) => shown(child.when, pane))} pane={pane} />;
  if (item.text !== undefined) {
    return place === "toolbar" || place === "aside" ? (
      <span className="muted">{item.text}</span>
    ) : (
      <p className="muted" style={{ margin: "10px 0 0" }}>
        {item.text}
      </p>
    );
  }
  if (item.copy) return <CopyButton value={pane.outputs[item.copy]} />;
  if (item.action) {
    const action = pane.m.actions.find((a) => a.id === item.action)!;
    return <ActionButton action={action} pane={pane} place={place} />;
  }
  if (item.input) {
    const input = pane.m.inputs.find((i) => i.key === item.input)!;
    return <InputView input={input} pane={pane} place={place} />;
  }
  if (item.output) {
    const output = pane.m.outputs.find((o) => o.key === item.output)!;
    const value = pane.outputs[output.key];
    if (!present(value) && item.empty) {
      return (
        <p className="muted" style={{ margin: 0 }}>
          {item.empty}
        </p>
      );
    }
    return <OutputView output={output} value={value} pane={pane} place={place} first={first} />;
  }
  return null;
}

function inputOf(item: LayoutItem, pane: Pane): ManifestInput | undefined {
  return item.input ? pane.m.inputs.find((i) => i.key === item.input) : undefined;
}

/**
 * Items side by side. Several labelled boxes (Diff's two texts, JWT's
 * algorithm and secret) each get a column with its label on top. One
 * labelled box with things beside it (JWT's secret and its verdict) keeps
 * its label above the whole row, so what's beside it lines up with the box
 * rather than with the label.
 */
function RowView({ items, pane }: { items: LayoutItem[]; pane: Pane }) {
  const labelled = items.filter((item) => textOf(inputOf(item, pane)?.label, pane.inputs));
  const hoisted = labelled.length === 1 && labelled[0] === items[0] ? inputOf(items[0], pane) : undefined;
  const wide = items.some((item) => inputOf(item, pane)?.rows);
  const style = hoisted ? undefined : { alignItems: "flex-start", ...(wide ? { gap: 12 } : {}) };
  const row = (
    <div className="row" style={style}>
      {items.map((child, i) => (
        <Item key={i} item={child} pane={pane} place={hoisted && i === 0 ? "bare" : "row"} />
      ))}
    </div>
  );
  if (!hoisted) return row;
  return (
    <>
      <span className="field-label">{textOf(hoisted.label, pane.inputs)}</span>
      {row}
    </>
  );
}

function CopyButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = typeof value === "string" ? value : present(value) ? JSON.stringify(value, null, 2) : "";
  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied or unavailable -- nothing more we can do
    }
  }
  return (
    <button className="secondary" onClick={copy} disabled={!text}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ActionButton({ action, pane, place }: { action: ManifestAction; pane: Pane; place: Place }) {
  const busy = !!pane.busy[action.id];
  const error = pane.errors[action.id];
  const button = (
    <button onClick={() => pane.run(action)} disabled={busy}>
      {busy ? action.busy_label ?? "Running…" : textOf(action.run_label, pane.inputs) || "Run"}
    </button>
  );
  const shownError = error ? <span className="error-text">{error}</span> : null;
  if (place === "toolbar") {
    return (
      <>
        {button}
        {shownError}
      </>
    );
  }
  return (
    <div className="toolbar">
      {button}
      {shownError}
    </div>
  );
}

// ---------------------------------------------------------------- inputs

/** An input under its label. In a row it is a column: one that grows when
 * `grow` gives its minimum width, otherwise only as wide as it is. A field
 * stacked in a card's column is `spaced` from the next (a text box carries
 * its own margin already). */
function Labelled({
  label,
  children,
  grow,
  spaced = false,
}: {
  label: string;
  children: ReactNode;
  grow: number | false;
  spaced?: boolean;
}) {
  if (grow === -1) return <>{children}</>;
  const style = grow ? { flex: 1, minWidth: grow } : spaced ? { marginBottom: 10 } : undefined;
  return (
    <div style={style}>
      {label && <span className="field-label">{label}</span>}
      {children}
    </div>
  );
}

function InputView({ input, pane, place }: { input: ManifestInput; pane: Pane; place: Place }) {
  const value = pane.inputs[input.key];
  const set = (v: unknown) => pane.setInput(input.key, v);
  const label = textOf(input.label, pane.inputs);
  const placeholder = textOf(input.placeholder, pane.inputs) || undefined;
  const inRow = place === "row";
  const bare = place === "bare";
  const title = input.help || undefined;
  // A column in a row grows: a text box further than a line.
  const grow = (min: number): number | false => (bare ? -1 : inRow ? min : false);
  const spaced = place === "card" && !input.rows;

  if (input.type === "choice" && input.buttons) {
    const buttons = input.choices.map((choice) => (
      <button
        key={String(choice)}
        className={value === choice ? "" : "secondary"}
        onClick={() => set(choice)}
        title={title}
      >
        {input.choice_labels[String(choice)] ?? String(choice)}
      </button>
    ));
    return place === "toolbar" || place === "aside" ? <>{buttons}</> : <div className="toolbar">{buttons}</div>;
  }
  if (input.type === "bool") {
    return (
      <label className="checkbox-item" title={title}>
        <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
        {label}
      </label>
    );
  }
  if (input.type === "choice") {
    const select = (
      <select value={String(value ?? "")} onChange={(e) => set(e.target.value)} aria-label={label || input.key} title={title}>
        {input.choices.map((choice) => (
          <option key={String(choice)} value={String(choice)}>
            {input.choice_labels[String(choice)] ?? String(choice)}
          </option>
        ))}
      </select>
    );
    if (place === "toolbar" || place === "aside" || bare) return select;
    return (
      <Labelled label={label} grow={false} spaced={spaced}>
        {select}
      </Labelled>
    );
  }
  if (input.type === "connection") {
    return (
      <Labelled label={label} grow={grow(200)} spaced={spaced}>
        <ConnectionPicker input={input} value={value} onChange={set} label={label} />
      </Labelled>
    );
  }
  if (input.type === "headers") {
    return (
      <Labelled label={label} grow={grow(200)} spaced={spaced}>
        <PairsEditor value={value} onChange={set} label={label} />
      </Labelled>
    );
  }
  if (input.type === "int") {
    return (
      <Labelled label={label} grow={bare ? -1 : false} spaced={spaced}>
        <input
          type="number"
          min={input.min}
          max={input.max}
          value={value == null ? "" : String(value)}
          onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))}
          aria-label={label || input.key}
          title={title}
          style={{ width: 100 }}
        />
      </Labelled>
    );
  }
  if (input.type === "text") {
    const text = typeof value === "string" ? value : "";
    const box = input.rows ? (
      <textarea
        rows={input.rows}
        value={text}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        aria-label={label || undefined}
        title={title}
        style={inRow ? { width: "100%" } : undefined}
      />
    ) : (
      <input
        type="text"
        value={text}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        aria-label={label || placeholder || input.key}
        title={title}
        style={{ width: input.width ?? "100%" }}
      />
    );
    return (
      <Labelled label={label} grow={input.width ? (bare ? -1 : false) : grow(input.rows ? 240 : 200)} spaced={spaced}>
        {box}
      </Labelled>
    );
  }
  // Environment and log-group pickers are drawn by their services' own pages
  // until those are ported (Phase 3's later PRs).
  return <p className="muted">{label || input.key}: not drawn by manifests yet.</p>;
}

/** A connection of the input's type the user can reach, by its label. */
function ConnectionPicker({
  input,
  value,
  onChange,
  label,
}: {
  input: ManifestInput;
  value: unknown;
  onChange: (v: unknown) => void;
  label: string;
}) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listTargets(input.connection_type)
      .then(setTargets)
      .catch((e) => setError(readableError(e)));
  }, [input.connection_type]);
  const chosen = targets?.find((t) => t.id === value);
  return (
    <>
      <select
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        aria-label={label || input.key}
      >
        <option value="">{targets === null ? "Loading…" : "Choose a connection…"}</option>
        {targets?.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
            {t.config.base_url ? ` (${t.config.base_url})` : ""}
          </option>
        ))}
        {value != null && targets !== null && !chosen && (
          <option value={String(value)}>A connection you can't reach</option>
        )}
      </select>
      {targets?.length === 0 && (
        <span className="muted" style={{ marginLeft: 8 }}>
          None of your environments has one.
        </span>
      )}
      {error && <span className="error-text">{error}</span>}
    </>
  );
}

interface Pair {
  id: number;
  key: string;
  value: string;
}

/** Name/value rows, the HTTP client's header editor's shape, which the agent
 * writes the same way (`platform_tools/panes.convert`). */
function PairsEditor({ value, onChange, label }: { value: unknown; onChange: (v: Pair[]) => void; label: string }) {
  const pairs: Pair[] = Array.isArray(value) ? (value as Pair[]) : [];
  const nextId = () => pairs.reduce((max, p) => Math.max(max, p.id), 0) + 1;
  const update = (id: number, field: "key" | "value", text: string) =>
    onChange(pairs.map((p) => (p.id === id ? { ...p, [field]: text } : p)));
  return (
    <>
      {pairs.map((pair) => (
        <div className="row" key={pair.id} style={{ marginBottom: 6 }}>
          <input
            type="text"
            placeholder="Name"
            aria-label={`${label} name`}
            value={pair.key}
            onChange={(e) => update(pair.id, "key", e.target.value)}
            style={{ width: 200 }}
          />
          <input
            type="text"
            placeholder="Value"
            aria-label={`${label} value`}
            value={pair.value}
            onChange={(e) => update(pair.id, "value", e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="danger" onClick={() => onChange(pairs.filter((p) => p.id !== pair.id))}>
            Remove
          </button>
        </div>
      ))}
      <button
        className="secondary"
        aria-label={`Add a row to ${label || "the list"}`}
        onClick={() => onChange([...pairs, { id: nextId(), key: "", value: "" }])}
      >
        Add row
      </button>
    </>
  );
}

// ---------------------------------------------------------------- outputs

function OutputView({
  output,
  value,
  pane,
  place,
  first,
}: {
  output: ManifestOutput;
  value: unknown;
  pane: Pane;
  place: Place;
  first?: boolean;
}) {
  const inline = place === "toolbar" || place === "aside";
  const label = textOf(output.label, pane.inputs);
  switch (output.render) {
    case "error":
      if (!present(value)) return null;
      return inline ? (
        <span className="error-text">{String(value)}</span>
      ) : (
        <p className="error-text" style={first ? { margin: 0 } : { marginBottom: 0 }}>
          {String(value)}
        </p>
      );
    case "text":
      if (!present(value)) return null;
      return inline ? <span className="muted">{String(value)}</span> : <p className="muted">{String(value)}</p>;
    case "badge": {
      if (!present(value)) return null;
      const badge = output.badges[String(value)] ?? { text: String(value) };
      const tone = badge.tone === "ok" || badge.tone === "error" ? badge.tone : "";
      return <span className={`tag ${tone}`}>{badge.text}</span>;
    }
    case "code": {
      const text = typeof value === "string" ? value : present(value) ? JSON.stringify(value) : "";
      if (output.rows) return <textarea rows={output.rows} value={text} readOnly aria-label={label || output.key} />;
      if (!text) return null;
      return (
        <pre className="tool-json-output" style={{ wordBreak: "break-all", marginBottom: 0 }}>
          {text}
        </pre>
      );
    }
    case "json":
      if (value === undefined) return null;
      return (
        <>
          {label && <span className="field-label">{label}</span>}
          <pre className="tool-json-output">{JSON.stringify(value, null, 2)}</pre>
        </>
      );
    case "diff": {
      const viewInput = output.config.view;
      const view = (typeof viewInput === "string" ? pane.inputs[viewInput] : "unified") as DiffViewMode;
      return <DiffView rows={(value as DiffRow[]) ?? []} view={view || "unified"} />;
    }
    case "table":
      return <TableView output={output} rows={Array.isArray(value) ? (value as Values[]) : []} pane={pane} />;
  }
}

/** Columns in order of first appearance, over enough rows to see them all in
 * practice without walking a huge result. */
const COLUMN_SCAN_ROWS = 200;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function TableView({ output, rows, pane }: { output: ManifestOutput; rows: Values[]; pane: Pane }) {
  const can = (a: ManifestOutput["actions"][number]) => output.actions.includes(a);
  const [shared, setShared] = useState<Values[]>([]);
  const keyed = useMemo(() => rows.map((row, index) => ({ key: String(index), row })), [rows]);
  const selection = useRowSelection({
    rows: keyed,
    keyOf: (r) => r.key,
    toObject: (r) => r.row,
    onSelectionChange: setShared,
    resetOn: pane.resultsVersion,
  });
  const displayed = selection.visibleRows;
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const { row } of keyed.slice(0, COLUMN_SCAN_ROWS)) {
      for (const key of Object.keys(row ?? {})) if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  }, [keyed]);
  const chosen = selection.selectedObjects;

  return (
    <div className="manifest-table">
      <div className="toolbar">
        {can("select") && <SelectAllCheckbox selection={selection} displayed={displayed} />}
        <span className="muted">
          {displayed.length} row{displayed.length === 1 ? "" : "s"}
          {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
          {selection.selectedCount > 0 && `, ${selection.selectedCount} selected`}
        </span>
        {can("select") && <HideSelectedButtons selection={selection} />}
        {can("copy") && <CopyButton value={chosen.length > 0 ? chosen : displayed.map((r) => r.row)} />}
        {can("export") && (
          <ExportMenu rows={displayed.map((r) => r.row)} selectedRows={chosen} filename={pane.m.id} />
        )}
      </div>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          The reply holds no rows.
        </p>
      ) : (
        <div className="manifest-table-scroll">
          <table>
            <thead>
              <tr>
                {can("select") && <th className="manifest-table-check" />}
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((r) => (
                <tr key={r.key} className={selection.isSelected(r) ? "selected" : undefined}>
                  {can("select") && (
                    <td className="manifest-table-check">
                      <input
                        type="checkbox"
                        checked={selection.isSelected(r)}
                        onChange={() => selection.toggle(r)}
                        aria-label={`Select row ${Number(r.key) + 1}`}
                      />
                    </td>
                  )}
                  {columns.map((c) => {
                    const text = cell(r.row?.[c]);
                    return (
                      <td key={c} title={text}>
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can("attach") && <PaneSelectionShare domain={pane.m.id} selectedRows={shared} />}
    </div>
  );
}
