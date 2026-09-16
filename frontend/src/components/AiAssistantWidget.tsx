import { useEffect, useState } from "react";
import { api, AiAssistMode, AiChatMessage } from "../api";
import MarkdownLite from "./MarkdownLite";

interface DisplayMessage extends AiChatMessage {
  suggestedQuery?: string | null;
}

interface Props {
  queryString?: string;
  sampleRows?: Record<string, unknown>[];
  rowCount?: number;
  /** Wires up the "Use this query" button in the build_query thread. */
  onUseQuery?: (query: string) => void;
}

const MODE_LABELS: Record<AiAssistMode, string> = {
  build_query: "Build query",
  ask_results: "About results",
};

const MODE_PLACEHOLDERS: Record<AiAssistMode, string> = {
  build_query: "e.g. show errors from the last hour grouped by service",
  ask_results: "e.g. what's the most common error?",
};

const MODE_EMPTY_HINTS: Record<AiAssistMode, string> = {
  build_query: "Describe the query you want in plain English.",
  ask_results: "Ask a question about the current results.",
};

const EMPTY_THREADS: Record<AiAssistMode, DisplayMessage[]> = { build_query: [], ask_results: [] };

export default function AiAssistantWidget({ queryString, sampleRows, rowCount, onUseQuery }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AiAssistMode>("build_query");
  const [threads, setThreads] = useState(EMPTY_THREADS);
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
    const nextMessages: DisplayMessage[] = [...threads[mode], { role: "user", content: text }];
    setThreads((prev) => ({ ...prev, [mode]: nextMessages }));
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const resp = await api.aiAssist({
        mode,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        query_string: queryString,
        sample_rows: mode === "ask_results" ? sampleRows : undefined,
        row_count: mode === "ask_results" ? rowCount : undefined,
      });
      setThreads((prev) => ({
        ...prev,
        [mode]: [...nextMessages, { role: "assistant", content: resp.reply, suggestedQuery: resp.suggested_query }],
      }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (!configured) return null;

  const messages = threads[mode];

  return (
    <>
      <button className="ai-widget-button" onClick={() => setOpen((v) => !v)}>
        {open ? "Close AI assistant" : "✦ Ask AI"}
      </button>
      {open && (
        <div className="ai-widget-panel">
          <div className="ai-widget-header">
            <div className="ai-widget-tabs">
              {(Object.keys(MODE_LABELS) as AiAssistMode[]).map((m) => (
                <button
                  key={m}
                  className={mode === m ? "tab active" : "tab"}
                  onClick={() => setMode(m)}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <button className="secondary" style={{ padding: "2px 8px" }} onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>

          <div className="ai-widget-messages">
            {messages.length === 0 && <p className="muted">{MODE_EMPTY_HINTS[mode]}</p>}
            {messages.map((m, i) => (
              <div className="result-row" key={i} style={{ marginBottom: 8 }}>
                <div className="result-row-detail" style={{ borderTop: "none" }}>
                  <span className={m.role === "user" ? "tag" : "tag ok"}>{m.role === "user" ? "You" : "AI"}</span>
                  <div style={{ marginTop: 6 }}>
                    <MarkdownLite text={m.content} />
                  </div>
                  {m.suggestedQuery && onUseQuery && (
                    <button className="secondary" style={{ padding: "3px 10px" }} onClick={() => onUseQuery(m.suggestedQuery!)}>
                      Use this query
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="ai-widget-input">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={MODE_PLACEHOLDERS[mode]}
              style={{ flex: 1 }}
            />
            <button onClick={send} disabled={loading || !input.trim()} style={{ padding: "6px 12px" }}>
              {loading ? "…" : "Ask"}
            </button>
          </div>
          {error && (
            <p className="error-text" style={{ padding: "0 12px 10px" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}
