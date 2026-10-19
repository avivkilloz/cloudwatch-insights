import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  Dispatch,
  ReactNode,
  SetStateAction,
} from "react";
import { ApiError, HomeSession, LiveSessionSummary, SessionCategory, api, readableError } from "../api";
import { PageId } from "../pages/pageTypes";
import {
  EMPTY_WORKSPACE,
  PersistedSession,
  Workspace,
  isInputStateKey,
  loadWorkspace,
  saveWorkspace,
} from "./storage";
import { SYNC_DEBOUNCE_MS, WorkspaceSync, fromWire, mergeSession } from "./sync";
import { subscribeLiveEvents } from "./liveEvents";
import { announceApprovals } from "../workflowApprovals";
import { applyOutputs, dropOutputs, outputsVersion } from "./outputs";
import { migratePaneKeys } from "../panes/manifest";

/** Which panes a session can hold. Values are stored, so renaming one orphans
 * existing sessions -- add rather than rename. ./registry.tsx says what each
 * one is and renders.
 *
 * "aggregator" is in here for one reason: it is what every session's own `type`
 * now is. There is no longer an Aggregator you open alongside other things --
 * a session *is* one, holding whichever of the panes below. "agent" is here
 * only so sessions stored before it became a page still have a valid type
 * while they are migrated away on load. */
export type SessionType =
  /** Legacy: one page with a CloudWatch/OpenSearch switch inside it. Kept in
   * the union so a session stored before the split still has a valid type
   * while it is migrated on load -- it is not offered anywhere any more. */
  | "logs"
  | "logs-cloudwatch"
  | "logs-opensearch"
  | "iot"
  | "tables"
  | "buckets"
  | "cognito"
  | "aggregator"
  | "tool-http"
  | "tool-mqtt"
  | "tool-jwt"
  | "tool-base64"
  | "tool-diff"
  | "agent";

/** A session's own type. Every session is an Aggregator now, holding panes. */
export const SESSION_TYPE: SessionType = "aggregator";

/**
 * Brings a stored workspace up to the shape this version expects.
 *
 * Three migrations, in order, because each depends on the one before:
 *
 * 1. The old single "logs" page split into CloudWatch and OpenSearch. Which
 *    one a session was is already in its own state -- the `backend` key the
 *    removed switch wrote -- so nothing is guessed.
 * 2. Every session became an Aggregator. A session that was a page becomes one
 *    holding that page as its only pane: an Aggregator keeps a pane's state
 *    under "<paneId>.<key>", so every key it owns moves under the pane's id in
 *    the same step. Tabs, so one pane looks like the page it used to be.
 * 3. A pane ported to a manifest keeps its keys under "<pane>.in." and
 *    "<pane>.out." (PLATFORM_PLAN.md §15.4), by its manifest's own list.
 *
 * Agent sessions have nowhere to go -- the agent is a page now, not something
 * you have several of -- so they are dropped. They only ever held a
 * conversation with a model that was never connected.
 *
 * Runs on every load rather than once: a workspace can come back from an older
 * browser, or from the server, at any time.
 */
export function migrateSessionList(list: PersistedSession[]): PersistedSession[] {
  const out: PersistedSession[] = [];
  for (const session of list) {
    const s = migrateLogsSplit(session);
    if (s.type === "agent") continue;
    out.push(migratePanes(s.type === SESSION_TYPE ? s : wrapAsAggregator(s)));
  }
  return out;
}

function migrateSessions(w: Workspace): Workspace {
  const sessions = migrateSessionList(w.sessions);
  if (sessions.length === w.sessions.length && sessions.every((s, i) => s === w.sessions[i])) return w;
  const ids = new Set(sessions.map((s) => s.id));
  const activeId = w.activeId && ids.has(w.activeId) ? w.activeId : sessions[0]?.id ?? null;
  return { sessions, activeId, view: w.view === "session" && !activeId ? "home" : w.view };
}

function migrateLogsSplit(s: PersistedSession): PersistedSession {
  if (s.type === "logs") {
    return { ...s, type: s.state.backend === "opensearch" ? "logs-opensearch" : "logs-cloudwatch" };
  }
  if (s.type !== SESSION_TYPE) return s;
  const services = s.state.services as string[] | undefined;
  if (!services?.includes("logs")) return s;

  // Renaming only the pane's id would leave it on screen with none of its
  // inputs, so the id and every key under it move together.
  const backend = s.state["logs.backend"] === "opensearch" ? "logs-opensearch" : "logs-cloudwatch";
  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s.state)) {
    state[key.startsWith("logs.") ? `${backend}.${key.slice("logs.".length)}` : key] = value;
  }
  state.services = services.map((id) => (id === "logs" ? backend : id));
  if (s.state.minimized instanceof Set && s.state.minimized.has("logs")) {
    const minimized = new Set(s.state.minimized as Set<string>);
    minimized.delete("logs");
    minimized.add(backend);
    state.minimized = minimized;
  }
  return { ...s, state };
}

/** The server does the same on every read and write; this covers the copy
 * kept in IndexedDB, and a remote session merged in before its next read. */
function migratePanes(s: PersistedSession): PersistedSession {
  const state = withoutOutputs(migratePaneKeys(s.state));
  return state === s.state ? s : { ...s, state };
}

/** A pane's outputs live in the outputs store, not the state (D21,
 * sessions/outputs.ts): a copy from before that -- IndexedDB, an old row --
 * leaves them behind here; the server has moved them already, and sends them
 * beside the state. */
function withoutOutputs(state: Record<string, unknown>): Record<string, unknown> {
  const stale = Object.keys(state).filter((k) => /^[^.]+\.out\./.test(k));
  if (!stale.length) return state;
  const next = { ...state };
  for (const k of stale) delete next[k];
  return next;
}

/** One page's session becomes an Aggregator holding that page. */
function wrapAsAggregator(s: PersistedSession): PersistedSession {
  const state: Record<string, unknown> = { services: [s.type], layout: "tabs", activePane: s.type };
  for (const [key, value] of Object.entries(s.state)) state[`${s.type}.${key}`] = value;
  return { ...s, type: SESSION_TYPE, state };
}

