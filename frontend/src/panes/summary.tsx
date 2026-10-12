/**
 * A list row's summary line, drawn from a manifest's `summary` parts: shared
 * by a list output's rows (ListView) and by the lists inside a row's detail
 * (DetailSections: a thing's certificates, a certificate's policies).
 *
 *   { tag: "{{ row.status }}", tone_of: status, tones: { CONFIRMED: ok }, tone_default: pending }
 *   { tag: disabled, tone: error, when: { field: enabled, equals: false } }
 *   { msg: "{{ row.username }}" }       { muted: "{{ row.attributes.email }}" }
 *   { keys: [out.tableInfo.partition_key, …], separator: " / " }  (DynamoDB)
 *   { copy: "s3://{{ in.bucket }}/{{ row.key }}", label: Copy S3 URI, message: S3 URI }
 */

import { PaneApi } from "./paneApi";
import { lookup, render, Scope, text } from "./template";

export type Row = Record<string, unknown>;

export interface RowWhen {
  field: string;
  equals?: unknown;
  present?: boolean;
}

export interface SummaryPart {
  tag?: string;
  tone?: string;
  tone_of?: string;
  tones?: Record<string, string>;
  /** The tone of a value `tones` doesn't name (a job still running: pending). */
  tone_default?: string;
  msg?: string;
  muted?: string;
  keys?: string[];
  separator?: string;
  copy?: string;
  label?: string;
  message?: string;
  when?: RowWhen;
}

export function rowShows(when: RowWhen | undefined, row: Row): boolean {
  if (!when) return true;
  const value = lookup(row, when.field);
  if (when.equals !== undefined) return value === when.equals;
  const present = value !== undefined && value !== null && value !== "";
  return present === (when.present ?? true);
}

export function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** A tag's tone: fixed, or by one of the row's fields. */
export function toneOf(part: { tone?: string; tone_of?: string; tones?: Record<string, string>; tone_default?: string }, row: Row) {
  if (part.tone) return part.tone;
  if (!part.tone_of) return undefined;
  return part.tones?.[text(lookup(row, part.tone_of))] ?? part.tone_default;
}

/** DynamoDB's summary: the row's values at the table's key fields, joined;
 * else its first field; else "(empty item)". */
function keySummary(part: SummaryPart, row: Row, scope: Scope): string {
  const values: string[] = [];
  for (const path of part.keys ?? []) {
    const field = lookup(scope, path);
    if (typeof field === "string" && field && row[field] !== undefined) values.push(String(row[field]));
  }
  if (values.length > 0) return values.join(part.separator ?? " / ");
  const first = Object.keys(row)[0];
  return first ? `${first}: ${String(row[first])}` : "(empty item)";
}

export function SummaryParts({ parts, row, scope, pane }: { parts: SummaryPart[]; row: Row; scope: Scope; pane: PaneApi }) {
  return (
    <>
      {parts.map((part, i) => {
        if (!rowShows(part.when, row)) return null;
        if (part.tag !== undefined) {
          return (
            <span key={i} className={classes("tag", toneOf(part, row))}>
              {render(part.tag, scope)}
            </span>
          );
        }
        if (part.msg !== undefined) {
          return (
            <span key={i} className="msg">
              {render(part.msg, scope)}
            </span>
          );
        }
        if (part.keys) {
          return (
            <span key={i} className="msg">
              {keySummary(part, row, scope)}
            </span>
          );
        }
        if (part.muted !== undefined) {
          return (
            <span key={i} className="muted">
              {render(part.muted, scope)}
            </span>
          );
        }
        if (part.copy !== undefined) {
          const value = render(part.copy, scope);
          const label = part.message ?? part.label ?? "Value";
          return (
            <button
              key={i}
              className="secondary"
              style={{ padding: "2px 8px" }}
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await navigator.clipboard.writeText(value);
                  pane.flash(`${label} copied to clipboard`);
                } catch {
                  pane.flash(`Could not copy automatically — ${label}: ${value}`);
                }
              }}
            >
              {part.label ?? "Copy"}
            </button>
          );
        }
        return null;
      })}
    </>
  );
}
