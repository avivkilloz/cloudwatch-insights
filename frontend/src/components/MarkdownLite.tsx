import { Fragment, ReactNode } from "react";

/**
 * Minimal Markdown renderer for AI chat replies: fenced code blocks, GFM
 * pipe tables, headings, lists, and inline bold/italic/code. Not a general
 * Markdown engine -- just enough to render what the agent sends back.
 */
export default function MarkdownLite({ text }: { text: string }) {
  return <>{parseBlocks(text)}</>;
}

const CODE_BLOCK_RE = /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g;
const TABLE_SEPARATOR_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/;

function parseBlocks(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  CODE_BLOCK_RE.lastIndex = 0;
  while ((match = CODE_BLOCK_RE.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...parseTextBlocks(text.slice(lastIndex, match.index), key));
      key += 100;
    }
    nodes.push(
      <pre
        key={`code-${key++}`}
        style={{
          margin: "6px 0",
          background: "var(--panel-alt)",
          padding: 8,
          borderRadius: 6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 12,
        }}
      >
        {match[1].replace(/\n$/, "")}
      </pre>,
    );
    lastIndex = CODE_BLOCK_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(...parseTextBlocks(text.slice(lastIndex), key));
  }
  return nodes;
}

function parseTextBlocks(text: string, keyBase: number): ReactNode[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, i) => renderBlock(block, `${keyBase}-${i}`));
}

const BULLET_RE = /^\s*[-*+]\s+/;
const ORDERED_RE = /^\s*\d+\.\s+/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Scans a block's lines for headings, tables and lists wherever they start,
 * rather than requiring the whole block to be one shape -- the model doesn't
 * reliably put a blank line before a heading or table, and a block that
 * mixes prose with one (a common shape: "Here's what I found:\n| Name |...")
 * used to fall through to one plain paragraph, "###" and all, because only
 * `lines[0]`/`lines.length === 1` were ever checked. */
function renderBlock(block: string, key: string): ReactNode {
  const lines = block.split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let n = 0;

  const isTableStart = (idx: number): boolean =>
    lines[idx].includes("|") && idx + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[idx + 1].trim());

  while (i < lines.length) {
    const headingMatch = HEADING_RE.exec(lines[i]);
    if (headingMatch) {
      nodes.push(
        <div key={`${key}-${n}`} style={{ fontWeight: 600, margin: "8px 0 4px" }}>
          {renderInline(headingMatch[2], `${key}-${n++}`)}
        </div>,
      );
      i++;
      continue;
    }

    if (isTableStart(i)) {
      let end = i + 2;
      while (end < lines.length && lines[end].trim() !== "" && lines[end].includes("|")) end++;
      nodes.push(renderTable(lines.slice(i, end), `${key}-${n++}`));
      i = end;
      continue;
    }

    if (BULLET_RE.test(lines[i]) || ORDERED_RE.test(lines[i])) {
      const ordered = ORDERED_RE.test(lines[i]);
      const test = ordered ? ORDERED_RE : BULLET_RE;
      let end = i;
      while (end < lines.length && test.test(lines[end])) end++;
      const items = lines.slice(i, end);
      const ListTag = ordered ? "ol" : "ul";
      nodes.push(
        <ListTag key={`${key}-${n}`} style={{ margin: "4px 0", paddingLeft: 20 }}>
          {items.map((l, li) => (
            <li key={li} style={{ fontSize: 13 }}>
              {renderInline(l.replace(/^\s*([-*+]|\d+\.)\s+/, ""), `${key}-${n}-${li}`)}
            </li>
          ))}
        </ListTag>,
      );
      n++;
      i = end;
      continue;
    }

    // Plain text: a run of lines that don't start a heading, table or list.
    let end = i + 1;
    while (end < lines.length && !HEADING_RE.test(lines[end]) && !isTableStart(end) && !BULLET_RE.test(lines[end]) && !ORDERED_RE.test(lines[end])) {
      end++;
    }
    nodes.push(
      <p key={`${key}-${n}`} style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>
        {renderInline(lines.slice(i, end).join("\n"), `${key}-${n++}`)}
      </p>,
    );
    i = end;
  }

  return <Fragment key={key}>{nodes}</Fragment>;
}

function renderTable(lines: string[], key: string): ReactNode {
  const header = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return (
    <div key={key} style={{ overflowX: "auto", margin: "6px 0" }}>
      <table style={{ fontSize: 12 }}>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}>{renderInline(cell, `${key}-h${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{renderInline(cell, `${key}-r${ri}-${ci}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = regex.exec(text))) {
    if (m.index > lastIndex) parts.push(<Fragment key={`${keyPrefix}-t${i}`}>{text.slice(lastIndex, m.index)}</Fragment>);
    if (m[1] !== undefined) {
      parts.push(<strong key={`${keyPrefix}-b${i}`}>{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      parts.push(
        <code
          key={`${keyPrefix}-c${i}`}
          style={{ background: "var(--panel-alt)", padding: "1px 4px", borderRadius: 4, fontSize: "0.92em" }}
        >
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined) {
      parts.push(<em key={`${keyPrefix}-i${i}`}>{m[3]}</em>);
    }
    lastIndex = regex.lastIndex;
    i++;
  }
  if (lastIndex < text.length) parts.push(<Fragment key={`${keyPrefix}-t${i}`}>{text.slice(lastIndex)}</Fragment>);
  return parts;
}
