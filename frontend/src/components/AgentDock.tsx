import { useAgent } from "../agent/AgentContext";
import { useSessions } from "../sessions/SessionContext";
import AgentChat from "./AgentChat";

/**
 * The conversation with the agent, docked beside whatever is on screen --
 * which is how you watch it work: ask from the header, and the session it
 * opens or fills in is right there next to what it's saying about it.
 */
export default function AgentDock() {
  const { setDockOpen } = useAgent();
  const { show } = useSessions();
  return (
    <aside className="agent-dock" aria-label="Agent">
      <div className="panel agent-dock-panel">
        <div className="agent-dock-head">
          <h2>Agent</h2>
          <div className="agent-dock-actions">
            <button className="secondary" onClick={() => show("agent")} title="Open the conversation as a page">
              Full page
            </button>
            <button className="secondary" onClick={() => setDockOpen(false)} aria-label="Close the agent" title="Close">
              ✕
            </button>
          </div>
        </div>
        <AgentChat />
      </div>
    </aside>
  );
}
