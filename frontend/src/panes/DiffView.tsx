/**
 * How a diff output is drawn: Unified, Split, or Compact (unchanged runs
 * folded away). Lifted from the Diff tool unchanged when it became a manifest
 * pane (PLATFORM_PLAN.md §15); the rows come from the `diff.compute` live
 * function (./live.ts), the view from the input the manifest's
 * `config.view` names.
 */

import { useMemo, useState } from "react";
import { diffChars, Change } from "diff";
import { DiffRow } from "./live";

export type DiffViewMode = "unified" | "split" | "compact";

// How many unchanged lines to keep visible around a change in Compact view
// before collapsing the rest, and how long a run of unchanged lines needs to
// be before it's worth collapsing at all (a short run just adds noise).
const COMPACT_CONTEXT_LINES = 2;
const COMPACT_COLLAPSE_THRESHOLD = 5;

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

export default function DiffView({ rows, view }: { rows: DiffRow[]; view: DiffViewMode }) {
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

  function toggleGroup(key: number) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const compactItems = useMemo(
    () => (view === "compact" ? buildCompactItems(rows, expandedGroups) : null),
    [rows, view, expandedGroups],
  );

  if (view === "split") {
    return (
      <div className="diff-output">
        {rows.map((row, i) => (
          <SplitRow row={row} key={i} />
        ))}
      </div>
    );
  }
  if (compactItems) {
    return (
      <div className="diff-output">
        {compactItems.map((item, i) =>
          item.kind === "collapsed" ? (
            <div className="diff-collapsed-row" key={i} onClick={() => toggleGroup(item.expandKey)}>
              ⋯ {item.count} unchanged line{item.count === 1 ? "" : "s"} (click to expand) ⋯
            </div>
          ) : (
            <UnifiedRow row={item.row} key={i} />
          ),
        )}
      </div>
    );
  }
  return (
    <div className="diff-output">
      {rows.map((row, i) => (
        <UnifiedRow row={row} key={i} />
      ))}
    </div>
  );
}
