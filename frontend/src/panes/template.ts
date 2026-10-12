/**
 * The small template language manifests use for text drawn from data
 * (PLATFORM_PLAN.md §16.3.2): a list row's summary, a count line, an export's
 * file name, the S3 URI a Copy button copies.
 *
 *   "{{ n }} item(s) loaded, {{ out.scannedCount ?? 0 }} scanned so far"
 *   "{{ row.status ?? 'unknown' }}"
 *   "{{ out.activeSearch ? row.key : row.name }}"
 *   "https://{{ in.bucket }}.s3.{{ out.bucketRegion }}.amazonaws.com/{{ row.key | encode_path }}"
 *
 * Inside `{{ }}`: dotted paths into the scope (`row`, `in`, `out`, `v` and
 * the component's own counts), quoted strings and numbers; `a ?? b` takes b
 * when a is missing or empty; `c ? a : b`; then `| filter`s (bytes, time,
 * encode_path, json, count). Nothing else --
 * no calls, no operators -- so a manifest from anywhere can't do more than
 * read what it was given. CEL replaces this with the builder (D8, D43).
 */

export type Scope = Record<string, unknown>;

function formatBytes(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return String(value);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(1)} ${units[unit]}`;
}

/** Epoch seconds, in the viewer's own locale and zone. */
function formatTime(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return String(value);
  return new Date(seconds * 1000).toLocaleString();
}

const FILTERS: Record<string, (value: unknown) => unknown> = {
  bytes: formatBytes,
  time: formatTime,
  // Each path segment URL-encoded, the slashes kept: an S3 key in a URL.
  encode_path: (value) => text(value).split("/").map(encodeURIComponent).join("/"),
  json: (value) => JSON.stringify(value),
  // How many: a list's items or an object's keys ("Shadows (2)").
  count: (value) =>
    Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0,
};

export function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function missing(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** A dotted path into the scope (`row.attributes.email`). */
export function lookup(scope: Scope, path: string): unknown {
  let value: unknown = scope;
  for (const part of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function term(scope: Scope, source: string): unknown {
  const t = source.trim();
  const quoted = t.match(/^'(.*)'$|^"(.*)"$/s);
  if (quoted) return quoted[1] ?? quoted[2];
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return lookup(scope, t);
}

function fallback(scope: Scope, source: string): unknown {
  let value: unknown = undefined;
  for (const part of source.split("??")) {
    value = term(scope, part);
    if (!missing(value)) return value;
  }
  return value;
}

/** One `{{ … }}`'s value, before it is turned into text. */
export function evaluate(scope: Scope, expression: string): unknown {
  const [head, ...filters] = expression.split("|");
  let value: unknown;
  const ternary = head.match(/^(.*?)\?(?!\?)(.*):(.*)$/s);
  if (ternary && !head.includes("??")) {
    const condition = fallback(scope, ternary[1]);
    value = missing(condition) || condition === false ? fallback(scope, ternary[3]) : fallback(scope, ternary[2]);
  } else {
    value = fallback(scope, head);
  }
  for (const name of filters) {
    const filter = FILTERS[name.trim()];
    if (filter) value = filter(value);
  }
  return value;
}

/** A template with every `{{ … }}` filled in. A string with none is itself. */
export function render(template: string | undefined, scope: Scope): string {
  if (!template) return "";
  return template.replace(/\{\{(.*?)\}\}/gs, (_, expression: string) => text(evaluate(scope, expression)));
}
