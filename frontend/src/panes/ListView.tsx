/**
 * The list and file-browser outputs (PLATFORM_PLAN.md §16.3.2–16.3.3),
 * generalised from DynamoDB's, Cognito's and S3's own `.result-row` lists so
 * those panes look exactly as they did. A manifest output's `config` says
 * what each row shows:
 *
 *   summary: parts drawn in a row's summary line, in order --
 *     { tag: "{{ row.status }}", tone_of: status, tones: { CONFIRMED: ok } }
 *     { tag: disabled, tone: error, when: { field: enabled, equals: false } }
 *     { msg: "{{ row.username }}" }       { muted: "{{ row.attributes.email }}" }
 *     { keys: [out.tableInfo.partition_key, …], separator: " / " }  (DynamoDB)
 *     { copy: "s3://{{ in.bucket }}/{{ row.key }}", label: Copy S3 URI, message: S3 URI }
 *   detail: json | [{ fields: [{label, value}] }, { title, entries: attributes, empty }]
 *   count, export, empty: templates; toolbar: always | rows; expand: a view key.
 *
 * Expanded rows are a view key (`view.expanded`, D48), synced like inputs,
 * so the agent or another member can open a row for everyone looking.
 */

import { ReactNode, useMemo, useState } from "react";
import ExportMenu from "../components/ExportMenu";
import { PaneSelectionShare } from "../components/paneSelection";
import {
  HideSelectedButtons,
  RowCheckbox,
  RowSelection,
  SelectAllCheckbox,
  useRowSelection,
} from "../components/rowSelection";
import { ManifestOutput } from "./manifest";
import { PaneApi, Values } from "./paneApi";
import { lookup, render, Scope, text } from "./template";

type Row = Record<string, unknown>;

interface Keyed {
  key: string;
  index: number;
  row: Row;
}

interface RowWhen {
  field: string;
  equals?: unknown;
  present?: boolean;
}

interface SummaryPart {
  tag?: string;
  tone?: string;
  tone_of?: string;
  tones?: Record<string, string>;
  msg?: string;
  muted?: string;
  keys?: string[];
  separator?: string;
  copy?: string;
  label?: string;
  message?: string;
  when?: RowWhen;
}

interface DetailSection {
  fields?: { label: string; value: string }[];
  title?: string;
  entries?: string;
  empty?: string;
}

function config(output: ManifestOutput): Values {
  return output.config ?? {};
}

function partsOf(output: ManifestOutput): SummaryPart[] {
  const parts = config(output).summary;
  return Array.isArray(parts) ? (parts as SummaryPart[]) : [];
}

function rowShows(when: RowWhen | undefined, row: Row): boolean {
  if (!when) return true;
  const value = lookup(row, when.field);
  if (when.equals !== undefined) return value === when.equals;
  const present = value !== undefined && value !== null && value !== "";
  return present === (when.present ?? true);
}

function scopeOf(pane: PaneApi, extra: Scope): Scope {
  return { in: pane.inputs, out: pane.outputs, ...extra };
}

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** DynamoDB's summary: the row's values at the table's key fields, joined;
 * else its first field; else "(empty item)". */
function keySummary(part: SummaryPart, row: Row, scope: Scope): string {
  const values: string[] = [];
  for (const path of part.keys ?? []) {
    const field = lookup(scope, path);
    if (typeof field === "string" && field && row[field] !== undefined) values.push(String(row[field]));
  }
  if (values.length > 0) return values.join(part.separator ?? " / ");
  const first = Object.keys(row)[0];
  return first ? `${first}: ${String(row[first])}` : "(empty item)";
}

function Summary({ output, row, pane }: { output: ManifestOutput; row: Row; pane: PaneApi }) {
  const scope = scopeOf(pane, { row });
  return (
    <>
      {partsOf(output).map((part, i) => {
        if (!rowShows(part.when, row)) return null;
        if (part.tag !== undefined) {
          const tone = part.tone ?? (part.tone_of ? part.tones?.[text(lookup(row, part.tone_of))] : undefined);
          return (
            <span key={i} className={classes("tag", tone)}>
              {render(part.tag, scope)}
            </span>
          );
        }
        if (part.msg !== undefined) {
          return (
            <span key={i} className="msg">
              {render(part.msg, scope)}
            </span>
          );
        }
        if (part.keys) {
          return (
            <span key={i} className="msg">
              {keySummary(part, row, scope)}
            </span>
          );
        }
        if (part.muted !== undefined) {
          return (
            <span key={i} className="muted">
              {render(part.muted, scope)}
            </span>
          );
        }
        if (part.copy !== undefined) {
          const value = render(part.copy, scope);
          const label = part.message ?? part.label ?? "Value";
          return (
            <button
              key={i}
              className="secondary"
              style={{ padding: "2px 8px" }}
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(value);
                  pane.flash(`${label} copied to clipboard`);
                } catch {
                  pane.flash(`Could not copy automatically — ${label}: ${value}`);
                }
              }}
            >
              {part.label ?? "Copy"}
            </button>
          );
        }
        return null;
      })}
    </>
  );
}

