import { useAuth } from "../AuthContext";
import { useSessions } from "../sessions/SessionContext";
import { sessionType } from "../sessions/registry";

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

const HOME = {
  title: "Home",
  help:
    "Everything you can open, grouped by what it is for. Pick a card to start a session, or tick several and " +
    "aggregate them into one.",
};

const SETTINGS = {
  title: "Settings",
  help:
    "Your account and how the app looks, the environments and saved items you work with, and — if you are an " +
    "admin — the users, groups and which pages each group can see.",
};

/** The title and help for whatever is on screen, or null if nothing is. */
export function usePageInfo(): { title: string; help: string } | null {
  const { user } = useAuth();
  const { sessions, activeId, view } = useSessions();

  if (view === "home") return HOME;
  if (view === "settings") return SETTINGS;

  const session = sessions.find((s) => s.id === activeId);
  if (!session) return null;
  const def = sessionType(session.type);

  // The same two cases the body owns up to: a service an admin has since
  // revoked, and a session type this version no longer knows.
  if (!def) {
    return { title: session.title, help: "This session is of a kind this version no longer knows how to open." };
  }
  if (!def.enabledFor(user)) {
    return { title: def.label, help: "This session's service is no longer enabled for your account." };
  }
  return { title: def.label, help: def.help };
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
