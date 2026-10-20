import { useLayoutEffect, useMemo, useRef } from "react";

/**
 * A definition's YAML, with its line numbers (D127): Check names a problem
 * by its line ("Line 31: …"), and counting down a textarea to find it was the
 * builder's job. The pane, step and workflow editors use it alike.
 *
 * Lines don't wrap -- a wrapped line would put every number under it out of
 * step -- and the gutter follows the text's scroll. The lines Check found
 * problems on are marked. It fills the height its card gives it (`.code-editor`
 * is a flex child), so beside a tall preview there's more of it to see.
 */
export default function CodeEditor({
  id,
  value,
  onChange,
  readOnly,
  minRows = 14,
  marked = [],
}: {
  id: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  minRows?: number;
  /** Lines to mark in the gutter: where Check found problems. */
  marked?: number[];
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const count = useMemo(() => Math.max(1, value.split("\n").length), [value]);
  const bad = useMemo(() => new Set(marked), [marked]);

  // The gutter scrolls with the text; a new text (the agent's draft, a
  // restored one) may have moved it.
  function follow() {
    if (gutter.current && text.current) gutter.current.scrollTop = text.current.scrollTop;
  }
  useLayoutEffect(follow, [value]);

  return (
    <div className="code-editor" style={{ minHeight: `calc(${minRows} * 1.5em + 18px)` }}>
      <div className="code-editor-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={bad.has(i + 1) ? "bad" : undefined}>
            {i + 1}
          </div>
        ))}
        {/* Room for a horizontal scrollbar under the text, so the last numbers can scroll level with it. */}
        <div className="code-editor-gutter-end" />
      </div>
      <textarea
        id={id}
        ref={text}
        className="code-editor-text"
        spellCheck={false}
        wrap="off"
        readOnly={readOnly}
        value={value}
        onScroll={follow}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  );
}

/** The lines a list of problems names, for `marked`. */
export function problemLines(problems: { line?: number | null }[] | null | undefined): number[] {
  return (problems ?? []).map((p) => p.line ?? 0).filter((n) => n > 0);
}
