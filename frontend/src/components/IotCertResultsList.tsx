import { useState } from "react";
import { api, IotCertificateDetail, IotCertificateInfo, IotCertificateSearchResultItem } from "../api";
import ExportMenu from "./ExportMenu";
import IotCertificateDetailPanel from "./IotCertificateDetailPanel";

interface FlatCert {
  key: string;
  environment_id: number;
  environment_name: string;
  cert: IotCertificateInfo;
}

type DetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: IotCertificateDetail };

function certStatusTagClass(status: string): string {
  if (status === "ACTIVE") return "tag ok";
  if (status === "REVOKED" || status === "PENDING_TRANSFER" || status === "REGISTER_INACTIVE") return "tag error";
  return "tag pending";
}

export default function IotCertResultsList({ items }: { items: IotCertificateSearchResultItem[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, DetailState>>({});

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

  const errors = items.filter((i) => i.error);

  async function toggle(row: FlatCert) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
    if (!details[row.key]) {
      setDetails((prev) => ({ ...prev, [row.key]: { status: "loading" } }));
      try {
        const detail = await api.getIotCertificateDetail({
          environment_id: row.environment_id,
          certificate_id: row.cert.certificate_id,
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
          {flat.length} certificate(s) across {items.length} target(s)
        </span>
        <ExportMenu
          rows={flat.map((row) => ({ environment: row.environment_name, ...row.cert }))}
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
      {flat.map((row) => {
        const isOpen = expanded.has(row.key);
        const state = details[row.key];
        return (
          <div className="result-row" key={row.key}>
            <div className="result-row-summary" onClick={() => toggle(row)}>
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
