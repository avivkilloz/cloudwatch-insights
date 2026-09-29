/**
 * Keeping the open sessions in step with the server -- both ways.
 *
 * This browser pushes whatever in its workspace the server hasn't been told
 * about. It used to be the only writer, so last-write-wins was enough. It no
 * longer is: another tab, another machine and the platform agent can all
 * change a session on the server. So every push says which server version it
 * was made from; the server refuses a push made from an older one (409), and
 * this side fetches what is there, merges (`mergeSession`) and pushes again.
 * Changes that arrive without a conflict -- announced on the event stream
 * (./liveEvents) -- go through the same merge via `receive`.
 *
 * Two things it deliberately does not sync: which session is active, and which
 * view is showing. Those are "what is this browser looking at", not work worth
 * carrying to another machine.
 */

import { ApiError, LiveSession, api } from "../api";
import { PersistedSession, capSession, decode, encode } from "./storage";

/** How long to let changes settle before writing to the server. Longer than
 * the IndexedDB debounce: a local write is free, a request is not, and the
 * local copy is already safe by the time this fires. */
export const SYNC_DEBOUNCE_MS = 1200;

/** A session as the server wants it, and the fingerprint used to tell whether
 * it has changed since the last push. Comparing the encoded form rather than
 * object identity means a page that rewrites a key with an equal value doesn't
 * cost a request. */
/** What a session's save sends, minus its position: order is the reorder
 * endpoint's alone (a save only places a session when it creates one), so a
 * session that merely moved has nothing new to save. */
function fingerprint(session: PersistedSession): string {
  return encode({ t: session.type, n: session.title, c: session.categoryId ?? null, s: session.state });
}

/** Sets and Maps have to survive the trip, and the server only stores JSON.
 * encode() tags them; parsing the tagged text back gives a plain object that
 * is still JSON, which is what goes in the request body. */
function toWire(session: PersistedSession, position: number) {
  const capped = capSession(session);
  return {
    type: capped.type,
    title: capped.title,
    position,
    category_id: capped.categoryId ?? null,
    state: JSON.parse(encode(capped.state)) as Record<string, unknown>,
    truncated: capped.truncated ?? false,
  };
}

/** And back: re-tagging the server's plain JSON rebuilds the Sets and Maps the
 * pages expect. */
export function fromWire(row: LiveSession): PersistedSession {
  return {
    id: row.client_id,
    type: row.type,
    title: row.title,
    categoryId: row.category_id,
    state: decode<Record<string, unknown>>(JSON.stringify(row.state)),
    truncated: row.truncated,
    role: row.role,
  };
}

/** A key's value, or its absence, as comparable text. */
const ABSENT = "\u0000absent";
function printOf(value: unknown): string {
  return value === undefined ? ABSENT : encode(value);
}

// Must match agent/AgentContext.tsx's own SESSION_CHAT_KEY -- duplicated
// rather than imported, since that module sits above this one (it imports
// from ../sessions/SessionContext, which imports this file; the reverse
// import would cycle).
const SESSION_CHAT_KEY = "agentChat";

/** Whether `session` differs from `base` (the last server copy this browser
 * agreed with) only in its chat log, if at all -- title, category and every
 * other state key besides `agentChat` all have to match exactly. A viewer
 * can't change any of those (there's no UI path that lets one try), but
 * chatting isn't editing the session's own content, so a change confined to
 * just the chat log is the one thing a viewer's browser may still push (see
 * `pushOne`, and the identical carve-out `upsert_live_session` enforces
 * server-side, independently of this check). No `base` at all (a session
 * this browser has never synced) means there's nothing to compare against,
 * so it isn't treated as chat-only. */
function chatOnlyChange(base: PersistedSession | undefined, session: PersistedSession): boolean {
  if (!base) return false;
  if (base.type !== session.type || base.title !== session.title || base.categoryId !== session.categoryId) {
    return false;
  }
  const baseState = base.state ?? {};
  const state = session.state ?? {};
  for (const key of new Set([...Object.keys(baseState), ...Object.keys(state)])) {
    if (key === SESSION_CHAT_KEY) continue;
    if (printOf(baseState[key]) !== printOf(state[key])) return false;
  }
  return true;
}

/** Every other key is "whichever side changed it wins" (see `pick` above),
 * fine for a value someone edits in place. A chat log is different: it's an
 * append-only list several people can add to at once, so the ordinary merge
 * would let one person's own new message silently overwrite another's sent
 * in the same debounce window, rather than keeping both. This unions by
 * turn id instead -- remote's own turns, plus whatever this side added that
 * base didn't already have -- so no message either side sent is lost. */
