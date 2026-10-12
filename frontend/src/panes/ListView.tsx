/**
 * The list and file-browser outputs (PLATFORM_PLAN.md §16.3.2–16.3.3,
 * §16.4), generalised from DynamoDB's, Cognito's, S3's and IoT's own
 * `.result-row` lists so those panes look exactly as they did. A manifest
 * output's `config` says what each row shows:
 *
 *   summary: parts drawn in a row's summary line (panes/summary.tsx)
 *   detail: json | sections (panes/DetailSections.tsx) | a detail action:
 *     { action: thing_detail, include, include_help, noun, merge: [fields], sections }
 *     -- expanding a row fetches its detail; "Include detail" fetches the
 *     checked rows' for export and attach
 *   groups: { rows: things, name: environment_name, error: error, as: environment }
 *     -- the value is one group per connection (a fan-out's), each holding
 *     its rows; a group's error goes in the Target errors box
 *   count, export, empty: templates; toolbar: always | rows; expand: a view
 *   key; domain: what the agent's chat calls the attached rows.
 *
 * Expanded rows are a view key (`view.expanded`, D48), synced like inputs,
 * so the agent or another member can open a row for everyone looking --
 * and a row opened elsewhere has its detail fetched here.
 */

import { useEffect, useMemo, useState } from "react";
import ExportMenu from "../components/ExportMenu";
import { PaneSelectionShare } from "../components/paneSelection";
import {
  HideSelectedButtons,
  RowCheckbox,
  RowSelection,
  SelectAllCheckbox,
  useRowSelection,
} from "../components/rowSelection";
import { DetailSections, Section } from "./DetailSections";
import { ManifestAction, ManifestOutput } from "./manifest";
import { PaneApi, Values } from "./paneApi";
import { DetailCache, useDetailCache } from "./rowDetail";
import { Row, SummaryPart, SummaryParts } from "./summary";
import { lookup, render, Scope, text } from "./template";

interface Keyed {
  key: string;
  index: number;
  row: Row;
  /** The connection's group the row came from, for a fan-out's list. */
  group?: Row;
}

interface Groups {
  rows?: string;
  name?: string;
  error?: string;
  as?: string;
}

interface DetailAction {
  action: string;
  include?: string;
  include_help?: string;
  noun?: string;
  merge?: string[];
  sections?: Section[];
}

function config(output: ManifestOutput): Values {
  return output.config ?? {};
}

function partsOf(output: ManifestOutput): SummaryPart[] {
  const parts = config(output).summary;
  return Array.isArray(parts) ? (parts as SummaryPart[]) : [];
}

function scopeOf(pane: PaneApi, extra: Scope): Scope {
  return { in: pane.inputs, out: pane.outputs, ...extra };
}

function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === "object") as Row[]) : [];
}

function detailActionOf(output: ManifestOutput): DetailAction | undefined {
  const detail = config(output).detail;
  return detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as DetailAction) : undefined;
}

/** A list output's rows, keyed. A fan-out's groups are flattened the way the
 * server's `platform_tools/panes.flatten` does, each row stamped with its
 * group's name under `as` -- what export and attach have always called
 * `environment` -- so the agent's row numbers and the pane's agree. */
function flatten(value: unknown, groups: Groups | undefined, keyField: string | undefined) {
  const out: Keyed[] = [];
  const errors: { name: string; error: string }[] = [];
  if (!groups) {
    rowsOf(value).forEach((row, index) => out.push({ key: keyField ? text(row[keyField]) : String(index), index, row }));
    return { rows: out, errors, groupCount: 0 };
  }
  const listed = rowsOf(value);
  listed.forEach((group, g) => {
    const name = group[groups.name ?? "name"];
    const error = group[groups.error ?? "error"];
    if (error) errors.push({ name: text(name), error: text(error) });
    for (const row of rowsOf(group[groups.rows ?? "rows"])) {
      const stamped = groups.as ? { [groups.as]: name, ...row } : row;
      const index = out.length;
      out.push({ key: `${g}|${keyField ? text(row[keyField]) : index}`, index, row: stamped, group });
    }
  });
  return { rows: out, errors, groupCount: listed.length };
}

/** A row action's inputs, read from the row and its group by the paths its
 * `args` give (the server reads the same paths for the agent's inspect_row). */
