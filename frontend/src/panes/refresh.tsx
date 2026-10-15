/**
 * Auto-refresh (PLATFORM_PLAN.md R4, D22, §18.3): a pane run again by itself
 * while its session is on screen.
 *
 * The interval is session state -- the pane's own (`<pane>.refresh`, 0 for
 * off) or, unset, the session's (`refresh`) -- so it syncs, templates keep
 * it and the agent sets it. The timer is this tab's, and runs only while the
 * session is on screen and the tab visible; on coming back, an overdue pane
 * is asked for at once. Asking is all it does: the server runs the pane once
 * for everyone watching (five tabs, one run) and every tab follows the result
 * through the pane's outputs. A failure is on the outputs too, so every
 * viewer sees why, and the interval doubles with each one, up to an hour.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { applyOutputs } from "../sessions/outputs";
import { useSessions, useSessionScope, useSessionState } from "../sessions/SessionContext";
import { PaneManifest } from "./manifest";
import { Values } from "./paneApi";

export const REFRESH_CHOICES = [10, 30, 60, 300, 900, 3600];
const MAX_BACKOFF_SECONDS = 3600;

export function every(seconds: number): string {
  if (!seconds) return "Off";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** A key of the session itself (not the pane's), followed as it changes. */
function useSessionValue<T>(key: string): T | undefined {
  const scope = useSessionScope();
  const [value, setValue] = useState<T | undefined>(() => scope?.read()?.[key] as T | undefined);
  useEffect(() => {
    if (!scope) return;
    setValue(scope.read()?.[key] as T | undefined);
    return scope.subscribe((bag) => setValue(bag[key] as T | undefined));
  }, [scope, key]);
  return value;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

export interface RefreshState {
  /** The pane's own setting (undefined: follows the session's). */
  own: number | undefined;
  setOwn: (seconds: number | undefined) => void;
  /** The session's default. */
  sessionEvery: number;
  /** What it refreshes at, the floor applied (0: off). */
  interval: number;
  failures: number;
  error: string | null;
}

interface Failure {
  failures?: number;
  error?: string;
  at?: number;
}

/** The pane's refresh, and the timer that asks for it. */
export function useAutoRefresh(m: PaneManifest, session: string | null, pane: string, held: Values, timezone?: string): RefreshState {
  const [own, setOwnState] = useSessionState<number | undefined>("refresh", undefined);
  const sessionEvery = Number(useSessionValue<number>("refresh") ?? 0) || 0;
  const { activeId, view, sessions } = useSessions();
  const role = sessions.find((s) => s.id === session)?.role;
  const onScreen = view === "session" && activeId === session;
  const visible = usePageVisible();
  const chosen = own !== undefined && own !== null ? Number(own) : sessionEvery;
  const interval = m.refresh && chosen > 0 ? Math.max(chosen, m.refresh.floor) : 0;
  const failure = (held.refresh ?? null) as Failure | null;
  const failures = failure?.failures ?? 0;
  const ranAt = typeof held.ranAt === "number" ? held.ranAt : 0;
  const asked = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!interval || !session || !onScreen || !visible || role === "viewer") return;
    const wait = Math.min(interval * 2 ** Math.min(failures, 10), MAX_BACKOFF_SECONDS) * 1000;
    // From whichever is latest: the last run (anyone's), the last failure,
    // or this tab's last ask -- the server may have answered "another tab's
    // refresh is under way", and asking again at once would hammer it.
    const last = Math.max(ranAt, failure?.at ?? 0, asked.current);
    // Jittered, so tabs whose timers line up don't arrive together.
    const delay = Math.max(0, last + wait - Date.now()) + Math.random() * 2000;
    const timer = window.setTimeout(() => {
      asked.current = Date.now();
      api
        .refreshPane(m.id, session, pane, interval, timezone)
        // This tab's own write comes back with the answer, not as an event
        // (the event carries this tab's origin, and is skipped as its echo).
        .then((answer) => answer.outputs && applyOutputs(session, { [pane]: answer.outputs }))
        .catch(() => undefined)
        .finally(() => setTick((t) => t + 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [interval, session, pane, onScreen, visible, role, failures, ranAt, failure?.at, tick, m.id, timezone]);

  return {
    own: own ?? undefined,
    setOwn: (seconds) => setOwnState(seconds),
    sessionEvery,
    interval,
    failures,
    error: failure?.error ?? null,
  };
}

/** Auto-refresh in the pane's ⋮ menu (PaneSettings.tsx). It was a ↻ select
 * beside the first card's title, until that title held two controls. */
export function RefreshSection({ m, state }: { m: PaneManifest; state: RefreshState }) {
  if (!m.refresh) return null;
  const floor = m.refresh.floor;
  const value = state.own === undefined ? "session" : String(state.own);
  const costly = m.cost === "per_run";
  return (
    <>
      <div className="pane-menu-heading">Auto-refresh</div>
      <label className="pane-menu-field">
        <select
          aria-label="Refresh every"
          value={value}
          onChange={(e) => state.setOwn(e.target.value === "session" ? undefined : Number(e.target.value))}
        >
          <option value="session">As the session ({every(state.sessionEvery ? Math.max(state.sessionEvery, floor) : 0)})</option>
          <option value="0">Off</option>
          {REFRESH_CHOICES.filter((s) => s >= floor).map((s) => (
            <option key={s} value={String(s)}>
              Every {every(s)}
            </option>
          ))}
        </select>
      </label>
      <div className="pane-menu-note muted">
        {costly
          ? `Runs again by itself while the session is open, at most every ${every(floor)}. Each run is a query billed by the data it scans.`
          : `Runs again by itself while the session is open, at most every ${every(floor)}.`}
      </div>
    </>
  );
}

/** Beside the ⋮ while the pane refreshes by itself, so that shows without
 * opening the menu. */
export function RefreshBadge({ state }: { state: RefreshState }) {
  if (!state.interval) return null;
  return (
    <span className="pane-refresh-on" title={`Refreshes every ${every(state.interval)}`}>
      ↻ {every(state.interval)}
    </span>
  );
}

/** What a refresh that keeps failing says, above the pane's cards. */
export function RefreshFailure({ state }: { state: RefreshState }) {
  if (!state.interval || !state.failures || !state.error) return null;
  const next = Math.min(state.interval * 2 ** Math.min(state.failures, 10), MAX_BACKOFF_SECONDS);
  return (
    <p className="error-text pane-refresh-error" role="status">
      Refreshing failed {state.failures === 1 ? "once" : `${state.failures} times`}: {state.error} Trying again every{" "}
      {every(next)}.
    </p>
  );
}
