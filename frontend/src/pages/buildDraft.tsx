/**
 * An editor's draft (D125): what's typed and not saved -- the text, the Id of
 * a new one, the chat -- kept on the server as it's typed, so leaving the page
 * (or the tab) loses none of it. The Builder's editors all use it.
 *
 * A draft is made by the first change (opening the starter and leaving makes
 * none) and saved again a moment after each; leaving saves at once. Opened
 * again -- a new one from the list, an existing one by itself -- it's put
 * back as it was, chat and all. Create or Save leaves it holding the chat,
 * as the saved one's (`finish`), so how it was built isn't lost.
 *
 * A saved one has one draft, everyone's who may change it (D161): its owner,
 * its members, admins, Claude Code as any of them. Each editor follows the
 * others' changes as they're made, and what it typed meanwhile is merged
 * over them by lines (D162, merge3) -- never dropped, and never written over
 * theirs: a save made on an older version is refused, merged, and saved again.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError, BuildDraft, BuildFiles, readableError, SYNC_ORIGIN } from "../api";
import { BuildDraftHooks, BuildKind } from "../agent/buildFocus";
import { BUILD_MEMBERS_EVENT, DRAFT_EVENT, LiveEvent } from "../sessions/liveEvents";
import { MEMBERS_CHANGED } from "../components/BuildMembers";
import { merge3, mergeFiles } from "./merge3";

const SAVE_AFTER_MS = 800;

/** The Builder editor open in this tab, and its draft (D157): what this tab
 * reports as on screen, so Claude Code knows which draft it's helping with. */
export interface EditorOnScreen {
  kind: BuildKind;
  targetId: string | null;
  draftId: number | null;
}
let onScreen: EditorOnScreen | null = null;
const screenListeners = new Set<() => void>();
function setOnScreen(next: EditorOnScreen | null) {
  onScreen = next;
  screenListeners.forEach((l) => l());
}
export function useEditorOnScreen(): EditorOnScreen | null {
  return useSyncExternalStore(
    (l) => {
      screenListeners.add(l);
      return () => screenListeners.delete(l);
    },
    () => onScreen,
  );
}

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
  /** The files beside the text (D136) -- a pane's or a step's -- and as saved;
   * undefined for a workflow, which has none. */
  files?: BuildFiles;
  baseFiles?: BuildFiles | null;
  /** Puts a draft's text (and a new one's Id, and its files) in the editor. */
  restore: (source: string, newId: string, files: BuildFiles) => void;
  /** False for someone who may only read it (D161): nothing is kept. */
  editable?: boolean;
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
  /** After Create or Save: the draft keeps the chat (and its members), now the saved one's. */
  finish: (savedId: string, savedSource: string, savedFiles?: BuildFiles) => Promise<void>;
  /** More than one person works in it (D161): its chat is people talking (D163). */
  shared: boolean;
}

