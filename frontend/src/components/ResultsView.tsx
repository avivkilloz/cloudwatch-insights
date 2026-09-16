import { useState } from "react";
import { QueryResultItem } from "../api";

interface FlatRow {
  key: string;
  environment_name: string;
  environment_id: number;
  fields: { field: string; value: string }[];
}

function pickSummaryField(fields: { field: string; value: string }[]): string {
  const message = fields.find((f) => f.field === "@message");
  if (message) return message.value;
  return fields.map((f) => `${f.field}=${f.value}`).join(" ");
}

function pickTimestamp(fields: { field: string; value: string }[]): string | null {
  const ts = fields.find((f) => f.field === "@timestamp");
  return ts ? ts.value : null;
}

// CloudWatch's @timestamp ("YYYY-MM-DD HH:MM:SS.mmm") sorts correctly as a
// plain string. Rows without a timestamp (e.g. stats-only queries) sort
// after timestamped ones rather than being interleaved arbitrarily.
function sortByTimestampDesc(rows: FlatRow[]): FlatRow[] {
  return [...rows].sort((a, b) => {
    const tsA = pickTimestamp(a.fields);
    const tsB = pickTimestamp(b.fields);
    if (tsA && tsB) return tsA < tsB ? 1 : tsA > tsB ? -1 : 0;
    if (tsA) return -1;
    if (tsB) return 1;
    return 0;
  });
}

export default function ResultsView({ items, limit }: { items: QueryResultItem[]; limit?: number }) {
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
  // than `limit` overall. Re-sort the merged set by recency and cap it to
  // the same limit so what's on screen matches what was asked for.
  const totalBeforeTruncation = flatRows.length;
  const sortedRows = sortByTimestampDesc(flatRows);
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
            const ts = pickTimestamp(row.fields);
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
