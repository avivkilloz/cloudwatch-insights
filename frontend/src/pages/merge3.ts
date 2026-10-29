/**
 * A three-way merge of text by lines (D162), for a draft several people type
 * in at once (D161): what this tab typed since it last agreed with the server
 * (`ours`) laid over what someone else saved since (`theirs`), both measured
 * from that agreed copy (`base`). A change only one side made is kept; the
 * same change on both sides is kept once; two different changes to the same
 * lines are a conflict, where theirs is kept -- the server wins a true
 * conflict, as a session's merge does (mergeSession) -- and it's said so.
 *
 * Only changes to the same lines conflict (or two different insertions at
 * one place): neighbouring lines changed by two people -- a label and the
 * description under it -- are both kept. git would call that a conflict;
 * here two people are typing in one definition at once, and that's the
 * usual case, not the suspicious one.
 */

export interface Merged {
  text: string;
  /** Whether a change of ours was given up for theirs. */
  conflict: boolean;
}

/** A replacement of base[start, end) by `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

// Past this many cells the table is too big to work out in a keystroke's time:
// the merge then treats the whole text as one change.
const MAX_CELLS = 4_000_000;

function hunks(base: string[], other: string[]): Hunk[] | null {
  // Common head and tail first: most edits are a few lines in a long text.
  let head = 0;
  while (head < base.length && head < other.length && base[head] === other[head]) head++;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < other.length - head &&
    base[base.length - 1 - tail] === other[other.length - 1 - tail]
  )
    tail++;
  const a = base.slice(head, base.length - tail);
  const b = other.slice(head, other.length - tail);
  if (a.length === 0 && b.length === 0) return [];
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null;
  // The longest common subsequence's lengths, from the end.
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (open) out.push(open);
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) open = { start: head + i, end: head + i, lines: [] };
    if (j < b.length && (i >= a.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      open.lines.push(b[j]);
      j++;
    } else {
      i++;
      open.end = head + i;
    }
  }
  if (open) out.push(open);
  return out;
}

/** base[from, to) with these hunks (all inside it) applied. */
function applied(base: string[], from: number, to: number, changes: Hunk[]): string[] {
  const out: string[] = [];
  let at = from;
  for (const h of changes) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...base.slice(at, to));
  return out;
}

export function merge3(base: string, ours: string, theirs: string): Merged {
  if (ours === theirs || ours === base) return { text: theirs, conflict: false };
  if (theirs === base) return { text: ours, conflict: false };
  const b = base.split("\n");
  const mine = hunks(b, ours.split("\n"));
  const yours = hunks(b, theirs.split("\n"));
  if (mine === null || yours === null) return { text: theirs, conflict: true };

  type Tagged = Hunk & { side: "ours" | "theirs" };
  const all: Tagged[] = [
    ...mine.map((h) => ({ ...h, side: "ours" as const })),
    ...yours.map((h) => ({ ...h, side: "theirs" as const })),
  ].sort((x, y) => x.start - y.start || x.end - y.end);

  const out: string[] = [];
  let pos = 0;
  let conflict = false;
  for (let k = 0; k < all.length; ) {
    // A group: every change overlapping the first one's lines, and those
    // overlapping them -- or, for an insertion, inserting at the same place.
    const group: Tagged[] = [all[k]];
    const first = all[k];
    let end = all[k].end;
    k++;
    while (
      k < all.length &&
      (all[k].start < end || (first.start === first.end && all[k].start === first.start && all[k].end === first.start))
    ) {
      group.push(all[k]);
      end = Math.max(end, all[k].end);
      k++;
    }
    const start = group[0].start;
    out.push(...b.slice(pos, start));
    const ourPart = group.filter((h) => h.side === "ours");
    const theirPart = group.filter((h) => h.side === "theirs");
    if (theirPart.length === 0) out.push(...applied(b, start, end, ourPart));
    else if (ourPart.length === 0) out.push(...applied(b, start, end, theirPart));
    else {
      const x = applied(b, start, end, ourPart);
      const y = applied(b, start, end, theirPart);
      if (x.join("\n") !== y.join("\n")) conflict = true;
      out.push(...y);
    }
    pos = end;
  }
  out.push(...b.slice(pos));
  return { text: out.join("\n"), conflict };
}

/** Files merged one by one: a file only one side added, removed or changed
 * is theirs or ours as that side left it. */
export function mergeFiles(
  base: Record<string, string>,
  ours: Record<string, string>,
  theirs: Record<string, string>,
): { files: Record<string, string>; conflict: boolean } {
  const out: Record<string, string> = {};
  let conflict = false;
  const names = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
  for (const name of names) {
    const [b, o, t] = [base[name], ours[name], theirs[name]];
    if (o === t) {
      if (o !== undefined) out[name] = o;
    } else if (o === b) {
      if (t !== undefined) out[name] = t;
    } else if (t === b) {
      if (o !== undefined) out[name] = o;
    } else if (o === undefined || t === undefined) {
      // Removed on one side, changed on the other: theirs, and said so.
      conflict = true;
      if (t !== undefined) out[name] = t;
    } else {
      const m = merge3(b ?? "", o, t);
      conflict ||= m.conflict;
      out[name] = m.text;
    }
  }
  return { files: out, conflict };
}