function Detail({ output, row, pane }: { output: ManifestOutput; row: Row; pane: PaneApi }) {
  const detail = config(output).detail;
  if (detail === "json") {
    return (
      <div className="result-row-detail">
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{JSON.stringify(row, null, 2)}</pre>
      </div>
    );
  }
  const sections = Array.isArray(detail) ? (detail as DetailSection[]) : [];
  const scope = scopeOf(pane, { row });
  return (
    <div className="result-row-detail">
      {sections.map((section, i) => {
        const parts: ReactNode[] = [];
        if (section.title) parts.push(<h3 key="t">{section.title}</h3>);
        if (section.fields) {
          parts.push(
            <table key="f" style={{ marginBottom: 10 }}>
              <tbody>
                {section.fields.map((f) => (
                  <tr key={f.label}>
                    <td>{f.label}</td>
                    <td>{render(f.value, scope)}</td>
                  </tr>
                ))}
              </tbody>
            </table>,
          );
        }
        if (section.entries) {
          const entries = Object.entries((lookup(row, section.entries) as Row | undefined) ?? {});
          parts.push(
            entries.length === 0 ? (
              <p key="e" className="muted">
                {section.empty ?? "Nothing."}
              </p>
            ) : (
              <table key="e">
                <tbody>
                  {entries.map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{v === null || v === undefined ? "—" : text(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          );
        }
        return <div key={i}>{parts}</div>;
      })}
    </div>
  );
}

function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === "object") as Row[]) : [];
}

function useSelection(pane: PaneApi, rows: Row[], keyField: string | undefined) {
  const [shared, setShared] = useState<Row[]>([]);
  const keyed = useMemo<Keyed[]>(
    () => rows.map((row, index) => ({ key: keyField ? text(row[keyField]) : String(index), index, row })),
    [rows, keyField],
  );
  const selection = useRowSelection<Keyed>({
    rows: keyed,
    keyOf: (r) => r.key,
    toObject: (r) => ({ ...r.row }),
    onSelectionChange: setShared,
    resetOn: pane.resultsVersion,
  });
  return { selection, shared };
}

function Toolbar({
  output,
  pane,
  selection,
  displayed,
  count,
}: {
  output: ManifestOutput;
  pane: PaneApi;
  selection: RowSelection<Keyed>;
  displayed: Keyed[];
  count: string;
}) {
  const can = (a: ManifestOutput["actions"][number]) => output.actions.includes(a);
  const filename = render(text(config(output).export) || pane.m.id, scopeOf(pane, {}));
  return (
    <div className="toolbar">
      {can("select") && <SelectAllCheckbox selection={selection} displayed={displayed} />}
      <span className="muted">
        {count}
        {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
      </span>
      {can("select") && <HideSelectedButtons selection={selection} />}
      {can("export") && (
        <ExportMenu rows={displayed.map((r) => r.row)} selectedRows={selection.selectedObjects} filename={filename} />
      )}
    </div>
  );
}

function expandedSet(pane: PaneApi, viewKey: string | undefined): Set<number> {
  const value = viewKey ? pane.views[viewKey] : undefined;
  if (value instanceof Set) return new Set(value as Set<number>);
  return new Set(Array.isArray(value) ? (value as number[]) : []);
}

export function ListView({ output, value, pane }: { output: ManifestOutput; value: unknown; pane: PaneApi }) {
  const cfg = config(output);
  const rows = rowsOf(value);
  const { selection, shared } = useSelection(pane, rows, typeof cfg.row_key === "string" ? cfg.row_key : undefined);
  const displayed = selection.visibleRows;
  const viewKey = typeof cfg.expand === "string" ? cfg.expand : undefined;
  const expanded = expandedSet(pane, viewKey);
  const busy = !!pane.busy[text(cfg.busy)];
  const showToolbar = cfg.toolbar === "always" || rows.length > 0;
  const count = render(text(cfg.count), scopeOf(pane, { n: displayed.length }));

  function toggle(index: number) {
    if (!viewKey) return;
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    pane.setView(viewKey, [...next].sort((a, b) => a - b));
  }

  return (
    <>
      {showToolbar && <Toolbar output={output} pane={pane} selection={selection} displayed={displayed} count={count} />}
      {rows.length === 0 && !busy && cfg.empty !== undefined && <p className="muted">{render(text(cfg.empty), {})}</p>}
      {displayed.map((r) => {
        const open = expanded.has(r.index);
        return (
          <div className="result-row" key={r.key}>
            <div className="result-row-summary" onClick={() => toggle(r.index)}>
              {output.actions.includes("select") && <RowCheckbox selection={selection} row={r} />}
              {viewKey && <span className={`chevron ${open ? "open" : ""}`}>▶</span>}
              <Summary output={output} row={r.row} pane={pane} />
            </div>
            {open && cfg.detail !== undefined && <Detail output={output} row={r.row} pane={pane} />}
          </div>
        );
      })}
      {output.actions.includes("attach") && <PaneSelectionShare domain={pane.m.id} selectedRows={shared} />}
    </>
  );
}

/**
 * S3's browser: folders (which navigate, setting the path input -- the
 * pane's own `on_change` then opens them) above files (a list). Folders
 * can't be selected: they're places, not data, and export never had them.
 */
export function FilesView({ output, value, pane }: { output: ManifestOutput; value: unknown; pane: PaneApi }) {
  const cfg = config(output);
  const files = rowsOf(value);
  const folders = rowsOf(pane.outputs[text(cfg.folders)]);
  const { selection, shared } = useSelection(pane, files, typeof cfg.row_key === "string" ? cfg.row_key : undefined);
  const displayed = selection.visibleRows;
  const busy = !!pane.busy[text(cfg.busy)];
  const path = text(cfg.path);
  const count = render(text(cfg.count), scopeOf(pane, { n: displayed.length, folders: folders.length }));
  const empty = folders.length === 0 && files.length === 0;

  return (
    <>
      {!empty && <Toolbar output={output} pane={pane} selection={selection} displayed={displayed} count={count} />}
      {empty && !busy && cfg.empty !== undefined && <p className="muted">{render(text(cfg.empty), {})}</p>}
      {folders.map((f) => (
        <div className="result-row" key={text(f.prefix)}>
          <div
            className="result-row-summary"
            style={{ cursor: "pointer" }}
            onClick={() => pane.changeInputs({ [path]: text(f.prefix) })}
          >
            <span className="tag">folder</span>
            <span className="msg">{text(f.name)}/</span>
          </div>
        </div>
      ))}
      {displayed.map((r) => (
        <div className="result-row" key={r.key}>
          <div className="result-row-summary" style={{ cursor: "default" }}>
            {output.actions.includes("select") && <RowCheckbox selection={selection} row={r} />}
            <Summary output={output} row={r.row} pane={pane} />
          </div>
        </div>
      ))}
      {output.actions.includes("attach") && <PaneSelectionShare domain={pane.m.id} selectedRows={shared} />}
    </>
  );
}

/** Tags drawn from one object output (DynamoDB's table info). Each entry is a
 * template over `v` (the output), or `{text, when}` to show only when a field
 * of it is set. */
export function TagsView({ output, value, pane }: { output: ManifestOutput; value: unknown; pane: PaneApi }) {
  const tags = Array.isArray(config(output).tags) ? (config(output).tags as (string | { text: string; when?: string })[]) : [];
  const v = (value ?? {}) as Row;
  const scope = scopeOf(pane, { v });
  return (
    <div className="row" style={{ marginTop: 8 }}>
      {tags.map((tag, i) => {
        if (typeof tag !== "string") {
          const field = tag.when ? v[tag.when] : true;
          if (field === undefined || field === null || field === "" || field === false) return null;
        }
        return (
          <span key={i} className="tag">
            {render(typeof tag === "string" ? tag : tag.text, scope)}
          </span>
        );
      })}
    </div>
  );
}
