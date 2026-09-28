import { PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { useAgent } from "../agent/AgentContext";
import AgentPanel from "./AgentPanel";
import { storedWidth, storeWidth } from "./ColumnResizer";

const SIZE = { width: 400, height: 520, minWidth: 320, minHeight: 300 };
const WIDTH_KEY = "cwi-agent-float-width";
const HEIGHT_KEY = "cwi-agent-float-height";

/**
 * The agent panel floating over the page, opened from a button in the corner
 * -- the way the old ✦ assistant sat -- for when the page needs its full
 * width. Anchored bottom-right, so its top-left corner is the one that drags
 * to resize it.
 */
export default function AgentFloat() {
  const { open, setOpen, running } = useAgent();
  const [size, setSize] = useState(() => ({
    width: storedWidth(WIDTH_KEY, SIZE.width, SIZE.minWidth, 2000),
    height: storedWidth(HEIGHT_KEY, SIZE.height, SIZE.minHeight, 2000),
  }));
  const start = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  function fit(width: number, height: number) {
    return {
      width: Math.round(Math.min(Math.max(width, SIZE.minWidth), window.innerWidth - 48)),
      height: Math.round(Math.min(Math.max(height, SIZE.minHeight), window.innerHeight - 140)),
    };
  }
  function down(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, ...size };
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s) return;
    setSize(fit(s.width + (s.x - e.clientX), s.height + (s.y - e.clientY)));
  }
  function up() {
    if (!start.current) return;
    start.current = null;
    storeWidth(WIDTH_KEY, size.width);
    storeWidth(HEIGHT_KEY, size.height);
  }

  return (
    <>
      {open && (
        <div className="agent-float-panel" style={{ width: size.width, height: size.height }} aria-label="Agent">
          <div
            className="agent-float-resize"
            title="Drag to resize"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
          <AgentPanel />
        </div>
      )}
      <button
        className={`agent-float-button${running ? " busy" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? "Hide the agent" : "Ask the agent"}
      >
        ✦ Agent
      </button>
    </>
  );
}
