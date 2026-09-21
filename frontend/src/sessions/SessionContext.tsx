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
import { LiveSessionSummary, api } from "../api";
import {
  EMPTY_WORKSPACE,
  PersistedSession,
  Workspace,
  isInputStateKey,
  loadWorkspace,
  saveWorkspace,
} from "./storage";
import { SYNC_DEBOUNCE_MS, WorkspaceSync, fromWire } from "./sync";

/** Which kinds of session the + button can start. Values are stored, so
 * renaming one orphans existing open sessions -- add rather than rename.
 * The registry in ./registry.tsx says what each one is and renders. */
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

/**
 * Splits the old single "logs" session into the two it became.
 *
 * Which one it is was already in the session's own state -- the `backend` key
 * the removed switch wrote -- so nothing is guessed and nothing is lost. Runs
 * on every load rather than once: a workspace can come back from an older
 * browser at any time.
 */
function migrateSessionTypes(w: Workspace): Workspace {
  const needsWork = w.sessions.some(
    (s) => s.type === "logs" || (s.type === "aggregator" && (s.state.services as string[] | undefined)?.includes("logs")),
  );
  if (!needsWork) return w;

  return {
    ...w,
    sessions: w.sessions.map((s) => {
      if (s.type === "logs") {
        return { ...s, type: s.state.backend === "opensearch" ? "logs-opensearch" : "logs-cloudwatch" };
      }
      if (s.type !== "aggregator") return s;
      const services = s.state.services as string[] | undefined;
      if (!services?.includes("logs")) return s;

      // An Aggregator keeps its panes' state under "<paneId>.<key>", so the
      // pane's id and every key it owns have to move together -- renaming only
      // the id would leave the pane on screen with none of its inputs.
      const next = s.state.backend === "opensearch" ? "logs-opensearch" : "logs-cloudwatch";
      const backend = s.state["logs.backend"] === "opensearch" ? "logs-opensearch" : next;
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
    }),
  };
}

export type ViewKind = "home" | "settings" | "session";

interface SessionsApi {
  sessions: PersistedSession[];
  activeId: string | null;
  view: ViewKind;
  /** False until the workspace has been read back from IndexedDB, so nothing
   * renders (and immediately re-persists) an empty workspace over a real one. */
  ready: boolean;
  open: (type: SessionType, title: string, state?: Record<string, unknown>) => string;
  /** Takes a session off the strip of tabs. It stays in `closed`, which the
   * side panel lists alongside the open ones, so nothing is lost. */
  close: (id: string) => void;
  /** Sessions that are not currently open, most recently closed first. Names
   * only: their state is fetched when one is reopened, since nothing trims
   * this list and loading every session's rows on boot would not scale. */
  closed: LiveSessionSummary[];
  /** Puts a closed session back on the strip, with the state it had. */
  reopen: (id: string) => void;
  /** Throws a session away for good, open or closed. The only thing here that
   * loses work, which is why it is not what the ✕ used to do. */
  remove: (id: string) => void;
  activate: (id: string) => void;
  rename: (id: string, title: string) => void;
  reorder: (id: string, toIndex: number) => void;
  show: (view: ViewKind) => void;
  /** This session's state with its outputs stripped -- what a saved session
   * stores. */
  captureInputs: (id: string) => Record<string, unknown>;
}

const SessionsContext = createContext<SessionsApi | null>(null);

export function useSessions(): SessionsApi {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used inside <SessionsProvider>");
  return ctx;
}

// How long to wait after the last change before writing. Typing in a query box
// shouldn't mean an IndexedDB write per keystroke, but a refresh a second later
// should still find your work.
const PERSIST_DEBOUNCE_MS = 400;

let sessionCounter = 0;

