/**
 * The logs panes' outputs (PLATFORM_PLAN.md §16.9.2), drawn as `ResultsView`
 * drew them so CloudWatch and OpenSearch look as they did:
 *
 * - `LogsView` (`render: logs`): one group per target, rows as `{field,
 *   value}` lists. A summary line per row (timestamp, environment and log
 *   group tags, the message), expanding to every field; Target errors; the
 *   merged set sorted (numbers as numbers) and capped at the pane's limit,
 *   "most recent N of M"; group by environment or log group; select, hide,
 *   export and attach.
 * - `SortControl` (`sort:` in a layout): "Sort by" a field the rows have, and
 *   the direction.
 * - `RunNote` (`render: run`): what became of a background run (D51) that
 *   didn't simply finish -- stopped, by whom or why, or failed.
 *
 * Sort, direction, group-by and expanded rows are the output's view keys
 * (D48), so they are the session's: another member, or the agent, sorting or
 * grouping the results does it for everyone looking.
 */

import { useMemo, useState } from "react";
import ExportMenu from "../components/ExportMenu";
import { PaneSelectionShare } from "../components/paneSelection";
import { HideSelectedButtons, RowCheckbox, SelectAllCheckbox, useRowSelection } from "../components/rowSelection";
import { ManifestOutput } from "./manifest";
import { PaneApi, Values } from "./paneApi";
import { text } from "./template";

interface Field {
  field: string;
  value: string;
}

interface Target {
  environment_id: number;
  environment_name: string;
  rows: Field[][];
  error: string | null;
}

interface FlatRow {
  key: string;
  environment_name: string;
  fields: Field[];
}

type Direction = "asc" | "desc";
type GroupBy = "none" | "environment" | "log";

interface LogsConfig {
  domain?: string;
  export?: string;
  limit?: string;
  sort?: { field: string; direction: string };
  group_by?: string;
  expand?: string;
}

function configOf(output: ManifestOutput): LogsConfig {
  return (output.config ?? {}) as LogsConfig;
}

function targetsOf(value: unknown): Target[] {
  return Array.isArray(value) ? (value.filter((t) => t && typeof t === "object") as Target[]) : [];
}

function pickField(fields: Field[], name: string): string | null {
  const f = fields.find((x) => x.field === name);
  return f ? f.value : null;
}

function summaryOf(fields: Field[]): string {
  const message = fields.find((f) => f.field === "@message");
  if (message) return message.value;
  return fields.map((f) => `${f.field}=${f.value}`).join(" ");
}

// CloudWatch Logs Insights' auto-included @log field (present when a query
// spans multiple log groups) is formatted "<account_id>:<log_group_name>" --
// the account id is redundant with the environment tag shown right next to
// it, so just show the log group name.
function logGroupTag(value: string): string {
  const idx = value.indexOf(":");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

// CloudWatch's @timestamp ("YYYY-MM-DD HH:MM:SS.mmm") sorts correctly as a
// plain string; other fields might hold numbers (e.g. @duration, a count
// from a `stats` query), which need numeric comparison to sort correctly
// once they have different digit counts ("10" < "9" lexicographically).
function compareValues(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Rows missing the sort field (e.g. a stats-only query has no @timestamp)
// always sort last, regardless of direction.
function sortRows(rows: FlatRow[], field: string, direction: Direction): FlatRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = pickField(a.fields, field);
    const vb = pickField(b.fields, field);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return compareValues(va, vb) * sign;
  });
}

function rowToObject(row: FlatRow): Record<string, unknown> {
  const obj: Record<string, unknown> = { environment: row.environment_name };
  for (const f of row.fields) obj[f.field] = f.value;
  return obj;
}

function flatten(targets: Target[]): FlatRow[] {
  const flat: FlatRow[] = [];
  targets.forEach((item, itemIdx) => {
    (item.rows ?? []).forEach((row, rowIdx) => {
      const ptr = row.find((f) => f.field === "@ptr")?.value;
      flat.push({
        key: ptr ? `${item.environment_id}|${ptr}` : `${itemIdx}-${rowIdx}`,
        environment_name: item.environment_name,
        fields: row,
      });
    });
  });
  return flat;
}

function viewString(pane: PaneApi, key: string | undefined, fallback: string): string {
  const value = key ? pane.views[key] : undefined;
  return typeof value === "string" ? value : fallback;
}

