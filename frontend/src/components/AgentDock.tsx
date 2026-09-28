import { ReactNode } from "react";
import AgentPanel from "./AgentPanel";
import ColumnResizer from "./ColumnResizer";

export const DOCK_WIDTH = { initial: 380, min: 300, max: 720 };

/**
 * The agent panel docked beside the body -- how you watch it work: the
 * session it opens or fills in is right there next to what it's saying about
 * it. Its left edge drags to resize it.
 */
export default function AgentDock({
  width,
  max,
  onResize,
  onCommit,
  account,
}: {
  width: number;
  /** DOCK_WIDTH.max, or less when the window hasn't the room (App.tsx). */
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  /** The account's picture, which ends this panel's header while it's docked. */
  account: ReactNode;
}) {
  return (
    <aside className="agent-dock" aria-label="Agent" style={{ width }}>
      <ColumnResizer
        className="agent-dock-resizer"
        label="Resize the agent panel"
        width={width}
        {...DOCK_WIDTH}
        max={max}
        grow={-1}
        onResize={onResize}
        onCommit={onCommit}
      />
      <div className="panel agent-dock-panel">
        <AgentPanel account={account} />
      </div>
    </aside>
  );
}
