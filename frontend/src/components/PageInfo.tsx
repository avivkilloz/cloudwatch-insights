import { useSessions } from "../sessions/SessionContext";
import { pageDef } from "../pages/pageTypes";

/**
 * What a page is for -- the home page, Settings, the Agent page and the rest --
 * as a card under the side panel, out of the body's reading column.
 *
 * Sessions don't use it: a session's name and description are in its own card
 * (SessionCard), with what it holds and how it's laid out, which sits either
 * at the top of the body or here in the side panel.
 *
 * It shows and hides with the panel, so collapsing for room takes this with it.
 */

/** The title and help for the page on screen, or null for a session. */
export function usePageInfo(): { title: string; help: string } | null {
  const { view } = useSessions();
  const page = pageDef(view);
  return page ? { title: page.label, help: page.help } : null;
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
