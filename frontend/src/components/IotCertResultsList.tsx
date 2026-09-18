import { useEffect, useState } from "react";
import { api, IotCertificateDetail, IotCertificateInfo, IotCertificateSearchResultItem } from "../api";
import ExportMenu from "./ExportMenu";
import IotCertificateDetailPanel from "./IotCertificateDetailPanel";
import { useDetailCache } from "./iotDetails";
import { HideSelectedButtons, RowCheckbox, SelectAllCheckbox, useRowSelection } from "./rowSelection";

interface FlatCert {
  key: string;
  environment_id: number;
  environment_name: string;
  cert: IotCertificateInfo;
}

function certStatusTagClass(status: string): string {
  if (status === "ACTIVE") return "tag ok";
  if (status === "REVOKED" || status === "PENDING_TRANSFER" || status === "REGISTER_INACTIVE") return "tag error";
  return "tag pending";
}

function rowToObject(row: FlatCert): Record<string, unknown> {
  return { environment: row.environment_name, ...row.cert };
}

// A certificate's search result already carries its policies, so detail only
// adds which things the certificate is attached to.
function withDetail(row: FlatCert, detail: IotCertificateDetail): Record<string, unknown> {
  return {
    ...rowToObject(row),
    thing_names: detail.thing_names,
    ...(detail.warnings.length > 0 ? { detail_warnings: detail.warnings } : {}),
  };
}

interface Props {
  items: IotCertificateSearchResultItem[];
  /** Reports the checked rows up to the page, which feeds them to the AI assistant. */
  onSelectionChange?: (rows: Record<string, unknown>[]) => void;
}

export default function IotCertResultsList({ items, onSelectionChange }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const flat: FlatCert[] = [];
  items.forEach((item) => {
    item.certificates.forEach((cert) => {
      flat.push({
        key: `${item.environment_id}|${cert.certificate_id}`,
        environment_id: item.environment_id,
        environment_name: item.environment_name,
        cert,
      });
    });
  });

  const detailCache = useDetailCache<FlatCert, IotCertificateDetail>({
    keyOf: (r) => r.key,
    fetchDetail: (r) =>
      api.getIotCertificateDetail({ environment_id: r.environment_id, certificate_id: r.cert.certificate_id }),
    resetOn: items,
  });

  function toExportObject(row: FlatCert): Record<string, unknown> {
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

  useEffect(() => {
    if (!detailCache.includeDetails) return;
    detailCache.loadMany(selection.selectedRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailCache.includeDetails, selection.selectionKey]);

  useEffect(() => {
    selection.resend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailCache.includeDetails, detailCache.details]);

  const errors = items.filter((i) => i.error);

  function toggle(row: FlatCert) {
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
          {displayRows.length} certificate(s) across {items.length} target(s)
          {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
        </span>
        <HideSelectedButtons selection={selection} />
        {selection.selectedCount > 0 && (
          <label
            className="checkbox-item"
            title="Fetches which things each checked certificate is attached to and includes it in the export and in what the AI assistant sees. One request per certificate."
          >
            <input
              type="checkbox"
              checked={detailCache.includeDetails}
              onChange={(e) => detailCache.setIncludeDetails(e.target.checked)}
            />
            Include attached things
          </label>
        )}
        {detailCache.loadingCount > 0 && <span className="muted">Loading details… ({detailCache.loadingCount} left)</span>}
        {detailCache.includeDetails && detailCache.errorCount > 0 && (
          <span className="error-text">
            {detailCache.errorCount} certificate(s) had no detail available — exported from their summary alone.
          </span>
        )}
        <ExportMenu
          rows={displayRows.map(rowToObject)}
          selectedRows={selection.selectedObjects}
          filename="iot-certificates"
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
      {flat.length === 0 && errors.length === 0 && <p className="muted">No certificates found.</p>}
      {displayRows.map((row) => {
        const isOpen = expanded.has(row.key);
        const state = detailCache.stateFor(row);
        return (
          <div className="result-row" key={row.key}>
            <div className="result-row-summary" onClick={() => toggle(row)}>
              <RowCheckbox selection={selection} row={row} />
              <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
              <span className={certStatusTagClass(row.cert.status)}>{row.cert.status}</span>
              <span className="tag">{row.environment_name}</span>
              <span className="msg">{row.cert.certificate_id}</span>
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
                <IotCertificateDetailPanel detail={state.detail} />
              ))}
          </div>
        );
      })}
    </div>
  );
}
