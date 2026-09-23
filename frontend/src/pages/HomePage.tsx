import { useState } from "react";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { defaultSessionName, useStartSession } from "../sessions/start";
import { GROUP_BLURB, GROUP_ORDER, SESSION_TYPES } from "../sessions/registry";
import { PAGES } from "./pageTypes";

/**
 * The landing view, and the only place a session is started.
 *
 * A session is an Aggregator holding panes, so starting one is choosing what
 * goes in it and what to call it -- which is what the card at the top is. The
 * cards below it are the rest of the platform: pages you go to rather than
 * open a copy of.
 *
 * Nothing here opens a session by itself any more. Ticking a card and pressing
 * Create is the one way in, so "what is this session for" is answered when it
 * is made rather than left as "CloudWatch 3".
 */
export default function HomePage() {
  const { user } = useAuth();
  const { show } = useSessions();
  const { start } = useStartSession();
  const [picked, setPicked] = useState<Set<SessionType>>(new Set());
  const [name, setName] = useState("");

  const panes = SESSION_TYPES.filter((t) => t.enabledFor(user));
  const pages = PAGES.filter((p) => p.onHome && p.enabledFor(user));

  function toggle(type: SessionType) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  /** In the order they are offered, not the order they were ticked, so the
   * session's tabs read the same way the cards below do. */
  function chosen(): SessionType[] {
    return panes.filter((t) => picked.has(t.type)).map((t) => t.type);
  }

  function create() {
    start(chosen(), name);
    setPicked(new Set());
    setName("");
  }

  return (
    <div className="home">
      <div className="panel">
        <h2 style={{ marginBottom: 4 }}>New session</h2>
        <p className="muted home-group-blurb">
          Pick what it should hold — as many as you like, and you can add and remove them later. One assistant sees
          across all of them at once.
        </p>

        <div className="home-new-row">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
              placeholder={defaultSessionName(chosen())}
              aria-label="Name for the new session"
            />
          </label>
          <button className="home-create" onClick={create} title="Start a session holding what you have ticked">
            Create
          </button>
        </div>

        {GROUP_ORDER.map((group) => {
          const inGroup = panes.filter((t) => t.group === group);
          if (inGroup.length === 0) return null;
          return (
            <div key={group}>
              <h3 style={{ margin: "14px 0 2px", fontSize: 13 }}>{group}</h3>
              <p className="muted home-group-blurb">{GROUP_BLURB[group]}</p>
              <div className="home-cards">
                {inGroup.map((t) => (
                  <div key={t.type} className={`home-card${picked.has(t.type) ? " picked" : ""}`}>
                    {/* The whole card toggles: there is nothing else it could
                        do now that a card no longer opens anything by itself. */}
                    <button className="home-card-open" onClick={() => toggle(t.type)} aria-pressed={picked.has(t.type)}>
                      <span className="home-card-title">{t.label}</span>
                      <span className="home-card-desc">{t.description}</span>
                    </button>
                    <input
                      className="home-card-pick"
                      type="checkbox"
                      checked={picked.has(t.type)}
                      onChange={() => toggle(t.type)}
                      aria-label={`Include ${t.label} in the new session`}
                      title={`Include ${t.label} in the new session`}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        <p className="muted" style={{ margin: "14px 0 0", fontSize: 12 }}>
          {picked.size === 0
            ? "Nothing ticked — Create makes an empty session you can fill from inside it."
            : `Create makes a session holding ${picked.size} page${picked.size === 1 ? "" : "s"}.`}
        </p>
      </div>

      {/* The rest of the platform: pages, not sessions. You go to one rather
          than having several open, which is why they are not in the panel's
          list of sessions. */}
      <div className="panel">
        <h2 style={{ marginBottom: 4 }}>Platform</h2>
        <p className="muted home-group-blurb">
          The app's own pages. Unlike a session you don't open copies of these — there is one of each, and you go to it.
        </p>
        <div className="home-cards">
          {pages.map((p) => (
            <div key={p.id} className="home-card">
              <button className="home-card-open" onClick={() => show(p.id)}>
                <span className="home-card-title">{p.label}</span>
                <span className="home-card-desc">{p.description}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
