/**
 * A credential or connection type's editor, as the Builder's other editors are
 * (D159): its text kept as the builder's draft while they work (D125), and
 * the editor offered to the agent panel's Building tab, so the Builder's
 * agent -- or Claude Code, on screen -- builds a type the way it builds a pane.
 *
 * The editors are forms with a YAML view (D158); this is mounted beside the
 * open one, keyed per type opened, and works on the YAML the form's draft
 * reads as (`typeText`). What comes back -- a draft put back, a change made
 * elsewhere, a proposal -- is read as YAML into the form.
 */

import { MutableRefObject } from "react";
import { parse } from "yaml";
import { useOfferBuild } from "../../agent/buildFocus";
import { DraftState, DraftStatus, useBuildDraft } from "../../pages/buildDraft";
import { TypeData } from "./TypeYaml";

export function readType(text: string): TypeData | null {
  try {
    const data = parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as TypeData) : null;
  } catch {
    return null;
  }
}

export default function TypeDraft({
  kind,
  targetId,
  draftId,
  base,
  source,
  newId,
  title,
  editable,
  onText,
  onProposed,
  keeper,
}: {
  kind: "credential" | "connection";
  /** The saved type it changes; null for a new one. */
  targetId: string | null;
  /** A new one's draft, opened from the list. */
  draftId: number | null;
  /** The text as saved, or as the new one started: what isn't a change. */
  base: string;
  source: string;
  newId: string;
  title: string;
  editable: boolean;
  /** Text to show in the form: a draft put back, or a change made elsewhere. */
  onText: (text: string, newId: string) => void;
  /** The agent's proposal: put in the form, unsaved, with what it says. */
  onProposed: (text: string, summary: string) => void;
  /** Where the editor reaches the draft from: Save finishes it, as Create/Save does a pane's. */
  keeper: MutableRefObject<DraftState | null>;
}) {
  const kept = useBuildDraft({ kind, targetId, draftId, base, source, newId, restore: (text, id) => onText(text, id) });
  keeper.current = kept;
  useOfferBuild(kind, targetId, title, editable, source, (text, summary) => onProposed(text, summary), kept.hooks);
  return <DraftStatus kept={kept} />;
}
