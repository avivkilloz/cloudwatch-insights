import { useState } from "react";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { GROUP_BLURB, GROUP_ORDER, SESSION_TYPES } from "../sessions/registry";

/**
 * The landing view: a card per session type, grouped by what it's for.
 *
 * Clicking a card opens that session. Ticking several raises a floating
 * Aggregate button -- in the same corner as the ✦ Ask AI button on every other
 * page -- which opens one Aggregator session with exactly those panes. The
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
      {GROUP_ORDER.map((group) => {
        const inGroup = types.filter((t) => t.group === group);
        if (inGroup.length === 0) return null;
        return (
          <div className="panel" key={group}>
            <h2 style={{ marginBottom: 4 }}>{group}</h2>
            <p className="muted home-group-blurb">{GROUP_BLURB[group]}</p>
            <div className="home-cards">
              {inGroup.map((t) => {
                const selectable = pickable.includes(t);
                return (
                  <div key={t.type} className={`home-card${picked.has(t.type) ? " picked" : ""}`}>
                    <button className="home-card-open" onClick={() => open(t.type, nextTitle(t.label))}>
                      <span className="home-card-title">{t.label}</span>
                      <span className="home-card-desc">{t.description}</span>
                    </button>
                    {/* Sits over the card's top-right corner, level with the
                        title. It is outside the open button rather than inside
                        it, so ticking it never also opens the session. */}
                    {selectable && aggregator && (
                      <input
                        className="home-card-pick"
                        type="checkbox"
                        checked={picked.has(t.type)}
                        onChange={() => toggle(t.type)}
                        aria-label={`Include ${t.label} when opening an Aggregator`}
                        title={`Include ${t.label} when opening an Aggregator`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Only once something is ticked: an always-present button that does
          nothing most of the time is just noise in the corner. */}
      {aggregator && picked.size > 0 && (
        <div className="home-aggregate-fab">
          <button
            className="ai-widget-button"
            onClick={openAggregator}
            title={`Open one Aggregator session with the ${picked.size} ticked page${picked.size === 1 ? "" : "s"} side by side`}
          >
            Aggregate {picked.size}
          </button>
          <button
            className="home-aggregate-clear"
            onClick={() => setPicked(new Set())}
            title="Clear the selection"
            aria-label="Clear the selection"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
