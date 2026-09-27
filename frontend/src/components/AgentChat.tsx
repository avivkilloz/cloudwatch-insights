import { useEffect, useRef, useState } from "react";
import { AgentStep, AgentTurn, useAgent } from "../agent/AgentContext";
import { PANE_TYPES } from "../sessions/paneTypes";
import { useSessions } from "../sessions/SessionContext";
import MarkdownLite from "./MarkdownLite";

/**
 * The conversation with the platform agent: each question, the steps the
 * agent took for it as they happen, and its answer as it streams. The same
 * component on the Agent page and in the dock beside a session -- it's one
 * conversation, shown wherever you are.
 */

function kindLabel(kind: unknown): string {
  return PANE_TYPES.find((t) => t.type === kind)?.label ?? String(kind ?? "a");
}

/** A step in words, as it's happening and once it's done. */
function describe(step: AgentStep): string {
  const a = step.args;
  const done = step.status !== "running";
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

function Turn({ turn }: { turn: AgentTurn }) {
  return (
    <div className="agent-turn">
      <div className="agent-question">{turn.question}</div>
      <div className="agent-answer">
        {turn.steps.length > 0 && (
          <ul className="agent-steps">
            {turn.steps.map((s) => (
              <Step key={s.id} step={s} />
            ))}
          </ul>
        )}
        {turn.answer && <MarkdownLite text={turn.answer} />}
        {turn.status === "running" && !turn.answer && turn.steps.length === 0 && (
          <p className="muted agent-thinking">Thinking…</p>
        )}
        {turn.status === "stopped" && <p className="muted">Stopped.</p>}
        {turn.error && <p className="error-text">{turn.error}</p>}
      </div>
    </div>
  );
}

export default function AgentChat() {
  const { status, turns, running, ask, stop, clear, follow, setFollow } = useAgent();
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const last = turns[turns.length - 1];

  // Keeps the newest step or word in view as it arrives.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, last?.answer.length, last?.steps.length]);

  const unavailable =
    status === null
      ? null
      : !status.available
        ? "This deployment doesn't run the platform agent."
        : !status.enabled
          ? "The platform agent isn't turned on for your group. An admin can turn it on in Settings, under User groups."
          : null;

  function send() {
    if (!input.trim() || running) return;
    ask(input);
    setInput("");
  }

  return (
    <div className="agent-chat">
      <div className="agent-transcript">
        {turns.length === 0 && (
          <p className="muted">
            Ask it to look something up, and it will open the sessions and panes it needs, fill them in and run them —
            you'll see each one change as it goes.
          </p>
        )}
        {turns.map((t) => (
          <Turn key={t.id} turn={t} />
        ))}
        <div ref={endRef} />
      </div>
      {unavailable && <p className="error-text">{unavailable}</p>}
      <div className="agent-compose">
        <textarea
          className="agent-compose-input"
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask the agent…"
          aria-label="Message the agent"
          disabled={!!unavailable}
        />
        <div className="agent-compose-actions">
          <label className="agent-follow" title="Go to each session the agent works on, as it gets there">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
          {turns.length > 0 && !running && (
            <button className="secondary" onClick={clear}>
              Clear
            </button>
          )}
          {running ? (
            <button className="danger" onClick={stop}>
              Stop
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim() || !!unavailable}>
              Ask
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
