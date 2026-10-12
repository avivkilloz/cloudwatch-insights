/**
 * What an expanded row shows (PLATFORM_PLAN.md §16.3.2, §16.4.2), as its
 * list's manifest declares it: sections drawn from data rather than a panel
 * written per service, so a plugin's rows can be as rich as IoT's. Each
 * section reads from `d` -- the row itself, or for a list with a detail
 * action the detail it fetched, or for a list inside a detail the item --
 * and templates see it as `d`, the item of a nested list as `row`:
 *
 *   { warnings: warnings }                       "Could not fully load …", one line each
 *   { title: "Shadows ({{ d.shadows | count }})" } a heading, over whatever else the section has
 *   { fields: [{ label, value }] }                a two-column table of templated values
 *   { entries: attributes, empty }                an object's keys and values
 *   { list: certificates, summary, detail, open: always, gap, empty }
 *                                                 rows of their own, expandable (or always open)
 *   { table: jobs, columns: [{ label, value } | { label, tag, tone_of, tones, tone_default }], empty }
 *   { tags: thing_names, empty }                  one tag per item
 *   { grid: [{ title, json }] }                   JSON blocks side by side (reported | desired)
 *   { json: policy_document, empty }              one JSON block
 *
 * In a rich detail (a fetched one) every section but the last is spaced
 * 14px from the next, as IoT's panels were; a plain row's detail (Cognito's)
 * keeps its tables close.
 */

import { ReactNode, useState } from "react";
import { PaneApi } from "./paneApi";
import { classes, Row, SummaryPart, SummaryParts, toneOf } from "./summary";
import { lookup, render, Scope, text } from "./template";

interface Column {
  label: string;
  value?: string;
  tag?: string;
  tone?: string;
  tone_of?: string;
  tones?: Record<string, string>;
  tone_default?: string;
}

export interface Section {
  warnings?: string;
  prefix?: string;
  title?: string;
  fields?: { label: string; value: string }[];
  entries?: string;
  list?: string;
  summary?: SummaryPart[];
  detail?: Section[];
  open?: "always";
  gap?: number;
  table?: string;
  columns?: Column[];
  tags?: string;
  grid?: { title: string; json: string }[];
  json?: string;
  empty?: string;
}

