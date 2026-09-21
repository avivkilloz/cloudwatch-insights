/**
 * Keeping the open sessions in step with the server.
 *
 * The rule here is that the browser owns the workspace and the server stores
 * it. Nothing in this file decides what a session contains or when one opens;
 * it takes whatever the workspace currently is, works out which sessions the
 * server has not been told about, and tells it -- last write wins, per session.
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
function fingerprint(session: PersistedSession, position: number): string {
  return encode({ t: session.type, n: session.title, p: position, s: session.state });
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
    state: decode<Record<string, unknown>>(JSON.stringify(row.state)),
    truncated: row.truncated,
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
  private order: string[] = [];
  private inFlight: Promise<void> = Promise.resolve();

  /** Called with what the server already had, so the first flush after a load
   * doesn't re-send every restored session unchanged. */
  adopt(rows: LiveSession[]): void {
    this.synced.clear();
    rows.forEach((row, index) => this.synced.set(row.client_id, fingerprint(fromWire(row), index)));
    this.order = rows.map((row) => row.client_id);
  }

  forget(clientId: string): void {
    this.synced.delete(clientId);
    this.order = this.order.filter((id) => id !== clientId);
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
    this.inFlight = this.inFlight.then(() => this.push(sessions)).catch(() => undefined);
    return this.inFlight;
  }

  private async push(sessions: PersistedSession[]): Promise<void> {
    for (const [index, session] of sessions.entries()) {
      const print = fingerprint(session, index);
      if (this.synced.get(session.id) === print) continue;
      try {
        await api.putLiveSession(session.id, toWire(session, index));
        this.synced.set(session.id, print);
      } catch (err) {
        // The one failure worth handling rather than retrying: the state is
        // past the server's ceiling even after capSession trimmed it. Send the
        // session without any state at all, so its title and position are
        // still there to come back to, flagged so the page says so.
        if (err instanceof ApiError && err.status === 413) {
          await api.putLiveSession(session.id, {
            type: session.type,
            title: session.title,
            position: index,
            state: {},
            truncated: true,
          });
          this.synced.set(session.id, print);
          continue;
        }
        // Anything else -- offline, a restart, a 500 -- leaves this session
        // unsynced and stops the run. The next flush picks up where this left
        // off; nothing local is lost either way.
        return;
      }
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
