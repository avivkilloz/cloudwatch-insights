import { useEffect, useRef, useState } from "react";
import { api, Environment, PublishedTemplate, readableError } from "../api";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "../sessions/SessionContext";
import { defaultSessionName, useStartSession } from "../sessions/start";
import { useCatalogue } from "../sessions/catalogue";
import Icon from "../components/Icon";
import { useTemplates } from "../sessions/templates";
import { clearPublishedAsked, useOpenPublished, usePublishedAsked } from "../sessions/published";

/**
 * The landing view, and the only place a session is started.
 *
 * A session is an Aggregator holding panes, so starting one is choosing what
 * goes in it and what to call it -- which is what the card at the top is; the
 * ready-made sessions (published templates) are below it. The platform's own
 * pages aren't here: they are the rail's rows (Workflows, Builder), the
 * agent's panel and the account menu's Settings -- a card for each read as a
 * second, stray way in.
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
  const { categories, home, setHome } = useSessions();
  const { start } = useStartSession();
  // How many panes of each kind the new session gets; absent means none.
  const [counts, setCounts] = useState<Partial<Record<SessionType, number>>>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Which category it's filed in; none unless one is picked.
  const [categoryId, setCategoryId] = useState<number | null>(null);

  const catalogue = useCatalogue();
  // Hidden pane types are left out unless asked for (D66): one person's own tidying.
  const [showHidden, setShowHidden] = useState(false);
  // In the catalogue's order, which is the order the cards are in.
  const panes = catalogue.categories.flatMap((c) => c.types);

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
    start(chosen(), name, description, categoryId);
    setCounts({});
    setName("");
    setDescription("");
    setCategoryId(null);
  }

  const total = chosen().length;

  return (
    <div className="home">
      {/* The session that was the home page is gone: say so rather than
          quietly showing this page instead (R3). Dismissing clears it. */}
      {home?.missing && (
        <div className="panel home-missing" role="status">
          <span>
            Your home page, “{home.missing}”, was deleted or isn't shared with you any more, so this is the default page.
          </span>
          <button className="secondary" onClick={() => setHome(null)}>
            Dismiss
          </button>
        </div>
      )}
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
          {/* Only when there are categories to choose from; none by default. */}
          {categories.length > 0 && (
            <label className="field">
              <span className="field-label">Category</span>
              <select
                value={categoryId ?? ""}
                onChange={(e) => setCategoryId(e.target.value === "" ? null : Number(e.target.value))}
                aria-label="Category for the new session"
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="home-create" onClick={create} title="Start a session holding the panes you have chosen">
            Create
          </button>
        </div>
        <label className="field home-description">
          <span className="field-label">Description</span>
          <textarea
            value={description}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this session is for — optional, and you can change it later from the card under the side panel."
            aria-label="Description for the new session"
          />
        </label>

        {/* The catalogue's categories, in the order an admin gave them (D66);
            Favourites aren't a group of their own here, where each card has
            its own star -- in the shorter lists they come first. */}
        {catalogue.groups({ withHidden: showHidden, withFavourites: false }).map(({ name: group, description: about, types: inGroup }) => {
          return (
            <div key={group} data-category={group}>
              {/* A category without a description keeps the same space
                  before its cards, or its heading sat on them. */}
              <h3 className={`home-group-title${about ? "" : " bare"}`}>{group}</h3>
              {about && <p className="muted home-group-blurb">{about}</p>}
              <div className="home-cards">
                {inGroup.map((t) => {
                  const n = counts[t.type] ?? 0;
                  const favourite = catalogue.favourites.includes(t.type);
                  const hidden = catalogue.hidden.includes(t.type);
                  return (
                    <div
                      key={t.type}
                      data-pane-type={t.type}
                      className={`home-card${n > 0 ? " picked" : ""}${hidden ? " hidden-type" : ""}`}
                    >
                      {/* One person's own layer over the catalogue: a star puts
                          it first in the shorter lists, hiding leaves it out
                          of them. */}
                      <div className="home-card-marks">
                        <button
                          className={`icon-btn home-card-mark${favourite ? " on" : ""}`}
                          onClick={() => catalogue.setFavourite(t.type, !favourite)}
                          aria-pressed={favourite}
                          aria-label={favourite ? `Unstar ${t.label}` : `Star ${t.label}`}
                          title={favourite ? "Starred: first in your lists. Unstar" : "Star: first in your lists"}
                        >
                          <Icon name="star" />
                        </button>
                        <button
                          className={`icon-btn home-card-mark home-card-mark-hide${hidden ? " on" : ""}`}
                          onClick={() => catalogue.setHidden(t.type, !hidden)}
                          aria-pressed={hidden}
                          aria-label={hidden ? `Show ${t.label} again` : `Hide ${t.label}`}
                          title={hidden ? "Hidden from your lists. Show it again" : "Hide from your lists"}
                        >
                          <Icon name="hide" />
                        </button>
                      </div>
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

        {catalogue.hidden.length > 0 && (
          <button className="link-button home-show-hidden" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Leave out the hidden ones" : `Show hidden (${catalogue.hidden.length})`}
          </button>
        )}
        {catalogue.error && <p className="error-text">{catalogue.error}</p>}
        <p className="muted" style={{ margin: "14px 0 0", fontSize: 12 }}>
          {total === 0
            ? "Nothing chosen — Create makes an empty session you can fill from inside it."
            : `Create makes a session holding ${total} pane${total === 1 ? "" : "s"}.`}
        </p>
      </div>

      <ReadyMade />

    </div>
  );
}

/**
 * Published templates (§23, D101): sessions made for anyone, opened for the
 * environment you choose. A card that needs one asks for it in place -- asked
 * from Add or the strip's ＋ with more than one to choose from, you land here
 * with that card asking.
 */
function ReadyMade() {
  const { published } = useTemplates();
  const asked = usePublishedAsked();
  const [choosing, setChoosing] = useState<string | null>(null);
  useEffect(() => {
    if (asked) {
      setChoosing(asked);
      clearPublishedAsked();
    }
  }, [asked]);
  if (published.length === 0) return null;
  return (
    <div className="panel">
      <h2 style={{ marginBottom: 4 }}>Ready-made sessions</h2>
      <p className="muted home-group-blurb">
        Sessions put together for anyone to start from: choose the environment they're for, and they open with their
        panes filled in.
      </p>
      <div className="home-cards">
        {published.map((t) => (
          <ReadyMadeCard key={t.id} template={t} choosing={choosing === t.id} choose={(on) => setChoosing(on ? t.id : null)} />
        ))}
      </div>
    </div>
  );
}

function ReadyMadeCard({
  template: t,
  choosing,
  choose,
}: {
  template: PublishedTemplate;
  choosing: boolean;
  choose: (on: boolean) => void;
}) {
  const openPublished = useOpenPublished();
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [environment, setEnvironment] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!choosing) return;
    ref.current?.scrollIntoView({ block: "nearest" });
    api
      .listEnvironments()
      .then((list) => {
        setEnvironments(list);
        if (list.length === 1) setEnvironment(list[0].id);
      })
      .catch((e) => setError(readableError(e)));
  }, [choosing]);

  async function open(env: number | null) {
    setBusy(true);
    setError(null);
    try {
      await openPublished(t, env);
      choose(false);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className={`home-card home-ready${choosing ? " home-ready-choosing" : ""}`} data-template={t.id}>
      <button
        className="home-card-open"
        disabled={busy}
        onClick={() => (t.needs_environment ? choose(!choosing) : open(null))}
        title={t.needs_environment ? "Choose the environment it's for" : `Start a session from ${t.label}`}
      >
        <span className="home-card-title">{t.label}</span>
        {t.description && <span className="home-card-desc">{t.description}</span>}
      </button>
      {choosing && (
        <div className="home-ready-choose">
          <select
            aria-label={`Environment for ${t.label}`}
            value={environment ?? ""}
            onChange={(e) => setEnvironment(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{environments === null ? "Loading…" : "Choose environment…"}</option>
            {(environments ?? []).map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
          <button onClick={() => open(environment)} disabled={busy || environment === null}>
            {busy ? "Opening…" : "Open"}
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
