import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { AgentScope, AgentStep, AgentTurn, splitThinking, useAgent } from "../agent/AgentContext";
import { useSessionSelection } from "../agent/selection";
import { useAuth } from "../AuthContext";
import { PANE_TYPES } from "../sessions/paneTypes";
import { useSessions } from "../sessions/SessionContext";
import MarkdownLite from "./MarkdownLite";

/** The agent's own @mention handle -- always offered alongside whoever else
 * is on the session, even one with no other members, since @mentioning it is
 * always a valid thing to type (it's just never *required* until shared). */
const AGENT_HANDLE = "platform-agent";

/**
 * One conversation with the platform agent -- the global one, or the chat of
 * the session on screen: each question, the steps the agent took for it as
 * they happen, and its answer as it streams.
 */

function kindLabel(kind: unknown): string {
  return PANE_TYPES.find((t) => t.type === kind)?.label ?? String(kind ?? "a");
}

/** A step in words, as it's happening and once it's done. */
function describe(step: AgentStep): string {
  const a = step.args;
  const done = step.status !== "running";
  // The reads every turn starts with, told apart from the model's own calls
  // to the same tools -- otherwise the list opened "Looked at what you can
  // reach" twice whenever the model checked again for itself.
  if (step.preamble && step.name === "get_context")
    return done ? "Checked who's asking and what they can reach" : "Checking who's asking…";
  if (step.preamble && step.name === "get_session") return done ? "Read this session as it is now" : "Reading this session…";
  switch (step.name) {
    case "get_context":
      return done ? "Looked at what you can reach" : "Looking at what you can reach…";
    case "list_sessions":
      return done ? "Listed your sessions" : "Listing your sessions…";
    case "get_session":
      return done ? "Read a session" : "Reading a session…";
    case "list_log_groups":
      return done ? "Listed log groups" : "Listing log groups…";
    case "list_opensearch_domains":
    case "list_opensearch_indices":
      return done ? "Listed OpenSearch domains" : "Listing OpenSearch domains…";
    case "list_dynamodb_tables":
      return done ? "Listed DynamoDB tables" : "Listing DynamoDB tables…";
    case "list_s3_buckets":
      return done ? "Listed S3 buckets" : "Listing S3 buckets…";
    case "list_cognito_user_pools":
      return done ? "Listed Cognito user pools" : "Listing Cognito user pools…";
    case "create_session":
      return `${done ? "Created" : "Creating"} session “${String(a.title ?? "")}”`;
    case "add_pane":
      return `${done ? "Added" : "Adding"} a ${kindLabel(a.kind)} pane`;
    case "remove_pane":
      return done ? "Removed a pane" : "Removing a pane…";
    case "rename":
      return `${done ? "Renamed" : "Renaming"} to “${String(a.title ?? "")}”`;
    case "set_layout":
      return `${done ? "Switched" : "Switching"} to the ${String(a.layout ?? "")} layout`;
    case "arrange_dashboard":
      return done ? "Arranged the dashboard" : "Arranging the dashboard…";
    case "set_pane_inputs":
      return done ? "Filled in a pane" : "Filling in a pane…";
    case "run_pane":
      return done ? "Ran a pane" : "Running a pane…";
    case "inspect_row":
      return done ? "Looked at a row in full" : "Looking at a row…";
    case "unreadable_tool_call":
      // The model's tool call came back garbled; the agent answered it as a
      // call to no tool, so the model could try again (platform-agent's repair.py).
      return done ? "Sent a tool call that couldn't be read" : "Reading a tool call…";
    default:
      return step.name;
  }
}

function Step({ step }: { step: AgentStep }) {
  const { sessions, activate } = useSessions();
  const target = step.sessionId ? sessions.find((s) => s.id === step.sessionId) : undefined;
  const mark = step.status === "running" ? "…" : step.status === "ok" ? "✓" : "✕";
  return (
    <li className={`agent-step agent-step-${step.status}`}>
      <details>
        <summary>
          <span className="agent-step-mark" aria-hidden>
            {mark}
          </span>
          <span className="agent-step-text">{describe(step)}</span>
          {target && (
            <button
              className="agent-step-open"
              onClick={(e) => {
                e.preventDefault();
                activate(target.id);
              }}
              title={`Open ${target.title}`}
            >
              Open
            </button>
          )}
        </summary>
        <pre className="agent-step-detail">
          {JSON.stringify(step.args, null, 2)}
          {step.summary ? `\n\n${step.summary}` : ""}
        </pre>
      </details>
    </li>
  );
}

/** The model's reasoning, folded: there if you want to see how it got to its
 * answer, out of the way of the answer itself. */
