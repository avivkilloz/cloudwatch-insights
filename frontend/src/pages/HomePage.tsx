import { useEffect, useRef, useState } from "react";
import MarkdownLite from "../components/MarkdownLite";
import { sessionTypeLabel } from "../components/SessionTabs";
import { useSessions } from "../sessions/SessionContext";

/**
 * The platform agent's page -- where you land on opening the app and whenever
 * you click the brand.
 *
 * The agent itself isn't wired to a model yet. This deliberately doesn't fake
 * one: a chat that invents answers about your AWS accounts is worse than one
 * that says it can't answer. What it does do is show the platform state the
 * agent will be given, which is real and is the thing the next change builds
 * on.
 *
 * It's a different thing from the per-session AI assistant: that one sees one
 * session's query and rows, this one sees the workspace from outside and will
 * be able to act on it.
 */

export interface HomeMessage {
  role: "user" | "agent";
  content: string;
}

const NOT_WIRED =
  "I'm not connected to a model yet, so I can't answer that.\n\n" +
  "Once I am, I'll be able to read the whole workspace and act on it — open a " +
  "session for you, run a search in one, and answer across every session at " +
  "once. That's different from the **✦ Ask AI** assistant inside a session, " +
  "which only ever sees that session's own query and rows.";

export default function HomePage({
  messages,
  onMessagesChange,
  pendingPrompt,
  onPendingPromptHandled,
}: {
  messages: HomeMessage[];
  onMessagesChange: (messages: HomeMessage[]) => void;
  /** A prompt submitted from the header bar, handed over once on arrival. */
  pendingPrompt: string | null;
  onPendingPromptHandled: () => void;
}) {
  const { sessions } = useSessions();
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    onMessagesChange([...messages, { role: "user", content: trimmed }, { role: "agent", content: NOT_WIRED }]);
    setInput("");
  }

  // The header bar submits into this page, so a prompt typed up there arrives
  // as a pending value the moment the page mounts.
  const handled = useRef(false);
  useEffect(() => {
    if (!pendingPrompt || handled.current) return;
    handled.current = true;
    send(pendingPrompt);
    onPendingPromptHandled();
    // Cleared so a later prompt from the header is handled too.
    handled.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="home">
      <div className="panel">
        <h2>Agent</h2>
        <p className="muted">
          Ask about anything in the platform, and — once this is connected — have it do the work: open the sessions
          you need, run the searches, and answer across all of them at once. It sees the workspace from outside,
          unlike the <strong>✦ Ask AI</strong> assistant inside a session, which only ever sees that session's own
          query and rows.
        </p>
        <p className="error-text" style={{ marginBottom: 0 }}>
          Not connected to a model yet — it will say so rather than guess.
        </p>
      </div>

      <div className="panel">
        <h2>What it can see</h2>
        {sessions.length === 0 ? (
          <p className="muted">
            No sessions open. Use the <strong>+</strong> button below the header to start one.
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
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td>{sessionTypeLabel(s.type)}</td>
                  <td className="muted">
                    {s.truncated
                      ? "inputs only — results were too large to keep"
                      : `${Object.keys(s.state).length} value(s)`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel home-chat">
        {messages.length === 0 && (
          <p className="muted">Nothing asked yet. Type below, or use the search bar in the header.</p>
        )}
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
