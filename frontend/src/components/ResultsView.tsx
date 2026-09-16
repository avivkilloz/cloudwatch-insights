import { useState } from "react";
import { ResultField } from "../api";

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
}

export default function ResultsView({ items, limit, sortField, sortDirection = "desc" }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupByTarget, setGroupByTarget] = useState(false);

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

  // Each target is independently capped at `limit` rows by the backend, so
  // with multiple environments selected the merged set can add up to more
  // than `limit` overall. Re-sort the merged set and cap it to the same
  // limit so what's on screen matches what was asked for.
  const totalBeforeTruncation = flatRows.length;
  const sortedRows = sortField ? sortRows(flatRows, sortField, sortDirection) : flatRows;
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

  const errors = items.filter((i) => i.error);

  const groups = groupByTarget
    ? Object.entries(
        displayRows.reduce<Record<string, FlatRow[]>>((acc, row) => {
          (acc[row.environment_name] ??= []).push(row);
          return acc;
        }, {})
      )
    : [["All results", displayRows] as [string, FlatRow[]]];

  return (
    <div>
      <div className="toolbar">
        <span className="muted">
          {truncated
            ? `Showing most recent ${displayRows.length} of ${totalBeforeTruncation} row(s) across ${items.length} target(s)`
            : `${displayRows.length} row(s) across ${items.length} target(s)`}
        </span>
        <label className="checkbox-item">
          <input type="checkbox" checked={groupByTarget} onChange={(e) => setGroupByTarget(e.target.checked)} />
          Group by environment
        </label>
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
          {groupByTarget && <h3>{groupName}</h3>}
          {rows.length === 0 && <p className="muted">No results.</p>}
          {rows.map((row) => {
            const isOpen = expanded.has(row.key);
            const ts = pickField(row.fields, "@timestamp");
            return (
              <div className="result-row" key={row.key}>
                <div className="result-row-summary" onClick={() => toggle(row.key)}>
                  <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
                  {ts && <span className="tag">{ts}</span>}
                  {!groupByTarget && <span className="tag">{row.environment_name}</span>}
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
