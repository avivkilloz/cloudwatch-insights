/**
 * The editor on screen, for the agent panel's Building tab (D107): a pane
 * type's in the Builder, or a workflow's on the Workflows page. The editor
 * registers itself while it's open and editable; the panel's turn reads the
 * text as it is when asked (a getter -- the store isn't touched per
 * keystroke) and hands back what the agent proposes (`apply`), which lands
 * in the editor unsaved. A small store, so the pages and the panel needn't
 * know each other.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

export type BuildKind = "pane" | "workflow";

export interface BuildFocus {
  /** One conversation per editor: "pane:<id>", "workflow:<id>", or "…:new". */
  key: string;
  kind: BuildKind;
  /** Null while it's a new one, not saved yet. */
  id: string | null;
  title: string;
  source: () => string;
  apply: (source: string, summary: string) => void;
}

let focus: BuildFocus | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBuildFocus(): BuildFocus | null {
  return useSyncExternalStore(subscribe, () => focus);
}

/** The focus as it is now, for a turn that outlives a render (a proposal
 * arriving after the editor was closed has nowhere to go). */
export function currentBuildFocus(): BuildFocus | null {
  return focus;
}

/** Registers an editor while `editable`; its text and how to put a proposal
 * in it are read through refs, so they're always the latest. */
export function useOfferBuild(
  kind: BuildKind,
  id: string | null,
  title: string,
  editable: boolean,
  source: string,
  apply: (source: string, summary: string) => void,
) {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (!editable) return;
    const mine: BuildFocus = {
      key: `${kind}:${id ?? "new"}`,
      kind,
      id,
      title,
      source: () => sourceRef.current,
      apply: (text, summary) => applyRef.current(text, summary),
    };
    focus = mine;
    listeners.forEach((l) => l());
    return () => {
      if (focus !== mine) return;
      focus = null;
      listeners.forEach((l) => l());
    };
  }, [kind, id, title, editable]);
}
