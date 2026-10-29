/**
 * What the Workflows page hands the rest of the app (§22.10):
 * - the run on screen, which the agent panel's "This run" tab is about (D98);
 * - a workflow drafted from a session, waiting for the editor to open it (D96);
 * - a workflow or a run something else asked to show: the Workflow pane's
 *   link to its run, the agent's `open_workflow` (`openWorkflowScreen`).
 * Small stores, so the page and the panel needn't know each other.
 */

import { useSyncExternalStore } from "react";

export interface RunFocus {
  runId: number;
  title: string;
}

export interface Draft {
  id: string;
  source: string;
}

/** What the Workflows page is asked to show. */
export type WorkflowScreen = { kind: "workflow"; id: string } | { kind: "run"; id: number };

let focus: RunFocus | null = null;
let draft: Draft | null = null;
let asked: WorkflowScreen | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Set by the run page while a run it may read is on screen; null when it goes. */
export function setRunFocus(next: RunFocus | null) {
  if (focus?.runId === next?.runId && focus?.title === next?.title) return;
  focus = next;
  emit();
}

export function useRunFocus(): RunFocus | null {
  return useSyncExternalStore(subscribe, () => focus);
}

/** A draft for the editor; taken (and cleared) by the Workflows page. */
export function offerDraft(next: Draft) {
  draft = next;
  emit();
}

export function takeDraft(): Draft | null {
  const taken = draft;
  draft = null;
  return taken;
}

export function useDraftWaiting(): boolean {
  return useSyncExternalStore(subscribe, () => draft !== null);
}

/** Asks the Workflows page to show a workflow or a run; whoever asks also
 * switches to the page (`show("workflows")`). Taken by the page. */
export function openWorkflowScreen(next: WorkflowScreen) {
  asked = next;
  emit();
}

export function takeWorkflowScreen(): WorkflowScreen | null {
  const taken = asked;
  asked = null;
  return taken;
}

export function useWorkflowScreenWaiting(): boolean {
  return useSyncExternalStore(subscribe, () => asked !== null);
}

/** A workflow to open in the Builder's Workflows (D128) -- the Workflows
 * page's New workflow and Open in the Builder: one editor, one place. */
export type BuilderAsk =
  | { what: "workflow"; id: string | null }
  | { what: "draft"; id: number }
  // "Make it", from a draft's Needs line (D159): a new type of that id.
  | { what: "type"; kind: "connection"; id: string };
let builderAsk: BuilderAsk | null = null;

export function openInBuilder(next: BuilderAsk) {
  builderAsk = next;
  emit();
}

export function takeBuilderAsk(): BuilderAsk | null {
  const taken = builderAsk;
  builderAsk = null;
  return taken;
}

export function useBuilderAskWaiting(): boolean {
  return useSyncExternalStore(subscribe, () => builderAsk !== null);
}

/**
 * A link inside the app (`?run=17`, `?workflow=orders_check`): shown in
 * place, never a page load -- a load would drop the tab's live state and
 * every open session's last second of edits. Anything else is left to the
 * browser. Returns whether it was taken.
 */
export function followAppLink(href: string, show: (view: "workflows" | "builder") => void): boolean {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  const run = url.searchParams.get("run");
  const workflow = url.searchParams.get("workflow");
  const draft = url.searchParams.get("draft");
  if (draft && /^\d+$/.test(draft)) {
    // A Builder draft (D156): what Claude Code proposed, there to review.
    openInBuilder({ what: "draft", id: Number(draft) });
    show("builder");
    return true;
  }
  if (run && /^\d+$/.test(run)) openWorkflowScreen({ kind: "run", id: Number(run) });
  else if (workflow) openWorkflowScreen({ kind: "workflow", id: workflow });
  else return false;
  show("workflows");
  return true;
}
