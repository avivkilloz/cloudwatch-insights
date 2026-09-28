/**
 * Starting a session, from wherever the offer was made.
 *
 * Both Add lists -- the panel's catalogue and the strip's ＋ -- and the home
 * page's card all end up here, so "what a new session looks like" is written
 * once. A session is an Aggregator, so starting one is seeding its panes
 * (`services`, `paneTypes`, `paneTitles` -- see ./panes), `layout` and
 * `activePane`; nothing else is special about it.
 */

import { SessionType, useSessions } from "./SessionContext";
import { nextTitle } from "./naming";
import { initialPanes } from "./panes";
import { sessionTypeLabel } from "./registry";
import { Template, templateState } from "./templates";

/** What a session is for, in its owner's words: a top-level key of its state,
 * so it syncs with the rest of it, and a template keeps it (it's an input,
 * not a result). Shown, and edited, in the card under the side panel. */
export const SESSION_DESCRIPTION_KEY = "description";

/** The layout a session starts in. Tabs: one pane at a time, which is what
 * most sessions hold, and the others are a click away in the picker. */
const START_LAYOUT = "tabs";

export interface StartSession {
  /** A session holding exactly the panes given -- a type listed twice is two
   * panes of it -- named after the first unless a name is passed, and with
   * the description given, if any (`SESSION_DESCRIPTION_KEY`). None at all
   * is fine: an empty session is filled from inside it. */
  start: (panes: SessionType[], name?: string, description?: string) => void;
  /** A session holding one pane, named after it: the shortcut behind clicking
   * a service or tool in an Add list. */
  startOne: (pane: SessionType) => void;
  /** A brand-new session seeded from a saved template. Nothing you then do in
   * it changes the saved copy. */
  startFromTemplate: (template: Template) => void;
}

/** What a session is called when you don't say: the pane in it, or how many
 * there are. Better than "Session 4", which tells you nothing in a list of
 * them. The home page shows this as the name box's placeholder, so it is the
 * same name there and everywhere a session is started without asking. */
export function defaultSessionName(panes: SessionType[]): string {
  if (panes.length === 0) return "Session";
  if (panes.length === 1) return sessionTypeLabel(panes[0]);
  return `${sessionTypeLabel(panes[0])} +${panes.length - 1}`;
}

export function useStartSession(): StartSession {
  const { sessions, open } = useSessions();

  function start(panes: SessionType[], name?: string, description?: string) {
    const title = nextTitle(name?.trim() || defaultSessionName(panes), sessions.map((s) => s.title));
    const seeded = initialPanes(panes);
    const about = description?.trim();
    open(title, {
      ...seeded,
      layout: START_LAYOUT,
      activePane: seeded.services[0] ?? null,
      ...(about ? { [SESSION_DESCRIPTION_KEY]: about } : {}),
    });
  }

  return {
    start,
    startOne: (pane) => start([pane]),
    startFromTemplate: (template) =>
      open(nextTitle(template.entry.name, sessions.map((s) => s.title)), templateState(template.entry)),
  };
}
