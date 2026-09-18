import { useState } from "react";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { GROUP_ORDER, SESSION_TYPES } from "../sessions/registry";

/**
 * The landing view: a card per session type, grouped by what it's for.
 *
 * Clicking a card opens that session. Ticking several and pressing "Open in
 * Aggregator" opens one Aggregator session with exactly those panes -- the
 * Aggregator itself is unchanged, so panes can still be added and removed once
 * it's open.
 */
export default function HomePage() {
  const { user } = useAuth();
  const { sessions, open } = useSessions();
  const [picked, setPicked] = useState<Set<SessionType>>(new Set());

  const types = SESSION_TYPES.filter((t) => t.enabledFor(user));
  const aggregator = types.find((t) => t.type === "aggregator");

  function nextTitle(label: string): string {
    const taken = sessions.map((s) => s.title);
    if (!taken.includes(label)) return label;
    for (let n = 2; ; n++) {
      const candidate = `${label} ${n}`;
      if (!taken.includes(candidate)) return candidate;
    }
  }

  function toggle(type: SessionType) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function openAggregator() {
    if (!aggregator || picked.size === 0) return;
    // The Aggregator reads `services` as its open panes, so seeding that key
    // is all it takes -- no special entry point into the page itself.
    open("aggregator", nextTitle("Aggregator"), { services: Array.from(picked) });
    setPicked(new Set());
  }

  const pickable = types.filter((t) => t.paneable);

  return (
    <div className="home">
      <div className="panel">
        <h2>Start a session</h2>
        <p className="muted">
          Open any of these on its own, or tick several and open them together in one Aggregator session — you can
          still add and remove panes once it's running. Everything you open gets a tab above and keeps its state, so a
          refresh puts you back where you were.
        </p>
        {aggregator && (
          <div className="toolbar">
            <button onClick={openAggregator} disabled={picked.size === 0}>
              Open {picked.size > 0 ? picked.size : ""} in Aggregator
            </button>
            {picked.size > 0 && (
              <button className="secondary" onClick={() => setPicked(new Set())}>
                Clear selection
              </button>
            )}
            {picked.size === 0 && <span className="muted">Tick the cards you want side by side.</span>}
          </div>
        )}
      </div>

      {GROUP_ORDER.map((group) => {
        const inGroup = types.filter((t) => t.group === group);
        if (inGroup.length === 0) return null;
        return (
          <div className="panel" key={group}>
            <h2>{group}</h2>
            <div className="home-cards">
              {inGroup.map((t) => {
                const selectable = pickable.includes(t);
                return (
                  <div key={t.type} className={`home-card${picked.has(t.type) ? " picked" : ""}`}>
                    <button className="home-card-open" onClick={() => open(t.type, nextTitle(t.label))}>
                      <span className="home-card-title">{t.label}</span>
                      <span className="home-card-desc">{t.description}</span>
                    </button>
                    {selectable && aggregator && (
                      <label className="home-card-pick" title={`Include ${t.label} when opening an Aggregator`}>
                        <input type="checkbox" checked={picked.has(t.type)} onChange={() => toggle(t.type)} />
                        Aggregate
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
