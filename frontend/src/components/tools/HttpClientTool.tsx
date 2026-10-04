import { useEffect, useState } from "react";
import { PaneSelectionShare } from "../paneSelection";
import { useSessionState } from "../../sessions/SessionContext";
import { api, CredentialSummary, HttpMethod, HttpToolResponse, readableError, SavedSession, ToolHeader } from "../../api";
import { BODYLESS_METHODS, HTTP_METHODS } from "./httpRequestJson";

const METHODS = HTTP_METHODS;
const SAVED_REQUESTS_PAGE = "tools-http";

let nextHeaderId = 1;
interface HeaderRow {
  id: number;
  key: string;
  value: string;
}

interface SavedHttpRequestState {
  method: HttpMethod;
  url: string;
  headers: ToolHeader[];
  body: string;
  /** By id only; older saved requests have none. */
  credentialId?: number | null;
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function statusTag(statusCode: number): string {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "error";
  if (statusCode >= 300) return "pending";
  return "ok";
}

export default function HttpClientTool() {
  const [method, setMethod] = useSessionState<HttpMethod>("method", "GET");
  const [url, setUrl] = useSessionState("url", "");
  const [headerRows, setHeaderRows] = useSessionState<HeaderRow[]>("headerRows", () => [{ id: nextHeaderId++, key: "", value: "" }]);
  const [body, setBody] = useSessionState("body", "");
  // Which credential to authenticate with -- its id, never its value: the
  // backend resolves it and adds the header itself (PLATFORM_PLAN.md §13.8),
  // so nothing secret is in this pane, the session, or the agent's history.
  const [credentialId, setCredentialId] = useSessionState<number | null>("credentialId", null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useSessionState<HttpToolResponse | null>("response", null);

  const [savedRequests, setSavedRequests] = useState<SavedSession<SavedHttpRequestState>[]>([]);

  // The last exchange, kept as the single "row" this pane offers the agent's
  // session chat to attach -- ask it why a request came back 403 -- and
  // versioned so a new request replaces it rather than piling up.
  const [exchange, setExchange] = useSessionState<Record<string, unknown>[]>("exchange", []);
  const [exchangeVersion, setExchangeVersion] = useSessionState("exchangeVersion", 0);

  useEffect(() => {
    api.listSavedSessions<SavedHttpRequestState>(SAVED_REQUESTS_PAGE).then(setSavedRequests);
    // Admins get full rows and everyone else summaries; both say whether a
    // credential can authenticate a request, which is all this needs.
    api
      .listCredentials<CredentialSummary>()
      .then((rows) => setCredentials(rows.filter((c) => c.authenticates)))
      .catch(() => setCredentials([]));
  }, []);

  const chosenCredential = credentials.find((c) => c.id === credentialId) ?? null;

  async function saveCurrentRequest() {
    const name = prompt("Save request as:");
    if (!name) return;
    const headers: ToolHeader[] = headerRows.filter((r) => r.key.trim()).map((r) => ({ key: r.key, value: r.value }));
    const saved = await api.createSavedSession<SavedHttpRequestState>({
      page: SAVED_REQUESTS_PAGE,
      name,
      state: { method, url, headers, body, credentialId },
    });
    setSavedRequests((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function loadSavedRequest(id: number) {
    const saved = savedRequests.find((r) => r.id === id);
    if (!saved) return;
    setMethod(saved.state.method);
    setUrl(saved.state.url);
    setHeaderRows(
      saved.state.headers.length > 0
        ? saved.state.headers.map((h) => ({ id: nextHeaderId++, key: h.key, value: h.value }))
        : [{ id: nextHeaderId++, key: "", value: "" }]
    );
    setBody(saved.state.body);
    setCredentialId(saved.state.credentialId ?? null);
  }

  function updateHeader(id: number, field: "key" | "value", value: string) {
    setHeaderRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function addHeaderRow() {
    setHeaderRows((prev) => [...prev, { id: nextHeaderId++, key: "", value: "" }]);
  }

  function removeHeaderRow(id: number) {
    setHeaderRows((prev) => prev.filter((r) => r.id !== id));
  }

  async function send() {
    if (!url.trim()) {
      setError("Enter a URL.");
      return;
    }
    setSending(true);
    setError(null);
    setResponse(null);
    try {
      const headers: ToolHeader[] = headerRows.filter((r) => r.key.trim()).map((r) => ({ key: r.key, value: r.value }));
      const sentBody = BODYLESS_METHODS.includes(method) ? undefined : body || undefined;
      const resp = await api.sendHttpToolRequest({
        method,
        url: url.trim(),
        headers,
        body: sentBody,
        credential_id: credentialId,
      });
      setResponse(resp);
      // The request goes in alongside the response: asking "why is this a
      // 403?" is unanswerable without seeing what was actually sent, and the
      // form may well be edited before the question is asked.
      setExchange([
        {
          request: {
            method,
            url: url.trim(),
            headers,
            body: sentBody,
            // Which credential signed it, by name: enough to ask about a 401.
            ...(chosenCredential ? { auth: `credential "${chosenCredential.name}"` } : {}),
          },
          response: {
            status_code: resp.status_code,
            status_text: resp.status_text,
            elapsed_ms: resp.elapsed_ms,
            headers: resp.headers,
            body: resp.body,
            body_truncated: resp.body_truncated,
          },
        },
      ]);
      setExchangeVersion((v) => v + 1);
    } catch (e) {
      setError(readableError(e));
      // A request that never completed has no response to ask about.
      setExchange([]);
      setExchangeVersion((v) => v + 1);
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <div className="panel">
        <h2>Request</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <select value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="https://api.example.com/resource"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
          />
          <button onClick={send} disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>

        <div className="row http-auth-row" style={{ marginBottom: 10 }}>
          <label className="field-label" htmlFor="http-auth" style={{ margin: 0 }}>
            Auth
          </label>
          <select
            id="http-auth"
            value={credentialId == null ? "" : String(credentialId)}
            onChange={(e) => setCredentialId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">None</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.type_label})
              </option>
            ))}
            {credentialId != null && !chosenCredential && (
              <option value={credentialId}>A credential you can't use</option>
            )}
          </select>
          {chosenCredential && (
            <span className="muted">Added by the server when sent; never shown here.</span>
          )}
          {credentials.length === 0 && (
            <span className="muted">No credentials your group can use for requests.</span>
          )}
        </div>

        <div className="row">
          <select
            onChange={(e) => {
              if (e.target.value) loadSavedRequest(Number(e.target.value));
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved request…
            </option>
            {savedRequests.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentRequest}>
            Save request
          </button>
        </div>

        <p className="muted" style={{ margin: "10px 0 0" }}>
          Requests are sent from the backend, not your browser, so CORS doesn't apply — but for the same reason the
          backend refuses to reach loopback, private and link-local addresses (cloud metadata endpoints included), so
          this can't be used to reach internal infrastructure. Redirects are shown as-is rather than followed.
        </p>
      </div>

      <div className="panel">
        <h2>Headers</h2>
        {headerRows.map((row) => (
          <div className="row" key={row.id} style={{ marginBottom: 6 }}>
            <input
              type="text"
              placeholder="Header name"
              value={row.key}
              onChange={(e) => updateHeader(row.id, "key", e.target.value)}
              style={{ width: 200 }}
            />
            <input
              type="text"
              placeholder="Value"
              value={row.value}
              onChange={(e) => updateHeader(row.id, "value", e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            />
            <button className="danger" onClick={() => removeHeaderRow(row.id)}>
              Remove
            </button>
          </div>
        ))}
        <button className="secondary" onClick={addHeaderRow}>
          Add header
        </button>
      </div>

      {!BODYLESS_METHODS.includes(method) && (
        <div className="panel">
          <h2>Body</h2>
          <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Request body (raw)…" />
        </div>
      )}

      {error && (
        <div className="panel">
          <p className="error-text" style={{ margin: 0 }}>{error}</p>
        </div>
      )}

      {response && (
        <div className="panel">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Response</h2>
            <span className={`tag ${statusTag(response.status_code)}`}>
              {response.status_code} {response.status_text}
            </span>
            <span className="muted">{response.elapsed_ms} ms</span>
            {response.body_truncated && <span className="tag pending">response truncated</span>}
          </div>

          <span className="field-label">Headers</span>
          <table>
            <tbody>
              {response.headers.map((h, i) => (
                <tr key={i}>
                  <td>{h.key}</td>
                  <td>{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <span className="field-label">Body</span>
          <pre className="tool-json-output" style={{ marginBottom: 0 }}>
            {prettyBody(response.body)}
          </pre>
        </div>
      )}

      {/* The last exchange is this pane's one "row": what the agent's session
          chat can attach, to ask why a request came back the way it did. */}
      <PaneSelectionShare domain="tools-http" selectedRows={exchange} />
    </div>
  );
}
