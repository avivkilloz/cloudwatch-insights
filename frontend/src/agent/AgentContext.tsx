/**
 * The conversation with the platform agent, and what it's doing right now.
 *
 * One conversation for the whole app, held here rather than in a page, because
 * it is shown in two places: the Agent page, and the dock beside a session
 * (opened from the header's "Ask the agent…"), which is how you watch the
 * agent fill a session in while you talk to it.
 *
 * The agent works on the server; what it changes arrives in the panes through
 * live sync like any other remote change. What this adds is the running
 * commentary -- its words as they stream, and each tool it uses -- and, with
 * "Follow" on, taking you to each session it works on as it gets there.
 *
 * The conversation lives in memory: it survives moving around the app, not a
 * reload. Each turn sends the conversation so far, and the agent starts from
 * that; keeping conversations on the server is the next step.
 */

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AgentChatMessage, AgentEvent, AgentStatus, api, ApiError } from "../api";
import { useSessions } from "../sessions/SessionContext";

export interface AgentStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "failed";
  summary?: string;
  sessionId?: string;
}

export interface AgentTurn {
  id: number;
  question: string;
  answer: string;
  steps: AgentStep[];
  status: "running" | "done" | "failed" | "stopped";
  error?: string;
}

interface AgentApi {
  /** Null until fetched. */
  status: AgentStatus | null;
  turns: AgentTurn[];
  running: boolean;
  ask: (text: string) => void;
  stop: () => void;
  clear: () => void;
  /** Whether the app goes to each session the agent works on, as it does. */
  follow: boolean;
  setFollow: (follow: boolean) => void;
  /** The conversation beside whatever is on screen. */
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
}

const AgentContext = createContext<AgentApi | null>(null);

export function useAgent(): AgentApi {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgent must be used inside <AgentProvider>");
  return ctx;
}

// How much of the conversation goes with each turn. Older than this, the
// agent has the sessions themselves to look at.
const HISTORY_TURNS = 20;

function history(turns: AgentTurn[]): AgentChatMessage[] {
  return turns
    .filter((t) => t.status !== "running" && t.answer.trim())
    .slice(-HISTORY_TURNS)
    .flatMap((t) => [
      { role: "user" as const, content: t.question },
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

let turnCounter = 0;

export function AgentProvider({ children }: { children: ReactNode }) {
  const { sessions, activeId, view, activate } = useSessions();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [running, setRunning] = useState(false);
  const [follow, setFollow] = useState(true);
  const [dockOpen, setDockOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // A session the agent just touched that this tab hasn't heard about yet --
  // its create arrives through live sync a moment after the tool reports it.
  const [pendingFollow, setPendingFollow] = useState<string | null>(null);

  useEffect(() => {
    api
      .getAgentStatus()
      .then(setStatus)
      .catch(() => setStatus({ available: false, enabled: false }));
  }, []);

  // Read through a ref by `ask`, so a turn started from anywhere asks about
  // what is on screen at that moment without `ask` changing every render.
  const viewingRef = useRef<string | null>(null);
  viewingRef.current = view === "session" ? activeId : null;
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    if (!pendingFollow) return;
    if (!sessions.some((s) => s.id === pendingFollow)) return;
    if (!(view === "session" && activeId === pendingFollow)) activate(pendingFollow);
    setPendingFollow(null);
  }, [pendingFollow, sessions, view, activeId, activate]);

  const update = useCallback((id: number, change: (turn: AgentTurn) => AgentTurn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? change(t) : t)));
  }, []);

  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const ask = useCallback(
    (text: string) => {
      const question = text.trim();
      if (!question || abortRef.current) return;
      const id = ++turnCounter;
      const messages = [...history(turnsRef.current), { role: "user" as const, content: question }];
      setTurns((prev) => [...prev, { id, question, answer: "", steps: [], status: "running" }]);
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const onEvent = (event: AgentEvent) => {
        if (event.type === "text") {
          update(id, (t) => ({ ...t, answer: t.answer + event.delta }));
        } else if (event.type === "tool_call") {
          update(id, (t) => ({
            ...t,
            steps: [...t.steps, { id: event.id, name: event.name, args: event.args ?? {}, status: "running" }],
          }));
        } else if (event.type === "tool_result") {
          update(id, (t) => ({
            ...t,
            steps: t.steps.map((s) =>
              s.id === event.id
                ? { ...s, status: event.ok ? "ok" : "failed", summary: event.summary, sessionId: event.session_id }
                : s,
            ),
          }));
          if (event.ok && event.session_id && followRef.current) setPendingFollow(event.session_id);
        } else if (event.type === "error") {
          update(id, (t) => ({ ...t, status: "failed", error: event.message }));
        } else if (event.type === "done") {
          update(id, (t) => (t.status === "running" ? { ...t, status: "done" } : t));
        }
      };

      api
        .agentChat({ messages, viewing_session_id: viewingRef.current, timezone: timezone() }, onEvent, controller.signal)
        .then(() =>
          update(id, (t) =>
            t.status === "running" ? { ...t, status: "failed", error: "The agent's reply ended before it finished." } : t,
          ),
        )
        .catch((e: unknown) => {
          if (controller.signal.aborted) {
            update(id, (t) => ({ ...t, status: "stopped" }));
          } else {
            const message = e instanceof ApiError || e instanceof Error ? e.message : String(e);
            update(id, (t) => ({ ...t, status: "failed", error: message }));
          }
        })
        .finally(() => {
          abortRef.current = null;
          setRunning(false);
          // Mark anything still spinning as settled: the turn is over.
          update(id, (t) => ({
            ...t,
            steps: t.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" } : s)),
          }));
        });
    },
    [update],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const clear = useCallback(() => {
    if (!abortRef.current) setTurns([]);
  }, []);

  const value = useMemo(
    () => ({ status, turns, running, ask, stop, clear, follow, setFollow, dockOpen, setDockOpen }),
    [status, turns, running, ask, stop, clear, follow, dockOpen],
  );
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
