import { useEffect, useRef, useState } from "react";
import MarkdownLite from "../components/MarkdownLite";
import { useSessionState, useSessions } from "../sessions/SessionContext";
import { sessionTypeLabel } from "../sessions/registry";

/**
 * A conversation with the platform agent, as its own session.
 *
 * It's a different thing from the ✦ Ask AI assistant inside a service session:
 * that one sees one session's query and rows, this one sees the workspace from
 * outside and will be able to act on it.
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

/** The messages an agent session starts with when it was opened by a question
 * typed in the header. */
export function openingExchange(question: string): AgentMessage[] {
  return [
    { role: "user", content: question },
    { role: "agent", content: AGENT_NOT_WIRED },
  ];
}

export default function AgentPage() {
  const { sessions } = useSessions();
  // Persisted like any other session state, so the conversation survives a
  // reload the same way a query and its results do.
  const [messages, setMessages] = useSessionState<AgentMessage[]>("agent.messages", []);
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

  const others = sessions.filter((s) => s.type !== "agent");

  return (
    <div className="agent-session">
      <div className="panel">
        <h2>Agent</h2>
        <p className="muted">
          Ask about anything in the platform, and — once this is connected — have it do the work: open the sessions you
          need, run the searches, and answer across all of them at once. It sees the workspace from outside, unlike the{" "}
          <strong>✦ Ask AI</strong> assistant inside a service session, which only ever sees that session's own query
          and rows.
        </p>
        <p className="error-text" style={{ marginBottom: 0 }}>
          Not connected to a model yet — it will say so rather than guess.
        </p>
      </div>

      <div className="panel">
        <h2>What it can see</h2>
        {others.length === 0 ? (
          <p className="muted">
            No other sessions open. Start one from <strong>+</strong>, or from the cards on the home page.
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
