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
import ToolsPage from "./ToolsPage";

const SESSION_PAGE = "aggregator";

type ServiceId = "logs" | "iot" | "tables" | "buckets" | "cognito" | "tools";
type Layout = "columns" | "stacked";

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
  // Not a searchable service, but the thing you most often need *beside* one:
  // decode the JWT a request came in with, or replay the call that produced
  // the log line you're reading, without losing either pane's state. The HTTP
  // client carries its own assistant, so opening it here registers it as
  // another target the shared assistant can write for and ask about.
  {
    id: "tools",
    label: "Tools",
    render: () => <ToolsPage />,
    enabledFor: (u) => !!u?.tools_enabled,
  },
];

export default function AggregatorPage() {
  const { user } = useAuth();
  const [services, setServices] = useState<ServiceId[]>([]);
  const [layout, setLayout] = useState<Layout>("columns");
  // Panes collapsed to just their header. Independent per pane -- minimising
  // one says nothing about the others, unlike a single "focused" pane would.
  const [minimized, setMinimized] = useState<Set<ServiceId>>(new Set());
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

  // Which pane is mid-drag, and which one it's currently hovering over. Only
  // the highlight lives in state; the order itself is `services`.
  const [dragging, setDragging] = useState<ServiceId | null>(null);
  const [dropTarget, setDropTarget] = useState<ServiceId | null>(null);

  // The checkbox list keeps its fixed order, but the panes follow `services`,
  // which is what reordering rewrites.
  const available = SERVICES.filter((s) => s.enabledFor(user));
  const open = services
    .map((id) => SERVICES.find((s) => s.id === id))
    .filter((s): s is (typeof SERVICES)[number] => !!s);

  function toggleService(id: ServiceId) {
    setServices((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
    // Closing a pane shouldn't leave it minimised for the next time it's opened.
    setMinimized((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** Moves a pane one place earlier (-1) or later (+1) in the order. */
  function moveService(id: ServiceId, delta: number) {
    setServices((prev) => {
      const from = prev.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  /** Drops `id` into the slot `over` currently occupies, shifting the rest. */
  function dropService(id: ServiceId, over: ServiceId) {
    if (id === over) return;
    setServices((prev) => {
      const from = prev.indexOf(id);
      const to = prev.indexOf(over);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  function toggleMinimized(id: ServiceId) {
    setMinimized((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    // Sessions saved before this mode was renamed carry the old "focus" value.
    setLayout(state.layout === "columns" ? "columns" : "stacked");
    setMinimized(new Set());
  }

  // Rows from every open pane, each tagged with the service it came from so
  // the assistant can tell a log line from a Cognito user once they're pooled.
  function taggedSelection(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const pane of panesRef.current.values()) {
      const label = DOMAIN_LABELS[pane.domain];
      for (const row of pane.selectedRows) out.push({ service: label, ...row });
    }
    return out;
  }

  const activeSummary = summaries.find((s) => s.id === target) ?? summaries[0];
  const activePane = activeSummary ? panesRef.current.get(activeSummary.id) : undefined;
  const totalSelected = summaries.reduce((n, s) => n + s.selectedCount, 0);
  const contributing = summaries.filter((s) => s.selectedCount > 0);
  // Any pane re-running its search changes the pooled result set, so the
  // "About results" thread should start over.
  const combinedVersion = summaries.reduce((n, s) => n + s.resultsVersion, 0);

  return (
    <>
      <div className="panel">
        <h2>Session</h2>
        <p className="muted">
          Pick what you're debugging across — any of the search tabs, plus the Tools page — and work with them side by
          side, each with its own state. Drag a pane by its title bar to reorder them, or use the arrows on it. The AI
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
          <button className={layout === "stacked" ? "" : "secondary"} onClick={() => setLayout("stacked")}>
            Stacked
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
      {/* Minimising only hides a pane's body -- it stays mounted in both
          layouts, so its results and any in-flight search survive, which is the
          whole point of working across services at once. */}
      <AiPaneRegistryContext.Provider value={registry}>
        <div className={layout === "columns" ? "aggregator-columns" : "aggregator-stack"}>
          {open.map((s, i) => {
            const collapsed = minimized.has(s.id);
            // Which way "earlier" and "later" actually look depends on the
            // layout, so the arrows follow it rather than always saying up/down.
            const back = layout === "columns" ? "left" : "up";
            const forward = layout === "columns" ? "right" : "down";
            return (
              <section
                key={s.id}
                className={
                  "aggregator-pane" +
                  (collapsed ? " collapsed" : "") +
                  (dragging === s.id ? " dragging" : "") +
                  (dropTarget === s.id && dragging !== s.id ? " drop-target" : "")
                }
                // The drop zone is the whole pane, not just its title bar, so
                // there's something to aim at once a pane is minimised too.
                onDragOver={(e) => {
                  if (!dragging || dragging === s.id) return;
                  e.preventDefault();
                  setDropTarget(s.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging) dropService(dragging, s.id);
                  setDragging(null);
                  setDropTarget(null);
                }}
              >
                {/* The whole title bar toggles, so the buttons on it have to
                    stop their click bubbling -- otherwise minimise would fire
                    twice and cancel itself out, and closing would also toggle.
                    It's also the drag handle: a completed drag doesn't fire a
                    click, so reordering doesn't minimise the pane on the way. */}
                <header
                  className="aggregator-pane-header"
                  draggable
                  onDragStart={(e) => {
                    setDragging(s.id);
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox won't start a drag without some payload set.
                    e.dataTransfer.setData("text/plain", s.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropTarget(null);
                  }}
                  onClick={() => toggleMinimized(s.id)}
                  title={`${collapsed ? "Expand" : "Minimise"} ${s.label} — drag to reorder`}
                >
                  <span className="aggregator-drag-handle" aria-hidden="true">
                    ⠿
                  </span>
                  <h3>{s.label}</h3>
                  <button
                    className="secondary"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveService(s.id, -1);
                    }}
                    title={`Move ${s.label} ${back}`}
                    aria-label={`Move ${s.label} ${back}`}
                  >
                    {layout === "columns" ? "◀" : "▲"}
                  </button>
                  <button
                    className="secondary"
                    disabled={i === open.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      moveService(s.id, 1);
                    }}
                    title={`Move ${s.label} ${forward}`}
                    aria-label={`Move ${s.label} ${forward}`}
                  >
                    {layout === "columns" ? "▶" : "▼"}
                  </button>
                  <button
                    className="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleMinimized(s.id);
                    }}
                    aria-label={collapsed ? `Expand ${s.label}` : `Minimise ${s.label}`}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? "+" : "−"}
                  </button>
                  <button
                    className="secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleService(s.id);
                    }}
                    title={`Close ${s.label}`}
                    aria-label={`Close ${s.label}`}
                  >
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
          selectedRows={taggedSelection()}
          resultsVersion={combinedVersion}
          headerExtra={(mode) =>
            // "Build for" picks the one service a generated query is written
            // for, so it only belongs in that mode -- "About results" pools
            // every open service at once and has nothing to target.
            mode === "build_query" ? (
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
                </div>
              )
            ) : contributing.length > 0 ? (
              <p className="muted" style={{ padding: "4px 12px 0", fontSize: 11 }}>
                Across {contributing.map((s) => DOMAIN_LABELS[s.domain]).join(", ")}.
              </p>
            ) : null
          }
        />
      )}
    </>
  );
}