/** What the body is showing: one of the pages that are not sessions, or the
 * active session. */
export type ViewKind = PageId | "session";

interface SessionsApi {
  sessions: PersistedSession[];
  activeId: string | null;
  view: ViewKind;
  /** False until the workspace has been read back from IndexedDB, so nothing
   * renders (and immediately re-persists) an empty workspace over a real one. */
  ready: boolean;
  /** Starts a session. No type: every session is an Aggregator, and what it
   * holds is the `services` key in its state. */
  open: (title: string, state?: Record<string, unknown>) => string;
  /** Takes a session off the strip of tabs. It stays in `closed`, which the
   * side panel lists alongside the open ones, so nothing is lost. */
  close: (id: string) => void;
  /** Sessions that are not currently open, most recently closed first. Names
   * only: their state is fetched when one is reopened, since nothing trims
   * this list and loading every session's rows on boot would not scale. */
  closed: LiveSessionSummary[];
  /** Puts a closed session back on the strip, with the state it had. */
  reopen: (id: string) => void;
  /** Throws a session away for good, open or closed -- or, one shared with
   * you, leaves it (only its owner can delete it). The only thing here that
   * loses work, which is why it is not what the ✕ used to do. */
  remove: (id: string) => void;
  /** Something that didn't work and isn't any one page's to show: a delete
   * the server refused. */
  notice: string | null;
  dismissNotice: () => void;
  /** The user's home page (R3, D63): a session, one that's gone, or neither --
   * null until the server has said. */
  home: HomeSession | null;
  /** Makes a session the home page, or (null) the default page again. */
  setHome: (id: string | null) => void;
  /** Where the brand goes: the home session (reopened if it was closed), or
   * the default page. */
  goHome: () => void;
  activate: (id: string) => void;
  /** Shows a session the server just made for this user (a run investigated,
   * D95): fetched and taken in at once, rather than when its announcement
   * arrives -- the click that made it wants it on screen now. */
  openFromServer: (id: string) => Promise<void>;
  rename: (id: string, title: string) => void;
  reorder: (id: string, toIndex: number) => void;
  show: (view: ViewKind) => void;
  /** This session's state with its outputs stripped -- what a saved session
   * stores. */
  captureInputs: (id: string) => Record<string, unknown>;
  /** Saves every open session now -- locally and to the server -- rather
   * than on the debounce, resolving once both are done. For leaving the page
   * on purpose (a reload into a newer build), where the debounced save would
   * be cut off and the server's older copy would win on the way back. */
  flushAll: () => Promise<void>;

  /** Slack-style groups for the panel's session list, in display order. A
   * session with no category (or one that was deleted) just doesn't appear
   * in any of these. */
  categories: SessionCategory[];
  createCategory: (name: string) => Promise<SessionCategory>;
  renameCategory: (id: number, name: string) => Promise<void>;
  /** Sessions in the deleted category are not deleted -- they fall back to
   * ungrouped, both here and on the server (ON DELETE SET NULL). */
  deleteCategory: (id: number) => Promise<void>;
  reorderCategories: (ids: number[]) => void;
  /** Moves a session into a category, or out of any category with `null`. */
  setSessionCategory: (id: string, categoryId: number | null) => void;
}

const SessionsContext = createContext<SessionsApi | null>(null);

/** The sessions the platform agent has written in the last few seconds --
 * what the panel and the strip mark as "the agent is working on this". Its
 * own context rather than part of SessionsApi, which every page reads: the
 * agent writing a session is no reason to re-render all of them. */
const AgentActivityContext = createContext<ReadonlySet<string>>(new Set());

export function useAgentActivity(): ReadonlySet<string> {
  return useContext(AgentActivityContext);
}

// Long enough to read as "busy" across the gap between a run's two writes
// (its inputs, then its results), short enough to stop soon after it's done.
const AGENT_ACTIVITY_MS = 4000;

export function useSessions(): SessionsApi {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used inside <SessionsProvider>");
  return ctx;
}

// How long to wait after the last change before writing. Typing in a query box
// shouldn't mean an IndexedDB write per keystroke, but a refresh a second later
// should still find your work.
/** What this browser changed between loading the page and the server's list
 * arriving: only this is laid over the server's copy then. */
interface SinceLoad {
  /** session -> state key -> its value now (undefined: removed). */
  keys: Map<string, Map<string, unknown>>;
  /** session -> key prefixes dropped (closed panes). */
  drops: Map<string, string[]>;
  titles: Map<string, string>;
  categories: Map<string, number | null>;
  /** Opened or reopened here: kept though the server's list hasn't them. */
  opened: Set<string>;
  /** Closed or deleted here: left out though the server's list has them. */
  gone: Set<string>;
  reordered: boolean;
}

function emptySinceLoad(): SinceLoad {
  return {
    keys: new Map(),
    drops: new Map(),
    titles: new Map(),
    categories: new Map(),
    opened: new Set(),
    gone: new Set(),
    reordered: false,
  };
}

function keysOf(changes: SinceLoad, sessionId: string): Map<string, unknown> {
  let keys = changes.keys.get(sessionId);
  if (!keys) changes.keys.set(sessionId, (keys = new Map()));
  return keys;
}

/** The server's copy of a session with what was done here since the load. */
function overlay(session: PersistedSession, changes: SinceLoad): PersistedSession {
  const keys = changes.keys.get(session.id);
  const drops = changes.drops.get(session.id);
  const title = changes.titles.get(session.id);
  const hasCategory = changes.categories.has(session.id);
  if (!keys && !drops && title === undefined && !hasCategory) return session;
  const state = drops
    ? Object.fromEntries(Object.entries(session.state).filter(([k]) => !drops.some((p) => k.startsWith(p))))
    : { ...session.state };
  for (const [key, value] of keys ?? []) {
    if (value === undefined) delete state[key];
    else state[key] = value;
  }
  return {
    ...session,
    state,
    title: title ?? session.title,
    categoryId: hasCategory ? changes.categories.get(session.id) : session.categoryId,
  };
}

