/**
 * Edits to a definition's YAML that change only what they touch (5-2d, D115).
 *
 * The form editor works on the very text the YAML editor shows. Re-printing
 * the whole document after each change (the `yaml` package's own toString)
 * re-folded every long description and re-spaced every flow mapping -- a
 * changed label became a diff of a hundred lines, in the editor and in the
 * store repo's history. So each edit here is a splice: the `yaml` package
 * parses the text (its nodes know where they start and end), the change is
 * written in place of the one node, key or list item it is about, and every
 * other byte -- comments, wrapping, quoting -- is left as it was.
 */

import { Document, isMap, isScalar, isSeq, Node, Pair, parseDocument, stringify, YAMLMap, YAMLSeq } from "yaml";

export type Path = (string | number)[];
export type Doc = Document.Parsed;

/** The text, parsed; `errors` says why the form can't edit it. */
export function parse(source: string): { doc: Doc; errors: string[] } {
  const doc = parseDocument(source, { keepSourceTokens: false });
  return { doc, errors: doc.errors.map((e) => e.message) };
}

/** A plain JS value at `path`, or undefined. */
export function read(doc: Doc, path: Path): unknown {
  const node = doc.getIn(path, true) as Node | undefined;
  if (node === undefined || node === null) return undefined;
  return isScalar(node) ? node.value : (node as Node).toJSON();
}

/** How many items the list at `path` has (0 when it isn't there). */
export function count(doc: Doc, path: Path): number {
  const node = doc.getIn(path, true);
  return isSeq(node) ? node.items.length : 0;
}

function lineStart(src: string, pos: number): number {
  return src.lastIndexOf("\n", pos - 1) + 1;
}

/** Just past the end of the line `pos` is on, its newline included. */
function lineEnd(src: string, pos: number): number {
  const i = src.indexOf("\n", pos);
  return i < 0 ? src.length : i + 1;
}

function column(src: string, pos: number): number {
  return pos - lineStart(src, pos);
}

function indent(text: string, by: number): string {
  const pad = " ".repeat(by);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

/** A scalar as it goes after "key: " -- plain where YAML allows it, quoted
 * where it wouldn't read back the same; never a block. */
function scalarText(value: unknown): string {
  if (typeof value === "string" && value.includes("\n")) return JSON.stringify(value);
  const text = stringify(value, { lineWidth: 0 }).trimEnd();
  return text.includes("\n") ? JSON.stringify(value) : text;
}

/** `key: value` as block YAML at column 0 (a collection on the lines under it). */
function pairText(key: string, value: unknown): string {
  return stringify({ [key]: value }, { lineWidth: 120 }).trimEnd() + "\n";
}

/** Where a node's own text ends -- after its last line. */
function nodeEnd(node: Node): number {
  const r = node.range as [number, number, number];
  return r[1];
}

function pairOf(doc: Doc, path: Path): { map: YAMLMap; pair: Pair<Node, Node> } | null {
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) return null;
  const key = path[path.length - 1];
  const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<Node, Node> | undefined;
  return pair ? { map: parent, pair } : null;
}

/** The text with `path` set to `value`. A scalar replaces a scalar in place;
 * anything else replaces the key's whole `key: value` lines; a key not there
 * yet is added at the end of its mapping, at that mapping's indent. */
export function setIn(source: string, path: Path, value: unknown): string {
  if (value === undefined) return deleteIn(source, path);
  const { doc } = parse(source);
  const found = pairOf(doc, path);
  if (found) {
    const { pair } = found;
    const isScalarValue = value === null || ["string", "number", "boolean"].includes(typeof value);
    if (isScalarValue && pair.value && isScalar(pair.value) && pair.value.range) {
      const [start, end] = pair.value.range;
      return source.slice(0, start) + scalarText(value) + source.slice(end);
    }
    const keyNode = pair.key as Node;
    const start = lineStart(source, keyNode.range![0]);
    const end = lineEnd(source, Math.max(keyNode.range![1], pair.value ? nodeEnd(pair.value) - 1 : 0));
    const col = column(source, keyNode.range![0]);
    return source.slice(0, start) + indent(pairText(String(path[path.length - 1]), value), col) + source.slice(end);
  }
  return addPair(source, doc, path, value);
}

