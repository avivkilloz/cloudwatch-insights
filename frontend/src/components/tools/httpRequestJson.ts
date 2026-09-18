import { HttpMethod, ToolHeader } from "../../api";

/**
 * The JSON shape the AI assistant reads and writes for the HTTP client.
 *
 * Every other page's assistant suggests a query *string*, which drops
 * straight into a text box. An HTTP request isn't one value, so this tool
 * round-trips the whole thing -- method, URL, headers, body -- as a small
 * JSON object instead. The backend's existing code-block extraction gives us
 * the block's contents; everything here is about turning that text into form
 * state (and the form state back into the "current request" the assistant
 * refines).
 */

export const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Methods the tool doesn't send a body for -- mirrored from the tool's own UI. */
export const BODYLESS_METHODS: HttpMethod[] = ["GET", "HEAD"];

export interface RequestShape {
  method: HttpMethod;
  url: string;
  headers: ToolHeader[];
  body: string;
}

/**
 * The current form state, as the JSON the assistant is asked to refine.
 * Empty parts are left out rather than sent as empty strings, so "add an
 * Authorization header" doesn't also have to reason about `"body": ""`.
 * Returns undefined when there's no URL yet -- there's nothing to refine, and
 * an empty skeleton would only invite the model to preserve it.
 */
export function serializeRequest(req: RequestShape): string | undefined {
  if (!req.url.trim()) return undefined;
  const out: Record<string, unknown> = { method: req.method, url: req.url.trim() };
  const headers = req.headers.filter((h) => h.key.trim());
  if (headers.length > 0) {
    out.headers = Object.fromEntries(headers.map((h) => [h.key.trim(), h.value]));
  }
  if (req.body && !BODYLESS_METHODS.includes(req.method)) out.body = req.body;
  return JSON.stringify(out, null, 2);
}

function coerceHeaders(raw: unknown): ToolHeader[] {
  // The prompt asks for a flat object, which is the natural way to write
  // headers -- but an array of {key, value} is how this app stores them, so
  // accept that too rather than rejecting a suggestion that's merely in the
  // other obvious shape.
  if (Array.isArray(raw)) {
    return raw
      .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
      .map((h) => ({ key: String(h.key ?? h.name ?? ""), value: String(h.value ?? "") }))
      .filter((h) => h.key);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
  }
  return [];
}

function coerceBody(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  // The prompt asks for a JSON-encoded string, but a model writing a JSON
  // body will often just inline the object. Rendering that back out is
  // strictly better than dropping it or pasting "[object Object]".
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

/**
 * Parses an assistant suggestion into form state.
 *
 * Throws with a message meant to be shown to the user: this runs on a click
 * of "Use this request", so a malformed suggestion has to say what was wrong
 * rather than silently doing nothing.
 */
export function parseSuggestedRequest(text: string): RequestShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The assistant's suggestion isn't valid JSON, so it can't be loaded into the form.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The assistant's suggestion isn't a JSON object describing a request.");
  }

  const obj = parsed as Record<string, unknown>;
  const url = typeof obj.url === "string" ? obj.url.trim() : "";
  if (!url) throw new Error("The assistant's suggestion has no URL.");

  const rawMethod = String(obj.method ?? "GET").toUpperCase();
  const method = (HTTP_METHODS as string[]).includes(rawMethod) ? (rawMethod as HttpMethod) : "GET";

  return { method, url, headers: coerceHeaders(obj.headers), body: coerceBody(obj.body) };
}