export function SessionsProvider({ userId, children }: { userId: number; children: ReactNode }) {
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [closed, setClosed] = useState<LiveSessionSummary[]>([]);
  const [ready, setReady] = useState(false);
  // One per mounted provider, and never in state: it is bookkeeping about what
  // the server has been told, and re-rendering the workspace on every reply
  // would be a lot of renders for nothing on screen.
  const sync = useMemo(() => new WorkspaceSync(), []);
  // Set by the first local change, so a slow server reply can't land on top of
  // something typed while it was in flight.
  const touched = useRef(false);
  // reopen reads the closed list without depending on it, so it does not get a
  // new identity every time a session is closed.
  const closedRef = useRef<LiveSessionSummary[]>([]);
  closedRef.current = closed;

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setClosed([]);
    touched.current = false;

    (async () => {
      // The local copy first, so the panel is populated on the first paint
      // rather than after a round trip.
      const local = migrateSessionTypes(await loadWorkspace(userId));
      if (cancelled) return;
      setWorkspace(local);
      setReady(true);

      let open: PersistedSession[];
      try {
        const [openRows, closedRows] = await Promise.all([
          api.listLiveSessions(),
          api.listClosedLiveSessions(),
        ]);
        if (cancelled) return;
        open = openRows.map(fromWire);
        sync.adopt(openRows);
        setClosed(closedRows);
      } catch {
        // Offline, or a backend that has not been migrated yet. Keep working
        // against the local copy; the next flush pushes it up.
        return;
      }

      // Someone who had sessions before this existed, or who worked through an
      // outage, has them only in this browser -- adopting the empty server list
      // would throw them away. Keep the local ones and let the sync push them.
      if (open.length === 0 && local.sessions.length > 0) return;
      // And don't overwrite work done in the moment the request was in flight.
      if (touched.current) return;

      setWorkspace((w) => {
        const ids = new Set(open.map((session) => session.id));
        const activeId = w.activeId && ids.has(w.activeId) ? w.activeId : open[0]?.id ?? null;
        return {
          sessions: open,
          activeId,
          // Which tab this browser was on is local; falling back to home when
          // the session it pointed at is gone.
          view: w.view === "session" && !activeId ? "home" : w.view,
        };
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, sync]);

  // Persist on a trailing debounce. Writing only after `ready` matters: the
  // first render holds an empty workspace, and saving that would wipe the one
  // still being read back.
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      saveWorkspace(userId, workspace);
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, [workspace, ready, userId]);

  // A debounce loses the last few hundred milliseconds if the tab is closed
  // mid-flight, which is exactly when someone is most likely to be mid-edit.
  useEffect(() => {
    function flush() {
      if (ready) saveWorkspace(userId, workspace);
    }
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [workspace, ready, userId]);

  // And the same to the server, on a longer debounce: the local copy is
  // already safe by the time this fires, so this is about durability and
  // reaching your other browser rather than about not losing the last
  // keystroke. Only what changed goes; WorkspaceSync works that out.
  const syncPending = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (syncPending.current !== null) window.clearTimeout(syncPending.current);
    syncPending.current = window.setTimeout(() => {
      syncPending.current = null;
      sync.flush(workspace.sessions);
    }, SYNC_DEBOUNCE_MS);
    return () => {
      if (syncPending.current !== null) window.clearTimeout(syncPending.current);
    };
  }, [workspace.sessions, ready, sync]);

  const open = useCallback((type: SessionType, title: string, state: Record<string, unknown> = {}) => {
    touched.current = true;
    const id = `s${Date.now().toString(36)}${(sessionCounter++).toString(36)}`;
    setWorkspace((w) => ({
      ...w,
      sessions: [...w.sessions, { id, type, title, state }],
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
      touched.current = true;
      setWorkspace((w) => {
        const session = w.sessions.find((s) => s.id === id);
        // Moved across optimistically: a ✕ should feel instant rather than wait
        // on the network, and the list is re-read on the next load anyway.
        if (session) {
          setClosed((c) => [
            { client_id: id, type: session.type, title: session.title, truncated: !!session.truncated, closed_at: null },
            ...c.filter((s) => s.client_id !== id),
          ]);
        }
        return withoutSession(w, id);
      });
      // The row stays on the server; only its closed_at changes. Queued behind
      // any sync already running: a PUT landing after this would clear
      // closed_at and quietly reopen the session. A session that never reached
      // the server has nothing to close, so a 404 here is the expected outcome
      // rather than a failure.
      sync.forget(id);
      sync.enqueue(() => api.closeLiveSession(id));
    },
    [sync],
  );

  const reopen = useCallback(
    (id: string) => {
      touched.current = true;
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
        .then((row) => put(fromWire(row)))
        .catch(() => {
          // Offline, or a session that never reached the server. Open it with
          // what the panel knows rather than not at all; `truncated` is what
          // already exists to explain an empty one.
          put({ id, type: summary.type, title: summary.title, state: {}, truncated: true });
        });
    },
    [],
  );

  const remove = useCallback(
    (id: string) => {
      touched.current = true;
      setWorkspace((w) => withoutSession(w, id));
      setClosed((c) => c.filter((s) => s.client_id !== id));
      sync.forget(id);
      sync.enqueue(() => api.deleteLiveSession(id));
    },
    [sync],
  );

  const activate = useCallback((id: string) => {
    setWorkspace((w) => ({ ...w, activeId: id, view: "session" }));
  }, []);

  const rename = useCallback((id: string, title: string) => {
    touched.current = true;
    setWorkspace((w) => ({
      ...w,
      sessions: w.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  }, []);

  const reorder = useCallback((id: string, toIndex: number) => {
    touched.current = true;
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

  const captureInputs = useCallback(
    (id: string) => {
      const session = workspace.sessions.find((s) => s.id === id);
      if (!session) return {};
      return Object.fromEntries(Object.entries(session.state).filter(([key]) => isInputStateKey(key)));
    },
    [workspace.sessions],
  );

  // Pages call this (through useSessionState) on every change they want kept.
  const writeState = useCallback((sessionId: string, key: string, value: unknown) => {
    touched.current = true;
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

  // Named `sessionsApi` rather than `api`: the module-level `api` is the HTTP
  // client, and shadowing it here would quietly break the calls above.
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
      activate,
      rename,
      reorder,
      show,
      captureInputs,
    }),
    [workspace, closed, ready, open, close, reopen, remove, activate, rename, reorder, show, captureInputs],
  );

  return (
    <SessionsContext.Provider value={sessionsApi}>
      <WriteStateContext.Provider value={writeState}>{children}</WriteStateContext.Provider>
    </SessionsContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

type WriteState = (sessionId: string, key: string, value: unknown) => void;
const WriteStateContext = createContext<WriteState | null>(null);

interface SessionScope {
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
  const scope = useMemo(() => ({ id: session.id, read: () => latest.current }), [session.id]);
  return <SessionScopeContext.Provider value={scope}>{children}</SessionScopeContext.Provider>;
}

export function useSessionScope(): SessionScope | null {
  return useContext(SessionScopeContext);
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
  useEffect(() => {
    if (!scope || !write) return;
    if (Object.is(lastWritten.current, value)) return;
    lastWritten.current = value;
    write(scope.id, fullKey, value);
  }, [scope, write, fullKey, value]);

  return [value, setValue];
}
