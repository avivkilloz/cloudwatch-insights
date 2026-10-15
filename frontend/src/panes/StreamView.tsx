/**
 * The MQTT tester's pieces (PLATFORM_PLAN.md §16.13, D54):
 *
 * - `StreamView` (`render: stream`): messages as the server's connection
 *   receives them, newest first -- the session's copy, so every tab and
 *   member sees the same ones and a reload keeps them. Select, export, and
 *   hand the selection to the agent's chat.
 * - `TopicsEditor` (`type: topics`): topic filters as chips; add with Enter
 *   or Add, remove with ✕. Changing them while connected reconnects (the
 *   action's `restart_on`), so they take effect without a Connect.
 */

import { useState } from "react";
import ExportMenu from "../components/ExportMenu";
import { PaneSelectionShare } from "../components/paneSelection";
import { RowCheckbox, SelectAllCheckbox, useRowSelection } from "../components/rowSelection";
import { ManifestInput, ManifestOutput } from "./manifest";
import { PaneApi } from "./paneApi";

interface Message {
  id: string;
  topic: string;
  payload: string;
  timestamp: number;
}

/** A JSON payload indented; anything else as it came. */
function pretty(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return payload;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return payload;
  }
}

function toObject(m: Message): Record<string, unknown> {
  return { time: new Date(m.timestamp).toISOString(), topic: m.topic, payload: m.payload };
}

export function StreamView({ output, value, pane }: { output: ManifestOutput; value: unknown; pane: PaneApi }) {
  const messages = Array.isArray(value) ? (value as Message[]) : [];
  const [shared, setShared] = useState<Record<string, unknown>[]>([]);
  const selection = useRowSelection({
    rows: messages,
    keyOf: (m) => m.id,
    toObject,
    onSelectionChange: setShared,
    // A fresh Connect, not each new message: what you ticked stays ticked.
    resetOn: pane.resultsVersion,
  });
  const shown = selection.visibleRows;
  const can = (a: ManifestOutput["actions"][number]) => output.actions.includes(a);
  return (
    <div>
      <div className="toolbar">
        <SelectAllCheckbox selection={selection} displayed={shown} />
        <span className="muted">
          {messages.length} message{messages.length === 1 ? "" : "s"}, newest first
          {selection.selectedCount > 0 && `, ${selection.selectedCount} selected`}
        </span>
        {can("export") && (
          <ExportMenu rows={shown.map(toObject)} selectedRows={selection.selectedObjects} filename="mqtt-messages" />
        )}
      </div>
      <div className="checkbox-list stream-list">
        {shown.map((m) => (
          <div key={m.id} className="result-row stream-message">
            <div className="result-row-summary" onClick={() => selection.toggle(m)}>
              <RowCheckbox selection={selection} row={m} />
              <span className="tag">{m.topic}</span>
              <span className="muted">{new Date(m.timestamp).toLocaleTimeString()}</span>
            </div>
            <pre className="tool-json-output stream-payload">{pretty(m.payload)}</pre>
          </div>
        ))}
      </div>
      {can("attach") && <PaneSelectionShare domain={String(output.config.domain ?? pane.m.id)} selectedRows={shared} />}
    </div>
  );
}

export function TopicsEditor({
  input,
  value,
  onChange,
  placeholder,
}: {
  input: ManifestInput;
  value: unknown;
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const topics = Array.isArray(value) ? (value as string[]) : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    const topic = draft.trim();
    if (!topic) return;
    if (!topics.includes(topic)) onChange([...topics, topic]);
    setDraft("");
  };
  return (
    <div>
      <div className="row">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={placeholder}
          aria-label={`Add to ${input.key}`}
          title={input.help || undefined}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button className="secondary" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {topics.length > 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          {topics.map((t) => (
            <span key={t} className="tag topic-chip">
              {t}
              <button
                className="danger"
                style={{ padding: "0 6px", marginLeft: 4 }}
                onClick={() => onChange(topics.filter((x) => x !== t))}
                aria-label={`Remove ${t}`}
                title="Stop listening to this topic"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