function argsOf(action: ManifestAction, r: Keyed): Values {
  const scope = { row: r.row, group: r.group ?? {} };
  return Object.fromEntries(Object.entries(action.args ?? {}).map(([name, path]) => [name, lookup(scope, path)]));
}

/** What export and attach carry for a checked row with "Include detail" on:
 * the row, plus the detail's `merge` fields, plus what couldn't be loaded. */
function withDetail(row: Row, detail: Row, spec: DetailAction): Row {
  const merged: Row = { ...row };
  for (const field of spec.merge ?? Object.keys(detail)) merged[field] = detail[field];
  const warnings = detail.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) merged.detail_warnings = warnings;
  return merged;
}

function useSelection(
  pane: PaneApi,
  keyed: Keyed[],
  toObject: (r: Keyed) => Row = (r) => ({ ...r.row }),
) {
  const [shared, setShared] = useState<Row[]>([]);
  const selection = useRowSelection<Keyed>({
    rows: keyed,
    keyOf: (r) => r.key,
    toObject,
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
  detail,
}: {
  output: ManifestOutput;
  pane: PaneApi;
  selection: RowSelection<Keyed>;
  displayed: Keyed[];
  count: string;
  detail?: { spec: DetailAction; cache: DetailCache<Keyed, Row> };
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
      {detail?.spec.include && selection.selectedCount > 0 && (
        <label className="checkbox-item" title={detail.spec.include_help}>
          <input
            type="checkbox"
            checked={detail.cache.includeDetails}
            onChange={(e) => detail.cache.setIncludeDetails(e.target.checked)}
          />
          {detail.spec.include}
        </label>
      )}
      {detail && detail.cache.loadingCount > 0 && (
        <span className="muted">Loading details… ({detail.cache.loadingCount} left)</span>
      )}
      {detail && detail.cache.includeDetails && detail.cache.errorCount > 0 && (
        <span className="error-text">
          {detail.cache.errorCount} {detail.spec.noun ?? "row(s)"} had no detail available — exported from their
          summary alone.
        </span>
      )}
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

const NO_ACTION: ManifestAction = {
  id: "",
  run_on: "click",
  on_change: [],
  requires: {},
  resets: [],
  main: false,
  args: {},
};

export function ListView({ output, value, pane }: { output: ManifestOutput; value: unknown; pane: PaneApi }) {
  const cfg = config(output);
  const keyField = typeof cfg.row_key === "string" ? cfg.row_key : undefined;
  const groups = cfg.groups && typeof cfg.groups === "object" ? (cfg.groups as Groups) : undefined;
  const { rows: keyed, errors, groupCount } = useMemo(() => flatten(value, groups, keyField), [value, groups, keyField]);
  const spec = detailActionOf(output);
  const action = spec ? pane.m.actions.find((a) => a.id === spec.action) ?? NO_ACTION : NO_ACTION;
  const cache = useDetailCache<Keyed, Row>({
    keyOf: (r) => r.key,
    fetchDetail: (r) => pane.runRow(action, argsOf(action, r)),
    resetOn: pane.resultsVersion,
  });
  const toObject = (r: Keyed): Row => {
    if (!spec || !cache.includeDetails) return { ...r.row };
    const detail = cache.detailFor(r);
    return detail ? withDetail(r.row, detail, spec) : { ...r.row };
  };
  const { selection, shared } = useSelection(pane, keyed, toObject);
  const displayed = selection.visibleRows;
  const viewKey = typeof cfg.expand === "string" ? cfg.expand : undefined;
  const expanded = expandedSet(pane, viewKey);
  const busy = !!pane.busy[text(cfg.busy)];
  const showToolbar = cfg.toolbar === "always" || keyed.length > 0;
  const count = render(text(cfg.count), scopeOf(pane, { n: displayed.length, groups: groupCount }));
  const expandedKey = [...expanded].sort((a, b) => a - b).join(",");

  // Pull detail for whatever is checked once "Include detail" is on, and
  // again as the selection grows.
  useEffect(() => {
    if (spec && cache.includeDetails) cache.loadMany(selection.selectedRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache.includeDetails, selection.selectionKey]);

  // That detail arriving (or the option going off) changes what the checked
  // rows serialize to, so the copy the agent's chat holds is stale until
  // it's sent again.
  useEffect(() => {
    if (spec) selection.resend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache.includeDetails, cache.details]);

  // A row expanded anywhere -- here, in another tab, by a member or the
  // agent -- has its detail fetched here: expanding is session state (D48),
  // the detail it shows is this tab's.
  useEffect(() => {
    if (!spec) return;
    for (const r of keyed) if (expanded.has(r.index)) cache.loadOne(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedKey, keyed]);

  function toggle(index: number) {
    if (!viewKey) return;
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    pane.setView(viewKey, [...next].sort((a, b) => a - b));
  }

  return (
    <>
      {showToolbar && (
        <Toolbar
          output={output}
          pane={pane}
          selection={selection}
          displayed={displayed}
          count={count}
          detail={spec ? { spec, cache } : undefined}
        />
      )}
      {errors.length > 0 && (
        <div className="panel" style={{ borderColor: "var(--error)" }}>
          <h3>Target errors</h3>
          {errors.map((e, i) => (
            <div key={i} className="error-text">
              {e.name}: {e.error}
            </div>
          ))}
        </div>
      )}
      {keyed.length === 0 && errors.length === 0 && !busy && cfg.empty !== undefined && (
        <p className="muted">{render(text(cfg.empty), {})}</p>
      )}
      {displayed.map((r) => {
        const open = expanded.has(r.index);
        return (
          <div className="result-row" key={r.key}>
            <div className="result-row-summary" onClick={() => toggle(r.index)}>
              {output.actions.includes("select") && <RowCheckbox selection={selection} row={r} />}
              {viewKey && <span className={`chevron ${open ? "open" : ""}`}>▶</span>}
              <SummaryParts parts={partsOf(output)} row={r.row} scope={scopeOf(pane, { row: r.row })} pane={pane} />
            </div>
            {open && spec && <FetchedDetail state={cache.stateFor(r)} sections={spec.sections ?? []} pane={pane} />}
            {open && !spec && cfg.detail !== undefined && <Detail output={output} row={r.row} pane={pane} />}
          </div>
        );
      })}
      {output.actions.includes("attach") && (
        <PaneSelectionShare domain={text(cfg.domain) || pane.m.id} selectedRows={shared} />
      )}
    </>
  );
}

function FetchedDetail({
  state,
  sections,
  pane,
}: {
  state: ReturnType<DetailCache<Keyed, Row>["stateFor"]>;
  sections: Section[];
  pane: PaneApi;
}) {
  if (!state || state.status === "loading") {
    return (
      <div className="result-row-detail">
        <p className="muted">Loading…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="result-row-detail">
        <p className="error-text">{state.message}</p>
      </div>
    );
  }
  return (
    <div className="result-row-detail">
      <DetailSections sections={sections} d={state.detail} pane={pane} rich />
    </div>
  );
}

/** A row's own detail: the row as JSON, or sections drawn from it. */
function Detail({ output, row, pane }: { output: ManifestOutput; row: Row; pane: PaneApi }) {
  const detail = config(output).detail;
  if (detail === "json") {
    return (
      <div className="result-row-detail">
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{JSON.stringify(row, null, 2)}</pre>
      </div>
    );
  }
  return (
    <div className="result-row-detail">
      <DetailSections sections={Array.isArray(detail) ? (detail as Section[]) : []} d={row} pane={pane} rich={false} />
    </div>
  );
}

/**
 * S3's browser: folders (which navigate, setting the path input -- the
 * pane's own `on_change` then opens them) above files (a list). Folders
 * can't be selected: they're places, not data, and export never had them.
 */
export function FilesView({ output, value, pane }: { output: ManifestOutput; value: unknown; pane: PaneApi }) {
  const cfg = config(output);
  const keyField = typeof cfg.row_key === "string" ? cfg.row_key : undefined;
  const files = useMemo(() => flatten(value, undefined, keyField).rows, [value, keyField]);
  const folders = rowsOf(pane.outputs[text(cfg.folders)]);
  const { selection, shared } = useSelection(pane, files);
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
            <SummaryParts parts={partsOf(output)} row={r.row} scope={scopeOf(pane, { row: r.row })} pane={pane} />
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