/** The ids of every session this browser has seen on the server, kept in
 * localStorage per user (capped: the newest are what matter). */
class SeenSessions {
  private static readonly CAP = 2000;
  private readonly key: string;
  constructor(userId: number) {
    this.key = `cwi-synced-${userId}`;
  }
  /** Null when this browser has no record yet. */
  ids(): Set<string> | null {
    try {
      const raw = window.localStorage.getItem(this.key);
      return raw === null ? null : new Set(JSON.parse(raw) as string[]);
    } catch {
      return null;
    }
  }
  add(ids: string[]): void {
    const current = this.ids();
    if (current && ids.every((id) => current.has(id))) return;
    const now = current ?? new Set<string>();
    // Re-added at the end, so the cap keeps the most recently seen.
    for (const id of ids) {
      now.delete(id);
      now.add(id);
    }
    try {
      window.localStorage.setItem(this.key, JSON.stringify([...now].slice(-SeenSessions.CAP)));
    } catch {
      // Storage full or blocked: the load then treats this browser as one
      // without a record, which is what it was before one was kept.
    }
  }
}

const PERSIST_DEBOUNCE_MS = 400;

let sessionCounter = 0;

export function SessionsProvider({ userId, children }: { userId: number; children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [closed, setClosed] = useState<LiveSessionSummary[]>([]);
  const [categories, setCategories] = useState<SessionCategory[]>([]);
  const [ready, setReady] = useState(false);
  // One per mounted provider, and never in state: it is bookkeeping about what
  // the server has been told, and re-rendering the workspace on every reply
  // would be a lot of renders for nothing on screen.
  const sync = useMemo(() => new WorkspaceSync(), []);
  const [agentActive, setAgentActive] = useState<ReadonlySet<string>>(new Set());
  const agentTimers = useRef(new Map<string, number>());
  const markAgentActive = useCallback((id: string) => {
    setAgentActive((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    const timers = agentTimers.current;
    window.clearTimeout(timers.get(id));
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id);
        setAgentActive((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, AGENT_ACTIVITY_MS),
    );
  }, []);
  // What this browser changed since the page loaded, until the server's list
  // arrives: laid over the server's copy then, rather than this browser's whole
  // local copy winning (see the load below). Null once the load is done.
  const sinceLoad = useRef<SinceLoad | null>(null);
  const changed = (record: (c: SinceLoad) => void) => {
    if (sinceLoad.current) record(sinceLoad.current);
  };
  // The sessions this browser has ever seen on the server, kept across loads:
  // one of them missing from the server's list was deleted elsewhere, while
  // one never seen there is this browser's own, not saved yet.
  const seen = useMemo(() => new SeenSessions(userId), [userId]);
  // The workspace is pushed only once the server's list is in: before it, no
  // version is known, and a push without one overwrites whatever is there.
  const [listed, setListed] = useState(false);
  // Whether this load may still land on the home session: once, when it
  // would otherwise show the default page (see the effect after goHome).
  const landing = useRef(true);
  // The stored bases, until the server's list replaces them: a save in the
  // meantime would otherwise store none, and a second reload lose them.
  const storedBases = useRef<Record<string, PersistedSession>>({});
  const basesFor = useCallback(
    (sessions: PersistedSession[]) => {
      const ids = sessions.map((s) => s.id);
      const kept = Object.fromEntries(ids.filter((id) => storedBases.current[id]).map((id) => [id, storedBases.current[id]]));
      return { ...kept, ...sync.basesOf(ids) };
    },
    [sync],
  );
  // reopen reads the closed list without depending on it, so it does not get a
  // new identity every time a session is closed.
  const closedRef = useRef<LiveSessionSummary[]>([]);
  closedRef.current = closed;
  // close reads the session being closed from here rather than from inside a
  // setWorkspace updater, which React may run later than the ✕ -- or twice.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setClosed([]);
    setCategories([]);
    setListed(false);
    setHomeState(null);
    landing.current = true;
    sinceLoad.current = emptySinceLoad();

    (async () => {
      // The local copy first, so the panel is populated on the first paint
      // rather than after a round trip.
      const stored = await loadWorkspace(userId);
      const local = migrateSessions(stored.workspace);
      const localBases = new Map(migrateSessionList(Object.values(stored.bases)).map((b) => [b.id, b]));
      if (cancelled) return;
      storedBases.current = stored.bases;
      setWorkspace(local);
      setReady(true);

      let open: PersistedSession[];
      let known: Set<string> | null;
      try {
        const [openRows, closedRows, categoryRows] = await Promise.all([
          api.listLiveSessions(),
          api.listClosedLiveSessions(),
          api.listSessionCategories(),
        ]);
        if (cancelled) return;
        setCategories(categoryRows);
        // Read before adopt records the open rows as seen: whether this
        // browser kept a record at all decides what its local-only sessions are.
        known = seen.ids();
        open = migrateSessionList(openRows.map(fromWire));
        sync.adopt(openRows);
        storedBases.current = {};
        // Agent sessions are dropped by the migration above. Taking them off
        // the server too, rather than only out of this list, is what makes the
        // drop real: otherwise every load would fetch and discard them again,
        // and the server would go on reporting sessions nobody can see.
        const kept = new Set(open.map((session) => session.id));
        for (const row of openRows) {
          if (!kept.has(row.client_id)) sync.enqueue(() => api.deleteLiveSession(row.client_id));
        }
        for (const row of closedRows) {
          if (row.type === "agent") sync.enqueue(() => api.deleteLiveSession(row.client_id));
        }
        setClosed(closedRows.filter((row) => row.type !== "agent"));
        seen.add(closedRows.map((row) => row.client_id));
      } catch {
        // Offline, or a backend that has not been migrated yet. Keep working
        // against the local copy; the next flush pushes it up.
        sinceLoad.current = null;
        setListed(true);
        return;
      }

      // The server's copy wins, with only what was done here since the page
      // loaded laid over it. This browser's local copy used to win whenever
      // anything had been written since the load -- and a pane writing the
      // values it opened with counted, so it always did: a stale copy was
      // pushed with the version just adopted, the server took it, and a
      // change made elsewhere since (another browser, the agent) was lost, a
      // session deleted elsewhere came back.
      const changes = sinceLoad.current ?? emptySinceLoad();
      sinceLoad.current = null;
      setWorkspace((w) => {
        const sessions = open
          .filter((s) => !changes.gone.has(s.id))
          .map((s) => {
            // Merged as a conflict is (mergeSession): what this browser
            // changed since it last agreed with the server -- before the
            // reload too, pushed or not -- kept, the server's changes taken,
            // the server's where both did. A browser without a stored base
            // (from before one was kept) only has what was done since the load.
            const here = w.sessions.find((l) => l.id === s.id);
            const base = localBases.get(s.id);
            return here && base ? mergeSession(base, here, s) : overlay(s, changes);
          });
        const onServer = new Set(open.map((s) => s.id));
        for (const session of w.sessions) {
          if (onServer.has(session.id) || changes.gone.has(session.id)) continue;
          // Not on the server: opened just now, or never saved from here (an
          // outage, a first load) -- pushed by the next flush. One this
          // browser saw there before was deleted or closed elsewhere and stays
          // so. Without a record (a browser from before one was kept), only
          // an empty server list is taken as "never saved", as it always was.
          const ownUnsaved = known ? !known.has(session.id) : open.length === 0;
          if (changes.opened.has(session.id) || ownUnsaved) sessions.push(session);
        }
        if (changes.reordered) {
          const rank = new Map(w.sessions.map((s, i) => [s.id, i]));
          const last = Number.MAX_SAFE_INTEGER;
          sessions.sort((a, b) => (rank.get(a.id) ?? last) - (rank.get(b.id) ?? last));
        }
        const ids = new Set(sessions.map((session) => session.id));
        const activeId = w.activeId && ids.has(w.activeId) ? w.activeId : sessions[0]?.id ?? null;
        return {
          sessions,
          activeId,
          // Which tab this browser was on is local; falling back to home when
          // the session it pointed at is gone.
          view: w.view === "session" && !activeId ? "home" : w.view,
        };
      });
      setListed(true);
      const homeAnswer = await api.getHomeSession().catch(() => null);
      if (!cancelled && homeAnswer) setHomeState(homeAnswer);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, sync, seen]);

  // A base moves when a push lands or a change is received; stored with the
  // workspace, so it's saved again then too -- a stale stored base is merged
  // against as if this browser had changed what the push carried.
  const [basesMoved, setBasesMoved] = useState(0);
  useEffect(() => {
    sync.onSynced = (id) => {
      seen.add([id]);
      setBasesMoved((n) => n + 1);
    };
    return () => {
      sync.onSynced = null;
    };
  }, [sync, seen]);

  // Persist on a trailing debounce. Writing only after `ready` matters: the
  // first render holds an empty workspace, and saving that would wipe the one
  // still being read back.
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      saveWorkspace(userId, workspace, basesFor(workspace.sessions));
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, [workspace, basesMoved, ready, userId, basesFor]);

  // A debounce loses the last few hundred milliseconds if the tab is closed
  // mid-flight, which is exactly when someone is most likely to be mid-edit.
  useEffect(() => {
    function flush() {
      if (ready) saveWorkspace(userId, workspace, basesFor(workspace.sessions));
    }
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [workspace, ready, userId, basesFor]);

  // And the same to the server, on a longer debounce: the local copy is
  // already safe by the time this fires, so this is about durability and
  // reaching your other browser rather than about not losing the last
  // keystroke. Only what changed goes; WorkspaceSync works that out.
  const syncPending = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || !listed) return;
    if (syncPending.current !== null) window.clearTimeout(syncPending.current);
    syncPending.current = window.setTimeout(() => {
      syncPending.current = null;
      sync.flush(workspace.sessions);
    }, SYNC_DEBOUNCE_MS);
    return () => {
      if (syncPending.current !== null) window.clearTimeout(syncPending.current);
    };
  }, [workspace.sessions, ready, listed, sync]);

  // A newer copy of a session from the server -- someone else's change,
  // announced or found on a 409 -- merged into this browser's (see
  // mergeSession). A session this browser didn't have yet is added, not
  // switched to: something appearing elsewhere shouldn't pull you off what
  // you're looking at.
  useEffect(() => {
    sync.onRemote = (remote, base) => {
      // Arriving while the load's list is in flight: kept by the load too.
      changed((c) => {
        c.opened.add(remote.id);
        c.gone.delete(remote.id);
      });
      setClosed((c) => (c.some((s) => s.client_id === remote.id) ? c.filter((s) => s.client_id !== remote.id) : c));
      setWorkspace((w) => {
        const index = w.sessions.findIndex((s) => s.id === remote.id);
        if (index < 0) return { ...w, sessions: [...w.sessions, remote] };
        const sessions = [...w.sessions];
        sessions[index] = mergeSession(base, w.sessions[index], remote);
        return { ...w, sessions };
      });
    };
    return () => {
      sync.onRemote = null;
    };
  }, [sync]);

  // The event stream: changes made somewhere else, as they happen. Only once
  // the workspace is loaded, so an early event can't land on the empty one
  // that the first render holds.
  useEffect(() => {
    if (!ready) return;
    const migrate = (s: PersistedSession) => migrateSessionList([s])[0] ?? s;
    const refreshClosed = () =>
      api
        .listClosedLiveSessions()
        .then((rows) => setClosed(rows.filter((row) => row.type !== "agent")))
        .catch(() => undefined);
    // Gone elsewhere: off the strip here too, and forgotten, so the next
    // flush doesn't push it back and undo the close.
    // Someone else's panel order: follow it, keeping any session the server
    // doesn't know yet where it was, at the end.
    const followOrder = (ids: string[]) => {
      sync.adoptOrder(ids);
      setWorkspace((w) => {
        const rank = new Map(ids.map((id, i) => [id, i]));
        const sorted = [...w.sessions].sort(
          (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        );
        return sorted.every((s, i) => s === w.sessions[i]) ? w : { ...w, sessions: sorted };
      });
    };
    const drop = (id: string) => {
      changed((c) => c.gone.add(id));
      if (homeRef.current?.home?.client_id === id) refreshHome();
      sync.forget(id);
      setWorkspace((w) => (w.sessions.some((s) => s.id === id) ? withoutSession(w, id) : w));
    };
    // Read the whole list and take whatever is newer than what's here. What a
    // reconnect does, since anything announced while the stream was down is
    // gone -- and what a failed fetch falls back to, since the event that
    // prompted it won't come again. Only sessions the server has already seen
    // are dropped for being missing: one made here and not pushed yet isn't
    // gone, just new.
    let retry: number | null = null;
    const catchUp = () => {
      if (retry !== null) window.clearTimeout(retry);
      retry = null;
      api
        .listLiveSessions()
        .then((rows) => {
          const onServer = new Set(rows.map((row) => row.client_id));
          for (const row of rows) sync.receive(row, migrate);
          followOrder(rows.map((row) => row.client_id));
          for (const s of workspaceRef.current.sessions) {
            if (!onServer.has(s.id) && sync.versionOf(s.id) !== undefined) drop(s.id);
          }
          refreshClosed();
        })
        .catch(catchUpLater);
    };
    const catchUpLater = () => {
      if (retry === null) retry = window.setTimeout(catchUp, 3000);
    };
    const fetchAndReceive = (id: string) =>
      api
        .getLiveSession(id)
        // Closed again by the time it was fetched: its own close event says so.
        .then((row) => (row.closed_at ? undefined : sync.receive(row, migrate)))
        .catch(catchUpLater);
    // The stream can survive a network blip that the fetches it prompts
    // don't, so coming back online is a reason to look again too.
    window.addEventListener("online", catchUp);

    const unsubscribe = subscribeLiveEvents(
      (event) => {
        if (event.kind === "reorder") {
          if (event.order) followOrder(event.order);
          else catchUp();
          return;
        }
        if (event.kind === "approvals") {
          // Not a session's: the Workflows row and page listen for it (D88).
          announceApprovals();
          return;
        }
        const id = event.client_id;
        if (!id) return;
        if (event.origin === "agent" && (event.kind === "upsert" || event.kind === "outputs")) markAgentActive(id);
        if (event.kind === "outputs") {
          // One pane's results, versioned on their own (D21): fetched alone,
          // without the session -- a refresh or a poll used to make every
          // tab fetch the whole session.
          const pane = event.pane;
          if (!pane || outputsVersion(id, pane) >= (event.version ?? 0)) return;
          if (!workspaceRef.current.sessions.some((s) => s.id === id)) return;
          api
            .getPaneOutputs(id, [pane])
            .then((got) => applyOutputs(id, got))
            .catch(catchUpLater);
          return;
        }
        if (event.kind === "upsert") {
          if ((sync.versionOf(id) ?? -1) >= (event.version ?? 0)) return;
          fetchAndReceive(id);
        } else if (event.kind === "access") {
          // The owner changed this user's permission: same version, new role.
          // The role decides whether this browser pushes its edits at all.
          api
            .getLiveSession(id)
            .then((row) =>
              setWorkspace((w) =>
                w.sessions.some((s) => s.id === id && s.role !== row.role)
                  ? { ...w, sessions: w.sessions.map((s) => (s.id === id ? { ...s, role: row.role } : s)) }
                  : w,
              ),
            )
            .catch(catchUpLater);
        } else if (event.kind === "close") {
          drop(id);
          refreshClosed();
        } else if (event.kind === "delete") {
          drop(id);
          setClosed((c) => c.filter((s) => s.client_id !== id));
        }
      },
      () => {
        catchUp();
        // Anything announced while the stream was down is gone: ask again.
        announceApprovals();
      },
    );
    return () => {
      unsubscribe();
      window.removeEventListener("online", catchUp);
      if (retry !== null) window.clearTimeout(retry);
    };
    // `withoutSession` is a plain function of its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sync, markAgentActive]);

  const open = useCallback((title: string, state: Record<string, unknown> = {}) => {
    const id = `s${Date.now().toString(36)}${(sessionCounter++).toString(36)}`;
    changed((c) => c.opened.add(id));
    setWorkspace((w) => ({
      ...w,
      sessions: [...w.sessions, { id, type: SESSION_TYPE, title, state }],
      activeId: id,
      view: "session",
    }));
    return id;
  }, []);

  /** Drops a session from the panel, and returns the workspace without it.
   * Shared by close and remove, which differ only in what becomes of the row
   * on the server. */
  function withoutSession(w: Workspace, id: string): Workspace {
    const index = w.sessions.findIndex((s) => s.id === id);
    const sessions = w.sessions.filter((s) => s.id !== id);
    if (w.activeId !== id) return { ...w, sessions };
    // Closing the session you're looking at lands on its neighbour rather
    // than dumping you back on the home page.
    const next = sessions[Math.min(index, sessions.length - 1)];
    return { ...w, sessions, activeId: next?.id ?? null, view: next ? "session" : "home" };
  }

  const close = useCallback(
    (id: string) => {
      changed((c) => c.gone.add(id));
      setWorkspace((w) => {
        const session = w.sessions.find((s) => s.id === id);
        // Moved across optimistically: a ✕ should feel instant rather than wait
        // on the network, and the list is re-read on the next load anyway.
        if (session) {
          setClosed((c) => [
            {
              client_id: id,
              type: session.type,
              title: session.title,
              truncated: !!session.truncated,
              closed_at: null,
              category_id: session.categoryId ?? null,
              role: session.role ?? "owner",
            },
            ...c.filter((s) => s.client_id !== id),
          ]);
        }
        return withoutSession(w, id);
      });
      // The row stays on the server; only its closed_at changes. Queued behind
      // any sync already running: a PUT landing after this would clear
      // closed_at and quietly reopen the session. Its state as of the ✕ goes
      // first, on the same chain -- see WorkspaceSync.close for what was lost
      // without it.
      const sessions = workspaceRef.current.sessions;
      const index = sessions.findIndex((s) => s.id === id);
      sync.close(id, sessions[index], index);
    },
    [sync],
  );

  const reopen = useCallback(
    (id: string) => {
      changed((c) => {
        c.opened.add(id);
        c.gone.delete(id);
      });
      const summary = closedRef.current.find((s) => s.client_id === id);
      if (!summary) return;
      setClosed((c) => c.filter((s) => s.client_id !== id));

      function put(session: PersistedSession) {
        setWorkspace((w) =>
          w.sessions.some((s) => s.id === id)
            ? { ...w, activeId: id, view: "session" }
            : { ...w, sessions: [...w.sessions, session], activeId: id, view: "session" },
        );
      }

      // The state has to be in hand *before* the session goes on the strip.
      // Putting it there first and filling it in when the request lands would
      // show the page for a moment with nothing in it -- and worse, leave it
      // that way: useSessionState seeds from the session's bag when it mounts,
      // so a bag that arrives afterwards never reaches the mounted page.
      api
        .getLiveSession(id)
        .then((row) => put(migrateSessionList([fromWire(row)])[0] ?? fromWire(row)))
        .catch(() => {
          // Offline, or a session that never reached the server. Open it with
          // what the panel knows rather than not at all; `truncated` is what
          // already exists to explain an empty one.
          put({ id, type: summary.type, title: summary.title, state: {}, truncated: true, categoryId: summary.category_id });
        });
    },
    [],
  );

  const [notice, setNotice] = useState<string | null>(null);
  const [home, setHomeState] = useState<HomeSession | null>(null);
  const homeRef = useRef(home);
  homeRef.current = home;
  const refreshHome = useCallback(() => {
    api.getHomeSession().then(setHomeState, () => undefined);
  }, []);
  const remove = useCallback(
    (id: string) => {
      changed((c) => c.gone.add(id));
      const open = workspaceRef.current.sessions.find((s) => s.id === id);
      const shut = closedRef.current.find((s) => s.client_id === id);
      const role = open?.role ?? shut?.role;
      // Shared with you: only its owner can delete it, so this leaves it. A
      // member's delete used to be refused (404) and the refusal swallowed --
      // the session went from the panel and came back on the next load.
      const leaving = role !== undefined && role !== "owner";
      setWorkspace((w) => withoutSession(w, id));
      setClosed((c) => c.filter((s) => s.client_id !== id));
      sync.forget(id);
      sync.enqueue(() =>
        (leaving ? api.removeSessionMember(id, userId) : api.deleteLiveSession(id)).then(() => {
          // Gone, and it was the home page: the default page says so now.
          if (homeRef.current?.home?.client_id === id) refreshHome();
        }, (e: unknown) => {
          // Already gone from the server: what was asked for is done.
          if (!leaving && e instanceof ApiError && e.status === 404) return;
          // Otherwise it's still there, and will be on the next load: put it
          // back where it was and say why, rather than let it seem gone.
          if (open) setWorkspace((w) => (w.sessions.some((s) => s.id === id) ? w : { ...w, sessions: [...w.sessions, open] }));
          if (shut) setClosed((c) => (c.some((s) => s.client_id === id) ? c : [...c, shut]));
          const title = open?.title ?? shut?.title ?? "the session";
          setNotice(`Couldn't ${leaving ? "leave" : "delete"} "${title}": ${readableError(e)}`);
        }),
      );
    },
    [sync, userId, refreshHome],
  );
  const dismissNotice = useCallback(() => setNotice(null), []);

  const activate = useCallback((id: string) => {
    setWorkspace((w) => ({ ...w, activeId: id, view: "session" }));
  }, []);

  const openFromServer = useCallback(
    async (id: string) => {
      const row = await api.getLiveSession(id);
      sync.receive(row, (s: PersistedSession) => migrateSessionList([s])[0] ?? s);
      setWorkspace((w) => ({ ...w, activeId: id, view: "session" }));
    },
    [sync],
  );

  const setHome = useCallback((id: string | null) => {
    (id ? api.setHomeSession(id) : api.clearHomeSession()).then(setHomeState, (e: unknown) =>
      setNotice(`Couldn't ${id ? "set" : "change"} your home page: ${readableError(e)}`),
    );
  }, []);

  const goHome = useCallback(() => {
    const target = homeRef.current?.home?.client_id;
    if (target && workspaceRef.current.sessions.some((s) => s.id === target)) activate(target);
    else if (target && closedRef.current.some((s) => s.client_id === target)) reopen(target);
    else setWorkspace((w) => ({ ...w, view: "home" }));
  }, [activate, reopen]);

  // A load that would land on the default page -- sign-in, a fresh browser, a
  // reload while on it -- lands on the home session instead (R3). Once, when
  // both the lists and the home answer are in, so it reopens from the real
  // closed list; "Start new session…" afterwards still shows the default page.
  useEffect(() => {
    if (!listed || !home || !landing.current) return;
    landing.current = false;
    if (home.home && workspace.view === "home") goHome();
  }, [listed, home, workspace.view, goHome]);

  const rename = useCallback((id: string, title: string) => {
    changed((c) => c.titles.set(id, title));
    setWorkspace((w) => ({
      ...w,
      sessions: w.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  }, []);

  const reorder = useCallback((id: string, toIndex: number) => {
    changed((c) => {
      c.reordered = true;
    });
    setWorkspace((w) => {
      const from = w.sessions.findIndex((s) => s.id === id);
      if (from < 0 || toIndex < 0 || toIndex >= w.sessions.length) return w;
      const sessions = [...w.sessions];
      sessions.splice(toIndex, 0, sessions.splice(from, 1)[0]);
      return { ...w, sessions };
    });
  }, []);

  const show = useCallback((view: ViewKind) => {
    setWorkspace((w) => ({ ...w, view }));
  }, []);

  const setSessionCategory = useCallback((id: string, categoryId: number | null) => {
    changed((c) => c.categories.set(id, categoryId));
    setWorkspace((w) => {
      const session = w.sessions.find((s) => s.id === id);
      if (!session || (session.categoryId ?? null) === categoryId) return w;
      return { ...w, sessions: w.sessions.map((s) => (s.id === id ? { ...s, categoryId } : s)) };
    });
  }, []);

  const createCategory = useCallback(async (name: string) => {
    const category = await api.createSessionCategory(name);
    setCategories((prev) => [...prev, category]);
    return category;
  }, []);

  const renameCategory = useCallback(async (id: number, name: string) => {
    const category = await api.renameSessionCategory(id, name);
    setCategories((prev) => prev.map((c) => (c.id === id ? category : c)));
  }, []);

  const deleteCategory = useCallback(async (id: number) => {
    await api.deleteSessionCategory(id);
    setCategories((prev) => prev.filter((c) => c.id !== id));
    // The server already set these sessions' category_id to null (ON DELETE
    // SET NULL); mirrored here so the panel doesn't wait for a reload to stop
    // showing them under a category that no longer exists.
    setWorkspace((w) => ({
      ...w,
      sessions: w.sessions.map((s) => (s.categoryId === id ? { ...s, categoryId: null } : s)),
    }));
  }, []);

  // Optimistic, like session reorder: the panel should feel instant, and a
  // failed request just leaves the next drag's reorder to retry the same call.
  const reorderCategories = useCallback((ids: number[]) => {
    setCategories((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]));
      const next = ids.map((id) => byId.get(id)).filter((c): c is SessionCategory => !!c);
      return next.length === prev.length ? next : prev;
    });
    api.reorderSessionCategories(ids).catch(() => {
      // Retried on the next reorder; nothing local was lost either way.
    });
  }, []);

  const captureInputs = useCallback(
    (id: string) => {
      const session = workspace.sessions.find((s) => s.id === id);
      if (!session) return {};
      return Object.fromEntries(Object.entries(session.state).filter(([key]) => isInputStateKey(key)));
    },
    [workspace.sessions],
  );

  // Pages call this (through useSessionState) on every change they want kept.
  // A `seed` -- a pane writing the value it opened with -- is no change of
  // anyone's: it goes in the workspace but is not laid over the server's copy
  // on load (see the load above), which a stale value of this browser's would
  // otherwise undo.
  const writeState = useCallback((sessionId: string, key: string, value: unknown, seed?: boolean) => {
    if (!seed) {
      const current = workspaceRef.current.sessions.find((s) => s.id === sessionId)?.state[key];
      if (!Object.is(current, value)) changed((c) => keysOf(c, sessionId).set(key, value));
    }
    setWorkspace((w) => {
      const session = w.sessions.find((s) => s.id === sessionId);
      if (!session || Object.is(session.state[key], value)) return w;
      return {
        ...w,
        sessions: w.sessions.map((s) =>
          s.id === sessionId ? { ...s, state: { ...s.state, [key]: value } } : s,
        ),
      };
    });
  }, []);

  // A closed pane's keys go with it. Pane ids are reused -- the first pane of a
  // kind is always the type itself (see ./panes) -- so without this a pane
  // added later would come back holding a closed one's inputs, and every
  // closed pane's results would ride along in the session forever.
  const dropState = useCallback((sessionId: string, prefix: string) => {
    changed((c) => {
      const keys = keysOf(c, sessionId);
      for (const key of [...keys.keys()]) if (key.startsWith(prefix)) keys.delete(key);
      c.drops.set(sessionId, [...(c.drops.get(sessionId) ?? []), prefix]);
    });
    // Its outputs too, here; the server drops its record when the save
    // without the pane arrives.
    if (prefix.endsWith(".") && !prefix.slice(0, -1).includes(".")) dropOutputs(sessionId, prefix.slice(0, -1));
    setWorkspace((w) => {
      const session = w.sessions.find((s) => s.id === sessionId);
      if (!session || !Object.keys(session.state).some((k) => k.startsWith(prefix))) return w;
      const state = Object.fromEntries(Object.entries(session.state).filter(([k]) => !k.startsWith(prefix)));
      return { ...w, sessions: w.sessions.map((s) => (s.id === sessionId ? { ...s, state } : s)) };
    });
  }, []);

  // Named `sessionsApi` rather than `api`: the module-level `api` is the HTTP
  // client, and shadowing it here would quietly break the calls above.
  const flushAll = useCallback(async () => {
    await saveWorkspace(userId, workspaceRef.current, basesFor(workspaceRef.current.sessions));
    await sync.flush(workspaceRef.current.sessions);
  }, [userId, sync, basesFor]);

  const sessionsApi = useMemo<SessionsApi>(
    () => ({
      sessions: workspace.sessions,
      activeId: workspace.activeId,
      view: workspace.view as ViewKind,
      ready,
      open,
      close,
      closed,
      reopen,
      remove,
      notice,
      dismissNotice,
      home,
      setHome,
      goHome,
      activate,
      openFromServer,
      rename,
      reorder,
      show,
      captureInputs,
      flushAll,
      categories,
      createCategory,
      renameCategory,
      deleteCategory,
      reorderCategories,
      setSessionCategory,
    }),
    [
      workspace,
      closed,
      ready,
      open,
      close,
      reopen,
      remove,
      notice,
      dismissNotice,
      home,
      setHome,
      goHome,
      activate,
      openFromServer,
      rename,
      reorder,
      show,
      captureInputs,
      flushAll,
      categories,
      createCategory,
      renameCategory,
      deleteCategory,
      reorderCategories,
      setSessionCategory,
    ],
  );

  return (
    <SessionsContext.Provider value={sessionsApi}>
      <WriteStateContext.Provider value={writeState}>
        <DropStateContext.Provider value={dropState}>
          <AgentActivityContext.Provider value={agentActive}>{children}</AgentActivityContext.Provider>
        </DropStateContext.Provider>
      </WriteStateContext.Provider>
    </SessionsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

type WriteState = (sessionId: string, key: string, value: unknown, seed?: boolean) => void;
const WriteStateContext = createContext<WriteState | null>(null);
type DropState = (sessionId: string, prefix: string) => void;
const DropStateContext = createContext<DropState | null>(null);

/** Writes one key of any open session's state from outside it -- how the
 * agent panel, which sits beside every session rather than inside one, keeps
 * a session's own conversation in that session. Syncs like any other change. */
export function useWriteSessionState(): WriteState {
  const write = useContext(WriteStateContext);
  if (!write) throw new Error("useWriteSessionState must be used inside <SessionsProvider>");
  return write;
}

/** Removes every key of the current session starting with `prefix` -- a
 * closed pane's "<paneId>." -- from its stored state. A no-op outside a
 * session. Only for keys no mounted component reads any more: a mounted
 * useSessionState would just write its value straight back. */
export function useDropSessionKeys(): (prefix: string) => void {
  const scope = useContext(SessionScopeContext);
  const drop = useContext(DropStateContext);
  return useCallback(
    (prefix: string) => {
      if (scope && drop) drop(scope.id, prefix);
    },
    [scope, drop],
  );
}

interface SessionScope {
  /** Called on every change to the session's bag, with the bag. */
  subscribe: (listener: (bag: Record<string, unknown>) => void) => () => void;
  id: string;
  /** The session's state as it is right now. Read once per mount, by
   * useSessionState's initialiser. */
  read: () => Record<string, unknown>;
}

const SessionScopeContext = createContext<SessionScope | null>(null);

/** Wraps one session's subtree so everything inside it reads and writes that
 * session's own state. */
export function SessionScopeProvider({
  session,
  children,
}: {
  session: PersistedSession;
  children: ReactNode;
}) {
  // Kept pointing at the current state rather than frozen. A useState
  // initialiser only runs on mount, so this can't make a mounted page reset;
  // freezing it, though, means a remount (React's strict double-mount, a key
  // change) re-seeds from the original bag and throws away everything since.
  const latest = useRef(session.state);
  latest.current = session.state;
  const listeners = useRef(new Set<(bag: Record<string, unknown>) => void>());
  const scope = useMemo(
    () => ({
      id: session.id,
      read: () => latest.current,
      subscribe: (listener: (bag: Record<string, unknown>) => void) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [session.id],
  );
  // Every change to the bag, whoever made it: a mounted useSessionState
  // compares its own key and takes a value it didn't write itself (see there).
  useEffect(() => {
    for (const listener of listeners.current) listener(session.state);
  }, [session.state]);
  return <SessionScopeContext.Provider value={scope}>{children}</SessionScopeContext.Provider>;
}

/** The pane a component is drawn in: its session's client id and the pane's id
 * (a background run is started in, and writes into, exactly that pane). */
export function usePaneAddress(): { session: string | null; pane: string } {
  const scope = useContext(SessionScopeContext);
  const prefix = useContext(KeyPrefixContext);
  return { session: scope?.id ?? null, pane: prefix.replace(/\.$/, "") };
}

export function useSessionScope(): SessionScope | null {
  return useContext(SessionScopeContext);
}

/** A key at the session's own level (not a pane's), read-only and followed as
 * it changes: the session's refresh, its variables, its view mode -- what a
 * pane, inside its own key scope, needs to know about the session it's in. */
export function useSessionValue<T>(key: string): T | undefined {
  const scope = useSessionScope();
  const [value, setValue] = useState<T | undefined>(() => scope?.read()?.[key] as T | undefined);
  useEffect(() => {
    if (!scope) return;
    setValue(scope.read()?.[key] as T | undefined);
    return scope.subscribe((bag) => setValue(bag[key] as T | undefined));
  }, [scope, key]);
  return value;
}

/**
 * Namespaces the keys used inside it.
 *
 * The Aggregator renders whole pages as panes, so one session can hold a Logs
 * pane and an IoT pane that both want a key called "queryString". Without a
 * prefix per pane they'd overwrite each other and restore as each other.
 */
const KeyPrefixContext = createContext("");

export function SessionKeyScope({ prefix, children }: { prefix: string; children: ReactNode }) {
  const parent = useContext(KeyPrefixContext);
  const value = useMemo(() => `${parent}${prefix}.`, [parent, prefix]);
  return <KeyPrefixContext.Provider value={value}>{children}</KeyPrefixContext.Provider>;
}

/**
 * useState, except the value is seeded from the session's restored state and
 * written back as it changes.
 *
 * Outside a session (the Tools tab used standalone, a page rendered in a test)
 * it degrades to a plain useState, so the same components work in both places.
 *
 * Only pass state worth restoring. Loading flags, in-flight errors and
 * anything derived should stay on useState -- restoring "Searching…" from
 * yesterday would be a lie.
 */
export function useSessionState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const scope = useContext(SessionScopeContext);
  const write = useContext(WriteStateContext);
  const fullKey = useContext(KeyPrefixContext) + key;

  const [value, setValue] = useState<T>(() => {
    const bag = scope?.read();
    if (bag && fullKey in bag) return bag[fullKey] as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });

  // Report after render rather than inside the setter, so a page that calls
  // several setters in one handler produces one workspace update per commit.
  const lastWritten = useRef<unknown>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    if (!scope || !write) return;
    if (Object.is(lastWritten.current, value)) return;
    lastWritten.current = value;
    // The first write is what the pane opened with, not a change (see
    // writeState).
    write(scope.id, fullKey, value, !mounted.current);
    mounted.current = true;
  }, [scope, write, fullKey, value]);

  // And the other way: the bag changed under a mounted pane -- another tab,
  // another machine, the platform agent -- so its value follows. Seeding only
  // on mount used to be enough because this browser was the only writer.
  // What this hook wrote itself comes back as the very same object, so only
  // someone else's change gets through; a key that was removed (a closed
  // pane's, on its way out) is left alone.
  useEffect(() => {
    if (!scope) return;
    return scope.subscribe((bag) => {
      if (!(fullKey in bag)) return;
      const next = bag[fullKey];
      if (Object.is(next, lastWritten.current)) return;
      lastWritten.current = next;
      setValue(next as T);
    });
  }, [scope, fullKey]);

  return [value, setValue];
}
