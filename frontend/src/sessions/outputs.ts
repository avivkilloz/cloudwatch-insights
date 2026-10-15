/**
 * What each pane of each session shows -- its outputs -- held apart from the
 * session's state (PLATFORM_PLAN.md D21, §18.2).
 *
 * The state is what people edit and this browser saves whole; outputs are
 * what runs write, and the server is their only writer. Kept in the state,
 * every 1-second poll, Load more or refresh resent the whole session to every
 * tab, moved its version under whoever was typing (their save became a 409 to
 * merge), and past 4 MiB the whole session lost every pane's results. So they
 * live here instead: not in IndexedDB, not in the sync fingerprint, not in
 * templates -- filled from the server's reads (`outputs` beside `state`),
 * from an action's own reply, and from "outputs" events, one pane at a time,
 * each record newer only when its version is.
 *
 * A pane reads its record with `usePaneOutputs`. Writing goes through the
 * server; `setLocal` is for what the server doesn't store -- a viewer's own
 * clicks, a reset shown before the server confirms it.
 */

import { useSyncExternalStore } from "react";
import type { PaneOutputs } from "../api";

type Values = Record<string, unknown>;

const EMPTY: Values = Object.freeze({}) as Values;

const records = new Map<string, Map<string, PaneOutputs>>();
const listeners = new Set<() => void>();

function key(session: string, pane: string): string {
  return `${session}\u0000${pane}`;
}

// Per pane, so a hook re-renders only when its own pane changes.
let snapshots = new Map<string, Values>();

function emit(changed: string[]) {
  const next = new Map(snapshots);
  for (const k of changed) next.delete(k);
  snapshots = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The version this browser holds of a pane's outputs (-1: none). */
export function outputsVersion(session: string, pane: string): number {
  return records.get(session)?.get(pane)?.version ?? -1;
}

/** Takes what the server says panes hold -- a session's read, an action's
 * reply, a pane's fetch -- keeping any pane's record this browser already
 * has a newer version of. A record at version 0 is outputs still sitting in
 * an old session's state: taken only when nothing is held. */
export function applyOutputs(session: string, given: Record<string, PaneOutputs> | undefined): void {
  if (!given) return;
  const held = records.get(session) ?? new Map<string, PaneOutputs>();
  const changed: string[] = [];
  for (const [pane, record] of Object.entries(given)) {
    const current = held.get(pane);
    if (current && current.version >= record.version && !(current.version === 0 && record.version === 0)) continue;
    held.set(pane, record);
    changed.push(key(session, pane));
  }
  if (!changed.length) return;
  records.set(session, held);
  emit(changed);
}

/** Changes a pane's outputs in this browser only, keeping its version: what
 * the server isn't asked to store (a viewer's clicks), or hasn't answered
 * yet (a reset). */
export function setLocal(session: string, pane: string, change: (values: Values) => Values): void {
  const held = records.get(session) ?? new Map<string, PaneOutputs>();
  const current = held.get(pane) ?? { version: -1, values: {} };
  const values = change(current.values);
  if (values === current.values) return;
  held.set(pane, { version: current.version, values });
  records.set(session, held);
  emit([key(session, pane)]);
}

/** Forgets panes (closed) or a whole session (closed, deleted, left). */
export function dropOutputs(session: string, pane?: string): void {
  const held = records.get(session);
  if (!held) return;
  const panes = pane === undefined ? [...held.keys()] : [pane];
  for (const p of panes) held.delete(p);
  if (pane === undefined || held.size === 0) records.delete(session);
  emit(panes.map((p) => key(session, p)));
}

function snapshot(session: string | null, pane: string): Values {
  if (!session) return EMPTY;
  const k = key(session, pane);
  let values = snapshots.get(k);
  if (values === undefined) {
    values = records.get(session)?.get(pane)?.values ?? EMPTY;
    snapshots.set(k, values);
  }
  return values;
}

/** A pane's outputs, kept current as the server's writes arrive. */
export function usePaneOutputs(session: string | null, pane: string): Values {
  return useSyncExternalStore(subscribe, () => snapshot(session, pane));
}