function mergeChatTurns(base: unknown, local: unknown, remote: unknown): unknown {
  const asTurns = (v: unknown): { id: string }[] => (Array.isArray(v) ? (v as { id: string }[]) : []);
  const baseIds = new Set(asTurns(base).map((t) => t.id));
  const remoteTurns = asTurns(remote);
  const remoteIds = new Set(remoteTurns.map((t) => t.id));
  const addedHere = asTurns(local).filter((t) => !baseIds.has(t.id) && !remoteIds.has(t.id));
  // Turn ids are "t<base36 time><base36 counter>": lexicographic order
  // matches send order closely enough for a chat transcript.
  return [...remoteTurns, ...addedHere].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Folds a change the server has into this browser's copy of a session.
 *
 * Three-way, per state key (keys are "<paneId>.<key>", so this is per input
 * of each pane) against `base` -- the server's copy this browser last agreed
 * with: a key only this side changed keeps this side's value, one only the
 * server changed takes the server's, and one both changed takes the
 * server's. That last rule is the deliberate choice: the other writer is,
 * as often as not, the platform agent doing what it was just asked to, and
 * a stale tab silently undoing that is worse than a half-typed edit being
 * replaced. Values that come out equal keep this side's object, so a pane
 * reading it doesn't see a "change" and re-render for nothing.
 */
export function mergeSession(
  base: PersistedSession | undefined,
  local: PersistedSession | undefined,
  remote: PersistedSession,
): PersistedSession {
  if (!local) return remote;
  const pick = <T,>(b: T, l: T, r: T): T => {
    const lp = printOf(l);
    const rp = printOf(r);
    if (lp === rp) return l;
    const bp = printOf(b);
    return lp === bp ? r : rp === bp ? l : r;
  };
  const baseState = base?.state ?? {};
  const state: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(local.state), ...Object.keys(remote.state)])) {
    const value =
      key === SESSION_CHAT_KEY
        ? mergeChatTurns(baseState[key], local.state[key], remote.state[key])
        : pick(baseState[key], local.state[key], remote.state[key]);
    if (value !== undefined) state[key] = value;
  }
  return {
    ...remote,
    title: pick<string | undefined>(base?.title, local.title, remote.title) ?? remote.title,
    categoryId: pick(base?.categoryId, local.categoryId, remote.categoryId),
    state,
  };
}

/**
 * Tracks what the server has been told, so each flush sends only what changed.
 *
 * Deliberately not a React hook: it is mutable bookkeeping with no bearing on
 * what is rendered, and making it state would re-render the whole workspace
 * every time a request came back.
 */
export class WorkspaceSync {
  /** client_id -> the fingerprint last accepted by the server. */
  private synced = new Map<string, string>();
  /** client_id -> the server version this browser's copy is based on. */
  private versions = new Map<string, number>();
  /** client_id -> the server's copy at that version: the merge's base. */
  private bases = new Map<string, PersistedSession>();
  private order: string[] = [];
  private inFlight: Promise<void> = Promise.resolve();

  /** Set by the provider: applies a session the server has moved on to,
   * merged against `base`, to the workspace. The next flush then pushes the
   * merge, from the new version. */
  onRemote: ((remote: PersistedSession, base: PersistedSession | undefined) => void) | null = null;

  /** Called with what the server already had, so the first flush after a load
   * doesn't re-send every restored session unchanged. */
  adopt(rows: LiveSession[]): void {
    this.synced.clear();
    this.versions.clear();
    this.bases.clear();
    rows.forEach((row) => this.remember(row, fromWire(row)));
    this.order = rows.map((row) => row.client_id);
  }

  forget(clientId: string): void {
    this.synced.delete(clientId);
    this.versions.delete(clientId);
    this.bases.delete(clientId);
    this.order = this.order.filter((id) => id !== clientId);
  }

  /** The server version this browser has seen for a session, if any. */
  versionOf(clientId: string): number | undefined {
    return this.versions.get(clientId);
  }

  /** A newer copy of a session from the server -- announced on the event
   * stream, or fetched after a 409. Ignored when it isn't newer than what
   * this browser already has. `migrate` is the same load-time migration the
   * workspace gets, so a row written by an older writer arrives in today's
   * shape. */
  receive(row: LiveSession, migrate: (s: PersistedSession) => PersistedSession = (s) => s): void {
    const known = this.versions.get(row.client_id);
    if (known !== undefined && known >= row.version) return;
    const remote = migrate(fromWire(row));
    const base = this.bases.get(row.client_id);
    this.remember(row, remote);
    this.onRemote?.(remote, base);
  }

  /** The order the server now has, from a reorder made somewhere else: this
   * browser follows it, and mustn't push its own old order back. */
  adoptOrder(ids: string[]): void {
    this.order = ids;
  }

  private remember(row: LiveSession, session: PersistedSession): void {
    this.synced.set(row.client_id, fingerprint(session));
    this.versions.set(row.client_id, row.version);
    this.bases.set(row.client_id, session);
  }