function addPair(source: string, doc: Doc, path: Path, value: unknown): string {
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  const key = String(path[path.length - 1]);
  if (isMap(parent) && parent.items.length > 0 && !parent.flow) {
    const last = parent.items[parent.items.length - 1] as Pair<Node, Node>;
    const col = column(source, (parent.items[0].key as Node).range![0]);
    const after = lineEnd(source, Math.max((last.key as Node).range![1], last.value ? nodeEnd(last.value) - 1 : 0));
    const tail = after === source.length && !source.endsWith("\n") ? "\n" : "";
    return source.slice(0, after) + tail + indent(pairText(key, value), col) + source.slice(after);
  }
  if (parentPath.length === 0) {
    const sep = source.length && !source.endsWith("\n") ? "\n" : "";
    return source + sep + pairText(key, value);
  }
  // A mapping that's empty or written inline: written out again, with the key.
  const whole = (read(doc, parentPath) as Record<string, unknown>) ?? {};
  return setIn(source, parentPath, { ...whole, [key]: value });
}

/** The text without the key at `path`, or without the list item at it. */
export function deleteIn(source: string, path: Path): string {
  const { doc } = parse(source);
  const last = path[path.length - 1];
  if (typeof last === "number") {
    const seq = doc.getIn(path.slice(0, -1), true);
    if (!isSeq(seq) || seq.flow) return source;
    const [start, end] = itemSpan(source, seq, last);
    return source.slice(0, start) + source.slice(end);
  }
  const found = pairOf(doc, path);
  if (!found) return source;
  const keyNode = found.pair.key as Node;
  const start = lineStart(source, keyNode.range![0]);
  const end = lineEnd(source, Math.max(keyNode.range![1], found.pair.value ? nodeEnd(found.pair.value) - 1 : 0));
  return source.slice(0, start) + source.slice(end);
}

/** An item's whole lines in a block list: from its "- " line to the next
 * item's (or past its own last line). */
function itemSpan(source: string, seq: YAMLSeq, index: number): [number, number] {
  const item = seq.items[index] as Node;
  const start = lineStart(source, item.range![0]);
  const next = seq.items[index + 1] as Node | undefined;
  const end = next ? lineStart(source, next.range![0]) : lineEnd(source, nodeEnd(item) - 1);
  return [start, end];
}

/** The text with `value` added at the end of the list at `path` (made, if
 * there's none). */
export function append(source: string, path: Path, value: unknown): string {
  const { doc } = parse(source);
  const seq = doc.getIn(path, true);
  if (!isSeq(seq) || seq.items.length === 0 || seq.flow) {
    const current = isSeq(seq) ? (seq.toJSON() as unknown[]) : [];
    return setIn(source, path, [...current, value]);
  }
  const lastItem = seq.items[seq.items.length - 1] as Node;
  const dash = lineStart(source, lastItem.range![0]);
  const col = source.slice(dash).search(/\S/);
  const after = lineEnd(source, nodeEnd(lastItem) - 1);
  const item = stringify([value], { lineWidth: 120 });
  const tail = after === source.length && !source.endsWith("\n") ? "\n" : "";
  return source.slice(0, after) + tail + indent(item, col) + source.slice(after);
}

/** The text with the list items at `path` `from` and `to` swapped, each
 * keeping its own lines and comments. */
export function swap(source: string, path: Path, from: number, to: number): string {
  if (from === to) return source;
  const { doc } = parse(source);
  const seq = doc.getIn(path, true);
  if (!isSeq(seq) || seq.flow || to < 0 || to >= seq.items.length) return source;
  const [a, b] = from < to ? [from, to] : [to, from];
  const [aStart, aEnd] = itemSpan(source, seq, a);
  const [bStart, bEnd] = itemSpan(source, seq, b);
  let first = source.slice(aStart, aEnd);
  let second = source.slice(bStart, bEnd);
  // The last item may lack a trailing newline; the swapped text needs one between.
  if (!second.endsWith("\n")) {
    second += "\n";
    first = first.replace(/\n$/, "");
  }
  return source.slice(0, aStart) + second + source.slice(aEnd, bStart) + first + source.slice(bEnd);
}
