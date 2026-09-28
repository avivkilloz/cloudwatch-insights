import { useRef, useState } from "react";
import { useSessions, useWriteSessionState } from "../sessions/SessionContext";
import { PaneTitles, PaneTypes, paneTitle } from "../sessions/panes";
import { SESSION_DESCRIPTION_KEY } from "../sessions/start";
import { pageDef } from "../pages/pageTypes";

/**
 * What you are looking at, and what it is for.
 *
 * It used to sit at the top of the body, above the first card, which put a
 * paragraph of explanation between you and the thing you came to use. Here it
 * is a card under the side panel: out of the body's reading column, and the
 * same shape for a session, the home page and settings alike -- which a
 * per-session control could not have been, since neither of those has a
 * session to hang off.
 *
 * A session's text is its own description when it has one (given when it was
 * started, or written here with ✎), and otherwise a line about what is in it.
 *
 * It shows and hides with the panel, so collapsing for room takes this with it.
 */

interface Info {
  title: string;
  help: string;
  /** Set for a session: the one whose description this card can edit. */
  sessionId?: string;
  description?: string;
}

/** The title and help for whatever is on screen, or null if nothing is. */
export function usePageInfo(): Info | null {
  const { sessions, activeId, view } = useSessions();

  const page = pageDef(view);
  if (page) return { title: page.label, help: page.help };

  const session = sessions.find((s) => s.id === activeId);
  if (!session) return null;
  // Every session is an Aggregator, so the interesting part is which panes are
  // in it -- the name is the session's own, which you chose.
  const services = (session.state.services as string[] | undefined) ?? [];
  const types = (session.state.paneTypes as PaneTypes | undefined) ?? {};
  const titles = (session.state.paneTitles as PaneTitles | undefined) ?? {};
  const labels = services.map((id) => paneTitle(id, types, titles));
  const description = session.state[SESSION_DESCRIPTION_KEY];
  return {
    title: session.title,
    help:
      labels.length === 0
        ? "An empty session. Add a service or tool from the Panes card to put something in it."
        : `${labels.join(", ")} in one session. Ask the agent about any of it in its Session tab.`,
    sessionId: session.id,
    description: typeof description === "string" && description.trim() ? description : undefined,
  };
}

export default function PageInfo() {
  const info = usePageInfo();
  const writeState = useWriteSessionState();
  // Which session's description is being edited, so switching sessions
  // mid-edit doesn't carry the box over to the next one.
  const [editing, setEditing] = useState<string | null>(null);
  // Escape unmounts the box, and the blur that fires as it goes must not save
  // what Escape meant to throw away.
  const skipBlur = useRef(false);
  if (!info) return null;

  const { sessionId } = info;
  const isEditing = sessionId !== undefined && editing === sessionId;

  function commit(value: string) {
    if (!sessionId) return;
    const next = value.trim();
    if (next !== (info?.description ?? "")) writeState(sessionId, SESSION_DESCRIPTION_KEY, next);
    // Enter's commit unmounts the box too; its blur has nothing left to do.
    skipBlur.current = true;
    setEditing(null);
  }

  return (
    <aside className="page-info" aria-label="About this page">
      <div className="page-info-head">
        <h1 className="page-info-title">{info.title}</h1>
        {sessionId && !isEditing && (
          <button
            className="page-info-edit"
            onClick={() => setEditing(sessionId)}
            aria-label={info.description ? "Edit the description" : "Add a description"}
            title={info.description ? "Edit the description" : "Add a description"}
          >
            ✎
          </button>
        )}
      </div>
      {isEditing ? (
        <textarea
          className="page-info-description-input"
          autoFocus
          rows={3}
          defaultValue={info.description ?? ""}
          placeholder="What this session is for"
          aria-label="Session description"
          onKeyDown={(e) => {
            // Enter saves, Shift+Enter is a new line, Escape leaves it as it was.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit((e.target as HTMLTextAreaElement).value);
            }
            if (e.key === "Escape") {
              skipBlur.current = true;
              setEditing(null);
            }
          }}
          onBlur={(e) => {
            if (skipBlur.current) {
              skipBlur.current = false;
              return;
            }
            commit(e.target.value);
          }}
        />
      ) : info.description ? (
        <p className="page-info-help page-info-description">{info.description}</p>
      ) : (
        <p className="page-info-help">{info.help}</p>
      )}
    </aside>
  );
}
