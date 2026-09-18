import { useState } from "react";
import { api, IotSearchResultItem, IotThingDetail, IotThingSummary } from "../api";
import ExportMenu from "./ExportMenu";
import IotThingDetailPanel from "./IotThingDetailPanel";
import { HideSelectedButtons, RowCheckbox, SelectAllCheckbox, useRowSelection } from "./rowSelection";

interface FlatThing {
  key: string;
  environment_id: number;
  environment_name: string;
  thing: IotThingSummary;
}

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: IotThingDetail };

function connectivityTag(thing: IotThingSummary) {
  if (thing.connected === true) return <span className="tag ok">Connected</span>;
  if (thing.connected === false) return <span className="tag error">Disconnected</span>;
  return <span className="tag">Unknown</span>;
}

function rowToObject(row: FlatThing): Record<string, unknown> {
  return { environment: row.environment_name, ...row.thing };
}

export default function IotResultsList({ items }: { items: IotSearchResultItem[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, DetailState>>({});

  const flat: FlatThing[] = [];
  items.forEach((item) => {
    item.things.forEach((thing) => {
      flat.push({
        key: `${item.environment_id}|${thing.thing_name}`,
        environment_id: item.environment_id,
        environment_name: item.environment_name,
        thing,
      });
    });
  });

  const selection = useRowSelection({
    rows: flat,
    keyOf: (r) => r.key,
    toObject: rowToObject,
    resetOn: items,
  });
  const displayRows = selection.visibleRows;

  const errors = items.filter((i) => i.error);

  async function toggle(row: FlatThing) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
    if (!details[row.key]) {
      setDetails((prev) => ({ ...prev, [row.key]: { status: "loading" } }));
      try {
        const detail = await api.getIotThingDetail({
          environment_id: row.environment_id,
          thing_name: row.thing.thing_name,
        });
        setDetails((prev) => ({ ...prev, [row.key]: { status: "ready", detail } }));
      } catch (e: any) {
        setDetails((prev) => ({ ...prev, [row.key]: { status: "error", message: e.message } }));
      }
    }
  }

  return (
    <div>
      <div className="toolbar">
        <SelectAllCheckbox selection={selection} displayed={displayRows} />
        <span className="muted">
          {displayRows.length} thing(s) across {items.length} target(s)
          {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
        </span>
        <HideSelectedButtons selection={selection} />
        <ExportMenu
          rows={displayRows.map(rowToObject)}
          selectedRows={selection.selectedObjects}
          filename="iot-things"
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
      {flat.length === 0 && errors.length === 0 && <p className="muted">No things found.</p>}
      {displayRows.map((row) => {
        const isOpen = expanded.has(row.key);
        const state = details[row.key];
        return (
          <div className="result-row" key={row.key}>
            <div className="result-row-summary" onClick={() => toggle(row)}>
              <RowCheckbox selection={selection} row={row} />
              <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
              {connectivityTag(row.thing)}
              <span className="tag">{row.environment_name}</span>
              {row.thing.thing_type_name && <span className="tag">{row.thing.thing_type_name}</span>}
              <span className="msg">{row.thing.thing_name}</span>
            </div>
            {isOpen &&
              (!state || state.status === "loading" ? (
                <div className="result-row-detail">
                  <p className="muted">Loading…</p>
                </div>
              ) : state.status === "error" ? (
                <div className="result-row-detail">
                  <p className="error-text">{state.message}</p>
                </div>
              ) : (
                <IotThingDetailPanel detail={state.detail} />
              ))}
          </div>
        );
      })}
    </div>
  );
}
