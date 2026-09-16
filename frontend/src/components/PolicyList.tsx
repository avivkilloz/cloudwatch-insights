import { useState } from "react";
import { IotPolicyInfo } from "../api";

function PolicyRow({ policy }: { policy: IotPolicyInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="result-row" style={{ marginBottom: 6 }}>
      <div className="result-row-summary" onClick={() => setOpen((v) => !v)}>
        <span className={`chevron ${open ? "open" : ""}`}>▶</span>
        <span className="msg">{policy.policy_name}</span>
        {!policy.policy_document && <span className="muted">document unavailable</span>}
      </div>
      {open && (
        <div className="result-row-detail">
          {policy.policy_document ? (
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {JSON.stringify(policy.policy_document, null, 2)}
            </pre>
          ) : (
            <p className="muted">Could not load policy document.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function PolicyList({ policies }: { policies: IotPolicyInfo[] }) {
  if (policies.length === 0) return <p className="muted">No policies attached.</p>;
  return <div>{policies.map((p) => <PolicyRow key={p.policy_name} policy={p} />)}</div>;
}