  /**
   * Pushes everything that has changed since the last flush.
   *
   * Requests are chained rather than fired in parallel: two flushes overlapping
   * on the same session would race, and the loser would leave the server
   * holding older state than the fingerprint claims. Failures leave the
   * fingerprint unset, so the next flush tries that session again -- which is
   * what makes an offline spell catch up by itself rather than lose the work.
   */
  flush(sessions: PersistedSession[]): Promise<void> {
    return this.enqueue(() => this.push(sessions));
  }

  /**
   * Runs something after whatever this is already doing.
   *
   * Closing and deleting go through here rather than straight to the API. A
   * flush can be in flight when you close a session, and a PUT that lands after
   * the close clears `closed_at` again -- the session reopens itself. Ordering
   * them on one chain is what stops that.
   */
  enqueue(task: () => Promise<unknown>): Promise<void> {
    this.inFlight = this.inFlight.then(task).then(
      () => undefined,
      () => undefined,
    );
    return this.inFlight;
  }

  /**
   * Closes a session on the server, first sending whatever the server hasn't
   * seen of it yet. Closing takes the session out of the workspace at once,
   * so the debounced flush that would have carried its last changes never
   * sees it again: without this, anything done in the second or so before
   * the ✕ was lost, and a session closed before its first save came back
   * from the server empty when reopened. `session` is its state at the ✕;
   * undefined when there's nothing local to send.
   */
  close(clientId: string, session: PersistedSession | undefined, position: number): Promise<void> {
    return this.enqueue(async () => {
      if (session) await this.pushOne(session, position);
      // After the push, not before: forgetting first would let the push
      // record a fingerprint for a session that is no longer open.
      this.forget(clientId);
      await api.closeLiveSession(clientId);
    });
  }

  /** Sends one session if it changed since the server last accepted it. False
   * when the request failed and the session is still unsynced. */
  private async pushOne(session: PersistedSession, index: number): Promise<boolean> {
    // A viewer's own edits to the session itself (if the UI let any happen)
    // have nowhere to go -- the server refuses those outright (403) -- and
    // without this, the mere act of *receiving* someone else's live change
    // here would otherwise queue a save right back, failing on every flush
    // for as long as the session stays open. Chatting is the one exception:
    // it isn't editing the session's content, so a change confined to just
    // the chat log still goes out (`chatOnlyChange`) -- without this, a
    // viewer's own chat messages (and the agent's replies to them) never
    // left their browser at all, invisible to everyone else on the session.
    if (session.role === "viewer" && !chatOnlyChange(this.bases.get(session.id), session)) return true;
    const print = fingerprint(session);
    if (this.synced.get(session.id) === print) return true;
    try {
      const saved = await api.putLiveSession(session.id, {
        ...toWire(session, index),
        base_version: this.versions.get(session.id),
      });
      this.synced.set(session.id, print);
      this.versions.set(session.id, saved.version);
      this.bases.set(session.id, session);
      return true;
    } catch (err) {
      // Someone else wrote first. Fetch theirs and merge; the merged session
      // lands in the workspace, and the flush that follows pushes it from
      // the version it was merged against. Nothing is dropped on the way.
      if (err instanceof ApiError && err.status === 409) {
        try {
          this.receive(await api.getLiveSession(session.id));
        } catch {
          return false;
        }
        return true;
      }
      // The one failure worth handling rather than retrying: the state is
      // past the server's ceiling even after capSession trimmed it. Send the
      // session without any state at all, so its title and position are
      // still there to come back to, flagged so the page says so.
      if (err instanceof ApiError && err.status === 413) {
        await api.putLiveSession(session.id, {
          type: session.type,
          title: session.title,
          position: index,
          category_id: session.categoryId ?? null,
          state: {},
          truncated: true,
          base_version: this.versions.get(session.id),
        }).then((saved) => this.versions.set(session.id, saved.version));
        this.synced.set(session.id, print);
        return true;
      }
      return false;
    }
  }

  private async push(sessions: PersistedSession[]): Promise<void> {
    for (const [index, session] of sessions.entries()) {
      // Anything but a 413 -- offline, a restart, a 500 -- leaves this
      // session unsynced and stops the run. The next flush picks up where
      // this left off; nothing local is lost either way.
      if (!(await this.pushOne(session, index))) return;
    }

    // Ordering last, and only when it actually differs: dragging a session
    // changes every position after it, and a PUT per row for a move of one
    // would be silly.
    const ids = sessions.map((s) => s.id);
    if (ids.length === this.order.length && ids.every((id, i) => this.order[i] === id)) return;
    try {
      await api.reorderLiveSessions(ids);
      this.order = ids;
    } catch {
      // Same as above: retried on the next flush.
    }
  }
}