function Thoughts({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="agent-thoughts">
      <summary className={live ? "agent-thinking" : undefined}>{live ? "Thinking…" : "Thought process"}</summary>
      <div className="agent-thoughts-text">{text.trim()}</div>
    </details>
  );
}

function Turn({ turn, mine }: { turn: AgentTurn; mine: boolean }) {
  // Turns stored before reasoning was kept apart still carry it inline.
  const legacy = splitThinking(turn.answer);
  const thoughts = [turn.thoughts ?? "", legacy.thoughts].filter((t) => t.trim()).join("\n\n");
  const answer = legacy.answer;
  const running = turn.status === "running";
  return (
    <div className="agent-turn">
      <div className={`agent-question${mine ? "" : " agent-question-theirs"}`}>
        {turn.author && <span className="agent-turn-author">{turn.author.name}</span>}
        {turn.question}
        {turn.attached && <div className="agent-attached">📎 {turn.attached}</div>}
      </div>
      {/* A plain message between people never went to the agent -- nothing
          of its own to show under it. */}
      {turn.agentInvoked !== false && (
        <div className="agent-answer">
          {thoughts && <Thoughts text={thoughts} live={running && !answer} />}
          {turn.steps.length > 0 && (
            <ul className="agent-steps">
              {turn.steps.map((s) => (
                <Step key={s.id} step={s} />
              ))}
            </ul>
          )}
          {answer && <MarkdownLite text={answer} />}
          {running && !answer && !thoughts && turn.steps.length === 0 && <p className="muted agent-thinking">Thinking…</p>}
          {turn.notice && <p className="agent-notice">⚠ {turn.notice}</p>}
          {turn.status === "stopped" && <p className="muted">Stopped.</p>}
          {turn.error && <p className="error-text">{turn.error}</p>}
        </div>
      )}
    </div>
  );
}

const INTRO: Record<AgentScope, string> = {
  global:
    "Ask it to look something up, and it will open the sessions and panes it needs, fill them in and run them — " +
    "you'll see each one change as it goes.",
  session:
    "Talk to it about this session: have it write or change a pane's query, add or arrange panes, or check some " +
    "rows in a pane and ask about them.",
};

const SHARED_INTRO =
  "This session's shared, so this is a chat: whoever's on it can talk here too. The agent only joins in when a " +
  "message mentions @platform-agent.";

