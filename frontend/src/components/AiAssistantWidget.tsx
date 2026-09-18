import {
  useEffect,
  useId,
  useRef,
  useState,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { useSessionState } from "../sessions/SessionContext";
import { api, AiAssistMode, AiChatMessage, AiDomain } from "../api";
import { useAiPaneRegistry } from "./aiPanes";
import MarkdownLite from "./MarkdownLite";

interface DisplayMessage extends AiChatMessage {
  suggestedQuery?: string | null;
}

interface Props {
  /** Which page/service this widget is sitting on. Decides the query syntax
   * "Build query" writes and what "About results" thinks the rows are, and
   * changing it starts fresh threads -- a conversation about IoT things has
   * nothing useful to say about DynamoDB items. */
  domain: AiDomain;
  /** Modes this page offers. Defaults to both; a page whose search box takes
   * something too trivial to need help writing (S3's filename substring) can
   * pass just ["ask_results"]. */
  modes?: AiAssistMode[];
  queryString?: string;
  /** The rows the user has checked in the results below. These are the whole
   * subject of ask_results, and optional examples for build_query. */
  selectedRows?: Record<string, unknown>[];
  /** Wires up the "Use this query" button in the build_query thread. */
  onUseQuery?: (query: string) => void;
  /**
   * Bumped by the parent each time a new query run supersedes the displayed
   * results. Used to drop the "About results" thread so it doesn't keep
   * answering from a previous, no-longer-visible result set.
   */
  resultsVersion?: number;
  /** Overrides `domain` in ask_results mode. The Aggregator asks about rows
   * pooled from several services at once, which is a different thing to
   * describe than the one service build_query is writing for. */
  askDomain?: AiDomain;
  /** Extra controls rendered under the mode tabs, per mode -- the Aggregator's
   * picker for which open service "Build query" writes for only belongs in that
   * mode, since "About results" spans every open service at once. */
  headerExtra?: (mode: AiAssistMode) => ReactNode;
}

const MODE_LABELS: Record<AiAssistMode, string> = {
  build_query: "Build query",
  ask_results: "About results",
};

const ALL_MODES: AiAssistMode[] = ["build_query", "ask_results"];

interface DomainCopy {
  /** Plural noun for a result row, used in the "check some rows" wording. */
  rows: string;
  /** Input placeholder in each mode. */
  build: string;
  ask: string;
  /** Label for the button that applies a suggestion. Defaults to "Use this
   * query"; the HTTP client's suggestion is a whole request, not a query. */
  applyLabel?: string;
  /** Override the empty-thread hint, which says what this mode is for. */
  buildHint?: string;
  askHint?: string;
  /** Overrides "Asking about the N checked row(s)." -- for a surface whose
   * ask subject is one implicit thing (the HTTP client's last response)
   * rather than rows the user ticks off a list. */
  askSubject?: string;
  /** Overrides "check some rows first", for the same reason. */
  askEmpty?: string;
}

// Per-page wording, so the prompts suggest something actually answerable on
// the page you're looking at rather than always talking about log lines.
const DOMAIN_COPY: Record<AiDomain, DomainCopy> = {
  "logs-cloudwatch": {
    rows: "log rows",
    build: "e.g. show errors from the last hour grouped by service",
    ask: "e.g. what's the most common error?",
  },
  "logs-opensearch": {
    rows: "log rows",
    build: "e.g. errors from the checkout service, excluding health checks",
    ask: "e.g. what's the most common error?",
  },
  "iot-things": {
    rows: "things",
    build: "e.g. prod-stage things that are currently disconnected",
    ask: "e.g. which of these have been offline longest?",
  },
  "iot-certificates": {
    rows: "certificates",
    build: "e.g. only inactive certificates",
    ask: "e.g. how many of these are inactive?",
  },
  tables: {
    rows: "items",
    build: "e.g. items whose status is ACTIVE",
    ask: "e.g. what fields do these items have in common?",
  },
  buckets: {
    rows: "files",
    build: "",
    ask: "e.g. which of these files is largest?",
  },
  cognito: {
    rows: "users",
    build: "e.g. users whose email starts with john",
    ask: "e.g. how many of these are unconfirmed?",
  },
  aggregator: {
    rows: "checked rows from every open service",
    build: "",
    ask: "e.g. do these log errors line up with the disconnected devices?",
  },
  "tools-http": {
    rows: "exchange",
    build: "e.g. POST a new thing with a JSON body and a bearer token",
    ask: "e.g. why is this coming back 403?",
    applyLabel: "Use this request",
    buildHint: "Describe the request you want in plain English.",
    askHint: "Ask about the request you sent and the response it came back with.",
    askSubject: "Asking about the request you just sent and its response.",
    askEmpty: "Send a request first — this answers about the response you got back.",
  },
};

const EMPTY_THREADS: Record<AiAssistMode, DisplayMessage[]> = { build_query: [], ask_results: [] };

// Mirrors the backend router's own cap on how many rows it will accept, so a
// very large selection can say up front that only part of it is going.
const MAX_ROWS_SENT = 500;

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

export default function AiAssistantWidget({
  domain,
  modes = ALL_MODES,
  queryString,
  selectedRows,
  onUseQuery,
  resultsVersion,
  askDomain,
  headerExtra,
}: Props) {
  const registry = useAiPaneRegistry();
  const paneId = useId();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useSessionState<AiAssistMode>("ai.mode", modes[0]);
  const [threads, setThreads] = useSessionState("ai.threads", EMPTY_THREADS);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeSelectedInBuildQuery, setIncludeSelectedInBuildQuery] = useState(false);
  const [size, setSize] = useState(loadStoredSize);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Inside an Aggregator this widget renders nothing, so it has no status to
    // check -- the Aggregator's own shared widget does that once instead.
    if (registry) return;
    api
      .getAiStatus()
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, [registry]);

  // Hand this page's assistant context to the Aggregator rather than putting
  // up a competing floating button. Deliberately runs on every render, since
  // the row arrays are rebuilt each time; the registry compares before
  // re-rendering, so re-registering unchanged content costs nothing.
  useEffect(() => {
    if (!registry) return;
    registry.register({
      id: paneId,
      domain,
      modes,
      queryString,
      selectedRows: selectedRows ?? [],
      onUseQuery,
      resultsVersion: resultsVersion ?? 0,
    });
  });

  // Deregistering belongs in its own effect with stable deps: as the cleanup
  // of the every-render effect above it would run on every render too, and the
  // remove/re-add churn would change the pane list each time and spin.
  useEffect(() => {
    if (!registry) return;
    return () => registry.unregister(paneId);
  }, [registry, paneId]);

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
    setIncludeSelectedInBuildQuery(false);
  }, [resultsVersion]);

  // Switching what the page is searching (Logs' CloudWatch/OpenSearch toggle,
  // IoT's things/certificates toggle) changes both the query language and what
  // the rows are, so neither thread still applies.
  const lastDomain = useRef(domain);
  useEffect(() => {
    if (domain === lastDomain.current) return;
    lastDomain.current = domain;
    setThreads(EMPTY_THREADS);
    setError(null);
    setIncludeSelectedInBuildQuery(false);
  }, [domain]);

  // A page can stop offering the mode that's currently showing (e.g. moving to
  // a domain with no worthwhile query to build).
  useEffect(() => {
    if (!modes.includes(mode)) setMode(modes[0]);
  }, [modes, mode]);

  // Nothing checked means there are no example rows left to include.
  useEffect(() => {
    if ((selectedRows?.length ?? 0) === 0) setIncludeSelectedInBuildQuery(false);
  }, [selectedRows]);

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
    // Enter-to-send bypasses the disabled button, so guard here too.
    if (mode === "ask_results" && (selectedRows?.length ?? 0) === 0) return;
    const nextMessages: DisplayMessage[] = [...threads[mode], { role: "user", content: text }];
    setThreads((prev) => ({ ...prev, [mode]: nextMessages }));
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "";
    setLoading(true);
    setError(null);
    try {
      // ask_results is always about the rows the user checked; build_query
      // takes them only as optional examples.
      const rowsToSend =
        mode === "ask_results" || includeSelectedInBuildQuery ? selectedRows : undefined;
      const resp = await api.aiAssist({
        mode,
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        query_string: queryString,
        sample_rows: rowsToSend,
        row_count: mode === "ask_results" ? rowsToSend?.length : undefined,
        domain: mode === "ask_results" ? askDomain ?? domain : domain,
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

  // Inside an Aggregator the pane has handed its context up; the Aggregator's
  // single shared widget is what the user actually interacts with.
  if (registry) return null;
  if (!configured) return null;

  const messages = threads[mode];
  const selectedCount = selectedRows?.length ?? 0;
  const copy = DOMAIN_COPY[domain];
  const placeholder = mode === "build_query" ? copy.build : copy.ask;
  // ask_results has nothing to answer from until rows are checked, so it says
  // so rather than letting a question go off with no data attached.
  const needsSelection = mode === "ask_results" && selectedCount === 0;
  const askEmpty = copy.askEmpty ?? `Check the ${copy.rows} you want to ask about — only checked rows are sent.`;
  const emptyHint =
    mode === "build_query"
      ? copy.buildHint ?? "Describe the query you want in plain English."
      : copy.askHint ?? `Check the ${copy.rows} you want to ask about in the results below.`;

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
              {modes.map((m) => (
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
          {headerExtra?.(mode)}

          {mode === "ask_results" && (
            <p className={needsSelection ? "muted" : undefined} style={{ padding: "4px 12px 0", fontSize: 12 }}>
              {needsSelection ? askEmpty : copy.askSubject ?? `Asking about the ${selectedCount} checked row(s).`}
              {selectedCount > MAX_ROWS_SENT && ` Only the first ${MAX_ROWS_SENT} will be sent.`}
            </p>
          )}
          {mode === "build_query" && selectedCount > 0 && (
            <div className="ai-widget-header" style={{ borderBottom: "none", paddingBottom: 0 }}>
              <label className="checkbox-item" style={{ fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={includeSelectedInBuildQuery}
                  onChange={(e) => setIncludeSelectedInBuildQuery(e.target.checked)}
                />
                Use {selectedCount} checked result(s) as examples
              </label>
            </div>
          )}

          <div className="ai-widget-messages">
            {messages.length === 0 && <p className="muted">{emptyHint}</p>}
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
                      {copy.applyLabel ?? "Use this query"}
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
              placeholder={placeholder}
              className="ai-widget-textarea"
            />
            <button
              onClick={send}
              disabled={loading || !input.trim() || needsSelection}
              title={needsSelection ? askEmpty : undefined}
              style={{ padding: "6px 12px" }}
            >
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
