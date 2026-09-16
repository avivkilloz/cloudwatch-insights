import { useEffect, useState } from "react";
import { api, AiAssistMode, AiChatMessage } from "../api";

interface DisplayMessage extends AiChatMessage {
  suggestedQuery?: string | null;
}

interface Props {
  mode: AiAssistMode;
  title: string;
  description: string;
  placeholder: string;
  queryString?: string;
  sampleRows?: Record<string, unknown>[];
  rowCount?: number;
  /** build_query mode only: wires up the "Use this query" button. */
  onUseQuery?: (query: string) => void;
}

export default function AiChatPanel({
  mode,
  title,
  description,
  placeholder,
  queryString,
  sampleRows,
  rowCount,
  onUseQuery,
}: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAiStatus()
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const nextMessages: DisplayMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const resp = await api.aiAssist({
        mode,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        query_string: queryString,
        sample_rows: sampleRows,
        row_count: rowCount,
      });
      setMessages([...nextMessages, { role: "assistant", content: resp.reply, suggestedQuery: resp.suggested_query }]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (!configured) return null;

  return (
    <div className="panel">
      <h2>{title}</h2>
      <p className="muted">{description}</p>

      {messages.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {messages.map((m, i) => (
            <div className="result-row" key={i} style={{ marginBottom: 8 }}>
              <div className="result-row-detail" style={{ borderTop: "none" }}>
                <span className={m.role === "user" ? "tag" : "tag ok"}>{m.role === "user" ? "You" : "AI"}</span>
                <p style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{m.content}</p>
                {m.suggestedQuery && (
                  <>
                    <pre
                      style={{
                        margin: "6px 0",
                        background: "var(--panel-alt)",
                        padding: 8,
                        borderRadius: 6,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {m.suggestedQuery}
                    </pre>
                    {onUseQuery && (
                      <button className="secondary" onClick={() => onUseQuery(m.suggestedQuery!)}>
                        Use this query
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={placeholder}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button onClick={send} disabled={loading || !input.trim()}>
          {loading ? "Thinking…" : "Ask"}
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