/** Files compared by what they hold, whatever order they were added in. */
export function filesKey(files: BuildFiles | undefined | null): string {
  return JSON.stringify(Object.entries(files ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
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
  const [shared, setShared] = useState(false);
  const editable = o.editable !== false;
  // The draft's version this editor holds (D157): its saves are made on it,
  // and an announced change past it is fetched and shown.
  const versionRef = useRef<number>(0);
  // The text, Id and files as the server last had them, as far as this editor
  // knows: what a merge measures both sides' changes from (D162).
  const agreed = useRef<{ source: string; newId: string; files: BuildFiles } | null>(null);

  // Read by saves that may outlive the editor (a turn's answer, its proposal).
  const idRef = useRef<number | null>(draftId);
  const sourceRef = useRef(o.source);
  sourceRef.current = o.source;
  const newIdRef = useRef(o.newId);
  newIdRef.current = o.newId;
  const withFiles = o.files !== undefined;
  const filesRef = useRef<BuildFiles | undefined>(o.files);
  filesRef.current = o.files;
  const baseRef = useRef(o.base);
  baseRef.current = o.base;
  const baseFilesRef = useRef(o.baseFiles);
  baseFilesRef.current = o.baseFiles;
  const turnCount = useRef(0);
  type Snapshot = { source: string; newId: string; files: string };
  const last = useRef<Snapshot | null>(null);
  const pending = useRef<Snapshot | null>(null);
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
    (change: { source?: string; new_id?: string; files?: BuildFiles; chat?: unknown[] }) =>
      enqueue(async () => {
        let saved: BuildDraft;
        if (idRef.current !== null) {
          // Text is saved on the version it was edited from; a chat alone isn't held to one.
          const held = change.source !== undefined || change.files !== undefined;
          try {
            saved = await api.updateBuildDraft(idRef.current, held ? { ...change, base_version: versionRef.current } : change);
          } catch (e) {
            // Changed elsewhere first (Claude Code, another tab): theirs is shown, not written over.
            if (e instanceof ApiError && e.status === 409) {
              await followRef.current(null);
              return;
            }
            throw e;
          }
        } else {
          try {
            saved = await api.createBuildDraft({
              kind,
              target_id: targetId,
              new_id: newIdRef.current,
              source: sourceRef.current,
              ...(filesRef.current !== undefined ? { files: filesRef.current } : {}),
              ...change,
              // A saved one's draft is everyone's (D161): if someone made it a
              // moment ago, this is told so rather than writing over theirs.
              ...(targetId !== null ? { expect_new: true } : {}),
            });
          } catch (e) {
            const theirs = e instanceof ApiError && e.status === 409 && targetId !== null ? await api.draftOf(kind, targetId) : null;
            if (!theirs) throw e;
            // Theirs, with what was typed here merged over it -- both
            // measured from the saved text this editor opened (D162).
            idRef.current = theirs.id;
            setId(theirs.id);
            if (baseRef.current !== null) agreed.current = { source: baseRef.current, newId: "", files: baseFilesRef.current ?? {} };
            await followRef.current(null);
            return;
          }
          idRef.current = saved.id;
          setId(saved.id);
          agreed.current = { source: saved.source ?? sourceRef.current, newId: newIdRef.current, files: filesRef.current ?? {} };
        }
        versionRef.current = Math.max(versionRef.current, saved.version ?? 0);
        if (change.source !== undefined || change.files !== undefined || change.new_id !== undefined) {
          const was = agreed.current ?? { source: sourceRef.current, newId: newIdRef.current, files: filesRef.current ?? {} };
          agreed.current = {
            source: change.source ?? was.source,
            newId: change.new_id ?? was.newId,
            files: change.files ?? was.files,
          };
        }
        setShared(!!saved.shared);
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
    // An existing one changed back to what's saved, with no chat and nobody
    // else in it: nothing to keep.
    if (targetId !== null && change.source === baseRef.current && change.files === filesKey(baseFilesRef.current)
        && turnCount.current === 0 && !sharedRef.current) {
      enqueue(async () => {
        if (idRef.current === null) return;
        await api.deleteBuildDraft(idRef.current);
        idRef.current = null;
        setId(null);
        setStatus(null);
      });
      return;
    }
    write({ source: change.source, new_id: change.newId, ...(withFiles ? { files: filesRef.current } : {}) });
  }, [enqueue, targetId, write, withFiles]);

  // Put back what was left: a new one's draft at once; an existing one's once
  // its saved text is in (or that text would land over the draft's).
  const ready = draftId !== null || targetId === null || o.base !== null;
  useEffect(() => {
    if (!ready || loaded) return;
    if (!editable) {
      // Someone who may only read it: nothing of theirs to put back or keep.
      setLoaded(true);
      return;
    }
    let cancelled = false;
    const found = draftId !== null ? api.getBuildDraft(draftId) : targetId !== null ? api.draftOf(kind, targetId) : Promise.resolve(null);
    found
      .then((d) => {
        if (cancelled) return;
        if (d) {
          idRef.current = d.id;
          setId(d.id);
          versionRef.current = d.version ?? 0;
          last.current = { source: d.source ?? "", newId: d.new_id, files: filesKey(d.files) };
          agreed.current = { source: d.source ?? "", newId: d.new_id, files: d.files ?? {} };
          turnCount.current = d.chat?.length ?? 0;
          setTurns(d.chat ?? []);
          setShared(!!d.shared);
          // A saved one's draft that holds only its chat changes nothing.
          if (d.changed) {
            restoreRef.current(d.source ?? "", d.new_id, d.files ?? {});
            const when = new Date(d.updated_at.endsWith("Z") ? d.updated_at : `${d.updated_at}Z`);
            setStatus(
              targetId !== null
                ? `Unsaved changes from ${when.toLocaleString()} are here: Save keeps them, Discard goes back to what's saved.`
                : `The draft from ${when.toLocaleString()}.`,
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
  }, [ready, loaded, draftId, targetId, kind, editable]);

  // Changed somewhere else (D157, D161): another member, Claude Code, the
  // agent, another tab. The editor shows it -- the text, the files, the chat
  // -- with what was typed here and not saved yet merged over it by lines
  // (D162), which the next save then writes on top of theirs. Run on the
  // save chain, so it never lands between a save and its reply.
  const follow = useCallback(async (by: string | null) => {
    if (idRef.current === null) return;
    const d = await api.getBuildDraft(idRef.current);
    // Only newer than what's held: one change can be announced twice (its
    // text, then its files), and a second follow of the same version would
    // merge what was typed since the first a second time.
    if ((d.version ?? 0) <= versionRef.current) return;
    versionRef.current = d.version ?? 0;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    const theirs = { source: d.source ?? "", newId: d.new_id, files: d.files ?? {} };
    // Never in sync with the server yet (an editor taking a draft made for
    // it): what it opened with is what its own changes are measured from.
    const opened = baseRef.current !== null ? { source: baseRef.current, newId: "", files: baseFilesRef.current ?? {} } : null;
    const base = agreed.current ?? opened ?? theirs;
    const ours = { source: sourceRef.current, newId: newIdRef.current, files: filesRef.current ?? {} };
    const textChanged = theirs.source !== base.source || filesKey(theirs.files) !== filesKey(base.files);
    const text = merge3(base.source, ours.source, theirs.source);
    const files = withFiles ? mergeFiles(base.files, ours.files, theirs.files) : { files: theirs.files, conflict: false };
    // A new one's Id: whoever typed one last; ours if we changed it.
    const newId = ours.newId.trim() !== base.newId.trim() ? ours.newId : theirs.newId;
    agreed.current = theirs;
    // What the server has; what's shown differs from it only by our merged
    // edits, which the effect below then saves on this version.
    last.current = { source: theirs.source, newId: theirs.newId, files: filesKey(theirs.files) };
    turnCount.current = d.chat?.length ?? 0;
    setTurns(d.chat ?? []);
    setShared(!!d.shared);
    restoreRef.current(text.text, newId, files.files);
    setError(null);
    if (text.conflict || files.conflict) {
      setStatus(`${by ?? "Someone else"} changed the same lines you were changing at ${at(Date.now())}: theirs are kept there, the rest of yours too.`);
    } else if (textChanged) {
      setStatus(`${by ? `Changed by ${by}` : "Changed elsewhere"} at ${at(Date.now())}${ours.source !== base.source ? ", your changes kept" : ""}.`);
    }
  }, [withFiles]);
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    if (!loaded) return;
    const onDraft = (e: Event) => {
      const event = (e as CustomEvent<LiveEvent>).detail;
      if (event.build_kind !== kind || event.draft_id === undefined) return;
      if (idRef.current === null) {
        // A draft made for this editor (open_draft on screen): taken, as this one's.
        if (event.for_tab !== SYNC_ORIGIN || (event.target_id ?? null) !== targetId) return;
        idRef.current = event.draft_id;
        setId(event.draft_id);
      } else if (event.draft_id !== idRef.current) return;
      if (event.version !== null && event.version <= versionRef.current) return;
      const by = event.by ?? null;
      enqueue(() => followRef.current(by));
    };
    window.addEventListener(DRAFT_EVENT, onDraft);
    return () => window.removeEventListener(DRAFT_EVENT, onDraft);
  }, [loaded, kind, targetId, enqueue]);

  // Someone added or removed, here or elsewhere (D161): whether it's shared
  // now decides what its chat is (D163).
  useEffect(() => {
    const onMembers = (e: Event) => {
      const detail = (e as CustomEvent<{ kind?: string; build_kind?: string }>).detail ?? {};
      if ((detail.kind ?? detail.build_kind) !== kind || idRef.current === null) return;
      api.getBuildDraft(idRef.current).then((d) => setShared(!!d.shared), () => undefined);
    };
    window.addEventListener(MEMBERS_CHANGED, onMembers);
    window.addEventListener(BUILD_MEMBERS_EVENT, onMembers);
    return () => {
      window.removeEventListener(MEMBERS_CHANGED, onMembers);
      window.removeEventListener(BUILD_MEMBERS_EVENT, onMembers);
    };
  }, [kind]);

  // Said to be on screen while open, with its draft once it has one.
  useEffect(() => {
    setOnScreen({ kind, targetId, draftId: id });
  }, [kind, targetId, id]);
  useEffect(() => () => setOnScreen(null), []);

  // Who else works in it decides what an emptied draft is: nobody else's,
  // it can go; shared, it stays (it's theirs too).
  const sharedRef = useRef(shared);
  sharedRef.current = shared;

  // Every change, a moment later.
  // By what they hold, never the objects: an editor's `{}` is a new one each
  // render, and an effect run on every render after Create queued the text
  // from before the save -- which leaving then wrote over the saved one's.
  const nowFiles = filesKey(o.files);
  const baseFiles = filesKey(o.baseFiles);
  useEffect(() => {
    if (!loaded || o.base === null || !editable) return;
    const now = { source: o.source, newId: o.newId.trim(), files: nowFiles };
    const changed = last.current
      ? now.source !== last.current.source || now.newId !== last.current.newId || now.files !== last.current.files
      : now.source !== o.base || now.newId !== "" || now.files !== baseFiles;
    if (!changed) return;
    pending.current = now;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_AFTER_MS);
  }, [loaded, o.base, baseFiles, o.source, o.newId, nowFiles, flush, editable]);

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
      keep: (text, files) => write({ source: text, ...(files !== undefined && withFiles ? { files } : {}) }),
      id,
      shared,
    }),
    [key, turns, write, withFiles, id, shared],
  );

  const discard = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    pending.current = null;
    await enqueue(async () => {
      if (idRef.current === null) return;
      // An existing one's goes back to what's saved -- for everyone in it;
      // its chat stays (the server's own rule, D161). A new one's goes.
      await api.deleteBuildDraft(idRef.current);
      if (targetId === null) {
        idRef.current = null;
        setId(null);
      } else if (baseRef.current !== null) {
        agreed.current = { source: baseRef.current, newId: "", files: baseFilesRef.current ?? {} };
      }
    });
    last.current = baseRef.current !== null ? { source: baseRef.current, newId: "", files: filesKey(baseFilesRef.current) } : null;
    setStatus(null);
  }, [enqueue, targetId]);

  const finish = useCallback(
    async (savedId: string, savedSource: string, savedFiles?: BuildFiles) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      pending.current = null;
      last.current = null;
      await enqueue(async () => {
        if (idRef.current === null) return;
        // The chat is how it was built, and its members are who built it:
        // kept, as the saved one's.
        if (turnCount.current > 0 || sharedRef.current || targetId !== null) {
          await api.updateBuildDraft(idRef.current, {
            target_id: savedId,
            source: savedSource,
            ...(savedFiles !== undefined ? { files: savedFiles } : {}),
          });
        }
        else {
          await api.deleteBuildDraft(idRef.current);
          idRef.current = null;
          setId(null);
        }
      });
      setStatus(null);
    },
    [enqueue, targetId],
  );

  return { id, status, error, hooks, discard, finish, shared };
}

/** The drafts of one kind this person works in, for its list: new ones, and
 * saved ones with unsaved changes -- theirs or their fellow members'. */
export function useDraftList(kind: BuildKind, again = 0): { fresh: BuildDraft[]; changed: Map<string, BuildDraft> } {
  const [drafts, setDrafts] = useState<BuildDraft[]>([]);
  // `again`: a list that stays mounted while an editor opens and closes over
  // it (the type lists, D159) reads again when it comes back.
  useEffect(() => {
    api.listBuildDrafts(kind).then(setDrafts, () => setDrafts([]));
  }, [kind, again]);
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
