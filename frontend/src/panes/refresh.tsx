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
 *
 * Run on open (D77, §21.8) is the other half: `<pane>.refreshOnOpen` (or the
 * session's `refreshOnOpen`) is a freshness window in seconds, and when the
 * session comes on screen in a visible tab -- opened, switched to, landed on,
 * or the browser tab come back to -- each such pane asks once. The server
 * runs it only if its outputs are older than the window, so switching back
 * and forth, or five members arriving together, runs it once.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { applyOutputs } from "../sessions/outputs";
import { useSessions, useSessionState, useSessionValue } from "../sessions/SessionContext";
import { PaneManifest } from "./manifest";
import { Values } from "./paneApi";

export const REFRESH_CHOICES = [10, 30, 60, 300, 900, 3600];
/** "If older than" windows a run on open offers. */
export const ON_OPEN_CHOICES = [60, 300, 900, 3600];
const MAX_BACKOFF_SECONDS = 3600;

export function every(seconds: number): string {
  if (!seconds) return "Off";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** A key of the session itself (not the pane's), followed as it changes. */
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
  /** Run on open: the pane's own window (undefined: follows the session's). */
  openOwn: number | undefined;
  setOpenOwn: (seconds: number | undefined) => void;
  sessionOpen: number;
  /** The window it runs on open with (0: off). */
  openWindow: number;
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
  const { activeId, view } = useSessions();
  const onScreen = view === "session" && activeId === session;
  const visible = usePageVisible();
  const chosen = own !== undefined && own !== null ? Number(own) : sessionEvery;
  const interval = m.refresh && chosen > 0 ? Math.max(chosen, m.refresh.floor) : 0;
  const failure = (held.refresh ?? null) as Failure | null;
  const failures = failure?.failures ?? 0;
  const ranAt = typeof held.ranAt === "number" ? held.ranAt : 0;
  const asked = useRef(0);
  const [tick, setTick] = useState(0);
  const [openOwn, setOpenOwnState] = useSessionState<number | undefined>("refreshOnOpen", undefined);
  const sessionOpen = Number(useSessionValue<number>("refreshOnOpen") ?? 0) || 0;
  const chosenOpen = openOwn !== undefined && openOwn !== null ? Number(openOwn) : sessionOpen;
  const openWindow = m.refresh && chosenOpen > 0 ? chosenOpen : 0;
  // Set on each arrival (off screen or hidden -> on screen and visible), and
  // spent by the one ask it causes. It waits for the window rather than being
  // dropped: on a load, the session's state can arrive after the pane is on
  // screen.
  const arrived = useRef(false);
  const present = !!session && onScreen && visible;

  useEffect(() => {
    if (present) arrived.current = true;
    else arrived.current = false;
  }, [present]);

  useEffect(() => {
    if (!present || !openWindow || !session || !arrived.current) return;
    arrived.current = false;
    asked.current = Date.now();
    api
      .refreshPane(m.id, session, pane, 0, timezone, openWindow)
      .then((answer) => answer.outputs && applyOutputs(session, { [pane]: answer.outputs }))
      .catch(() => undefined);
  }, [present, openWindow, session, pane, m.id, timezone]);

  useEffect(() => {
    // A viewer's tab asks too (D62): the server runs it as the viewer when they
    // can reach every connection the pane uses, and otherwise says so.
    if (!interval || !session || !onScreen || !visible) return;
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
  }, [interval, session, pane, onScreen, visible, failures, ranAt, failure?.at, tick, m.id, timezone]);

  return {
    own: own ?? undefined,
    setOwn: (seconds) => setOwnState(seconds),
    sessionEvery,
    interval,
    failures,
    error: failure?.error ?? null,
    openOwn: openOwn ?? undefined,
    setOpenOwn: (seconds) => setOpenOwnState(seconds),
    sessionOpen,
    openWindow,
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
      <label className="pane-menu-field">
        <select
          aria-label="Run on open"
          title="Runs once when someone opens the session, unless what it shows is newer than that."
          value={state.openOwn === undefined ? "session" : String(state.openOwn)}
          onChange={(e) => state.setOpenOwn(e.target.value === "session" ? undefined : Number(e.target.value))}
        >
          <option value="session">
            On open: as the session ({state.sessionOpen ? `if older than ${every(state.sessionOpen)}` : "off"})
          </option>
          <option value="0">On open: off</option>
          {ON_OPEN_CHOICES.map((s) => (
            <option key={s} value={String(s)}>
              On open, if older than {every(s)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/** Beside the ⋮ while the pane refreshes by itself, so that shows without
 * opening the menu. */
export function RefreshBadge({ state }: { state: RefreshState }) {
  if (!state.interval && state.openWindow) {
    return (
      <span className="pane-refresh-on" title={`Runs when the session is opened, if older than ${every(state.openWindow)}`}>
        ↻ on open
      </span>
    );
  }
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
