import { ReactNode } from "react";
import { useAgent } from "../agent/AgentContext";
import AgentChat from "./AgentChat";

/**
 * The agent's two conversations, whichever way the panel is laid out: a tab
 * for the global chat (the platform: start sessions, look across them) and
 * one for the session on screen (change it, ask about what's checked in it).
 * The header switches between docking the panel beside the page and floating
 * it over the page; floating, a ✕ puts it away (docked, that's the strip's
 * toggle).
 */
export default function AgentPanel({ account }: { account?: ReactNode }) {
  const { tab, setTab, layout, setLayout, setOpen, viewingSessionId } = useAgent();
  return (
    <div className="agent-panel">
      <div className="agent-panel-head">
        <div className="agent-tabs" role="tablist" aria-label="Conversation">
          <button
            role="tab"
            aria-selected={tab === "global"}
            className={`agent-tab${tab === "global" ? " active" : ""}`}
            onClick={() => setTab("global")}
            title="The platform: start sessions, find things across them"
          >
            Global
          </button>
          <button
            role="tab"
            aria-selected={tab === "session"}
            className={`agent-tab${tab === "session" ? " active" : ""}`}
            onClick={() => setTab("session")}
            title={viewingSessionId ? "This session: change it, ask about what's checked in it" : "Open a session first"}
          >
            Session
          </button>
        </div>
        <div className="agent-panel-actions">
          <button
            className="agent-icon-btn"
            onClick={() => setLayout(layout === "dock" ? "float" : "dock")}
            aria-label={layout === "dock" ? "Float the agent over the page" : "Dock the agent beside the page"}
            title={layout === "dock" ? "Float over the page" : "Dock beside the page"}
          >
            {layout === "dock" ? <FloatIcon /> : <DockIcon />}
          </button>
          {account}
          {/* Docked, the strip's toggle beside it already hides it; floating,
              the panel is away from the strip and wants its own. */}
          {layout === "float" && (
            <button className="agent-icon-btn" onClick={() => setOpen(false)} aria-label="Close the agent" title="Close">
              ✕
            </button>
          )}
        </div>
      </div>
      <AgentChat scope={tab} />
    </div>
  );
}

function DockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <line x1="9.5" y1="2.5" x2="9.5" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10.5" y="3.5" width="3" height="9" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

function FloatIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8" y="7.5" width="5" height="4.5" rx="1" fill="currentColor" opacity="0.6" />
    </svg>
  );
}
