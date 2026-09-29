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
import { useAuth } from "../AuthContext";
import { useSessions, useWriteSessionState } from "../sessions/SessionContext";
import { SessionSelection } from "./selection";

export interface AgentStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "failed";
  summary?: string;
  sessionId?: string;
  /** One of the reads every turn starts with (what the asker can reach, the
   * session as it is), made by the agent service rather than chosen by the
   * model -- left out of the history sent back, since each turn makes its
   * own fresh. */
  preamble?: boolean;
}

export interface AgentTurn {
  id: string;
  question: string;
  /** What came attached, in words ("3 rows from CloudWatch") -- the rows
   * themselves went to the agent, and aren't kept. */
  attached?: string;
  answer: string;
  /** The model's reasoning, kept apart from its answer: shown folded, never
   * sent back to it. */
  thoughts?: string;
  steps: AgentStep[];
  status: "running" | "done" | "failed" | "stopped";
  error?: string;
  /** A warning about the answer, from the agent service (e.g. details in it
   * that none of the turn's tools returned). */
  notice?: string;
  /** Who asked, in a session's own chat -- several people can share one, so
   * (unlike the Global tab, always just "you") a turn has to say. Absent on
   * a turn from before sharing existed, or in the Global conversation. */
  author?: { id: number; name: string };
  /** False for a plain message between people in a shared session's chat --
   * never sent to the agent at all. Undefined (treated as true) for every
   * turn from before this existed, and always true in the Global tab. */
  agentInvoked?: boolean;
}

// The one thing that makes the agent answer in a session's chat once it has
// more than one person in it -- otherwise it would answer every message,
// drowning out the people talking to each other. `\b` keeps it from also
// matching inside a longer word ("@platform-agentic").
const AGENT_MENTION = /@platform-agent\b/i;

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
  /** Whether that session has anyone else on it -- once it does, the agent
   * only answers a message that mentions it, so the compose box can say so. */
  viewingSessionShared: boolean;
  /** Re-checks whether a session is shared right away, rather than waiting
   * for the next time it's viewed -- the session card's own invite/remove/
   * permission-change handlers call this on success, so the chat gates
   * itself correctly without needing a reload to notice. */
  refreshShared: (sessionId: string) => void;
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

/** An answer stored before reasoning was kept apart, split the same way the
 * agent service splits it now: whatever came before the last "</think>" was
 * reasoning. Without this, old turns kept showing literal "</think>" tags --
 * and fed them back to the model as if it had said them. */
export function splitThinking(answer: string): { thoughts: string; answer: string } {
  const at = answer.lastIndexOf("</think>");
  if (at < 0) return { thoughts: "", answer };
  const thoughts = answer
    .slice(0, at)
    .replace(/<\/?think>/g, "\n\n")
    .trim();
  return { thoughts, answer: answer.slice(at + "</think>".length).trim() };
}

