import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, SavedSession } from "../api";
import { useAuth } from "../AuthContext";
import AiAssistantWidget from "../components/AiAssistantWidget";
import {
  AiPane,
  AiPaneRegistryContext,
  AiPaneSummary,
  DOMAIN_LABELS,
  sameSummaries,
  summarizePane,
} from "../components/aiPanes";
import BucketsPage from "./BucketsPage";
import CognitoPage from "./CognitoPage";
import InsightsPage from "./InsightsPage";
import IotPage from "./IotPage";
import TablesPage from "./TablesPage";

const SESSION_PAGE = "aggregator";

type ServiceId = "logs" | "iot" | "tables" | "buckets" | "cognito";
type Layout = "columns" | "focus";

interface AggregatorSessionState {
  services: ServiceId[];
  layout: Layout;
}

const SERVICES: {
  id: ServiceId;
  label: string;
  render: () => JSX.Element;
  enabledFor: (u: any) => boolean;
}[] = [
  {
    id: "logs",
    label: "Logs",
    render: () => <InsightsPage />,
    enabledFor: (u) => !!u?.logs_enabled,
  },
  {
    id: "iot",
    label: "IoT",
    render: () => <IotPage />,
    enabledFor: (u) => !!u?.iot_enabled,
  },
  {
    id: "tables",
    label: "Tables",
    render: () => <TablesPage />,
    enabledFor: (u) => !!u?.tables_enabled,
  },
  {
    id: "buckets",
    label: "Buckets",
    render: () => <BucketsPage />,
    enabledFor: (u) => !!u?.buckets_enabled,
  },
  {
    id: "cognito",
    label: "Cognito",
    render: () => <CognitoPage />,
    enabledFor: (u) => !!u?.cognito_enabled,
  },
];

