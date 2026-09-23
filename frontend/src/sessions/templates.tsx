/**
 * Saved templates: fetching them, and starting a session from one.
 *
 * Both places that offer them need this -- the side panel's catalogue and the
 * strip's ＋ menu -- and a template is opened the same way from either, so it
 * lives here rather than in whichever component happened to grow it first.
 *
 * A template is not a session. It is a name and a page's *inputs*, and opening
 * one starts a brand new session seeded from it; nothing you then do changes
 * the saved copy. That is why they sit under Add with the session types rather
 * than in the list of sessions you have.
 */

import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { SavedSession, User, api } from "../api";
import { useAuth } from "../AuthContext";
import { SessionType, useSessions } from "./SessionContext";
import { SESSION_SAVED_PAGE, sessionType } from "./registry";
import { PANE_TYPES } from "./paneTypes";
import { encode } from "./storage";
import { decode } from "./storage";

/** Stamped into every saved template so the reader can tell the current shape
 * (a session's own state bag) from the hand-rolled per-page shapes that came
 * before it. Guessing from the keys doesn't work: a legacy Aggregator save and
 * a current one both have `services`, and guessing threw the rest away. */
export const SAVED_STATE_VERSION = 2;
export const VERSION_KEY = "__savedStateVersion";

/**
 * Templates written before sessions held their own state used a hand-rolled
 * shape per page. Mapping the ones that existed costs little and beats opening
 * a session that silently ignores everything it was given.
 */
function migrateLegacyState(page: string, state: Record<string, any>): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  if (state[VERSION_KEY] === SAVED_STATE_VERSION) {
    const { [VERSION_KEY]: _version, ...rest } = state;
    // Round-tripped through the workspace codec, which tags Sets and Maps.
    // Plain JSON.stringify flattens a Set to {}, and a page that then calls
    // .has() on it takes the whole app down.
    return decode<Record<string, unknown>>(JSON.stringify(rest));
  }
  if (page === "logs" && Array.isArray(state.environment_ids)) {
    return {
      backend: state.backend ?? "cloudwatch",
      selectedEnvironmentIds: new Set(state.environment_ids),
      logGroupSelection: state.log_group_selection ?? {},
      queryString: state.query_string ?? "",
      limit: state.limit,
      timestampField: state.timestamp_field,
      sortField: state.sort_field,
      sortDirection: state.sort_direction,
      preset: state.preset,
      customStart: state.custom_start,
      customEnd: state.custom_end,
    };
  }
  if (page === "iot" && Array.isArray(state.environment_ids)) {
    return {
      selectedEnvironmentIds: new Set(state.environment_ids),
      searchMode: state.search_mode ?? "things",
      queryString: state.query_string ?? "",
      maxResults: state.max_results,
    };
  }
  if (page === "aggregator" && Array.isArray(state.services)) {
    return { services: state.services, layout: state.layout ?? "columns" };
  }
  return state;
}


export interface Template {
  entry: SavedSession<Record<string, unknown>>;
  type: SessionType;
}

/**
 * The state a new session should start with, given the template chosen.
 *
 * Every session is an Aggregator, so a template saved from one page -- back
 * when a page was a session -- becomes an Aggregator holding that one pane,
 * with its keys moved under the pane's id. The same shape the workspace
 * migration gives an old open session, for the same reason: a pane reads its
 * state under "<paneId>.<key>", so the id and the keys have to move together.
 */
export function templateState(entry: SavedSession<Record<string, unknown>>): Record<string, unknown> {
  const state = migrateLegacyState(entry.page, entry.state as Record<string, any>);
  if (entry.page === SESSION_SAVED_PAGE) return state;

  const pane = paneForPage(entry.page, state);
  if (!pane) return state;
  const wrapped: Record<string, unknown> = { services: [pane], layout: "tabs", activePane: pane };
  for (const [key, value] of Object.entries(state)) wrapped[`${pane}.${key}`] = value;
  return wrapped;
}

/** Which pane a template saved from a page becomes. Everything saved from the
 * old combined Logs page lives under "logs" whichever backend it used; its own
 * state says which. */
function paneForPage(page: string, state: Record<string, unknown>): SessionType | undefined {
  if (page === "logs") return state.backend === "opensearch" ? "logs-opensearch" : "logs-cloudwatch";
  return PANE_TYPES.find((t) => t.savedPage === page)?.type;
}

interface TemplatesApi {
  templates: Template[];
  /** Called after writing one, so the lists showing them pick it up. Saving a
   * template changes neither the session count nor anything else the fetch
   * depends on, so without this a template you just saved would not appear
   * until something unrelated moved. */
  reload: () => void;
}

const TemplatesContext = createContext<TemplatesApi>({ templates: [], reload: () => undefined });

export function useTemplates(): TemplatesApi {
  return useContext(TemplatesContext);
}

/** Every page a template could have been saved under: the session's own key,
 * plus the per-page keys used when a page was a session. Old templates still
 * open -- they just become a session holding that page. */
export const TEMPLATE_PAGES = [SESSION_SAVED_PAGE, "logs", ...PANE_TYPES.map((t) => t.savedPage)].filter(
  (p, i, all): p is string => !!p && all.indexOf(p) === i,
);

async function fetchTemplates(_user: User | null): Promise<Template[]> {
  const lists = await Promise.all(
    TEMPLATE_PAGES.map((page) =>
      api
        .listSavedSessions<Record<string, unknown>>(page)
        .then((list) => list.map((entry) => ({ entry, type: "aggregator" as SessionType })))
        .catch(() => [] as Template[]),
    ),
  );
  return lists.flat();
}

export function TemplatesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTemplates(user).then((list) => {
      if (!cancelled) setTemplates(list);
    });
    return () => {
      cancelled = true;
    };
  }, [user, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ templates, reload }), [templates, reload]);
  return <TemplatesContext.Provider value={value}>{children}</TemplatesContext.Provider>;
}

/**
 * Writing a session out as a template.
 *
 * Offered from the panel's ⋮ and the strip's, so it lives beside the code that
 * reads templates back rather than in whichever menu grew it first. What is
 * kept is the session's *inputs* -- captureInputs strips the rows, the
 * fetched-at markers and the assistant thread -- because a template is
 * something you start from, not someone else's results.
 *
 * Returns false when there was nothing to do: the session is gone, its kind has
 * no page to save under, or the name was left blank.
 */
export function useSaveAsTemplate(): (id: string) => Promise<boolean> {
  const { sessions, captureInputs } = useSessions();
  const { reload } = useTemplates();

  return async (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (!session) return false;
    const name = window.prompt("Save as template:", session.title);
    if (!name?.trim()) return false;
    // Encoded with the tags, then parsed back to a plain object so the API's
    // own JSON.stringify has nothing left to lose.
    const state = JSON.parse(encode(captureInputs(id)));
    await api.createSavedSession({
      page: SESSION_SAVED_PAGE,
      name: name.trim(),
      state: { ...state, [VERSION_KEY]: SAVED_STATE_VERSION },
    });
    reload();
    return true;
  };
}
