/**
 * An editor's draft (D125): what its builder has typed and not saved -- the
 * text, the Id of a new one, the Building chat -- kept on the server as they
 * type, so leaving the page (or the tab) loses none of it. The Builder's pane
 * and step editors and a workflow's use it alike.
 *
 * A draft is made by the first change (opening the starter and leaving makes
 * none) and saved again a moment after each; leaving saves at once. Opened
 * again -- a new one from the list, an existing one by itself -- it's put
 * back as it was, chat and all. Create or Save leaves it holding only the
 * chat, as the saved one's (`finish`), so how it was built isn't lost.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, BuildDraft, readableError } from "../api";
import { BuildDraftHooks, BuildKind } from "../agent/buildFocus";

const SAVE_AFTER_MS = 800;

export interface DraftOptions {
  kind: BuildKind;
  /** The saved one it changes; null for a new one. */
  targetId: string | null;
  /** A new one's draft, opened from the list. */
  draftId: number | null;
  /** The text as saved (or the starter, for a new one), once known: what
   * isn't a change. Null while it loads -- nothing is put back or saved
   * until then, or loading the saved text would overwrite the draft's. */
  base: string | null;
  source: string;
  newId: string;
  /** Puts a draft's text (and a new one's Id) in the editor. */
  restore: (source: string, newId: string) => void;
}

export interface DraftState {
  /** The draft's id, once there is one. */
  id: number | null;
  /** A line under the editor: "Draft saved 12:03", "Restored your draft…". */
  status: string | null;
  error: string | null;
  /** For useOfferBuild: the chat's key, its turns, where they're saved. */
  hooks: BuildDraftHooks;
  discard: () => Promise<void>;
  /** After Create or Save: the draft keeps only the chat, now the saved one's. */
  finish: (savedId: string, savedSource: string) => Promise<void>;
}