export default function AgentChat({ scope }: { scope: AgentScope }) {
  const {
    status,
    globalTurns,
    sessionTurns,
    running,
    runningIn,
    ask,
    stop,
    clear,
    follow,
    setFollow,
    viewingSessionId,
    viewingSessionShared,
  } = useAgent();
  const { user } = useAuth();
  const { sessions } = useSessions();
  const selection = useSessionSelection(scope === "session" ? viewingSessionId : null);
  const [input, setInput] = useState("");
  const [attach, setAttach] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);

  const sessionId = scope === "session" ? viewingSessionId : null;

  // Who "@" can mention in this session's chat: every current participant,
  // plus the agent's own handle, which is always offerable. Fetched fresh
  // each time a mention *starts* (below), not cached per session view --
  // an invite made moments ago has to show up the next time someone types
  // "@", the same immediacy `refreshShared` gives the chat's own gating.
  // Small and session-scoped, so unlike the invite field's username search
  // (a global, unbounded user list) this needs no server-side prefix search
  // or debounce: fetch the whole small list once per mention, filter it
  // locally on every keystroke after that.
  const [participants, setParticipants] = useState<{ username: string }[]>([]);
  const mentionCandidates = useMemo(() => {
    const names = participants.map((p) => p.username).filter((name) => name !== user?.username);
    return [...new Set([...names, AGENT_HANDLE])];
  }, [participants, user?.username]);

  // The "@word" just before the caret, if any -- `start` is where the "@"
  // itself sits, so a pick can splice the mention in over exactly that span.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionHighlighted, setMentionHighlighted] = useState(-1);
  const mentionSuggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return mentionCandidates.filter((name) => name.toLowerCase().startsWith(q)).slice(0, 8);
  }, [mention, mentionCandidates]);

  function onComposeChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setInput(value);
    const caret = e.target.selectionStart ?? value.length;
    const match = /(?:^|\s)@([A-Za-z0-9_.-]*)$/.exec(value.slice(0, caret));
    if (match && scope === "session" && sessionId) {
      if (mention === null) {
        api
          .listSessionParticipants(sessionId)
          .then(setParticipants)
          .catch(() => setParticipants([]));
      }
      setMention({ start: caret - match[1].length - 1, query: match[1] });
      setMentionHighlighted(-1);
    } else {
      setMention(null);
    }
  }

  function pickMention(name: string) {
    if (!mention) return;
    const before = input.slice(0, mention.start);
    const after = input.slice(mention.start + 1 + mention.query.length);
    const inserted = `@${name} `;
    setInput(before + inserted + after);
    setMention(null);
    setMentionHighlighted(-1);
    // The value above hasn't reached the DOM node yet this tick -- set the
    // caret once it has, or the browser leaves it where the click landed.
    requestAnimationFrame(() => {
      const el = composeRef.current;
      if (!el) return;
      const pos = before.length + inserted.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }
  const turns = scope === "global" ? globalTurns : sessionId ? sessionTurns(sessionId) : [];
  const last = turns[turns.length - 1];
  const checked = selection.summaries.reduce((n, s) => n + s.count, 0);
  // Busy elsewhere: one turn at a time, and it isn't in this conversation.
  const busyElsewhere =
    running && runningIn !== null && (runningIn.scope !== scope || (scope === "session" && runningIn.sessionId !== sessionId));

  // Keeps the newest step or word in view as it arrives.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, last?.answer.length, last?.steps.length, scope, sessionId]);

  const sessionTitle = sessionId ? sessions.find((s) => s.id === sessionId)?.title : undefined;
  const shared = scope === "session" && viewingSessionShared;

  const unavailable =
    status === null
      ? null
      : !status.available
        ? "This deployment doesn't run the platform agent."
        : !status.enabled && !shared
          ? // A shared session's chat is people talking to each other, not just
            // to the agent -- a group without agent access still has that to
            // use. A mention still reaches ask(), which still sends it to
            // /api/agent/chat, which still 403s (unchanged) -- shown the same
            // way any other failed turn is, so there's no separate "no
            // access" message to keep in sync with the backend's own.
            "The platform agent isn't turned on for your group. An admin can turn it on in Settings, under User groups."
          : scope === "session" && !sessionId
            ? "Open a session to talk to the agent about it."
            : null;

  function send() {
    if (!input.trim() || running) return;
    ask(input, scope, scope === "session" && attach && checked > 0 ? selection : undefined);
    setInput("");
  }

  return (
    <div className="agent-chat">
      <div className="agent-transcript">
        {turns.length === 0 && !unavailable && (
          <p className="muted">
            {scope === "session" && sessionTitle ? <strong>{sessionTitle}. </strong> : null}
            {shared ? SHARED_INTRO : INTRO[scope]}
          </p>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} mine={!t.author || t.author.id === user?.id} />
        ))}
        <div ref={endRef} />
      </div>
      {unavailable && <p className="error-text">{unavailable}</p>}
      {busyElsewhere && <p className="muted">The agent is busy in another conversation; it can take this when it's done.</p>}
      <div className="agent-compose">
        {scope === "session" && checked > 0 && (
          <label className="agent-attach" title="Send the rows checked in this session's panes with the question">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach{" "}
            {checked === 1 ? "1 checked row" : `${checked} checked rows`} (
            {selection.summaries.map((s) => `${s.count} in ${s.pane}`).join(", ")})
          </label>
        )}
        <div className="agent-compose-field">
          <textarea
            ref={composeRef}
            className="agent-compose-input"
            value={input}
            rows={2}
            onChange={onComposeChange}
            onKeyDown={(e) => {
              if (mention && mentionSuggestions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionHighlighted((i) => (i + 1) % mentionSuggestions.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionHighlighted((i) => (i <= 0 ? mentionSuggestions.length - 1 : i - 1));
                  return;
                }
                if (e.key === "Escape") {
                  setMention(null);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  pickMention(mentionSuggestions[mentionHighlighted >= 0 ? mentionHighlighted : 0]);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onBlur={() => setMention(null)}
            placeholder={shared ? "Chat, or mention @platform-agent…" : scope === "session" ? "Ask about this session…" : "Ask the agent…"}
            aria-label={scope === "session" ? "Message the agent about this session" : "Message the agent"}
            disabled={!!unavailable}
          />
          {mention && mentionSuggestions.length > 0 && (
            <div className="username-suggestions" role="listbox">
              {mentionSuggestions.map((name, i) => (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={i === mentionHighlighted}
                  className={"username-suggestion" + (i === mentionHighlighted ? " active" : "")}
                  onMouseDown={(e) => {
                    // Picks before the textarea's own onBlur can close this out from under the click.
                    e.preventDefault();
                    pickMention(name);
                  }}
                >
                  @{name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="agent-compose-actions">
          {scope === "global" && (
            <label className="agent-follow" title="Go to each session the agent works on, as it gets there">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
            </label>
          )}
          {turns.length > 0 && !running && (
            <button className="secondary" onClick={() => clear(scope)}>
              Clear
            </button>
          )}
          {running && !busyElsewhere ? (
            <button className="danger" onClick={stop}>
              Stop
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim() || !!unavailable || running}>
              Ask
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
