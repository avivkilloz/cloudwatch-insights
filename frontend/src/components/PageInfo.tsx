import { useSessions } from "../sessions/SessionContext";
import { sessionTypeLabel } from "../sessions/registry";
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
 * It shows and hides with the panel, so collapsing for room takes this with it.
 */

/** The title and help for whatever is on screen, or null if nothing is. */
export function usePageInfo(): { title: string; help: string } | null {
  const { sessions, activeId, view } = useSessions();

  const page = pageDef(view);
  if (page) return { title: page.label, help: page.help };

  const session = sessions.find((s) => s.id === activeId);
  if (!session) return null;
  // Every session is an Aggregator, so the interesting part is which panes are
  // in it -- the name is the session's own, which you chose.
  const services = (session.state.services as string[] | undefined) ?? [];
  const labels = services.map((id) => sessionTypeLabel(id));
  return {
    title: session.title,
    help:
      labels.length === 0
        ? "An empty session. Tick a service or tool in the panel above to put something in it."
        : `${labels.join(", ")} in one session, with one assistant across all of them.`,
  };
}

export default function PageInfo() {
  const info = usePageInfo();
  if (!info) return null;

  return (
    <aside className="page-info" aria-label="About this page">
      <h1 className="page-info-title">{info.title}</h1>
      <p className="page-info-help">{info.help}</p>
    </aside>
  );
}
