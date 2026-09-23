import { useEffect, useRef, useState } from "react";
import MarkdownLite from "../components/MarkdownLite";
import { useSessions } from "../sessions/SessionContext";
import { sessionTypeLabel } from "../sessions/registry";

/**
 * A conversation with the platform agent.
 *
 * A page rather than a session, because there is one agent and it sees across
 * everything -- you go to it rather than having several. It's a different thing
 * from the ✦ Ask AI assistant inside a session: that one sees one session's own
 * panes, this one sees the workspace from outside and will be able to act on it.
 *
 * The agent isn't wired to a model yet, and this deliberately doesn't fake
 * one -- a chat that invents answers about someone's AWS accounts is worse
 * than one that says it can't answer. What it does show is the real workspace
 * state the agent will be given, which is what the next change builds on.
 */

export interface AgentMessage {
  role: "user" | "agent";
  content: string;
}

export const AGENT_NOT_WIRED =
  "I'm not connected to a model yet, so I can't answer that.\n\n" +
  "Once I am, I'll be able to read the whole workspace and act on it — open a " +
  "session for you, run a search in one, and answer across every session at " +
  "once. That's different from the **✦ Ask AI** assistant inside a service " +
  "session, which only ever sees that session's own query and rows.";

export default function AgentPage({ ask, onAsked }: { ask?: string | null; onAsked?: () => void } = {}) {
  const { sessions } = useSessions();
  // Plain state, not session state: a page has no session to hang off. The
  // shell keeps this page mounted so the conversation survives moving around
  // the app; it does not survive a reload, which is honest for something not
  // connected to a model. Storing a transcript of "I can't answer that" would
  // be the wrong thing to make durable.
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [...prev, { role: "user", content: trimmed }, { role: "agent", content: AGENT_NOT_WIRED }]);
    setInput("");
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  // A question typed into the header bar arrives here.
  useEffect(() => {
    if (!ask) return;
    send(ask);
    onAsked?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  const others = sessions;

  return (
    <div className="agent-session">
      {/* What the agent is now lives in the page header the shell draws from
          the registry; this panel keeps only the part that is a warning. */}
      <div className="panel">
        <p className="error-text" style={{ margin: 0 }}>
          Not connected to a model yet — it will say so rather than guess.
        </p>
      </div>

      <div className="panel">
        <h2>What it can see</h2>
        {others.length === 0 ? (
          <p className="muted">
            No sessions open. Start one from the home page.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Type</th>
                <th>State kept</th>
              </tr>
            </thead>
            <tbody>
              {others.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td>{sessionTypeLabel(s.type)}</td>
                  <td className="muted">
                    {s.truncated ? "inputs only — results were too large to keep" : `${Object.keys(s.state).length} value(s)`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        {messages.length === 0 && <p className="muted">Nothing asked yet.</p>}
        {messages.map((m, i) => (
          <div className="result-row" key={i} style={{ marginBottom: 8 }}>
            <div className="result-row-detail" style={{ borderTop: "none" }}>
              <span className={m.role === "user" ? "tag" : "tag ok"}>{m.role === "user" ? "You" : "Agent"}</span>
              <div style={{ marginTop: 6 }}>
                <MarkdownLite text={m.content} />
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send(input);
            }}
            placeholder="Ask the agent…"
            style={{ flex: 1, minWidth: 240 }}
          />
          <button onClick={() => send(input)} disabled={!input.trim()}>
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}
