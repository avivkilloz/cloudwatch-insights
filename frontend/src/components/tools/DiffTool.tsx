import { useMemo, useState } from "react";
import { useSessionState } from "../../sessions/SessionContext";
import { diffChars, diffLines, Change } from "diff";

type ViewMode = "unified" | "split" | "compact";
type RowType = "equal" | "modify" | "remove" | "add";

interface DiffRow {
  type: RowType;
  left?: string;
  right?: string;
}

// How many unchanged lines to keep visible around a change in Compact view
// before collapsing the rest, and how long a run of unchanged lines needs to
// be before it's worth collapsing at all (a short run just adds noise).
const COMPACT_CONTEXT_LINES = 2;
const COMPACT_COLLAPSE_THRESHOLD = 5;

function splitChunkLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// diffLines groups whole runs of consecutive changed lines into a single
// removed chunk and a single added chunk. Splitting those into individual
// lines and pairing them index-wise (like a real side-by-side diff view)
// gives line-for-line "modify" rows instead of one big remove-then-add blob.
function buildDiffRows(left: string, right: string): DiffRow[] {
  const changes = diffLines(left, right);
  const rows: DiffRow[] = [];
  for (let i = 0; i < changes.length; i++) {
    const part = changes[i];
    if (!part.added && !part.removed) {
      for (const line of splitChunkLines(part.value)) rows.push({ type: "equal", left: line, right: line });
      continue;
    }
    if (part.removed) {
      const removedLines = splitChunkLines(part.value);
      const next = changes[i + 1];
      if (next && next.added) {
        const addedLines = splitChunkLines(next.value);
        const pairCount = Math.min(removedLines.length, addedLines.length);
        for (let j = 0; j < pairCount; j++) rows.push({ type: "modify", left: removedLines[j], right: addedLines[j] });
        for (let j = pairCount; j < removedLines.length; j++) rows.push({ type: "remove", left: removedLines[j] });
        for (let j = pairCount; j < addedLines.length; j++) rows.push({ type: "add", right: addedLines[j] });
        i++;
      } else {
        for (const line of removedLines) rows.push({ type: "remove", left: line });
      }
      continue;
    }
    for (const line of splitChunkLines(part.value)) rows.push({ type: "add", right: line });
  }
  return rows;
}

// Character-level (not word-level) refinement within a changed line pair --
// a word-level diff wouldn't highlight anything more precise than the whole
// line for a single unbroken token (e.g. an ID or hash) that changed by a
// couple of characters, which is exactly the case this needs to show clearly.
function charParts(a: string, b: string): { leftParts: Change[]; rightParts: Change[] } {
  const parts = diffChars(a, b);
  return {
    leftParts: parts.filter((p) => !p.added),
    rightParts: parts.filter((p) => !p.removed),
  };
}

function InlineParts({ parts }: { parts: Change[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={p.added ? "diff-added" : p.removed ? "diff-removed" : undefined}>
          {p.value}
        </span>
      ))}
    </>
  );
}

function UnifiedRow({ row }: { row: DiffRow }) {
  if (row.type === "modify") {
    const { leftParts, rightParts } = charParts(row.left!, row.right!);
    return (
      <>
        <div className="diff-row diff-line-remove">
          <span className="diff-gutter">−</span>
          <span>
            <InlineParts parts={leftParts} />
          </span>
        </div>
        <div className="diff-row diff-line-add">
          <span className="diff-gutter">+</span>
          <span>
            <InlineParts parts={rightParts} />
          </span>
        </div>
      </>
    );
  }
  if (row.type === "remove") {
    return (
      <div className="diff-row diff-line-remove">
        <span className="diff-gutter">−</span>
        <span>{row.left}</span>
      </div>
    );
  }
  if (row.type === "add") {
    return (
      <div className="diff-row diff-line-add">
        <span className="diff-gutter">+</span>
        <span>{row.right}</span>
      </div>
    );
  }
  return (
    <div className="diff-row">
      <span className="diff-gutter"> </span>
      <span>{row.left}</span>
    </div>
  );
}

