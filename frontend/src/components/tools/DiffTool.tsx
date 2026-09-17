import { useState } from "react";
import { diffLines } from "diff";

export default function DiffTool() {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");

  const changes = diffLines(left, right);
  const hasInput = left.length > 0 || right.length > 0;

  return (
    <div>
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <span className="field-label">Original</span>
          <textarea rows={10} value={left} onChange={(e) => setLeft(e.target.value)} style={{ width: "100%" }} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <span className="field-label">Changed</span>
          <textarea rows={10} value={right} onChange={(e) => setRight(e.target.value)} style={{ width: "100%" }} />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <span className="field-label">Diff</span>
        {hasInput ? (
          <pre className="diff-output">
            {changes.map((part, i) => (
              <span key={i} className={part.added ? "diff-added" : part.removed ? "diff-removed" : undefined}>
                {part.value}
              </span>
            ))}
          </pre>
        ) : (
          <p className="muted">Paste text into both boxes above to see the diff.</p>
        )}
      </div>
    </div>
  );
}
