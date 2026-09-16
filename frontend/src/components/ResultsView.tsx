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

export default function ResultsView({ items }: { items: QueryResultItem[] }) {
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

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const errors = items.filter((i) => i.error);
  const totalRows = flatRows.length;

  const groups = groupByTarget
    ? Object.entries(
        flatRows.reduce<Record<string, FlatRow[]>>((acc, row) => {
          (acc[row.environment_name] ??= []).push(row);
          return acc;
        }, {})
      )
    : [["All results", flatRows] as [string, FlatRow[]]];

  return (
    <div>
      <div className="toolbar">
        <span className="muted">{totalRows} row(s) across {items.length} target(s)</span>
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
