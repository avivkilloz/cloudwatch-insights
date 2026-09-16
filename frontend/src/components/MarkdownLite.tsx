import { Fragment, ReactNode } from "react";

/**
 * Minimal Markdown renderer for AI chat replies: fenced code blocks, GFM
 * pipe tables, headings, lists, and inline bold/italic/code. Not a general
 * Markdown engine -- just enough to render what the AI assistant sends back.
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

function renderBlock(block: string, key: string): ReactNode {
  const lines = block.split("\n");

  if (lines.length >= 2 && lines[0].includes("|") && TABLE_SEPARATOR_RE.test(lines[1].trim())) {
    return renderTable(lines, key);
  }

  const headingMatch = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
  if (headingMatch && lines.length === 1) {
    return (
      <div key={key} style={{ fontWeight: 600, margin: "8px 0 4px" }}>
        {renderInline(headingMatch[2], key)}
      </div>
    );
  }

  const isBulletList = lines.every((l) => /^\s*[-*+]\s+/.test(l));
  const isOrderedList = lines.every((l) => /^\s*\d+\.\s+/.test(l));
  if (isBulletList || isOrderedList) {
    const ListTag = isOrderedList ? "ol" : "ul";
    return (
      <ListTag key={key} style={{ margin: "4px 0", paddingLeft: 20 }}>
        {lines.map((l, i) => (
          <li key={i} style={{ fontSize: 13 }}>
            {renderInline(l.replace(/^\s*([-*+]|\d+\.)\s+/, ""), `${key}-${i}`)}
          </li>
        ))}
      </ListTag>
    );
  }

  return (
    <p key={key} style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>
      {renderInline(lines.join("\n"), key)}
    </p>
  );
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
