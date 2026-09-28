/**
 * The conversations with the platform agent, and how the panel shows them.
 *
 * Two kinds of conversation, one tab each in the agent panel:
 *
 * - **Global** -- one for the whole app, about the platform: start sessions,
 *   look across everything. Held in memory; it survives moving around the
 *   app, not a reload.
 * - **Session** -- one per session, about that session: change it, build a
 *   query into one of its panes, ask about rows checked in it (attached to
 *   the question). Kept in the session's own state (`agentChat`), so it syncs
 *   to your other browsers and comes back with the session. This is what the
 *   ✦ Ask AI assistant was for; the agent replaced it.
 *
 * The agent works on the server. What it changes arrives in the panes
 * through live sync; what this adds is the commentary -- its words as they
 * stream, each tool it uses -- and, with Follow on in the global chat, going
 * to each session it works on as it gets there.
 *
 * Only one turn runs at a time, whichever conversation it's in.
 */

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AgentChatMessage, AgentEvent, AgentStatus, api, ApiError } from "../api";
import { useSessions, useWriteSessionState } from "../sessions/SessionContext";
import { SessionSelection } from "./selection";

export interface AgentStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "failed";
  summary?: string;
  sessionId?: string;
}

export interface AgentTurn {
  id: string;
  question: string;
  /** What came attached, in words ("3 rows from CloudWatch") -- the rows
   * themselves went to the agent, and aren't kept. */
  attached?: string;
  answer: string;
  steps: AgentStep[];
  status: "running" | "done" | "failed" | "stopped";
  error?: string;
}

export type AgentScope = "global" | "session";
export type AgentLayout = "dock" | "float";

/** The session state key a session's conversation lives under. */
export const SESSION_CHAT_KEY = "agentChat";

interface AgentApi {
  /** Null until fetched. */
  status: AgentStatus | null;
  globalTurns: AgentTurn[];
  /** A session's conversation, the turn in flight included. */
  sessionTurns: (sessionId: string) => AgentTurn[];
  running: boolean;
  /** Which conversation the running turn belongs to. */
  runningIn: { scope: AgentScope; sessionId: string | null } | null;
  ask: (text: string, scope: AgentScope, selection?: SessionSelection) => void;
  stop: () => void;
  clear: (scope: AgentScope) => void;
  /** The session the Session tab is about: the one on screen. */
  viewingSessionId: string | null;
  follow: boolean;
  setFollow: (follow: boolean) => void;
  tab: AgentScope;
  setTab: (tab: AgentScope) => void;
  layout: AgentLayout;
  setLayout: (layout: AgentLayout) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const AgentContext = createContext<AgentApi | null>(null);

export function useAgent(): AgentApi {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used inside <AgentProvider>");
  return ctx;
}

// How much of a conversation goes with each turn. Older than this, the agent
// has the sessions themselves to look at.
const HISTORY_TURNS = 20;
// How much of a session's conversation it keeps. It rides along with the
// session's state everywhere that goes, so it can't grow without end.
const KEPT_TURNS = 40;
// What a question may carry of the rows checked in its session: enough to
// answer from, well inside what one message may be (the backend takes 60k).
const ATTACH_CHARS = 40_000;
const ATTACH_CELL_CHARS = 2_000;

function history(turns: AgentTurn[]): AgentChatMessage[] {
  return turns
    .filter((t) => t.status !== "running" && t.answer.trim())
    .slice(-HISTORY_TURNS)
    .flatMap((t) => [
      { role: "user" as const, content: t.attached ? `${t.question}\n\n(Attached: ${t.attached}.)` : t.question },
      { role: "assistant" as const, content: t.answer },
    ]);
}

function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The question as the agent receives it, with the checked rows after it --
 * cut down to fit, and saying so if they were. */
function withAttachment(question: string, selection: SessionSelection): { content: string; attached: string } | null {
  const rows = selection.rows();
  if (rows.length === 0) return null;
  const clipped = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        const text = typeof v === "string" ? v : JSON.stringify(v);
        return [k, text && text.length > ATTACH_CELL_CHARS ? `${text.slice(0, ATTACH_CELL_CHARS)}…` : v];
      }),
    ),
  );
  const kept: unknown[] = [];
  let size = 2;
  for (const row of clipped) {
    const next = JSON.stringify(row).length + 1;
    if (size + next > ATTACH_CHARS) break;
    kept.push(row);
    size += next;
  }
  const panes = selection.summaries.map((s) => s.pane).join(", ");
  const note = kept.length < rows.length ? ` -- the first ${kept.length}, to fit` : "";
  const content =
    `${question}\n\n---\nChecked rows attached (${rows.length}, from ${panes})${note}:\n` +
    "```json\n" +
    JSON.stringify(kept, null, 1) +
    "\n```";
  const attached = selection.summaries.map((s) => `${s.count} from ${s.pane}`).join(", ");
  return { content, attached: `${rows.length === 1 ? "1 row" : `${rows.length} rows`} (${attached})` };
}

