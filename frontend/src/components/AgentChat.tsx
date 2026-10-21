import { useEffect, useMemo, useRef, useState } from "react";
import Avatar from "./Avatar";
import { api } from "../api";
import { abandoned, AgentScope, AgentStep, AgentTurn, splitThinking, useAgent } from "../agent/AgentContext";
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
  if (step.preamble && step.name === "get_workflow_run") return done ? "Read this run as it is now" : "Reading this run…";
  if (step.preamble && step.name === "build_reference")
    return done ? "Read what a definition can say" : "Reading what a definition can say…";
  // The platform's check of the answer against what ran (platform-agent's
  // check.py): a failed one is followed by the agent's redo.
  if (step.preamble && step.name === "check_answer") {
    if (!done) return "Checking the answer against what ran…";
    return step.status === "failed" ? "Checked the answer: it didn't match what ran" : "Checked the answer against what ran";
  }
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
    case "list_options":
      return done ? "Listed the choices for a pane" : "Listing the choices for a pane…";
    case "list_workflows":
      return done ? "Listed the workflows" : "Listing the workflows…";
    case "run_workflow":
      return `${done ? "Ran" : "Running"} workflow “${String(a.workflow_id ?? "")}”`;
    case "get_workflow_run":
      return done ? "Read a workflow run" : "Reading a workflow run…";
    case "investigate_run":
      return done ? "Opened the run as a session" : "Opening the run as a session…";
    case "open_workflow":
      return done ? "Showed it on the Workflows page" : "Opening the Workflows page…";
    case "open_template":
      return `${done ? "Opened" : "Opening"} template “${String(a.template_id ?? "")}”`;
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
    case "set_pane_view":
      return done ? "Changed how a pane shows its results" : "Changing how a pane shows its results…";
    case "stop_pane":
      return done ? "Stopped a pane's run" : "Stopping a pane's run…";
    case "inspect_row":
      return done ? "Looked at a row in full" : "Looking at a row…";
    case "build_reference":
      return done ? "Read what a definition can say" : "Reading what a definition can say…";
    case "read_definition":
      return `${done ? "Read" : "Reading"} “${String(a.definition_id ?? "")}” as an example`;
    case "check_definition":
      return step.status === "failed" ? "Checked a draft" : done ? "Checked a draft" : "Checking a draft…";
    case "preview_definition":
      return `${done ? "Tried" : "Trying"} the draft's ${String(a.action ?? "")}`;
    case "try_definition": {
      // Trying the draft as its user will (D153); failed: something it
      // should show came back empty, and the loop's next step fixes it.
      const where = a.environment ? ` on ${String(a.environment)}` : "";
      if (step.status === "failed") return `Ran the draft${where}: something came back empty`;
      return done ? `Ran the draft${where}` : `Running the draft${where}…`;
    }
    case "propose_definition":
      // Refused when the draft has a problem: nothing reached the editor, and the step says so.
      if (step.status === "failed") return "Couldn't put the draft in the editor";
      return done ? "Put a draft in the editor" : "Putting a draft in the editor…";
    case "edit_definition":
      return done ? "Edited the draft" : "Editing the draft…";
    // The Builder's loop (platform-agent's builder.py, D116): its own steps,
    // the model's two kinds of answer among them.
    case "plan_change":
      if (step.status === "failed") return "Couldn't work out what to change";
      return done ? "Worked out what to change" : "Working out what to change…";
    case "write_changes":
      if (step.status === "failed") return "Couldn't write the changes";
      return done ? "Wrote the changes" : "Writing the changes…";
    case "change_definition":
      // Failed: refused, or made and then not checking clean -- either way the
      // loop sends it back, and the next step is the fix.
      if (step.status === "failed") return "Tried a change: it needs fixing";
      return done ? "Changed the draft" : "Changing the draft…";
    case "describe_aws_operation":
      return `${done ? "Looked up" : "Looking up"} ${String(a.service ?? "")} ${String(a.operation ?? "")}`.trimEnd();
    case "read_draft":
      return done ? "Read the draft" : "Reading the draft…";
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

function elapsed(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** What a running turn is doing, and for how long. There the whole time it
 * runs: "Thinking…" used to show only until the first step, so the long
 * quiet while a reasoning model worked out its next step read as the agent
 * having stopped. Another browser's turn (a member's, or this user's other
 * tab) has no steps to show here, only that it's being answered. */