function SplitRow({ row }: { row: DiffRow }) {
  if (row.type === "modify") {
    const { leftParts, rightParts } = charParts(row.left!, row.right!);
    return (
      <div className="diff-split-row">
        <div className="diff-split-cell diff-line-remove">
          <InlineParts parts={leftParts} />
        </div>
        <div className="diff-split-cell diff-line-add">
          <InlineParts parts={rightParts} />
        </div>
      </div>
    );
  }
  return (
    <div className="diff-split-row">
      <div className={`diff-split-cell ${row.type === "remove" ? "diff-line-remove" : ""}`}>{row.left ?? ""}</div>
      <div className={`diff-split-cell ${row.type === "add" ? "diff-line-add" : ""}`}>{row.right ?? ""}</div>
    </div>
  );
}

type DisplayItem = { kind: "row"; row: DiffRow } | { kind: "collapsed"; count: number; expandKey: number };

function buildCompactItems(rows: DiffRow[], expandedGroups: Set<number>): DisplayItem[] {
  const items: DisplayItem[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "equal") {
      items.push({ kind: "row", row: rows[i] });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].type === "equal") j++;
    const runLength = j - i;
    const threshold = COMPACT_CONTEXT_LINES * 2 + COMPACT_COLLAPSE_THRESHOLD;
    if (runLength <= threshold || expandedGroups.has(i)) {
      for (let k = i; k < j; k++) items.push({ kind: "row", row: rows[k] });
    } else {
      for (let k = i; k < i + COMPACT_CONTEXT_LINES; k++) items.push({ kind: "row", row: rows[k] });
      items.push({ kind: "collapsed", count: runLength - COMPACT_CONTEXT_LINES * 2, expandKey: i });
      for (let k = j - COMPACT_CONTEXT_LINES; k < j; k++) items.push({ kind: "row", row: rows[k] });
    }
    i = j;
  }
  return items;
}

export default function DiffTool() {
  const [left, setLeft] = useSessionState("left", "");
  const [right, setRight] = useSessionState("right", "");
  const [viewMode, setViewMode] = useSessionState<ViewMode>("viewMode", "unified");
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

  const hasInput = left.length > 0 || right.length > 0;
  const rows = useMemo(() => (hasInput ? buildDiffRows(left, right) : []), [left, right, hasInput]);

  const removedCount = rows.filter((r) => r.type === "remove" || r.type === "modify").length;
  const addedCount = rows.filter((r) => r.type === "add" || r.type === "modify").length;

  function toggleGroup(key: number) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const compactItems = useMemo(
    () => (viewMode === "compact" ? buildCompactItems(rows, expandedGroups) : null),
    [rows, viewMode, expandedGroups]
  );

  return (
    <div>
      <div className="panel">
        <h2>Text to compare</h2>
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
      </div>

      <div className="panel">
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Diff</h2>
          {hasInput && (
            <div className="row" style={{ gap: 8 }}>
              {(removedCount > 0 || addedCount > 0) && (
                <span className="muted">
                  {removedCount} removal{removedCount === 1 ? "" : "s"}, {addedCount} addition
                  {addedCount === 1 ? "" : "s"}
                </span>
              )}
              <select value={viewMode} onChange={(e) => setViewMode(e.target.value as ViewMode)}>
                <option value="unified">Unified</option>
                <option value="split">Split</option>
                <option value="compact">Compact</option>
              </select>
            </div>
          )}
        </div>
        {!hasInput ? (
          <p className="muted" style={{ margin: 0 }}>
            Paste text into both boxes above to see the diff.
          </p>
        ) : viewMode === "split" ? (
          <div className="diff-output">
            {rows.map((row, i) => (
              <SplitRow row={row} key={i} />
            ))}
          </div>
        ) : viewMode === "compact" ? (
          <div className="diff-output">
            {compactItems!.map((item, i) =>
              item.kind === "collapsed" ? (
                <div className="diff-collapsed-row" key={i} onClick={() => toggleGroup(item.expandKey)}>
                  ⋯ {item.count} unchanged line{item.count === 1 ? "" : "s"} (click to expand) ⋯
                </div>
              ) : (
                <UnifiedRow row={item.row} key={i} />
              )
            )}
          </div>
        ) : (
          <div className="diff-output">
            {rows.map((row, i) => (
              <UnifiedRow row={row} key={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
