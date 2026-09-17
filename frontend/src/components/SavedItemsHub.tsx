import { useState } from "react";
import { IotSavedSearch, SavedQuery, SavedSession } from "../api";
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

type TabId = "logs-queries" | "iot-searches" | "logs-sessions" | "iot-sessions" | "http-requests" | "mqtt-topics";

const TABS: { id: TabId; label: string }[] = [
  { id: "logs-queries", label: "Log Queries" },
  { id: "iot-searches", label: "IoT Searches" },
  { id: "logs-sessions", label: "Logs Sessions" },
  { id: "iot-sessions", label: "IoT Sessions" },
  { id: "http-requests", label: "HTTP Requests" },
  { id: "mqtt-topics", label: "MQTT Topics" },
];

export default function SavedItemsHub(props: Props) {
  const [tab, setTab] = useState<TabId>("logs-queries");

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

      {tab === "logs-sessions" && (
        <SavedSessionEditorPanel
          description="A full working-state snapshot from the Logs page — environments, filters, query, and so on — created via its &quot;Save session&quot; button. The raw JSON below is editable directly; load it on the Logs page to see it applied."
          kind="json"
          items={props.savedSessions.filter((s) => s.page === "logs")}
          onCreate={(name, state) => props.onCreateSession("logs", name, state)}
          onUpdate={props.onUpdateSession}
          onDelete={props.onDeleteSession}
        />
      )}

      {tab === "iot-sessions" && (
        <SavedSessionEditorPanel
          description="A full working-state snapshot from the IoT page, created via its &quot;Save session&quot; button. The raw JSON below is editable directly; load it on the IoT page to see it applied."
          kind="json"
          items={props.savedSessions.filter((s) => s.page === "iot")}
          onCreate={(name, state) => props.onCreateSession("iot", name, state)}
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
