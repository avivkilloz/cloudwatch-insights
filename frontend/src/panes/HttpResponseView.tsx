/**
 * The HTTP client's response (`render: http_response`, PLATFORM_PLAN.md
 * §16.4.4), drawn as the hand-written tool drew it: a title row with the
 * status (its tone by range), the time taken and whether the body was cut
 * off, then the headers and the body, pretty-printed when it's JSON. The
 * card holding it has no title of its own, since the status sits beside it.
 */

import { Values } from "./paneApi";

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function statusTone(statusCode: number): string {
  if (statusCode >= 400) return "error";
  if (statusCode >= 300) return "pending";
  return "ok";
}

export default function HttpResponseView({ response }: { response: Values }) {
  const status = Number(response.status_code);
  const headers = Array.isArray(response.headers) ? (response.headers as { key: string; value: string }[]) : [];
  return (
    <>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Response</h2>
        <span className={`tag ${statusTone(status)}`}>
          {status} {String(response.status_text ?? "")}
        </span>
        <span className="muted">{String(response.elapsed_ms ?? "")} ms</span>
        {!!response.body_truncated && <span className="tag pending">response truncated</span>}
      </div>

      <span className="field-label">Headers</span>
      <table>
        <tbody>
          {headers.map((h, i) => (
            <tr key={i}>
              <td>{h.key}</td>
              <td>{h.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <span className="field-label">Body</span>
      <pre className="tool-json-output" style={{ marginBottom: 0 }}>
        {prettyBody(String(response.body ?? ""))}
      </pre>
    </>
  );
}
