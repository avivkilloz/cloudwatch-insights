/**
 * What a pane says in view mode (PLATFORM_PLAN.md §18.7, D61), above its
 * outputs: how old they are, and Refresh. Refresh goes through the refresh
 * route rather than the pane's own Run: it coalesces like auto-refresh (two
 * people pressing it cause one run), and a viewer may use it -- run as the
 * viewer, when they can reach every connection the pane uses (D62).
 */

import { useEffect, useState } from "react";
import { api, readableError } from "../api";
import { applyOutputs } from "../sessions/outputs";
import { PaneManifest } from "./manifest";

function age(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const SAID: Record<string, string> = {
  fresh: "Already up to date.",
  refreshing: "Someone's refresh is already under way.",
  running: "It's still running.",
  unreachable: "You can't reach this pane's environment, so it waits for someone who can.",
};

export function ViewModeLine({
  m,
  session,
  pane,
  ranAt,
  timezone,
}: {
  m: PaneManifest;
  session: string | null;
  pane: string;
  ranAt: number | null;
  timezone?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => setSaid(null), [ranAt]);

  async function refresh() {
    if (!session || !m.refresh) return;
    setBusy(true);
    setSaid(null);
    try {
      const answer = await api.refreshPane(m.id, session, pane, m.refresh.floor, timezone);
      if (answer.outputs) applyOutputs(session, { [pane]: answer.outputs });
      if (!answer.refreshed) setSaid(answer.error ?? SAID[answer.reason] ?? null);
    } catch (e) {
      setSaid(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <p className="view-mode-line muted">
      <span>{ranAt ? `Updated ${age(ranAt, now)}` : "Not run yet"}</span>
      {m.refresh && session && (
        <button className="link-button" onClick={refresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      )}
      {said && <span>{said}</span>}
    </p>
  );
}