function at(iso: string | number): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function useBuildDraft(o: DraftOptions): DraftState {
  const { kind, targetId, draftId } = o;
  const [key] = useState(() => (draftId !== null ? `draft:${draftId}` : `${kind}:${targetId ?? "new"}:${Date.now().toString(36)}`));
  const [loaded, setLoaded] = useState(false);
  const [turns, setTurns] = useState<unknown[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<number | null>(draftId);

  // Read by saves that may outlive the editor (a turn's answer, its proposal).
  const idRef = useRef<number | null>(draftId);
  const sourceRef = useRef(o.source);
  sourceRef.current = o.source;
  const newIdRef = useRef(o.newId);
  newIdRef.current = o.newId;
  const baseRef = useRef(o.base);
  baseRef.current = o.base;
  const turnCount = useRef(0);
  const last = useRef<{ source: string; newId: string } | null>(null);
  const pending = useRef<{ source: string; newId: string } | null>(null);
  const timer = useRef<number | null>(null);
  // One save at a time, in order: the first makes the draft the rest change.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const restoreRef = useRef(o.restore);
  restoreRef.current = o.restore;

  const enqueue = useCallback((work: () => Promise<unknown>) => {
    chain.current = chain.current.then(work).catch((e) => setError(`Your draft wasn't saved: ${readableError(e)}`));
    return chain.current;
  }, []);

  /** Saves `change` into the draft, making it if there's none yet. */
  const write = useCallback(
    (change: { source?: string; new_id?: string; chat?: unknown[] }) =>
      enqueue(async () => {
        let saved: BuildDraft;
        if (idRef.current !== null) saved = await api.updateBuildDraft(idRef.current, change);
        else {
          saved = await api.createBuildDraft({
            kind,
            target_id: targetId,
            new_id: newIdRef.current,
            source: sourceRef.current,
            ...change,
          });
          idRef.current = saved.id;
          setId(saved.id);
        }
        setError(null);
        setStatus(`Draft saved ${at(saved.updated_at.endsWith("Z") ? saved.updated_at : `${saved.updated_at}Z`)}`);
      }),
    [enqueue, kind, targetId],
  );

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const change = pending.current;
    pending.current = null;
    if (!change) return;
    last.current = change;
    // An existing one changed back to what's saved, with no chat: nothing to keep.
    if (targetId !== null && change.source === baseRef.current && turnCount.current === 0) {
      enqueue(async () => {
        if (idRef.current === null) return;
        await api.deleteBuildDraft(idRef.current);
        idRef.current = null;
        setId(null);
        setStatus(null);
      });
      return;
    }
    write({ source: change.source, new_id: change.newId });
  }, [enqueue, targetId, write]);

  // Put back what was left: a new one's draft at once; an existing one's once
  // its saved text is in (or that text would land over the draft's).
  const ready = draftId !== null || targetId === null || o.base !== null;
  useEffect(() => {
    if (!ready || loaded) return;
    let cancelled = false;
    const found = draftId !== null ? api.getBuildDraft(draftId) : targetId !== null ? api.draftOf(kind, targetId) : Promise.resolve(null);
    found
      .then((d) => {
        if (cancelled) return;
        if (d) {
          idRef.current = d.id;
          setId(d.id);
          last.current = { source: d.source ?? "", newId: d.new_id };
          turnCount.current = d.chat?.length ?? 0;
          setTurns(d.chat ?? []);
          // A saved one's draft that holds only its chat changes nothing.
          if (d.changed) {
            restoreRef.current(d.source ?? "", d.new_id);
            const when = new Date(d.updated_at.endsWith("Z") ? d.updated_at : `${d.updated_at}Z`);
            setStatus(
              targetId !== null
                ? `Your unsaved changes from ${when.toLocaleString()} are back: Save keeps them, Discard goes back to what's saved.`
                : `Your draft from ${when.toLocaleString()}.`,
            );
          }
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(readableError(e));
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ready, loaded, draftId, targetId, kind]);

  // Every change, a moment later.
  useEffect(() => {
    if (!loaded || o.base === null) return;
    const now = { source: o.source, newId: o.newId.trim() };
    const changed = last.current
      ? now.source !== last.current.source || now.newId !== last.current.newId
      : now.source !== o.base || now.newId !== "";
    if (!changed) return;
    pending.current = now;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_AFTER_MS);
  }, [loaded, o.base, o.source, o.newId, flush]);

  // Leaving saves what's waiting, at once.
  useEffect(() => () => flush(), [flush]);

  const hooks = useMemo<BuildDraftHooks>(
    () => ({
      key,
      turns,
      saveTurns: (next) => {
        turnCount.current = next.length;
        if (next.length === 0 && idRef.current === null) return;
        write({ chat: next });
      },
      keep: (text) => write({ source: text }),
    }),
    [key, turns, write],
  );

  const discard = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    pending.current = null;
    await enqueue(async () => {
      if (idRef.current === null) return;
      // An existing one's chat stays; its text goes back to what's saved.
      if (targetId !== null && turnCount.current > 0 && baseRef.current !== null) {
        await api.updateBuildDraft(idRef.current, { source: baseRef.current });
        return;
      }
      await api.deleteBuildDraft(idRef.current);
      idRef.current = null;
      setId(null);
    });
    last.current = baseRef.current !== null ? { source: baseRef.current, newId: "" } : null;
    setStatus(null);
  }, [enqueue, targetId]);

  const finish = useCallback(
    async (savedId: string, savedSource: string) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      pending.current = null;
      last.current = null;
      await enqueue(async () => {
        if (idRef.current === null) return;
        // The chat is how it was built: kept, as the saved one's.
        if (turnCount.current > 0) await api.updateBuildDraft(idRef.current, { target_id: savedId, source: savedSource });
        else {
          await api.deleteBuildDraft(idRef.current);
          idRef.current = null;
          setId(null);
        }
      });
      setStatus(null);
    },
    [enqueue],
  );

  return { id, status, error, hooks, discard, finish };
}

/** This person's drafts of one kind, for its list: new ones, and the saved
 * ones they've changed and not saved. */
export function useDraftList(kind: BuildKind): { fresh: BuildDraft[]; changed: Map<string, BuildDraft> } {
  const [drafts, setDrafts] = useState<BuildDraft[]>([]);
  useEffect(() => {
    api.listBuildDrafts(kind).then(setDrafts, () => setDrafts([]));
  }, [kind]);
  return useMemo(
    () => ({
      fresh: drafts.filter((d) => d.target_id === null),
      changed: new Map(drafts.filter((d) => d.target_id !== null && d.changed).map((d) => [d.target_id!, d])),
    }),
    [drafts],
  );
}

export function draftTime(d: BuildDraft): string {
  return new Date(d.updated_at.endsWith("Z") ? d.updated_at : `${d.updated_at}Z`).toLocaleString();
}

/** Under an editor: whether what's typed is kept (D125). */
export function DraftStatus({ kept }: { kept: DraftState }) {
  if (kept.error) return <p className="error-text builder-draft-status">{kept.error}</p>;
  if (!kept.status) return null;
  return <p className="muted builder-draft-status">{kept.status}</p>;
}