function expandedOf(pane: PaneApi, key: string | undefined): Set<string> {
  const value = key ? pane.views[key] : undefined;
  if (value instanceof Set) return new Set([...value].map(String));
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

export function LogsView({ output, value, pane }: { output: ManifestOutput; value: unknown; pane: PaneApi }) {
  const cfg = configOf(output);
  const items = targetsOf(value);
  const flatRows = useMemo(() => flatten(items), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const [shared, setShared] = useState<Record<string, unknown>[]>([]);
  const selection = useRowSelection({
    rows: flatRows,
    keyOf: (r) => r.key,
    toObject: rowToObject,
    onSelectionChange: setShared,
    // A new run, not each poll of one: rows checked while a query is still
    // streaming in stay checked.
    resetOn: pane.resultsVersion,
  });
  const sortField = viewString(pane, cfg.sort?.field, "@timestamp");
  const direction = viewString(pane, cfg.sort?.direction, "desc") as Direction;
  const groupBy = viewString(pane, cfg.group_by, "none") as GroupBy;
  const expanded = expandedOf(pane, cfg.expand);
  const rawLimit = cfg.limit ? Number(pane.inputs[cfg.limit]) : NaN;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;

  // Each target is independently capped at `limit` rows by the backend, so
  // with multiple environments selected the merged set can add up to more
  // than `limit` overall. Re-sort the merged (visible, i.e. non-hidden) set
  // and cap it to the same limit so what's on screen matches what was asked
  // for -- hiding a row makes room for the next one rather than just
  // leaving a gap.
  const sortedRows = sortField ? sortRows(selection.visibleRows, sortField, direction) : selection.visibleRows;
  const truncated = limit != null && sortedRows.length > limit;
  const displayRows = truncated ? sortedRows.slice(0, limit) : sortedRows;
  const errors = items.filter((i) => i.error);

  function toggle(key: string) {
    if (!cfg.expand) return;
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    pane.setView(cfg.expand, [...next].sort());
  }

  function groupKeyFor(row: FlatRow): string {
    if (groupBy === "environment") return row.environment_name;
    const logField = pickField(row.fields, "@log");
    return logField ? logGroupTag(logField) : "(no @log field)";
  }

  const groups =
    groupBy === "none"
      ? [["All results", displayRows] as [string, FlatRow[]]]
      : Object.entries(
          displayRows.reduce<Record<string, FlatRow[]>>((acc, row) => {
            (acc[groupKeyFor(row)] ??= []).push(row);
            return acc;
          }, {}),
        );

  return (
    <div>
      <div className="toolbar">
        <SelectAllCheckbox selection={selection} displayed={displayRows} />
        <span className="muted">
          {truncated
            ? `Showing most recent ${displayRows.length} of ${sortedRows.length} row(s) across ${items.length} target(s)`
            : `${displayRows.length} row(s) across ${items.length} target(s)`}
          {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
        </span>
        {/* Sorts the rows on screen, at once -- it was in the Query card,
            beside Limit, where it read as part of the query (which has its
            own sort, deciding which rows come back at all). */}
        {cfg.sort && <SortControl output={output} pane={pane} />}
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">Group by</span>
          <select value={groupBy} onChange={(e) => cfg.group_by && pane.setView(cfg.group_by, e.target.value)}>
            <option value="none">None</option>
            <option value="environment">Environment</option>
            <option value="log">Log group</option>
          </select>
        </label>
        <HideSelectedButtons selection={selection} />
        <ExportMenu
          rows={displayRows.map(rowToObject)}
          selectedRows={selection.selectedObjects}
          filename={cfg.export || pane.m.id}
        />
      </div>
      {errors.length > 0 && (
        <div className="panel" style={{ borderColor: "var(--error)" }}>
          <h3>Target errors</h3>
          {errors.map((e, i) => (
            <div key={i} className="error-text">
              {e.environment_name}: {e.error}
            </div>
          ))}
        </div>
      )}
      {groups.map(([groupName, rows]) => (
        <div key={groupName} style={{ marginBottom: 16 }}>
          {groupBy !== "none" && <h3>{groupName}</h3>}
          {rows.length === 0 && <p className="muted">No results.</p>}
          {rows.map((row) => {
            const isOpen = expanded.has(row.key);
            const ts = pickField(row.fields, "@timestamp");
            const logGroup = pickField(row.fields, "@log");
            return (
              <div className="result-row" key={row.key}>
                <div className="result-row-summary" onClick={() => toggle(row.key)}>
                  <RowCheckbox selection={selection} row={row} />
                  <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
                  {ts && <span className="tag">{ts}</span>}
                  {groupBy !== "environment" && <span className="tag">{row.environment_name}</span>}
                  {logGroup && groupBy !== "log" && (
                    <span className="tag" title="@log">
                      {logGroupTag(logGroup)}
                    </span>
                  )}
                  <span className="msg">{summaryOf(row.fields)}</span>
                </div>
                {isOpen && (
                  <div className="result-row-detail">
                    <table>
                      <tbody>
                        {row.fields.map((f, idx) => (
                          <tr key={idx}>
                            <td>{f.field}</td>
                            <td>{f.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {output.actions.includes("attach") && (
        <PaneSelectionShare domain={text(cfg.domain) || pane.m.id} selectedRows={shared} />
      )}
    </div>
  );
}

/** "Sort by" a field the output's rows have, and the direction: its view keys. */
export function SortControl({ output, pane }: { output: ManifestOutput; pane: PaneApi }) {
  const cfg = configOf(output);
  const items = targetsOf(pane.outputs[output.key]);
  const fields = useMemo(() => {
    const seen = new Set<string>(["@timestamp"]);
    items.forEach((item) => (item.rows ?? []).forEach((row) => row.forEach((f) => seen.add(f.field))));
    return Array.from(seen);
  }, [pane.outputs[output.key]]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortField = viewString(pane, cfg.sort?.field, "@timestamp");
  const direction = viewString(pane, cfg.sort?.direction, "desc");
  const set = (key: string | undefined, v: string) => key && pane.setView(key, v);
  return (
    <label className="row" style={{ gap: 6 }}>
      <span className="muted">Sort by</span>
      <select value={sortField} onChange={(e) => set(cfg.sort?.field, e.target.value)}>
        <option value="">Original order</option>
        {fields.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <select value={direction} onChange={(e) => set(cfg.sort?.direction, e.target.value)} disabled={!sortField}>
        <option value="desc">Descending</option>
        <option value="asc">Ascending</option>
      </select>
    </label>
  );
}

/** What became of a background run that didn't just finish (D51). */
export function RunNote({ value }: { value: unknown }) {
  const run = (value && typeof value === "object" ? value : {}) as Values;
  if (run.status === "failed" && run.error) return <span className="error-text">{text(run.error)}</span>;
  if (run.status !== "stopped") return null;
  if (run.note) return <span className="muted">{text(run.note)}</span>;
  return <span className="muted">{run.stoppedBy ? `Stopped by ${text(run.stoppedBy)}.` : "Stopped."}</span>;
}