function history(turns: AgentTurn[]): AgentChatMessage[] {
  return turns
    .filter((t) => t.status !== "running" && (t.answer.trim() || t.agentInvoked === false))
    .slice(-HISTORY_TURNS)
    .flatMap((t) => {
      const question = t.author ? `${t.author.name}: ${t.question}` : t.question;
      // A plain message nobody sent to the agent -- still worth it seeing,
      // so a later @mention has the conversation that led up to it, but
      // there's no reply of its own to include.
      if (t.agentInvoked === false) return [{ role: "user" as const, content: question }];
      // The steps go back with the answer: with only its words, the model
      // couldn't tell a reported run from a made-up one, or see whose
      // get_context an earlier "there's no such environment" came from. Each
      // goes with the provider's own id for it: one made up by the agent was
      // copied by a model as a tool's name, and the turn failed.
      const steps = t.steps
        .filter((s) => !s.preamble)
        .map((s) => ({ id: s.id, name: s.name, args: s.args, ok: s.status === "ok", summary: s.summary ?? "" }));
      return [
        { role: "user" as const, content: t.attached ? `${question}\n\n(Attached: ${t.attached}.)` : question },
        { role: "assistant" as const, content: splitThinking(t.answer).answer, ...(steps.length ? { steps } : {}) },
      ];
    });
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

// What a stored turn keeps of its reasoning: it rides along in session state.
const KEPT_THOUGHT_CHARS = 4_000;

/** A finished turn as a session keeps it: small, and never "running". */
function forKeeping(turn: AgentTurn): AgentTurn {
  return {
    ...turn,
    thoughts:
      turn.thoughts && turn.thoughts.length > KEPT_THOUGHT_CHARS
        ? `${turn.thoughts.slice(0, KEPT_THOUGHT_CHARS)}…`
        : turn.thoughts,
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
  const { user } = useAuth();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [globalTurns, setGlobalTurns] = useState<AgentTurn[]>([]);
  // Sessions the owner's own roster fetch found had at least one member --
  // an invited member always knows their own view is shared (`role` says
  // so), but the owner's own `role` is always "owner" whether or not anyone
  // else is on it, so their side needs this to know when the agent should
  // start waiting for a mention instead of answering every message.
  const [sharedSessions, setSharedSessions] = useState<Set<string>>(new Set());
  // The turn in flight, whichever conversation it's in. A session's turn
  // joins that session's stored conversation only once it's over: writing
  // every streamed word into session state would sync the session a word at
  // a time.
  const [live, setLive] = useState<{ scope: AgentScope; sessionId: string | null; turn: AgentTurn } | null>(null);
  const [follow, setFollow] = useState(true);
  // Defaults to whichever makes sense for what's on screen right now (a
  // session, or not) -- not persisted, so a fresh load re-decides rather
  // than reopening wherever the panel happened to be left last time.
  const [tab, setTab] = useState<AgentScope>(() => (view === "session" ? "session" : "global"));
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

  // Opening a session (not just switching between two already-open ones --
  // that leaves whatever tab you picked alone) defaults the panel to the
  // Session tab, the same way the initial state above does for a session
  // already on screen at load. Except while a Global turn is running: then
  // it's the agent opening the session (Follow), and switching tabs hid the
  // very turn doing it -- its steps and answer carried on out of sight.
  const prevViewRef = useRef(view);
  const liveScopeRef = useRef<AgentScope | null>(null);
  liveScopeRef.current = live?.scope ?? null;
  useEffect(() => {
    if (view === "session" && prevViewRef.current !== "session" && liveScopeRef.current !== "global") setTab("session");
    prevViewRef.current = view;
  }, [view]);

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
  const sharedSessionsRef = useRef(sharedSessions);
  sharedSessionsRef.current = sharedSessions;
  const userRef = useRef(user);
  userRef.current = user;

  const storedTurns = useCallback((sessionId: string): AgentTurn[] => {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    const stored = session?.state[SESSION_CHAT_KEY];
    return Array.isArray(stored) ? (stored as AgentTurn[]) : [];
  }, []);

  // Only the owner's own browser needs to ask -- an invited member's `role`
  // already says their view is shared. `refreshShared` (below) shares this
  // same fetch so the session card's own member-management handlers can
  // trigger it too, on success, without waiting for the next view.
  const refreshShared = useCallback((sessionId: string) => {
    api
      .listSessionMembers(sessionId)
      .then((members) => {
        setSharedSessions((prev) => {
          const has = members.length > 0;
          if (has === prev.has(sessionId)) return prev;
          const next = new Set(prev);
          if (has) next.add(sessionId);
          else next.delete(sessionId);
          return next;
        });
      })
      .catch(() => {
        // Not the owner (a member's own fetch 404s -- their `role` already
        // covers them) or offline; either way, nothing to update.
      });
  }, []);

  // Refetched whenever the session on screen changes, so switching to a
  // session catches up on a membership change made while it was last open.
  useEffect(() => {
    if (!viewingSessionId) return;
    const session = sessionsRef.current.find((s) => s.id === viewingSessionId);
    if (session?.role && session.role !== "owner") return;
    refreshShared(viewingSessionId);
  }, [viewingSessionId, refreshShared]);

  function isShared(sessionId: string): boolean {
    const role = sessionsRef.current.find((s) => s.id === sessionId)?.role;
    return (role !== undefined && role !== "owner") || sharedSessionsRef.current.has(sessionId);
  }

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

      // Several people can share one session's conversation (the Global tab
      // never has more than one); once it's actually shared, every turn
      // there says who asked, and one without a mention just joins it as a
      // message, without troubling the agent -- otherwise it would answer
      // every line of a chat, drowning out the people in it. An ordinary,
      // unshared session keeps behaving exactly as it always did: no
      // author, no gating, nothing prefixed onto the question.
      const shared = scope === "session" && isShared(sessionId!);
      const author = shared && userRef.current ? { id: userRef.current.id, name: userRef.current.username } : undefined;
      if (shared && !AGENT_MENTION.test(question)) {
        const id = `t${Date.now().toString(36)}${(turnCounter++).toString(36)}`;
        const chatTurn: AgentTurn = { id, question, author, answer: "", steps: [], status: "done", agentInvoked: false };
        writeSessionState(sessionId!, SESSION_CHAT_KEY, [...storedTurns(sessionId!), chatTurn].slice(-KEPT_TURNS));
        return;
      }

      const promptQuestion = author ? `${author.name}: ${question}` : question;
      const attachment = selection ? withAttachment(promptQuestion, selection) : null;
      const earlier = scope === "global" ? globalRef.current : storedTurns(sessionId!);
      const messages = [
        ...history(earlier),
        { role: "user" as const, content: attachment ? attachment.content : promptQuestion },
      ];
      const id = `t${Date.now().toString(36)}${(turnCounter++).toString(36)}`;
      const first: AgentTurn = {
        id,
        question,
        attached: attachment?.attached,
        answer: "",
        steps: [],
        status: "running",
        author,
        agentInvoked: true,
      };
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
        } else if (event.type === "thinking") {
          change((t) => ({ ...t, thoughts: (t.thoughts ?? "") + event.delta }));
        } else if (event.type === "retract") {
          // Words already shown that turned out to be reasoning (sent again
          // as thinking right after) or a step stopped for looping.
          change((t) => ({ ...t, answer: event.chars > 0 ? t.answer.slice(0, -event.chars) : t.answer }));
        } else if (event.type === "notice") {
          change((t) => ({ ...t, notice: event.message }));
        } else if (event.type === "tool_call") {
          change((t) => ({
            ...t,
            steps: [
              ...t.steps,
              { id: event.id, name: event.name, args: event.args ?? {}, status: "running", preamble: event.preamble },
            ],
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
      viewingSessionShared: viewingSessionId ? isShared(viewingSessionId) : false,
      refreshShared,
      follow,
      setFollow,
      tab,
      setTab,
      layout,
      setLayout,
      open,
      setOpen,
    }),
    [
      status,
      shownGlobal,
      sessionTurns,
      live,
      ask,
      stop,
      clear,
      viewingSessionId,
      refreshShared,
      sessions,
      sharedSessions,
      follow,
      tab,
      layout,
      setLayout,
      open,
      setOpen,
    ],
  );
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
