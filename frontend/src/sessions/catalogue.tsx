/**
 * The catalogue panes are picked from (PLATFORM_PLAN.md §19.2, D66): the
 * admin's categories in their order, and this person's favourites and hidden
 * pane types. The default page, the side panel's Add list, the strip's +
 * menu, the session card's adds and the group form all draw from here, so a
 * pane is in the same place wherever it's offered.
 *
 * Until it has loaded (or if it can't), panes are grouped as their manifests
 * say -- Services, Tools -- rather than not offered at all.
 */

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, Catalogue, readableError } from "../api";
import { useAuth } from "../AuthContext";
import { SESSION_TYPES, SessionTypeDef } from "./registry";

export interface CatalogueGroup {
  /** The category's id; null for Favourites and for the fallback groups. */
  id: number | null;
  name: string;
  /** What the category is, under its name; "" or absent for none. */
  description?: string;
  types: SessionTypeDef[];
}

interface CatalogueApi {
  /** The categories, each with the panes this person may use, hidden ones included. */
  categories: CatalogueGroup[];
  favourites: string[];
  hidden: string[];
  /** Every person's lists: Favourites first (if any), then each category,
   * hidden pane types left out unless asked for. */
  groups: (options?: { withHidden?: boolean; withFavourites?: boolean }) => CatalogueGroup[];
  setFavourite: (type: string, on: boolean) => Promise<void>;
  setHidden: (type: string, on: boolean) => Promise<void>;
  /** What an admin's edit answered with: the catalogue as it is now. */
  replace: (next: Catalogue) => void;
  error: string | null;
}

const CatalogueContext = createContext<CatalogueApi | null>(null);

export function CatalogueProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [data, setData] = useState<Catalogue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getCatalogue().then(setData, (e) => setError(readableError(e)));
  }, [user?.id]);

  const byType = useMemo(() => new Map(SESSION_TYPES.map((t) => [t.type as string, t])), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const offered = useCallback((t: SessionTypeDef) => t.enabledFor(user), [user]);

  const categories = useMemo<CatalogueGroup[]>(() => {
    if (!data) {
      // As the manifests group them, until the catalogue is in.
      return (["Services", "Tools"] as const).map((group) => ({
        id: null,
        name: group,
        types: SESSION_TYPES.filter((t) => t.group === group && offered(t)),
      }));
    }
    return data.categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      types: c.pane_types.map((id) => byType.get(id)).filter((t): t is SessionTypeDef => !!t && offered(t)),
    }));
  }, [data, byType, offered]);

  const favourites = data?.favourites ?? [];
  const hidden = data?.hidden ?? [];

  const groups = useCallback(
    ({ withHidden = false, withFavourites = true }: { withHidden?: boolean; withFavourites?: boolean } = {}) => {
      const keep = (t: SessionTypeDef) => withHidden || !hidden.includes(t.type);
      const out: CatalogueGroup[] = [];
      const favs = favourites.map((id) => byType.get(id)).filter((t): t is SessionTypeDef => !!t && offered(t) && keep(t));
      if (withFavourites && favs.length) out.push({ id: null, name: "Favourites", types: favs });
      for (const c of categories) {
        const types = c.types.filter(keep);
        if (types.length) out.push({ ...c, types });
      }
      return out;
    },
    [categories, favourites, hidden, byType, offered],
  );

  const setPreference = useCallback(async (type: string, pref: { favourite?: boolean; hidden?: boolean }) => {
    try {
      setData(await api.setCataloguePreference(type, pref));
      setError(null);
    } catch (e) {
      setError(readableError(e));
    }
  }, []);

  const value = useMemo<CatalogueApi>(
    () => ({
      categories,
      favourites,
      hidden,
      groups,
      setFavourite: (type, on) => setPreference(type, { favourite: on }),
      setHidden: (type, on) => setPreference(type, { hidden: on }),
      replace: setData,
      error,
    }),
    [categories, favourites, hidden, groups, setPreference, error],
  );
  return <CatalogueContext.Provider value={value}>{children}</CatalogueContext.Provider>;
}

export function useCatalogue(): CatalogueApi {
  const ctx = useContext(CatalogueContext);
  if (!ctx) throw new Error("useCatalogue must be used inside <CatalogueProvider>");
  return ctx;
}
