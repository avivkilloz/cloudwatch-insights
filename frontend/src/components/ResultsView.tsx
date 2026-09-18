import { useEffect, useState } from "react";
import { ResultField } from "../api";
import ExportMenu from "./ExportMenu";

// Loosened to the fields this component actually renders, rather than the
// CloudWatch-specific QueryResultItem shape -- so it also accepts
// OpenSearchResultItem (which has no query_id/statistics) with no mapping.
export interface ResultsViewItem {
  environment_id: number;
  environment_name: string;
  rows: ResultField[][];
  error: string | null;
}

export type SortDirection = "asc" | "desc";

interface FlatRow {
  key: string;
  environment_name: string;
  environment_id: number;
  fields: { field: string; value: string }[];
}

function pickField(fields: { field: string; value: string }[], name: string): string | null {
  const f = fields.find((x) => x.field === name);
  return f ? f.value : null;
}

function pickSummaryField(fields: { field: string; value: string }[]): string {
  const message = fields.find((f) => f.field === "@message");
  if (message) return message.value;
  return fields.map((f) => `${f.field}=${f.value}`).join(" ");
}

// CloudWatch Logs Insights' auto-included @log field (present when a query
// spans multiple log groups) is formatted "<account_id>:<log_group_name>" --
// the account id is redundant with the environment tag shown right next to
// it, so just show the log group name.
function formatLogGroupTag(value: string): string {
  const idx = value.indexOf(":");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

type GroupBy = "none" | "environment" | "log";

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
function sortRows(rows: FlatRow[], field: string, direction: SortDirection): FlatRow[] {
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

interface Props {
  items: ResultsViewItem[];
  limit?: number;
  sortField?: string; // empty/undefined = keep the order results arrived in
  sortDirection?: SortDirection;
  /** Called with the full row data (same shape as each result row's fields,
   * plus environment) every time the checkbox selection changes -- lets a
   * parent page (e.g. the AI assistant) act on exactly the rows the user
   * has checked. */
  onSelectionChange?: (rows: Record<string, unknown>[]) => void;
}

function rowToObject(row: FlatRow): Record<string, unknown> {
  const obj: Record<string, unknown> = { environment: row.environment_name };
  for (const f of row.fields) obj[f.field] = f.value;
  return obj;
}

export default function ResultsView({ items, limit, sortField, sortDirection = "desc", onSelectionChange }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());

  const flatRows: FlatRow[] = [];
  items.forEach((item, itemIdx) => {
    item.rows.forEach((row, rowIdx) => {
      const ptr = row.find((f) => f.field === "@ptr")?.value;
      flatRows.push({
        key: ptr ? `${item.environment_id}|${ptr}` : `${itemIdx}-${rowIdx}`,
        environment_name: item.environment_name,
        environment_id: item.environment_id,
        fields: row,
      });
    });
  });

  // A new result set makes any previous selection/hides meaningless (their
  // row keys won't match anything here) -- clear them explicitly rather
  // than leaving stale state around.
  useEffect(() => {
    setSelectedKeys(new Set());
    setHiddenKeys(new Set());
    onSelectionChange?.([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const visibleRows = flatRows.filter((r) => !hiddenKeys.has(r.key));

  // Each target is independently capped at `limit` rows by the backend, so
  // with multiple environments selected the merged set can add up to more
  // than `limit` overall. Re-sort the merged (visible, i.e. non-hidden) set
  // and cap it to the same limit so what's on screen matches what was asked
  // for -- hiding a row makes room for the next one rather than just
  // leaving a gap.
  const sortedRows = sortField ? sortRows(visibleRows, sortField, sortDirection) : visibleRows;
  const truncated = limit != null && sortedRows.length > limit;
  const displayRows = truncated ? sortedRows.slice(0, limit) : sortedRows;

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function reportSelection(keys: Set<string>) {
    onSelectionChange?.(flatRows.filter((r) => keys.has(r.key)).map(rowToObject));
  }

  function toggleSelect(key: string) {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedKeys(next);
    reportSelection(next);
  }

  function toggleSelectAll() {
    const allSelected = displayRows.length > 0 && displayRows.every((r) => selectedKeys.has(r.key));
    const next = new Set(selectedKeys);
    if (allSelected) displayRows.forEach((r) => next.delete(r.key));
    else displayRows.forEach((r) => next.add(r.key));
    setSelectedKeys(next);
    reportSelection(next);
  }

  function hideSelected() {
    const nextHidden = new Set(hiddenKeys);
    selectedKeys.forEach((k) => nextHidden.add(k));
    setHiddenKeys(nextHidden);
    setSelectedKeys(new Set());
    reportSelection(new Set());
  }

  function showAllHidden() {
    setHiddenKeys(new Set());
  }

  const errors = items.filter((i) => i.error);

  function groupKeyFor(row: FlatRow): string {
    if (groupBy === "environment") return row.environment_name;
    const logField = pickField(row.fields, "@log");
    return logField ? formatLogGroupTag(logField) : "(no @log field)";
  }

  const groups =
    groupBy === "none"
      ? [["All results", displayRows] as [string, FlatRow[]]]
      : Object.entries(
          displayRows.reduce<Record<string, FlatRow[]>>((acc, row) => {
            (acc[groupKeyFor(row)] ??= []).push(row);
            return acc;
          }, {})
        );

  const allDisplayedSelected = displayRows.length > 0 && displayRows.every((r) => selectedKeys.has(r.key));

  return (
    <div>
      <div className="toolbar">
        <label className="checkbox-item" title="Select all currently shown rows">
          <input type="checkbox" checked={allDisplayedSelected} onChange={toggleSelectAll} disabled={displayRows.length === 0} />
          Select all
        </label>
        <span className="muted">
          {truncated
            ? `Showing most recent ${displayRows.length} of ${sortedRows.length} row(s) across ${items.length} target(s)`
            : `${displayRows.length} row(s) across ${items.length} target(s)`}
          {hiddenKeys.size > 0 && ` (${hiddenKeys.size} hidden)`}
        </span>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">Group by</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="none">None</option>
            <option value="environment">Environment</option>
            <option value="log">Log group</option>
          </select>
        </label>
        {selectedKeys.size > 0 && (
          <button className="secondary" onClick={hideSelected}>
            Hide selected ({selectedKeys.size})
          </button>
        )}
        {hiddenKeys.size > 0 && (
          <button className="secondary" onClick={showAllHidden}>
            Show {hiddenKeys.size} hidden
          </button>
        )}
        <ExportMenu rows={displayRows.map(rowToObject)} filename="logs-results" />
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
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(row.key)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelect(row.key)}
                  />
                  <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
                  {ts && <span className="tag">{ts}</span>}
                  {groupBy !== "environment" && <span className="tag">{row.environment_name}</span>}
                  {logGroup && groupBy !== "log" && (
                    <span className="tag" title="@log">
                      {formatLogGroupTag(logGroup)}
                    </span>
                  )}
                  <span className="msg">{pickSummaryField(row.fields)}</span>
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
    </div>
  );
}