/** A finished turn as a session keeps it: small, and never "running". */
function forKeeping(turn: AgentTurn): AgentTurn {
  return {
    ...turn,
    status: turn.status === "running" ? "failed" : turn.status,
    steps: turn.steps.map((s) => ({
      ...s,
      status: s.status === "running" ? "failed" : s.status,
      summary: s.summary && s.summary.length > 300 ? `${s.summary.slice(0, 300)}…` : s.summary,
    })),
  };
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // best-effort persistence only
  }
}

// Per browser, like the rail's own open/closed: how you like the panel laid
// out is a working preference, not workspace data.
const LAYOUT_KEY = "cwi-agent-layout";
const OPEN_KEY = "cwi-agent-open";

let turnCounter = 0;

export function AgentProvider({ children }: { children: ReactNode }) {
  const { sessions, activeId, view, activate } = useSessions();
  const writeSessionState = useWriteSessionState();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [globalTurns, setGlobalTurns] = useState<AgentTurn[]>([]);
  // The turn in flight, whichever conversation it's in. A session's turn
  // joins that session's stored conversation only once it's over: writing
  // every streamed word into session state would sync the session a word at
  // a time.
  const [live, setLive] = useState<{ scope: AgentScope; sessionId: string | null; turn: AgentTurn } | null>(null);
  const [follow, setFollow] = useState(true);
  const [tab, setTab] = useState<AgentScope>("global");
  const [layout, setLayoutState] = useState<AgentLayout>(() => readStored(LAYOUT_KEY, ["dock", "float"], "dock"));
  const [open, setOpenState] = useState(() => readStored(OPEN_KEY, ["open", "closed"], "closed") === "open");
  const abortRef = useRef<AbortController | null>(null);
  const [pendingFollow, setPendingFollow] = useState<string | null>(null);

  const setLayout = useCallback((next: AgentLayout) => {
    setLayoutState(next);
    store(LAYOUT_KEY, next);
  }, []);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    store(OPEN_KEY, next ? "open" : "closed");
  }, []);

  useEffect(() => {
    api
      .getAgentStatus()
      .then(setStatus)
      .catch(() => setStatus({ available: false, enabled: false }));
  }, []);

  const viewingSessionId = view === "session" ? activeId : null;

  // Read through refs by `ask`, so a turn asks about what is on screen and
  // what has been said at that moment without `ask` changing every render.
  const viewingRef = useRef(viewingSessionId);
  viewingRef.current = viewingSessionId;
  const followRef = useRef(follow);
  followRef.current = follow;
  const globalRef = useRef(globalTurns);
  globalRef.current = globalTurns;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const storedTurns = useCallback((sessionId: string): AgentTurn[] => {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    const stored = session?.state[SESSION_CHAT_KEY];
    return Array.isArray(stored) ? (stored as AgentTurn[]) : [];
  }, []);

  useEffect(() => {
    if (!pendingFollow) return;
    if (!sessions.some((s) => s.id === pendingFollow)) return;
    if (!(view === "session" && activeId === pendingFollow)) activate(pendingFollow);
    setPendingFollow(null);
  }, [pendingFollow, sessions, view, activeId, activate]);

  const sessionTurns = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      const stored = session?.state[SESSION_CHAT_KEY];
      const turns = Array.isArray(stored) ? (stored as AgentTurn[]) : [];
      return live && live.scope === "session" && live.sessionId === sessionId ? [...turns, live.turn] : turns;
    },
    [sessions, live],
  );

  const ask = useCallback(
    (text: string, scope: AgentScope, selection?: SessionSelection) => {
      const question = text.trim();
      if (!question || abortRef.current) return;
      const sessionId = scope === "session" ? viewingRef.current : null;
      if (scope === "session" && !sessionId) return;

      const attachment = selection ? withAttachment(question, selection) : null;
      const earlier = scope === "global" ? globalRef.current : storedTurns(sessionId!);
      const messages = [
        ...history(earlier),
        { role: "user" as const, content: attachment ? attachment.content : question },
      ];
      const id = `t${Date.now().toString(36)}${(turnCounter++).toString(36)}`;
      const first: AgentTurn = { id, question, attached: attachment?.attached, answer: "", steps: [], status: "running" };
      setLive({ scope, sessionId, turn: first });

      const controller = new AbortController();
      abortRef.current = controller;
      let turn = first;
      const change = (next: (t: AgentTurn) => AgentTurn) => {
        turn = next(turn);
        setLive((prev) => (prev && prev.turn.id === id ? { ...prev, turn } : prev));
      };

      const onEvent = (event: AgentEvent) => {
        if (event.type === "text") {
          change((t) => ({ ...t, answer: t.answer + event.delta }));
        } else if (event.type === "tool_call") {
          change((t) => ({
            ...t,
            steps: [...t.steps, { id: event.id, name: event.name, args: event.args ?? {}, status: "running" }],
          }));
        } else if (event.type === "tool_result") {
          change((t) => ({
            ...t,
            steps: t.steps.map((s) =>
              s.id === event.id
                ? { ...s, status: event.ok ? "ok" : "failed", summary: event.summary, sessionId: event.session_id }
                : s,
            ),
          }));
          // A session's chat is about the session already on screen; only
          // the global one goes places.
          if (scope === "global" && event.ok && event.session_id && followRef.current) {
            setPendingFollow(event.session_id);
          }
        } else if (event.type === "error") {
          change((t) => ({ ...t, status: "failed", error: event.message }));
        } else if (event.type === "done") {
          change((t) => (t.status === "running" ? { ...t, status: "done" } : t));
        }
      };

      api
        .agentChat(
          { messages, viewing_session_id: scope === "session" ? sessionId : viewingRef.current, timezone: timezone(), scope },
          onEvent,
          controller.signal,
        )
        .then(() =>
          change((t) =>
            t.status === "running" ? { ...t, status: "failed", error: "The agent's reply ended before it finished." } : t,
          ),
        )
        .catch((e: unknown) => {
          if (controller.signal.aborted) change((t) => ({ ...t, status: "stopped" }));
          else change((t) => ({ ...t, status: "failed", error: e instanceof ApiError || e instanceof Error ? e.message : String(e) }));
        })
        .finally(() => {
          abortRef.current = null;
          const done = forKeeping(turn);
          if (scope === "global") {
            setGlobalTurns((prev) => [...prev, done]);
          } else {
            writeSessionState(sessionId!, SESSION_CHAT_KEY, [...storedTurns(sessionId!), done].slice(-KEPT_TURNS));
          }
          setLive(null);
        });
    },
    [storedTurns, writeSessionState],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const clear = useCallback(
    (scope: AgentScope) => {
      if (abortRef.current) return;
      if (scope === "global") setGlobalTurns([]);
      else if (viewingRef.current) writeSessionState(viewingRef.current, SESSION_CHAT_KEY, []);
    },
    [writeSessionState],
  );

  const shownGlobal = useMemo(
    () => (live && live.scope === "global" ? [...globalTurns, live.turn] : globalTurns),
    [globalTurns, live],
  );

  const value = useMemo(
    () => ({
      status,
      globalTurns: shownGlobal,
      sessionTurns,
      running: live !== null,
      runningIn: live ? { scope: live.scope, sessionId: live.sessionId } : null,
      ask,
      stop,
      clear,
      viewingSessionId,
      follow,
      setFollow,
      tab,
      setTab,
      layout,
      setLayout,
      open,
      setOpen,
    }),
    [status, shownGlobal, sessionTurns, live, ask, stop, clear, viewingSessionId, follow, tab, layout, setLayout, open, setOpen],
  );
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
