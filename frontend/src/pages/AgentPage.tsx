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
 * This is the global conversation with room to read; the same one is the
 * Global tab of the agent panel beside (or over) the page, whose Session tab
 * holds each session's own.
 */
export default function AgentPage() {
  return (
    <div className="agent-session">
      <div className="panel agent-page-panel">
        <AgentChat scope="global" />
      </div>
    </div>
  );
}
