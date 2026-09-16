import { useState } from "react";
import { api, IotSearchResultItem, IotThingDetail, IotThingSummary } from "../api";
import IotThingDetailPanel from "./IotThingDetailPanel";

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
        <span className="muted">
          {flat.length} thing(s) across {items.length} target(s)
        </span>
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
      {flat.map((row) => {
        const isOpen = expanded.has(row.key);
        const state = details[row.key];
        return (
          <div className="result-row" key={row.key}>
            <div className="result-row-summary" onClick={() => toggle(row)}>
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
