import { useState } from "react";
import { IotSavedSearch, SavedQuery, SavedSession } from "../api";
import { SESSION_SAVED_PAGE } from "../sessions/registry";
import { TEMPLATE_PAGES } from "../sessions/templates";
import SavedItemsPanel from "./SavedItemsPanel";
import SavedSessionEditorPanel from "./SavedSessionEditorPanel";

interface Props {
  savedQueries: SavedQuery[];
  onCreateSavedQuery: (payload: { name: string; query_string: string; backend?: string }) => Promise<void>;
  onUpdateSavedQuery: (id: number, payload: { name: string; query_string: string; backend?: string }) => Promise<void>;
  onDeleteSavedQuery: (id: number) => Promise<void>;

  iotSavedSearches: IotSavedSearch[];
  onCreateIotSearch: (payload: { name: string; query_string: string; search_mode?: string }) => Promise<void>;
  onUpdateIotSearch: (id: number, payload: { name: string; query_string: string; search_mode?: string }) => Promise<void>;
  onDeleteIotSearch: (id: number) => Promise<void>;

  /** All saved sessions, every page -- the tab content below filters by `page` itself. */
  savedSessions: SavedSession[];
  onCreateSession: (page: string, name: string, state: Record<string, unknown>) => Promise<void>;
  onUpdateSession: (id: number, payload: { name?: string; state?: Record<string, unknown> }) => Promise<void>;
  onDeleteSession: (id: number) => Promise<void>;
}

type TabId =
  | "session-templates"
  | "logs-queries"
  | "iot-searches"
  | "buckets"
  | "tables"
  | "http-requests"
  | "mqtt-topics";

/* Templates first: a whole session is the biggest thing you can save, and the
   rest are inputs you load inside one. The per-service "sessions" tabs that
   used to sit here are gone -- a service is a pane now, not a session, so
   nothing has written one since; the ones saved back then are listed under
   Session templates, which is also where Add offers them. */
const TABS: { id: TabId; label: string }[] = [
  { id: "session-templates", label: "Session Templates" },
  { id: "logs-queries", label: "Log Queries" },
  { id: "iot-searches", label: "IoT Searches" },
  { id: "buckets", label: "S3" },
  { id: "tables", label: "DynamoDB" },
  { id: "http-requests", label: "HTTP Requests" },
  { id: "mqtt-topics", label: "MQTT Topics" },
];

export default function SavedItemsHub(props: Props) {
  const [tab, setTab] = useState<TabId>("session-templates");

  return (
    <div className="panel">
      <h2>Saved items</h2>
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

      {tab === "logs-queries" && (
        <SavedItemsPanel
          description="Available from the Logs page's &quot;Load saved query&quot; dropdown. Each is tagged with the backend (CloudWatch or OpenSearch) it's written for, and the dropdown only offers queries matching whichever backend is currently selected."
          queryLabel="Query"
          items={props.savedQueries}
          onCreate={props.onCreateSavedQuery}
          onUpdate={props.onUpdateSavedQuery}
          onDelete={props.onDeleteSavedQuery}
          extra={{
            key: "backend",
            label: "Backend",
            options: [
              { value: "cloudwatch", label: "CloudWatch" },
              { value: "opensearch", label: "OpenSearch (Lucene)" },
            ],
            defaultValue: "cloudwatch",
            getValue: (item) => item.backend,
          }}
        />
      )}

      {tab === "iot-searches" && (
        <SavedItemsPanel
          description="Available from the IoT page's &quot;Load saved search&quot; dropdown."
          queryLabel="Search query"
          items={props.iotSavedSearches}
          onCreate={props.onCreateIotSearch}
          onUpdate={props.onUpdateIotSearch}
          onDelete={props.onDeleteIotSearch}
          extra={{
            key: "search_mode",
            label: "Search mode",
            options: [
              { value: "things", label: "Things" },
              { value: "certificates", label: "Certificates" },
            ],
            defaultValue: "things",
            getValue: (item) => item.search_mode,
          }}
        />
      )}

      {tab === "buckets" && (
        <SavedSessionEditorPanel
          description="Available from the Buckets page's &quot;Load saved bucket…&quot; dropdown, created via its &quot;Save current bucket&quot; button."
          kind="json"
          items={props.savedSessions.filter((s) => s.page === "buckets")}
          onCreate={(name, state) => props.onCreateSession("buckets", name, state)}
          onUpdate={props.onUpdateSession}
          onDelete={props.onDeleteSession}
        />
      )}

      {tab === "tables" && (
        <SavedSessionEditorPanel
          description="Available from the Tables page's &quot;Load saved table…&quot; dropdown, created via its &quot;Save current table&quot; button."
          kind="json"
          items={props.savedSessions.filter((s) => s.page === "tables")}
          onCreate={(name, state) => props.onCreateSession("tables", name, state)}
          onUpdate={props.onUpdateSession}
          onDelete={props.onDeleteSession}
        />
      )}

      {tab === "http-requests" && (
        <SavedSessionEditorPanel
          description="Available from the HTTP Client tool's &quot;Load saved request…&quot; dropdown."
          kind="http"
          items={props.savedSessions.filter((s) => s.page === "tools-http")}
          onCreate={(name, state) => props.onCreateSession("tools-http", name, state)}
          onUpdate={props.onUpdateSession}
          onDelete={props.onDeleteSession}
        />
      )}

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
