/**
 * Whether this tab is running an older build than the one now deployed
 * (PLATFORM_PLAN.md §15.4).
 *
 * A tab open across a deploy keeps running the code it loaded. Since panes
 * moved to manifests that can matter: the server has migrated a ported pane's
 * keys to the v2 shape, and the old code reads the old ones -- the pane looks
 * empty and every save writes the old keys back (the server migrates them
 * again, so nothing is lost, but the tab shows nothing). So the tab looks:
 * every build writes its id to version.json beside index.html (vite.config.ts)
 * and compiles the same id in; a tab whose id differs from the file's says a
 * new version is available and reloads at the next natural break.
 *
 * Checked when the tab comes back into view and every few minutes, never
 * cached (docker/nginx.conf.template). The dev server answers with its own
 * id, so a tab there is never stale while it runs.
 */

import { useEffect, useState } from "react";

declare const __APP_BUILD__: string;

export const APP_BUILD: string = __APP_BUILD__;

const CHECK_EVERY_MS = 5 * 60 * 1000;

async function deployedBuild(): Promise<string | null> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const build = (body as { build?: unknown } | null)?.build;
    return typeof build === "string" ? build : null;
  } catch {
    // Offline, or index.html served in its place: no answer, not a new build.
    return null;
  }
}

export function useStaleBuild(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (stale) return;
    let cancelled = false;
    const check = async () => {
      const build = await deployedBuild();
      if (!cancelled && build !== null && build !== APP_BUILD) setStale(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [stale]);
  return stale;
}
