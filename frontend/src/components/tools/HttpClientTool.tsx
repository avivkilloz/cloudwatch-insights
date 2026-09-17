import { useEffect, useState } from "react";
import { api, HttpMethod, HttpToolResponse, SavedSession, ToolHeader } from "../../api";

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
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
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([{ id: nextHeaderId++, key: "", value: "" }]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<HttpToolResponse | null>(null);

  const [savedRequests, setSavedRequests] = useState<SavedSession<SavedHttpRequestState>[]>([]);

  useEffect(() => {
    api.listSavedSessions<SavedHttpRequestState>(SAVED_REQUESTS_PAGE).then(setSavedRequests);
  }, []);

  async function saveCurrentRequest() {
    const name = prompt("Save request as:");
    if (!name) return;
    const headers: ToolHeader[] = headerRows.filter((r) => r.key.trim()).map((r) => ({ key: r.key, value: r.value }));
    const saved = await api.createSavedSession<SavedHttpRequestState>({
      page: SAVED_REQUESTS_PAGE,
      name,
      state: { method, url, headers, body },
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
      const resp = await api.sendHttpToolRequest({
        method,
        url: url.trim(),
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : body || undefined,
      });
      setResponse(resp);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
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

      <div className="row" style={{ marginBottom: 10 }}>
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

      <span className="field-label">Headers</span>
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
      <button className="secondary" onClick={addHeaderRow} style={{ marginBottom: 10 }}>
        Add header
      </button>

      {!["GET", "HEAD"].includes(method) && (
        <>
          <span className="field-label">Body</span>
          <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Request body (raw)…" />
        </>
      )}

      {error && <p className="error-text">{error}</p>}

      {response && (
        <div style={{ marginTop: 14 }}>
          <div className="toolbar">
            <span className={`tag ${statusTag(response.status_code)}`}>
              {response.status_code} {response.status_text}
            </span>
            <span className="muted">{response.elapsed_ms} ms</span>
            {response.body_truncated && <span className="tag pending">response truncated</span>}
          </div>

          <span className="field-label">Response headers</span>
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

          <span className="field-label">Response body</span>
          <pre className="tool-json-output">{prettyBody(response.body)}</pre>
        </div>
      )}

      <p className="muted" style={{ marginTop: 4 }}>
        Requests are sent from the backend (not your browser), so CORS doesn't apply -- but for the same reason, the
        backend refuses to reach loopback, private, and link-local addresses (including cloud metadata endpoints), so
        this can't be used to reach internal infrastructure. Redirects are shown as-is rather than followed
        automatically.
      </p>
    </div>
  );
}
