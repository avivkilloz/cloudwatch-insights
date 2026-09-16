import { useState } from "react";
import { IotCertificateInfo, IotThingDetail } from "../api";
import PolicyList from "./PolicyList";

function formatTimestamp(epochSeconds: number | null): string {
  if (epochSeconds == null) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function certStatusTagClass(status: string): string {
  if (status === "ACTIVE") return "tag ok";
  if (status === "REVOKED" || status === "PENDING_TRANSFER" || status === "REGISTER_INACTIVE") return "tag error";
  return "tag pending";
}

function jobStatusTagClass(status: string): string {
  if (status === "SUCCEEDED") return "tag ok";
  if (["FAILED", "TIMED_OUT", "REJECTED", "REMOVED", "CANCELED"].includes(status)) return "tag error";
  return "tag pending"; // QUEUED, IN_PROGRESS, CANCELING, etc.
}

function CertificateRow({ cert }: { cert: IotCertificateInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="result-row" style={{ marginBottom: 8 }}>
      <div className="result-row-summary" onClick={() => setOpen((v) => !v)}>
        <span className={`chevron ${open ? "open" : ""}`}>▶</span>
        <span className={certStatusTagClass(cert.status)}>{cert.status}</span>
        <span className="msg">{cert.certificate_id}</span>
        <span className="muted">created {formatTimestamp(cert.creation_date)}</span>
      </div>
      {open && (
        <div className="result-row-detail">
          <h3>Attached policies ({cert.policies.length})</h3>
          <PolicyList policies={cert.policies} />
        </div>
      )}
    </div>
  );
}

export default function IotThingDetailPanel({ detail }: { detail: IotThingDetail }) {
  return (
    <div className="result-row-detail">
      {detail.warnings.length > 0 && (
        <div className="row" style={{ marginBottom: 10, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          {detail.warnings.map((w, i) => (
            <span key={i} className="error-text">
              Could not fully load {w}
            </span>
          ))}
        </div>
      )}

      <h3>Attributes</h3>
      {Object.keys(detail.attributes).length === 0 ? (
        <p className="muted">No attributes.</p>
      ) : (
        <table style={{ marginBottom: 14 }}>
          <tbody>
            {Object.entries(detail.attributes).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Shadows ({detail.shadows.length})</h3>
      {detail.shadows.length === 0 ? (
        <p className="muted">No shadow documents found.</p>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {detail.shadows.map((s) => (
            <div className="result-row" key={s.name} style={{ marginBottom: 8 }}>
              <div className="result-row-summary" style={{ cursor: "default" }}>
                <span className="tag">{s.name}</span>
                <span className="muted">version {s.version ?? "—"}</span>
                <span className="muted">updated {formatTimestamp(s.last_updated)}</span>
              </div>
              <div className="result-row-detail">
                <div className="grid-2">
                  <div>
                    <h3>Reported</h3>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {JSON.stringify(s.reported, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <h3>Desired</h3>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {JSON.stringify(s.desired, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3>Certificates ({detail.certificates.length})</h3>
      {detail.certificates.length === 0 ? (
        <p className="muted">No certificates attached.</p>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {detail.certificates.map((c) => (
            <CertificateRow key={c.certificate_id} cert={c} />
          ))}
        </div>
      )}

      <h3>Jobs ({detail.jobs.length})</h3>
      {detail.jobs.length === 0 ? (
        <p className="muted">No job executions found.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job ID</th>
              <th>Status</th>
              <th>Queued</th>
              <th>Started</th>
              <th>Last updated</th>
            </tr>
          </thead>
          <tbody>
            {detail.jobs.map((j) => (
              <tr key={j.job_id}>
                <td>{j.job_id}</td>
                <td>
                  <span className={jobStatusTagClass(j.status)}>{j.status}</span>
                </td>
                <td>{formatTimestamp(j.queued_at)}</td>
                <td>{formatTimestamp(j.started_at)}</td>
                <td>{formatTimestamp(j.last_updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
