import { useEffect, useState } from "react";
import { api, IotSearchResultItem, IotThingDetail, IotThingSummary } from "../api";
import ExportMenu from "./ExportMenu";
import IotThingDetailPanel from "./IotThingDetailPanel";
import { useDetailCache } from "./iotDetails";
import { HideSelectedButtons, RowCheckbox, SelectAllCheckbox, useRowSelection } from "./rowSelection";

interface FlatThing {
  key: string;
  environment_id: number;
  environment_name: string;
  thing: IotThingSummary;
}

function connectivityTag(thing: IotThingSummary) {
  if (thing.connected === true) return <span className="tag ok">Connected</span>;
  if (thing.connected === false) return <span className="tag error">Disconnected</span>;
  return <span className="tag">Unknown</span>;
}

function rowToObject(row: FlatThing): Record<string, unknown> {
  return { environment: row.environment_name, ...row.thing };
}

// The fields a thing's detail adds over its search-result summary.
function withDetail(row: FlatThing, detail: IotThingDetail): Record<string, unknown> {
  return {
    ...rowToObject(row),
    thing_arn: detail.thing_arn,
    version: detail.version,
    shadows: detail.shadows,
    certificates: detail.certificates,
    jobs: detail.jobs,
    ...(detail.warnings.length > 0 ? { detail_warnings: detail.warnings } : {}),
  };
}

interface Props {
  items: IotSearchResultItem[];
  /** Reports the checked rows up to the page, which feeds them to the AI assistant. */
  onSelectionChange?: (rows: Record<string, unknown>[]) => void;
}

export default function IotResultsList({ items, onSelectionChange }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const detailCache = useDetailCache<FlatThing, IotThingDetail>({
    keyOf: (r) => r.key,
    fetchDetail: (r) =>
      api.getIotThingDetail({ environment_id: r.environment_id, thing_name: r.thing.thing_name }),
    resetOn: items,
  });

  // Only the checked rows are ever enriched -- those are the ones whose detail
  // we actually fetch -- so exporting everything on screen stays a plain
  // summary dump rather than a partly-detailed one.
  function toExportObject(row: FlatThing): Record<string, unknown> {
    if (!detailCache.includeDetails) return rowToObject(row);
    const detail = detailCache.detailFor(row);
    return detail ? withDetail(row, detail) : rowToObject(row);
  }

  const selection = useRowSelection({
    rows: flat,
    keyOf: (r) => r.key,
    toObject: toExportObject,
    onSelectionChange,
    resetOn: items,
  });
  const displayRows = selection.visibleRows;

  // Pull detail for whatever is checked once the option is on, and again as the
  // selection grows.
  useEffect(() => {
    if (!detailCache.includeDetails) return;
    detailCache.loadMany(selection.selectedRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailCache.includeDetails, selection.selectionKey]);

  // That detail arriving (or the option being switched off) changes what the
  // checked rows serialize to, so the page's copy of the selection is stale
  // until we re-emit it.
  useEffect(() => {
    selection.resend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailCache.includeDetails, detailCache.details]);

  const errors = items.filter((i) => i.error);

  function toggle(row: FlatThing) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
    detailCache.loadOne(row);
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
        {selection.selectedCount > 0 && (
          <label
            className="checkbox-item"
            title="Fetches each checked thing's full detail and includes it in the export and in what the AI assistant sees. One request per thing."
          >
            <input
              type="checkbox"
              checked={detailCache.includeDetails}
              onChange={(e) => detailCache.setIncludeDetails(e.target.checked)}
            />
            Include shadows, certificates &amp; jobs
          </label>
        )}
        {detailCache.loadingCount > 0 && <span className="muted">Loading details… ({detailCache.loadingCount} left)</span>}
        {detailCache.includeDetails && detailCache.errorCount > 0 && (
          <span className="error-text">
            {detailCache.errorCount} thing(s) had no detail available — exported from their summary alone.
          </span>
        )}
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
        const state = detailCache.stateFor(row);
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
