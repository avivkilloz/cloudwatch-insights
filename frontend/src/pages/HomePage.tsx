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
 * Nothing here opens a session by itself any more. Choosing how many of each
 * card and pressing Create is the one way in, so "what is this session for" is
 * answered when it is made rather than left as "CloudWatch 3".
 */

/** A ceiling on one card's count, not a limit on the session: panes can still
 * be added from inside it. Ten CloudWatch panes is already more than a screen
 * holds, and a typo of 100 would be a lot of pages to mount at once. */
const MAX_PER_TYPE = 10;

export default function HomePage() {
  const { user } = useAuth();
  const { show } = useSessions();
  const { start } = useStartSession();
  // How many panes of each kind the new session gets; absent means none.
  const [counts, setCounts] = useState<Partial<Record<SessionType, number>>>({});
  const [name, setName] = useState("");

  const panes = SESSION_TYPES.filter((t) => t.enabledFor(user));
  const pages = PAGES.filter((p) => p.onHome && p.enabledFor(user));

  function setCount(type: SessionType, n: number) {
    const next = Math.min(MAX_PER_TYPE, Math.max(0, Math.floor(Number.isFinite(n) ? n : 0)));
    setCounts((prev) => ({ ...prev, [type]: next }));
  }

  /** In the order they are offered, not the order they were counted, so the
   * session's tabs read the same way the cards below do -- and all of one
   * kind together. */
  function chosen(): SessionType[] {
    return panes.flatMap((t) => Array<SessionType>(counts[t.type] ?? 0).fill(t.type));
  }

  function create() {
    start(chosen(), name);
    setCounts({});
    setName("");
  }

  const total = chosen().length;

  return (
    <div className="home">
      <div className="panel">
        <h2 style={{ marginBottom: 4 }}>New session</h2>
        <p className="muted home-group-blurb">
          Choose what it should hold — any mix, and more than one of a kind if you like; you can add and close panes
          later too. The agent can work across all of them at once.
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
          <button className="home-create" onClick={create} title="Start a session holding the panes you have chosen">
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
                {inGroup.map((t) => {
                  const n = counts[t.type] ?? 0;
                  return (
                    <div key={t.type} className={`home-card${n > 0 ? " picked" : ""}`}>
                      {/* The card itself adds one -- the biggest target on it,
                          and the thing you most likely came to do; the stepper
                          below is for setting an exact number, or taking one
                          back. */}
                      <button
                        className="home-card-open"
                        onClick={() => setCount(t.type, n + 1)}
                        title={`One more ${t.label} pane in the new session`}
                      >
                        <span className="home-card-title">{t.label}</span>
                        <span className="home-card-desc">{t.description}</span>
                      </button>
                      <div className="home-card-count" role="group" aria-label={`How many ${t.label} panes`}>
                        <button
                          className="secondary"
                          onClick={() => setCount(t.type, n - 1)}
                          disabled={n === 0}
                          aria-label={`One fewer ${t.label}`}
                          title={`One fewer ${t.label}`}
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min={0}
                          max={MAX_PER_TYPE}
                          value={n}
                          onChange={(e) => setCount(t.type, e.target.valueAsNumber)}
                          onFocus={(e) => e.target.select()}
                          aria-label={`Number of ${t.label} panes`}
                        />
                        <button
                          className="secondary"
                          onClick={() => setCount(t.type, n + 1)}
                          disabled={n === MAX_PER_TYPE}
                          aria-label={`One more ${t.label}`}
                          title={`One more ${t.label}`}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <p className="muted" style={{ margin: "14px 0 0", fontSize: 12 }}>
          {total === 0
            ? "Nothing chosen — Create makes an empty session you can fill from inside it."
            : `Create makes a session holding ${total} pane${total === 1 ? "" : "s"}.`}
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
