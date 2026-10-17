/**
 * What waits for this person's decision (D88): workflow steps paused on an
 * approval they may give. The rail's Workflows row counts them, the
 * Workflows page lists them, and a run page on screen reads itself again
 * when one changes -- all from one fetch, made again whenever the server
 * says (the "approvals" event on the stream SessionContext already holds
 * open, passed on as APPROVALS_EVENT) or the stream comes back.
 */

import { useEffect, useSyncExternalStore } from "react";
import { api, WorkflowApproval } from "./api";

export const APPROVALS_EVENT = "cwi:approvals";

let waiting: WorkflowApproval[] = [];
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let again = false;

function refresh(): Promise<void> {
  // One fetch at a time; a change announced meanwhile asks once more after it.
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = api
    .listApprovals()
    .then((list) => {
      waiting = list;
      listeners.forEach((l) => l());
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        void refresh();
      }
    });
  return inFlight;
}

/** Tells every listener that what waits may have changed (the stream said so). */
export function announceApprovals() {
  window.dispatchEvent(new Event(APPROVALS_EVENT));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The approvals waiting for this person; fetched once mounted and on every announcement. */
export function useWaitingApprovals(): WorkflowApproval[] {
  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(APPROVALS_EVENT, onChange);
    return () => window.removeEventListener(APPROVALS_EVENT, onChange);
  }, []);
  return useSyncExternalStore(subscribe, () => waiting);
}
