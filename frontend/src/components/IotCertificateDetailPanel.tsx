import { IotCertificateDetail } from "../api";
import PolicyList from "./PolicyList";

function formatTimestamp(epochSeconds: number | null): string {
  if (epochSeconds == null) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

export default function IotCertificateDetailPanel({ detail }: { detail: IotCertificateDetail }) {
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

      <table style={{ marginBottom: 14 }}>
        <tbody>
          <tr>
            <td>Certificate ARN</td>
            <td>{detail.certificate_arn ?? "—"}</td>
          </tr>
          <tr>
            <td>Created</td>
            <td>{formatTimestamp(detail.creation_date)}</td>
          </tr>
        </tbody>
      </table>

      <h3>Attached things ({detail.thing_names.length})</h3>
      {detail.thing_names.length === 0 ? (
        <p className="muted">No things use this certificate.</p>
      ) : (
        <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
          {detail.thing_names.map((name) => (
            <span key={name} className="tag">
              {name}
            </span>
          ))}
        </div>
      )}

      <h3>Attached policies ({detail.policies.length})</h3>
      <PolicyList policies={detail.policies} />
    </div>
  );
}