function TurnProgress({ turn, live }: { turn: AgentTurn; live: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  let doing: string;
  if (!live) {
    doing = turn.author ? `Answering ${turn.author.name}` : "Answering in another tab";
  } else {
    const step = [...turn.steps].reverse().find((s) => s.status === "running");
    if (step) doing = describe(step);
    else if (splitThinking(turn.answer).answer) doing = "Writing the answer";
    else if (turn.steps.length) doing = "Working out the next step";
    else doing = "Thinking";
  }
  const seconds = turn.startedAt ? Math.max(0, Math.floor((now - turn.startedAt) / 1000)) : null;
  return (
    <p className="agent-progress" role="status">
      <span className="agent-progress-dot" aria-hidden="true" />
      {doing.replace(/…$/, "")}…
      {seconds !== null && <span className="agent-progress-time">{elapsed(seconds)}</span>}
    </p>
  );
}

/** Who asked, drawn beside what they said in a session's or a run's chat (D129). */
interface Asker {
  username: string;
  avatarUrl?: string | null;
}

// Past this many, a turn's choices are a dropdown.
const MAX_CHOICE_BUTTONS = 6;

function Turn({
  turn,
  mine,
  live,
  asker,
  onFix,
  onChoose,
}: {
  turn: AgentTurn;
  mine: boolean;
  live: boolean;
  asker?: Asker | null;
  /** A build turn that ended with problems left: ask for them to be fixed. */
  onFix?: () => void;
  /** The last turn's choices, while nothing runs: a pick is the next turn. */
  onChoose?: (option: string) => void;
}) {
  // Turns stored before reasoning was kept apart still carry it inline.
  const legacy = splitThinking(turn.answer);
  const thoughts = [turn.thoughts ?? "", legacy.thoughts].filter((t) => t.trim()).join("\n\n");
  const answer = legacy.answer;
  // Left "running" by a browser that went away: its stream, and the turn,
  // ended with it.
  const gone = !live && abandoned(turn, Date.now());
  const running = turn.status === "running" && !gone;
  return (
    <div className="agent-turn">
      {asker ? (
        <div className={`agent-question-row${mine ? "" : " theirs"}`}>
          <Avatar username={asker.username} avatarUrl={asker.avatarUrl} size={24} />
          <div className={`agent-question${mine ? "" : " agent-question-theirs"}`}>
            {turn.author && <span className="agent-turn-author">{turn.author.name}</span>}
            {turn.question}
            {turn.attached && <div className="agent-attached">📎 {turn.attached}</div>}
          </div>
        </div>
      ) : (
        <div className={`agent-question${mine ? "" : " agent-question-theirs"}`}>
          {turn.author && <span className="agent-turn-author">{turn.author.name}</span>}
          {turn.question}
          {turn.attached && <div className="agent-attached">📎 {turn.attached}</div>}
        </div>
      )}
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
          {running && <TurnProgress turn={turn} live={live} />}
          {gone && <p className="error-text">This wasn't answered: the browser that asked it closed before the agent finished.</p>}
          {turn.notice && (
            <p className="agent-notice">
              ⚠ {turn.notice}
              {/* The editor's problems, sent back for fixing: people copied
                  Check's list into the chat by hand to get the same. */}
              {onFix && (
                <>
                  {" "}
                  <button className="link-button agent-fix" onClick={onFix}>
                    Fix what's left
                  </button>
                </>
              )}
            </p>
          )}
          {turn.choices && onChoose && turn.choices.options.length > 0 && (
            // The environments to try a draft on (D153): the user's call,
            // since it runs as them, against something real.
            <div className="agent-choices" role="group" aria-label={turn.choices.prompt}>
              <span className="muted">{turn.choices.prompt}</span>
              {turn.choices.options.length <= MAX_CHOICE_BUTTONS ? (
                turn.choices.options.map((option) => (
                  <button key={option} className="secondary agent-choice" onClick={() => onChoose(option)}>
                    {option}
                  </button>
                ))
              ) : (
                // A deployment with many environments: a wall of buttons
                // pushed the compose box out of sight.
                <select className="agent-choice-select" value="" onChange={(e) => e.target.value && onChoose(e.target.value)}>
                  <option value="">Choose…</option>
                  {turn.choices.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
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
  run:
    "Ask about this run: what it ran with, what a stage found, why one failed or waits. It can open the run as a " +
    "session to look further, or start it again. Everyone who can see the run's outputs shares this chat.",
  build:
    "Say what it should do, or what to change: the agent writes the definition, checks it and puts it in the " +
    "editor for you to look over and save. It never saves anything itself.",
};

const SHARED_INTRO =
  "This session's shared, so this is a chat: whoever's on it can talk here too. The agent only joins in when a " +
  "message mentions @platform-agent.";

export default function AgentChat({ scope }: { scope: AgentScope }) {
  const {
    status,
    globalTurns,
    sessionTurns,
    runTurns,
    buildTurns,
    running,
    runningIn,
    liveTurnId,
    ask,
    stop,
    clear,
    follow,
    setFollow,
    setTab,
    viewingSessionId,
    viewingRun,
    viewingBuild,
    viewingSessionShared,
  } = useAgent();
  const { user } = useAuth();
  const { sessions, activate } = useSessions();
  const selection = useSessionSelection(scope === "session" ? viewingSessionId : null);
  const [input, setInput] = useState("");
  const [attach, setAttach] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);
  const composeRef = useRef<HTMLTextAreaElement | null>(null);

  const sessionId = scope === "session" ? viewingSessionId : null;

  // Everyone's picture in this session's chat, by user id: read with the
  // session's participants, and again when a turn's author isn't among them
  // (someone invited since). The turns hold only an id and a name -- a
  // picture in every turn would be the same image stored over and over.
  const [pictures, setPictures] = useState<Map<number, Asker>>(new Map());
  const authorKey = (scope === "session" && sessionId ? sessionTurns(sessionId) : [])
    .map((t) => t.author?.id)
    .filter((id): id is number => id !== undefined && !pictures.has(id))
    .join(",");
  useEffect(() => {
    if (scope !== "session" || !sessionId) return;
    let cancelled = false;
    api.listSessionParticipants(sessionId).then(
      (list) =>
        !cancelled &&
        setPictures(new Map(list.map((p) => [p.user_id, { username: p.username, avatarUrl: p.avatar_url ?? null }]))),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [scope, sessionId, authorKey]);
  const me: Asker | null = user ? { username: user.username, avatarUrl: user.avatar_url } : null;
  const askerOf = (t: AgentTurn): Asker | null => {
    if (scope !== "session" && scope !== "run") return null;
    if (!t.author || t.author.id === user?.id) return me;
    return pictures.get(t.author.id) ?? { username: t.author.name };
  };

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
  const runId = scope === "run" ? (viewingRun?.runId ?? null) : null;
  const buildKey = scope === "build" ? (viewingBuild?.key ?? null) : null;
  const turns =
    scope === "global"
      ? globalTurns
      : scope === "run"
        ? runId !== null
          ? runTurns(runId)
          : []
        : scope === "build"
          ? buildKey !== null
            ? buildTurns(buildKey)
            : []
          : sessionId
            ? sessionTurns(sessionId)
            : [];
  const last = turns[turns.length - 1];
  const checked = selection.summaries.reduce((n, s) => n + s.count, 0);
  // Busy elsewhere: one turn at a time, and it isn't in this conversation.
  const busyElsewhere =
    running &&
    runningIn !== null &&
    (runningIn.scope !== scope ||
      (scope === "session" && runningIn.sessionId !== sessionId) ||
      (scope === "run" && runningIn.runId !== runId) ||
      (scope === "build" && runningIn.buildKey !== buildKey));

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
            : scope === "run" && runId === null
              ? "Open a run to talk to the agent about it."
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
            {scope === "run" && viewingRun ? <strong>{viewingRun.title}. </strong> : null}
            {scope === "build" && viewingBuild ? <strong>{viewingBuild.title}. </strong> : null}
            {shared ? SHARED_INTRO : INTRO[scope]}
          </p>
        )}
        {turns.map((t, i) => (
          <Turn
            key={t.id}
            turn={t}
            mine={!t.author || t.author.id === user?.id}
            live={t.id === liveTurnId}
            asker={askerOf(t)}
            onFix={
              scope === "build" && t.notice && i === turns.length - 1 && !running
                ? () => ask(`Carry on: fix what's left. ${t.notice}`, scope)
                : undefined
            }
            onChoose={
              scope === "build" && t.choices?.action === "try" && i === turns.length - 1 && !running
                ? (option) => ask(`Try it on ${option}`, scope, undefined, { tryOn: option })
                : undefined
            }
          />
        ))}
        <div ref={endRef} />
      </div>
      {unavailable && <p className="error-text">{unavailable}</p>}
      {busyElsewhere && runningIn && (
        // One turn at a time: say where the running one is, and take you there.
        <p className="muted agent-busy-note" role="status">
          <span className="agent-progress-dot" aria-hidden="true" />
          The agent is still answering in{" "}
          {runningIn.scope === "global"
            ? "the Global chat"
            : runningIn.scope === "run"
              ? "a run's chat"
              : runningIn.scope === "build"
                ? "an editor's chat"
              : `“${sessions.find((x) => x.id === runningIn.sessionId)?.title ?? "another session"}”`}
          ; it can take this when it's done.{" "}
          <button
            className="link-button"
            onClick={() => {
              if (runningIn.scope === "session" && runningIn.sessionId) activate(runningIn.sessionId);
              setTab(runningIn.scope === "global" ? "global" : "session");
            }}
          >
            Show
          </button>
        </p>
      )}
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
            placeholder={
              shared
                ? "Chat, or mention @platform-agent…"
                : scope === "session"
                  ? "Ask about this session…"
                  : scope === "run"
                    ? "Ask about this run…"
                    : scope === "build"
                      ? "Describe what to build or change…"
                      : "Ask the agent…"
            }
            aria-label={
              scope === "session"
                ? "Message the agent about this session"
                : scope === "run"
                  ? "Message the agent about this run"
                  : scope === "build"
                    ? "Message the agent about what's in the editor"
                    : "Message the agent"
            }
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
          {(scope === "global" || scope === "run") && (
            <label className="agent-follow" title="Go to each session the agent works on, as it gets there">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
            </label>
          )}
          {turns.length > 0 && !running && scope !== "run" && (
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
