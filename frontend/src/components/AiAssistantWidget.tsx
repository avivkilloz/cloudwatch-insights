import { useEffect, useRef, useState, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
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
  /**
   * Bumped by the parent each time a new query run supersedes the displayed
   * results. Used to drop the "About results" thread so it doesn't keep
   * answering from a previous, no-longer-visible result set.
   */
  resultsVersion?: number;
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

const SAMPLE_CAP = 40;

const DEFAULT_SIZE = { width: 380, height: 480 };
const MIN_SIZE = { width: 320, height: 280 };
const SIZE_STORAGE_KEY = "cw-ai-widget-size";
const VIEWPORT_MARGIN = { width: 48, height: 140 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadStoredSize(): { width: number; height: number } {
  try {
    const raw = window.localStorage.getItem(SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_SIZE;
    const parsed = JSON.parse(raw);
    if (typeof parsed.width === "number" && typeof parsed.height === "number") return parsed;
  } catch {
    // localStorage unavailable, or a bad/stale value -- fall back to the default size.
  }
  return DEFAULT_SIZE;
}

/**
 * Reorders rows so that distinct @log values interleave (row 0 from group A,
 * row 1 from group B, row 2 from group A, ...) rather than staying grouped
 * in their original order. A query spanning multiple log groups can have one
 * far higher-volume than another, so any prefix taken from a plain
 * chronological list can end up entirely from the dominant group. Once
 * interleaved, ANY prefix -- whether the capped sample or the full list
 * truncated later by the backend's context-size budget -- keeps every
 * represented log group fairly included.
 */
function interleaveByLogGroup(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = String(row["@log"] ?? "");
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  if (groups.size <= 1) return rows;

  const groupLists = Array.from(groups.values());
  const interleaved: Record<string, unknown>[] = [];
  for (let i = 0; interleaved.length < rows.length; i++) {
    for (const list of groupLists) {
      if (i < list.length) interleaved.push(list[i]);
    }
  }
  return interleaved;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
      <path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3.2 3.2L13 4.5" />
    </svg>
  );
}

export default function AiAssistantWidget({ queryString, sampleRows, rowCount, onUseQuery, resultsVersion }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AiAssistMode>("build_query");
  const [threads, setThreads] = useState(EMPTY_THREADS);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useFullResults, setUseFullResults] = useState(false);
  const [size, setSize] = useState(loadStoredSize);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .getAiStatus()
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, []);

  function startResize(e: ReactMouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = size;
    const maxWidth = window.innerWidth - VIEWPORT_MARGIN.width;
    const maxHeight = window.innerHeight - VIEWPORT_MARGIN.height;

    function onMove(ev: MouseEvent) {
      // The panel is anchored to the bottom-right corner, so dragging the
      // top-left handle up/left (a shrinking clientX/clientY) is what grows
      // it -- the delta is inverted relative to a normal bottom-right handle.
      const next = {
        width: clamp(startSize.width + (startX - ev.clientX), MIN_SIZE.width, maxWidth),
        height: clamp(startSize.height + (startY - ev.clientY), MIN_SIZE.height, maxHeight),
      };
      setSize(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSize((current) => {
        try {
          window.localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(current));
        } catch {
          // best-effort persistence only
        }
        return current;
      });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const lastResultsVersion = useRef(resultsVersion);
  useEffect(() => {
    if (resultsVersion === undefined || resultsVersion === lastResultsVersion.current) return;
    lastResultsVersion.current = resultsVersion;
    setThreads((prev) => ({ ...prev, ask_results: [] }));
    setUseFullResults(false);
  }, [resultsVersion]);

  function handleInputKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function copyMessage(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1500);
    } catch {
      // Clipboard access denied or unavailable (e.g. insecure context) -- nothing more we can do.
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const nextMessages: DisplayMessage[] = [...threads[mode], { role: "user", content: text }];
    setThreads((prev) => ({ ...prev, [mode]: nextMessages }));
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "";
    setLoading(true);
    setError(null);
    try {
      const interleaved = mode === "ask_results" ? interleaveByLogGroup(sampleRows ?? []) : undefined;
      const rowsToSend = interleaved && !useFullResults ? interleaved.slice(0, SAMPLE_CAP) : interleaved;
      const resp = await api.aiAssist({
        mode,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        query_string: queryString,
        sample_rows: rowsToSend,
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
  const totalAvailableRows = sampleRows?.length ?? 0;

  return (
    <>
      <button className="ai-widget-button" onClick={() => setOpen((v) => !v)}>
        {open ? "Close AI assistant" : "✦ Ask AI"}
      </button>
      {open && (
        <div className="ai-widget-panel" style={{ width: size.width, height: size.height }}>
          <div
            className="ai-widget-resize-handle"
            onMouseDown={startResize}
            title="Drag to resize"
            aria-hidden="true"
          />
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
            <button className="ai-widget-icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>

          {mode === "ask_results" && totalAvailableRows > SAMPLE_CAP && (
            <div className="ai-widget-header" style={{ borderBottom: "none", paddingBottom: 0 }}>
              <div className="ai-widget-tabs">
                <button
                  className={!useFullResults ? "tab active" : "tab"}
                  onClick={() => setUseFullResults(false)}
                  style={{ fontSize: 11, padding: "3px 8px" }}
                >
                  Sampled ({SAMPLE_CAP})
                </button>
                <button
                  className={useFullResults ? "tab active" : "tab"}
                  onClick={() => setUseFullResults(true)}
                  style={{ fontSize: 11, padding: "3px 8px" }}
                >
                  All results ({totalAvailableRows})
                </button>
              </div>
            </div>
          )}
          {mode === "ask_results" && totalAvailableRows > SAMPLE_CAP && useFullResults && (
            <p className="muted" style={{ padding: "4px 12px 0" }}>
              Sending all {totalAvailableRows} rows -- large result sets are automatically trimmed to fit the AI's
              context window, so the assistant will say if it only saw part of it.
            </p>
          )}

          <div className="ai-widget-messages">
            {messages.length === 0 && <p className="muted">{MODE_EMPTY_HINTS[mode]}</p>}
            {messages.map((m, i) => (
              <div className="result-row" key={i} style={{ marginBottom: 8 }}>
                <div className="result-row-detail" style={{ borderTop: "none" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className={m.role === "user" ? "tag" : "tag ok"}>{m.role === "user" ? "You" : "AI"}</span>
                    {m.role === "assistant" && (
                      <button
                        className="ai-widget-icon-btn"
                        style={copiedIndex === i ? { color: "var(--ok)" } : undefined}
                        onClick={() => copyMessage(i, m.content)}
                        aria-label={copiedIndex === i ? "Copied" : "Copy reply"}
                        title={copiedIndex === i ? "Copied" : "Copy reply"}
                      >
                        {copiedIndex === i ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    )}
                  </div>
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
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = "";
                el.style.height = `${el.scrollHeight}px`;
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={MODE_PLACEHOLDERS[mode]}
              className="ai-widget-textarea"
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
