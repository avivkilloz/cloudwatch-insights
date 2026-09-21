/**
 * Where an open session's live state lives between page loads.
 *
 * Saved sessions (the named ones under Saved items) stay in Postgres and hold
 * only a page's *inputs* -- they're templates you start from. Open sessions
 * are the opposite: everything, including the rows currently on screen and the
 * assistant conversation about them, so a refresh puts you back exactly where
 * you were.
 *
 * Those now live in Postgres too (see ./sync and the live-sessions router), so
 * they follow you to another browser. IndexedDB stays in front of it as the
 * local copy: it is there on the first paint, before any request has come
 * back, and it is what you keep working against when the network isn't there.
 * Which session is *active* is deliberately local-only -- that's which tab
 * this browser is looking at, not something to follow you to another machine.
 */

const DB_NAME = "cloud-insights-sessions";
const DB_VERSION = 1;
const STORE = "workspaces";

/** Per-session cap on persisted state. A Logs query can return thousands of
 * rows; past this we keep the session's inputs and drop its results rather
 * than writing tens of megabytes on every change. The session says so when it
 * comes back, instead of quietly looking like an empty result set. */
export const MAX_SESSION_BYTES = 4 * 1024 * 1024;

export interface PersistedSession {
  id: string;
  type: string;
  title: string;
  /** Each page's own bag of state, keyed by the names it passes to
   * useSessionState. This module never needs to know the shapes. */
  state: Record<string, unknown>;
  /** Set when state was dropped to stay under the cap, so the session can say
   * what happened rather than looking like it returned nothing. */
  truncated?: boolean;
}

export interface Workspace {
  sessions: PersistedSession[];
  activeId: string | null;
  /** "home" | "settings" | "session" -- which view was open. */
  view: string;
}

export const EMPTY_WORKSPACE: Workspace = { sessions: [], activeId: null, view: "home" };

// ---------------------------------------------------------------------------
// JSON that survives the types pages actually hold
// ---------------------------------------------------------------------------

// Pages keep plenty of Sets (selected environments, expanded rows, minimised
// panes) and the odd Map. JSON.stringify turns those into {} silently, which
// would restore a session that looks right and has lost every selection -- so
// they're tagged on the way out and rebuilt on the way in.
const SET_TAG = "__cwiSet";
const MAP_TAG = "__cwiMap";

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return { [SET_TAG]: Array.from(value) };
  if (value instanceof Map) return { [MAP_TAG]: Array.from(value.entries()) };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const tagged = value as Record<string, unknown>;
    if (Array.isArray(tagged[SET_TAG])) return new Set(tagged[SET_TAG] as unknown[]);
    if (Array.isArray(tagged[MAP_TAG])) return new Map(tagged[MAP_TAG] as [unknown, unknown][]);
  }
  return value;
}

export function encode(value: unknown): string {
  return JSON.stringify(value, replacer);
}

export function decode<T>(text: string): T {
  return JSON.parse(text, reviver) as T;
}

/**
 * Serializes a workspace, dropping the state of any session too big to keep.
 * Returns the text to store; sessions that lost their state are flagged so the
 * UI can own up to it.
 */
export function encodeWorkspace(workspace: Workspace): string {
  return encode({ ...workspace, sessions: workspace.sessions.map(capSession) });
}

/**
 * One session, cut down to fit under the cap.
 *
 * The results are what get big, and they are also the part you can rerun --
 * so they go first and the inputs stay, leaving a session you can put straight
 * back rather than a blank one. If even the inputs are over the cap (nothing
 * a page writes should be, but a pasted payload in the HTTP tool could),
 * everything goes. Either way `truncated` is how the session owns up to it
 * instead of coming back looking like it found nothing.
 *
 * Used by both stores, so IndexedDB and the server agree on what a session
 * holds rather than each keeping a different half of it.
 */
export function capSession(session: PersistedSession): PersistedSession {
  if (encode(session.state).length <= MAX_SESSION_BYTES) return session;

  const inputs = Object.fromEntries(Object.entries(session.state).filter(([key]) => isInputStateKey(key)));
  if (encode(inputs).length <= MAX_SESSION_BYTES) return { ...session, state: inputs, truncated: true };
  return { ...session, state: {}, truncated: true };
}

// Keys a page writes as a *result* rather than an input. A saved session is a
// template you start from, so it keeps what you chose and not what came back:
// restoring someone else's rows, or a "fetched 3 days ago" marker, from a
// template would be worse than an empty session.
//
// Matched on the last dot-separated segment, so an Aggregator pane's prefixed
// keys ("<paneId>.results") are covered by the same list.
const OUTPUT_STATE_KEYS = new Set([
  // Result sets.
  "results",
  "osResults",
  "thingResults",
  "certResults",
  "items",
  "users",
  "folders",
  "files",
  "exchange",
  "response",
  // Pagination cursors and counters that only mean something with the rows
  // they came with.
  "lastEvaluatedKey",
  "paginationToken",
  "continuationToken",
  "scannedCount",
  "expanded",
  "ranAt",
  "resultsVersion",
  "exchangeVersion",
  // Lists refetched on mount from the environment rather than chosen.
  "tables",
  "buckets",
  "userPools",
  "tableInfo",
  // The assistant conversation belongs to the rows it was about.
  "threads",
  "mode",
  "messages",
  "openingPrompt",
]);

export function isInputStateKey(key: string): boolean {
  const leaf = key.slice(key.lastIndexOf(".") + 1);
  return !OUTPUT_STATE_KEYS.has(leaf);
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Keyed per user so two accounts on one browser don't inherit each other's
 * open tabs. */
function keyFor(userId: number): string {
  return `user:${userId}`;
}

export async function loadWorkspace(userId: number): Promise<Workspace> {
  try {
    const db = await openDb();
    const text = await new Promise<string | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(keyFor(userId));
      request.onsuccess = () => resolve(request.result as string | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    if (!text) return EMPTY_WORKSPACE;
    const parsed = decode<Workspace>(text);
    // Anything half-written or from a shape we no longer understand starts
    // fresh rather than crashing the app on boot.
    if (!parsed || !Array.isArray(parsed.sessions)) return EMPTY_WORKSPACE;
    return { sessions: parsed.sessions, activeId: parsed.activeId ?? null, view: parsed.view ?? "home" };
  } catch {
    // Private windows, blocked site data, a corrupt database -- none of which
    // should stop the app loading. You just lose the restored tabs.
    return EMPTY_WORKSPACE;
  }
}

export async function saveWorkspace(userId: number, workspace: Workspace): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(encodeWorkspace(workspace), keyFor(userId));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch {
    // Same: losing persistence is survivable, losing the session in front of
    // the user is not.
  }
}

export async function clearWorkspace(userId: number): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).delete(keyFor(userId));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch {
    // Nothing to do -- see above.
  }
}
