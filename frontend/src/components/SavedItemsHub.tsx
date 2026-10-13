import { useState } from "react";
import { SavedSession } from "../api";
import { SESSION_SAVED_PAGE } from "../sessions/registry";
import { TEMPLATE_PAGES } from "../sessions/templates";
import SavedInputsPanel from "./SavedInputsPanel";
import SavedSessionEditorPanel from "./SavedSessionEditorPanel";

interface Props {
  /** All saved sessions, every page -- the tab content below filters by `page` itself. */
  savedSessions: SavedSession[];
  onCreateSession: (page: string, name: string, state: Record<string, unknown>) => Promise<void>;
  onUpdateSession: (id: number, payload: { name?: string; state?: Record<string, unknown> }) => Promise<void>;
  onDeleteSession: (id: number) => Promise<void>;
}

type TabId = "session-templates" | "saved-inputs" | "mqtt-topics";

/* Templates first: a whole session is the biggest thing you can save, and the
   rest are inputs you load inside one. The per-service "sessions" tabs that
   used to sit here are gone -- a service is a pane now, not a session, so
   nothing has written one since; the ones saved back then are listed under
   Session templates, which is also where Add offers them. */
// Saved inputs are every ported pane's (D46); the stores after them go as
// their panes are ported -- S3's and DynamoDB's (3b-1), IoT's searches and
// the HTTP client's requests (3b-2) and the logs panes' queries (3b-3)
// already have, leaving MQTT's topics.
const TABS: { id: TabId; label: string }[] = [
  { id: "session-templates", label: "Templates" },
  { id: "saved-inputs", label: "Saved inputs" },
  { id: "mqtt-topics", label: "MQTT Topics" },
];

export default function SavedItemsHub(props: Props) {
  const [tab, setTab] = useState<TabId>("session-templates");

  return (
    <div className="panel">
      <h2>Library</h2>
      <div className="tabs" style={{ justifySelf: "start", marginBottom: 14, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "session-templates" && (
        <SavedSessionEditorPanel
          description="A saved session: which panes it opens, how they're laid out and the inputs they start with, written by &quot;Save as template…&quot; in a session's ⋮ menu. These are what the panel's Add list offers — starting one makes a new session seeded from it, and nothing you then do changes the copy here. Templates saved when a single service was a session are listed here too; each opens as a session holding that one pane. The raw JSON below is editable directly."
          kind="json"
          items={props.savedSessions.filter((s) => TEMPLATE_PAGES.includes(s.page))}
          onCreate={(name, state) => props.onCreateSession(SESSION_SAVED_PAGE, name, state)}
          onUpdate={props.onUpdateSession}
          onDelete={props.onDeleteSession}
        />
      )}

      {tab === "saved-inputs" && <SavedInputsPanel />}

      {tab === "mqtt-topics" && (
        <SavedSessionEditorPanel
          description="Available from the MQTT Tester tool's &quot;Load saved topic…&quot; dropdowns."
          kind="mqtt-topic"
          items={props.savedSessions.filter((s) => s.page === "tools-mqtt-topics")}
          onCreate={(name, state) => props.onCreateSession("tools-mqtt-topics", name, state)}
          onUpdate={props.onUpdateSession}
          onDelete={props.onDeleteSession}
        />
      )}
    </div>
  );
}
