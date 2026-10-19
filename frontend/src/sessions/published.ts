/**
 * Opening a published template (PLATFORM_PLAN.md §23, D101). The server makes
 * the session -- the environment set, each pane's bound inputs copied in, the
 * log groups given to it -- and the browser opens what it made, as it does a
 * run investigated. One that needs an environment the opener hasn't chosen
 * goes to its card on the default page to choose; one environment, and there
 * is nothing to choose.
 */

import { useSyncExternalStore } from "react";
import { api, PublishedTemplate, readableError } from "../api";
import { useSessions } from "./SessionContext";

let asked: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

/** The template whose card the default page should open, asking for its environment. */
export function usePublishedAsked(): string | null {
  return useSyncExternalStore(subscribe, () => asked);
}

export function clearPublishedAsked() {
  asked = null;
  listeners.forEach((l) => l());
}

export function useOpenPublished(): (t: PublishedTemplate, environment?: number | null) => Promise<void> {
  const { openFromServer, show } = useSessions();
  return async (t, environment) => {
    let chosen = environment ?? null;
    if (t.needs_environment && chosen === null) {
      const environments = await api.listEnvironments();
      if (environments.length !== 1) {
        asked = t.id;
        listeners.forEach((l) => l());
        show("home");
        return;
      }
      chosen = environments[0].id;
    }
    const made = await api.openPublishedTemplate(t.id, chosen);
    await openFromServer(made.session_id);
  };
}

/** The same, from a menu that closes on the click: a failure is said where
 * the app says what isn't any one page's to show. */
export function useOpenPublishedFromMenu(): (t: PublishedTemplate) => void {
  const openPublished = useOpenPublished();
  const { say } = useSessions();
  return (t) => {
    openPublished(t).catch((e) => say(`Couldn't open "${t.label}": ${readableError(e)}`));
  };
}