export default function AggregatorPage() {
  const { user } = useAuth();
  const [services, setServices] = useState<ServiceId[]>([]);
  const [layout, setLayout] = useState<Layout>("columns");
  const [focused, setFocused] = useState<ServiceId | null>(null);
  const [savedSessions, setSavedSessions] = useState<SavedSession<AggregatorSessionState>[]>([]);

  // Panes register their full context (including the row arrays) here on every
  // render. Keeping it in a ref means that churn never re-renders this page;
  // `summaries` below holds only the small comparable slice the UI needs.
  const panesRef = useRef(new Map<string, AiPane>());
  const [summaries, setSummaries] = useState<AiPaneSummary[]>([]);
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    api.listSavedSessions<AggregatorSessionState>(SESSION_PAGE).then(setSavedSessions);
  }, []);

  const syncSummaries = useCallback(() => {
    const next = Array.from(panesRef.current.values()).map(summarizePane);
    setSummaries((prev) => (sameSummaries(prev, next) ? prev : next));
  }, []);

  const registry = useMemo(
    () => ({
      register(pane: AiPane) {
        panesRef.current.set(pane.id, pane);
        syncSummaries();
      },
      unregister(id: string) {
        panesRef.current.delete(id);
        syncSummaries();
      },
    }),
    [syncSummaries],
  );

  const available = SERVICES.filter((s) => s.enabledFor(user));
  const open = SERVICES.filter((s) => services.includes(s.id));

  function toggleService(id: ServiceId) {
    setServices((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
    setFocused((prev) => (prev === id ? null : prev));
  }

  async function saveCurrentSession() {
    const name = prompt("Save aggregator session as:");
    if (!name) return;
    const saved = await api.createSavedSession<AggregatorSessionState>({
      page: SESSION_PAGE,
      name,
      state: { services, layout },
    });
    setSavedSessions((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function applySession(state: AggregatorSessionState) {
    setServices(state.services.filter((id) => available.some((s) => s.id === id)));
    setLayout(state.layout);
    setFocused(null);
  }

  // Rows from every open pane, each tagged with the service it came from so
  // the assistant can tell a log line from a Cognito user once they're pooled.
  function taggedRows(pick: (pane: AiPane) => Record<string, unknown>[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const pane of panesRef.current.values()) {
      const label = DOMAIN_LABELS[pane.domain];
      for (const row of pick(pane)) out.push({ service: label, ...row });
    }
    return out;
  }

  const activeSummary = summaries.find((s) => s.id === target) ?? summaries[0];
  const activePane = activeSummary ? panesRef.current.get(activeSummary.id) : undefined;
  const totalSelected = summaries.reduce((n, s) => n + s.selectedCount, 0);
  const totalRows = summaries.reduce((n, s) => n + s.rowCount, 0);
  // Any pane re-running its search changes the pooled result set, so the
  // "About results" thread should start over.
  const combinedVersion = summaries.reduce((n, s) => n + s.resultsVersion, 0);

  return (
    <>
      <div className="panel">
        <h2>Session</h2>
        <p className="muted">
          Pick the services you're debugging across and work with them side by side, each with its own searches. The AI
          assistant spans all of them: ask about the rows you've checked across every service at once, or have it write
          a query for any one of them using what you selected in the others as examples.
        </p>
        <div className="toolbar">
          {available.map((s) => (
            <label key={s.id} className="checkbox-item">
              <input type="checkbox" checked={services.includes(s.id)} onChange={() => toggleService(s.id)} />
              {s.label}
            </label>
          ))}
        </div>
        <div className="toolbar">
          <span className="muted">Layout</span>
          <button className={layout === "columns" ? "" : "secondary"} onClick={() => setLayout("columns")}>
            Side by side
          </button>
          <button className={layout === "focus" ? "" : "secondary"} onClick={() => setLayout("focus")}>
            One at a time
          </button>
          <select
            onChange={(e) => {
              const s = savedSessions.find((x) => String(x.id) === e.target.value);
              if (s) applySession(s.state);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved session…
            </option>
            {savedSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentSession} disabled={services.length === 0}>
            Save session
          </button>
        </div>
      </div>

      {open.length === 0 && (
        <div className="panel">
          <p className="muted">Choose one or more services above to start a session.</p>
        </div>
      )}

      {/* Only the panes go inside the provider. The shared widget below must
          stay outside it, or it would register itself as a pane and render
          nothing -- leaving the page with no assistant at all. */}
      {/* Every pane stays mounted in both layouts -- "One at a time" only
          collapses the others, so their results and in-flight searches survive
          switching focus, which is the whole point of working across services. */}
      <AiPaneRegistryContext.Provider value={registry}>
        <div className={layout === "columns" ? "aggregator-columns" : "aggregator-stack"}>
          {open.map((s) => {
            const collapsed = layout === "focus" && focused !== null && focused !== s.id;
            return (
              <section key={s.id} className={`aggregator-pane${collapsed ? " collapsed" : ""}`}>
                <header className="aggregator-pane-header">
                  <h3>{s.label}</h3>
                  {layout === "focus" && (
                    <button className="secondary" onClick={() => setFocused(focused === s.id ? null : s.id)}>
                      {focused === s.id ? "Show all" : "Focus"}
                    </button>
                  )}
                  <button className="secondary" onClick={() => toggleService(s.id)} title={`Close ${s.label}`}>
                    ✕
                  </button>
                </header>
                <div className="aggregator-pane-body" hidden={collapsed}>
                  {s.render()}
                </div>
              </section>
            );
          })}
        </div>
      </AiPaneRegistryContext.Provider>

      {open.length > 0 && (
        <AiAssistantWidget
          domain={activePane?.domain ?? "logs-cloudwatch"}
          askDomain="aggregator"
          modes={activePane?.modes ?? ["ask_results"]}
          queryString={activePane?.queryString}
          onUseQuery={activePane?.onUseQuery}
          sampleRows={taggedRows((p) => p.rows)}
          rowCount={totalRows}
          selectedRows={taggedRows((p) => p.selectedRows)}
          resultsVersion={combinedVersion}
          headerExtra={
            summaries.length > 1 && (
              <div className="ai-widget-header" style={{ borderBottom: "none", paddingBottom: 0 }}>
                <label className="row" style={{ gap: 6, fontSize: 11 }}>
                  <span className="muted">Build for</span>
                  <select
                    value={activeSummary?.id ?? ""}
                    onChange={(e) => setTarget(e.target.value)}
                    style={{ fontSize: 11, padding: "2px 6px" }}
                  >
                    {summaries.map((s) => (
                      <option key={s.id} value={s.id}>
                        {DOMAIN_LABELS[s.domain]}
                      </option>
                    ))}
                  </select>
                </label>
                {totalSelected > 0 && <span className="muted">{totalSelected} checked across all services</span>}
              </div>
            )
          }
        />
      )}
    </>
  );
}
