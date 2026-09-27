import AgentChat from "../components/AgentChat";

/**
 * The conversation with the platform agent, as a page.
 *
 * A page rather than a session, because there is one agent and it works
 * across everything -- you go to it rather than having several. It's a
 * different thing from the ✦ Ask AI assistant inside a session, which only
 * sees that session's own panes: this one acts on the workspace, creating
 * sessions and filling in and running panes, as you.
 *
 * The same conversation shows in the dock beside a session (AgentDock); this
 * is it with room to read.
 */
export default function AgentPage() {
  return (
    <div className="agent-session">
      <div className="panel agent-page-panel">
        <AgentChat />
      </div>
    </div>
  );
}
