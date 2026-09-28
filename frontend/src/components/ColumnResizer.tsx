import { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, useRef, useState } from "react";

/**
 * The strip between two columns that resizes one of them: it sits in the
 * 16px gap between them, shows a dashed cut line while hovered or dragged
 * (the same line a pane shows where it will land), and drags the column's
 * width between `min` and `max`. Double-click puts it back to `initial`; the
 * arrow keys nudge it, for anyone not using a mouse.
 *
 * `grow` says which way is bigger: 1 for a column on the left (drag right to
 * widen it), -1 for one on the right.
 */
export default function ColumnResizer({
  width,
  min,
  max,
  initial,
  grow,
  label,
  className,
  onResize,
  onCommit,
}: {
  width: number;
  min: number;
  max: number;
  initial: number;
  grow: 1 | -1;
  label: string;
  className: string;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number) => Math.round(Math.min(Math.max(w, min), max));

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    onResize(clamp(start.current.width + grow * (e.clientX - start.current.x)));
  }
  function up(e: ReactPointerEvent<HTMLDivElement>) {
    if (!start.current) return;
    const next = clamp(start.current.width + grow * (e.clientX - start.current.x));
    start.current = null;
    setDragging(false);
    onResize(next);
    onCommit(next);
  }
  function key(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 64 : 16;
    const delta = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    const next = clamp(width + grow * delta);
    onResize(next);
    onCommit(next);
  }

  return (
    <div
      className={`column-resizer ${className}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => {
        onResize(initial);
        onCommit(initial);
      }}
      onKeyDown={key}
    />
  );
}

/** A column width remembered per browser -- a working preference, like the
 * rail being open, not workspace data. */
export function storedWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const n = Number(window.localStorage.getItem(key));
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  } catch {
    return fallback;
  }
}

export function storeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width));
  } catch {
    // best-effort persistence only
  }
}
