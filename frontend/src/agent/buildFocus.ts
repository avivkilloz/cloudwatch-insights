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
import { BuildFiles } from "../api";

/** "credential" and "connection" are those types (D159): built as their YAML. */
export type BuildKind = "pane" | "workflow" | "step" | "credential" | "connection";

/** Where an editor keeps what it builds (D125): its draft, which holds the
 * Building chat too. Works after the editor has closed -- a turn still
 * running when its builder left saves its answer, and a proposal its text. */
export interface BuildDraftHooks {
  /** The conversation's key: one per editor while it's open. */
  key: string;
  /** The chat the draft held when it was opened (null: none yet, or not read yet). */
  turns: unknown[] | null;
  saveTurns: (turns: unknown[]) => void;
  keep: (source: string, files?: BuildFiles) => void;
  /** Its draft, once there is one, and whether more than one person works
   * in it (D161): its chat is then people talking, an agent answering only
   * when @mentioned (D163). */
  id: number | null;
  shared: boolean;
}

export interface BuildFocus {
  /** One conversation per editor: "pane:<id>", "workflow:<id>", or "…:new". */
  key: string;
  kind: BuildKind;
  /** Null while it's a new one, not saved yet. */
  id: string | null;
  title: string;
  source: () => string;
  /** The Python files beside it (D136): a pane's or a step's; none for a workflow. */
  files: () => BuildFiles;
  apply: (source: string, summary: string, files?: BuildFiles) => void;
  draft?: BuildDraftHooks;
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
  apply: (source: string, summary: string, files?: BuildFiles) => void,
  draft?: BuildDraftHooks,
  files?: BuildFiles,
) {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const filesRef = useRef<BuildFiles>(files ?? {});
  filesRef.current = files ?? {};
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (!editable) return;
    const mine: BuildFocus = {
      key: draft?.key ?? `${kind}:${id ?? "new"}`,
      kind,
      id,
      title,
      source: () => sourceRef.current,
      files: () => filesRef.current,
      apply: (text, summary, proposed) => applyRef.current(text, summary, proposed),
      draft,
    };
    focus = mine;
    listeners.forEach((l) => l());
    return () => {
      if (focus !== mine) return;
      focus = null;
      listeners.forEach((l) => l());
    };
    // A draft's chat read in re-registers it, so the panel shows it.
  }, [kind, id, title, editable, draft]);
}