const PRE = { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" } as const;

function itemsAt(d: Row, path: string | undefined): Row[] {
  const value = path ? lookup(d, path) : undefined;
  return Array.isArray(value) ? (value as Row[]) : [];
}

function Empty({ text: shown }: { text?: string }) {
  return <p className="muted">{shown ?? "Nothing."}</p>;
}

export function DetailSections({
  sections,
  d,
  pane,
  rich,
}: {
  sections: Section[];
  d: Row;
  pane: PaneApi;
  rich: boolean;
}) {
  const scope: Scope = { in: pane.inputs, out: pane.outputs, d, row: d };
  return (
    <>
      {sections.map((section, i) => {
        const space = rich && i < sections.length - 1 ? 14 : undefined;
        return <SectionView key={i} section={section} d={d} scope={scope} pane={pane} space={space} rich={rich} />;
      })}
    </>
  );
}

function SectionView({
  section,
  d,
  scope,
  pane,
  space,
  rich,
}: {
  section: Section;
  d: Row;
  scope: Scope;
  pane: PaneApi;
  space: number | undefined;
  rich: boolean;
}) {
  const parts: ReactNode[] = [];
  if (section.warnings) {
    const warnings = itemsAt(d, section.warnings);
    if (warnings.length === 0) return null;
    return (
      <div className="row" style={{ marginBottom: 10, flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        {warnings.map((w, i) => (
          <span key={i} className="error-text">
            {section.prefix ?? "Could not fully load "}
            {text(w)}
          </span>
        ))}
      </div>
    );
  }
  if (section.title) parts.push(<h3 key="t">{render(section.title, scope)}</h3>);
  if (section.fields) {
    parts.push(
      <table key="f" style={{ marginBottom: rich ? space : 10 }}>
        <tbody>
          {section.fields.map((f) => (
            <tr key={f.label}>
              <td>{f.label}</td>
              <td>{render(f.value, scope)}</td>
            </tr>
          ))}
        </tbody>
      </table>,
    );
  }
  if (section.entries) {
    const entries = Object.entries((lookup(d, section.entries) as Row | undefined) ?? {});
    parts.push(
      entries.length === 0 ? (
        <Empty key="e" text={section.empty} />
      ) : (
        <table key="e" style={space ? { marginBottom: space } : undefined}>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v === null || v === undefined ? "—" : text(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ),
    );
  }
  if (section.list) {
    const items = itemsAt(d, section.list);
    parts.push(
      items.length === 0 ? (
        <Empty key="l" text={section.empty} />
      ) : (
        <div key="l" style={space ? { marginBottom: space } : undefined}>
          {items.map((item, i) => (
            <NestedRow key={i} section={section} item={item} pane={pane} />
          ))}
        </div>
      ),
    );
  }
  if (section.table) {
    const rows = itemsAt(d, section.table);
    const columns = section.columns ?? [];
    parts.push(
      rows.length === 0 ? (
        <Empty key="tb" text={section.empty} />
      ) : (
        <table key="tb" style={space ? { marginBottom: space } : undefined}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.label}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => {
              const rowScope = { ...scope, row };
              return (
                <tr key={r}>
                  {columns.map((c) => (
                    <td key={c.label}>
                      {c.tag !== undefined ? (
                        <span className={classes("tag", toneOf(c, row))}>{render(c.tag, rowScope)}</span>
                      ) : (
                        render(c.value, rowScope)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      ),
    );
  }
  if (section.tags) {
    const tags = itemsAt(d, section.tags);
    parts.push(
      tags.length === 0 ? (
        <Empty key="tg" text={section.empty} />
      ) : (
        <div key="tg" className="row" style={{ marginBottom: space, flexWrap: "wrap" }}>
          {tags.map((t, i) => (
            <span key={i} className="tag">
              {text(t)}
            </span>
          ))}
        </div>
      ),
    );
  }
  if (section.grid) {
    parts.push(
      <div key="g" className="grid-2">
        {section.grid.map((cell) => (
          <div key={cell.title}>
            <h3>{cell.title}</h3>
            <pre style={PRE}>{JSON.stringify(lookup(d, cell.json), null, 2)}</pre>
          </div>
        ))}
      </div>,
    );
  }
  if (section.json) {
    const value = lookup(d, section.json);
    parts.push(
      value === undefined || value === null ? (
        <Empty key="j" text={section.empty} />
      ) : (
        <pre key="j" style={PRE}>
          {JSON.stringify(value, null, 2)}
        </pre>
      ),
    );
  }
  return <>{parts}</>;
}

/** One row of a list inside a detail: its own summary, and its own detail
 * either always shown or opened by clicking (in this tab only -- a nested
 * row isn't a row of the pane's results, so it isn't a view key). */
function NestedRow({ section, item, pane }: { section: Section; item: Row; pane: PaneApi }) {
  const always = section.open === "always";
  const [open, setOpen] = useState(false);
  const shown = always || open;
  return (
    <div className="result-row" style={{ marginBottom: section.gap ?? 8 }}>
      <div
        className="result-row-summary"
        style={always ? { cursor: "default" } : undefined}
        onClick={always ? undefined : () => setOpen((v) => !v)}
      >
        {!always && <span className={`chevron ${open ? "open" : ""}`}>▶</span>}
        <SummaryParts parts={section.summary ?? []} row={item} scope={{ in: pane.inputs, row: item, d: item }} pane={pane} />
      </div>
      {shown && section.detail && (
        <div className="result-row-detail">
          <DetailSections sections={section.detail} d={item} pane={pane} rich={false} />
        </div>
      )}
    </div>
  );
}
