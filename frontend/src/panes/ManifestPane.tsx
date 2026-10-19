/**
 * The generic pane renderer (PLATFORM_PLAN.md §15.5): draws a pane from its
 * manifest alone -- cards of inputs, outputs and action buttons, in the
 * layout the YAML gives. Base64, Diff and JWT are drawn by it, looking and
 * behaving as their hand-written components did; the API table exists only
 * as a manifest.
 *
 * Where each value lives:
 * - an input under "<pane>.in.<key>" in session state (so it syncs, the agent
 *   can set it, a template keeps it) -- unless it is `sensitive`, which stays
 *   in this component's memory and nowhere else, as JWT's token always has;
 * - a live action's outputs (D43) are worked out here from the inputs on
 *   every change and never stored: the inputs are, and they come back the
 *   same. A `run_on: click` one keeps its last result in memory too;
 * - a server action's outputs (a declarative request, or a handler such as
 *   DynamoDB's scan), with `ranAt`/`resultsVersion` beside them, in the
 *   pane's own record on the server (D21, sessions/outputs.ts) -- not the
 *   session's state: the server stores them, applying Load more's append and
 *   an input's resets, and every tab follows them by the pane's own version;
 * - how the pane looks (expanded rows) under "<pane>.view.<key>", synced like
 *   the inputs so the agent or another member can show you something (D48);
 * - a picker's options in this component's memory, never the session (D47).
 *
 * A person's change to an input goes through `changeInputs`: it clears what
 * the input `resets` and runs the actions whose `on_change` names it (picking
 * a table describes it; clicking a folder opens it), with the new values.
 */

import { Dispatch, ReactNode, SetStateAction, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError, CredentialSummary, Environment, PaneOutputs, readableError, Target } from "../api";
import ExportMenu from "../components/ExportMenu";
import { PaneSelectionShare } from "../components/paneSelection";
import RestoredResultsNote from "../components/RestoredResultsNote";
import { HideSelectedButtons, SelectAllCheckbox, useRowSelection } from "../components/rowSelection";
import { applyOutputs, setLocal, usePaneOutputs } from "../sessions/outputs";
import { usePaneAddress, useSessions, useSessionState, useSessionValue } from "../sessions/SessionContext";
import DiffView, { DiffViewMode } from "./DiffView";
import { IndicesPicker, LogGroupsPicker, TimeRange } from "./GroupedPicker";
import { FilesView, ListView, TagsView } from "./ListView";
import { DiffRow, LIVE_FUNCTIONS, Outputs } from "./live";
import {
  Card,
  defaultOf,
  LayoutItem,
  manifest as findManifest,
  ManifestAction,
  ManifestInput,
  ManifestOutput,
  ManifestView,
  PaneManifest,
  textOf,
  When,
} from "./manifest";
import { actionById, Option, PaneApi, plain, RunOptions, Values } from "./paneApi";
import HttpResponseView from "./HttpResponseView";
import { LogsView, RunNote, SortControl } from "./LogsView";
import { StreamView, TopicsEditor } from "./StreamView";
import { ChartItem, HistogramView } from "./chart/ChartView";
import PaneSettings from "./PaneSettings";
import { RefreshFailure, useAutoRefresh } from "./refresh";
import { useSavedInputs } from "./SavedInputsMenu";
import { TitleExtra } from "./titleExtra";
import { boundBy, boundValues, changedInThisTab, targets as targetsOf, VARIABLE_LABELS, VARIABLES_KEY, VariableName, Variables } from "./variables";
import { ViewModeLine } from "./viewMode";
import { render } from "./template";

/** Where an item is drawn, which decides its markup: a card's own column, a
 * toolbar line, a row of equal columns, beside the card's title, "bare" --
 * an input whose label its row has already drawn -- or a `line`: inline as
 * in a toolbar, with a picker's label beside it (the HTTP client's Auth). */
type Place = "card" | "toolbar" | "row" | "aside" | "bare" | "line";

interface Pane extends PaneApi {
  /** Actions whose errors the layout places itself (`error:`), so their
   * buttons don't repeat them. */
  errorsPlaced: Set<string>;
  /** Each connection type's connections the user can reach, for its
   * pickers; null while loading. Fetched once per pane, not per picker. */
  targets: Record<string, Target[] | null>;
  /** Which inputs' examples are shown: the tab's own business. */
  examplesOpen: Record<string, boolean>;
  toggleExamples: (key: string) => void;
  /** Whether a background action (D51) is running on the server: it is
   * from its Run until the run the server wrote says otherwise. */
  running: (action: ManifestAction) => boolean;
  stopRun: (action: ManifestAction) => void;
  /** A results card's Clear: these outputs, for everyone looking. */
  clearOutputs: (keys: string[]) => void;
  /** Input key -> the session variable it follows now (D60): drawn read-only. */
  bound: Record<string, VariableName>;
  unlink: (name: VariableName) => void;
  /** View mode (D61): the pane shows its outputs only. */
  viewOnly: boolean;
}

/** A background run as the server writes it into `out.run` (D51). */
interface RunState {
  id?: string;
  status?: "running" | "done" | "stopped" | "failed";
}

/** Whether a layout draws a time range, so a run says the browser's time zone. */
function hasTimeRange(m: PaneManifest): boolean {
  const walk = (items: LayoutItem[]): boolean =>
    items.some((item) => !!item.time_range || walk(item.toolbar ?? []) || walk(item.row ?? []) || walk(item.line ?? []));
  return m.layout.some((card) => walk([...card.aside, ...card.items]));
}

/** A manifest text that may be a template over the inputs and the chosen
 * connections (`sel.targetId.base_url`): the HTTP client's URL placeholder. */
function textIn(text: Parameters<typeof textOf>[0], pane: Pane): string {
  const shown = textOf(text, pane.inputs);
  if (!shown.includes("{{")) return shown;
  const sel: Values = {};
  for (const input of pane.m.inputs) {
    if (input.type !== "connection" || !input.connection_type) continue;
    sel[input.key] = pane.targets[input.connection_type]?.find((t) => t.id === pane.inputs[input.key])?.config;
  }
  return render(shown, { in: pane.inputs, sel });
}

export default function ManifestPane({ type }: { type: string }) {
  const m = findManifest(type);
  if (!m) {
    return (
      <div className="panel">
        <p className="muted" style={{ margin: 0 }}>
          This pane's type ({type}) isn't available to you.
        </p>
      </div>
    );
  }
  return <Rendered m={m} />;
}

/** One stored input: a hook per key, so it reads and writes "<pane>.in.<key>". */
function useStoredInput(input: ManifestInput): [unknown, Dispatch<SetStateAction<unknown>>] {
  return useSessionState<unknown>(`in.${input.key}`, () => defaultOf(input));
}

function useStoredView(view: ManifestView): [unknown, Dispatch<SetStateAction<unknown>>] {
  return useSessionState<unknown>(`view.${view.key}`, () => view.default ?? null);
}

function isLoader(m: PaneManifest, action: ManifestAction): boolean {
  return m.inputs.some((i) => i.options?.action === action.id);
}

function missingInput(action: ManifestAction, inputs: Values): string | null {
  for (const [key, message] of Object.entries(action.requires ?? {})) {
    const value = inputs[key];
    const empty = (Array.isArray(value) && value.length === 0) || (value instanceof Set && value.size === 0);
    if (!present(value) || empty) return message;
  }
  return null;
}

/** Where every layout item names an action's error, so its button leaves it out. */
function placedErrors(m: PaneManifest): Set<string> {
  const placed = new Set<string>();
  const walk = (items: LayoutItem[]) => {
    for (const item of items) {
      if (item.error) placed.add(item.error);
      walk(item.toolbar ?? []);
      walk(item.row ?? []);
      walk(item.line ?? []);
    }
  };
  for (const card of m.layout) walk([...card.aside, ...card.items]);
  return placed;
}

function Rendered({ m }: { m: PaneManifest }) {
  // A manifest never changes while its pane is mounted, so the number of
  // hooks below is fixed for the component's life.
  const stored = m.inputs.filter((i) => !i.sensitive).map((i) => [i, useStoredInput(i)] as const);
  const [secret, setSecret] = useState<Values>(() =>
    Object.fromEntries(m.inputs.filter((i) => i.sensitive).map((i) => [i.key, defaultOf(i)])),
  );
  const inputs: Values = { ...secret };
  for (const [i, [value]] of stored) inputs[i.key] = value;

  function setInputValue(key: string, value: unknown) {
    const found = stored.find(([i]) => i.key === key);
    if (found) found[1][1](value);
    else setSecret((prev) => ({ ...prev, [key]: value }));
  }

  const address = usePaneAddress();
  // Outputs live beside the session, not in it (D21, sessions/outputs.ts):
  // written by the server, for every tab and member at once. A pane outside
  // a session keeps its own, in this tab.
  const outputsAt = address.session ?? `local:${m.id}`;
  const held = usePaneOutputs(outputsAt, address.pane);
  const storedViews = (m.views ?? []).map((v) => [v, useStoredView(v)] as const);
  const resultsVersion = held.resultsVersion as number | undefined;
  const ranAt = held.ranAt as number | undefined;
  const saved = useSavedInputs(m, inputs);
  const refresh = useAutoRefresh(
    m,
    address.session,
    address.pane,
    held,
    hasTimeRange(m) ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
  );

  const live = useLiveOutputs(m, inputs);
  // Session variables this pane follows (D60), and view mode (D61). A viewer
  // always sees view mode: they can't change inputs, so showing them was only
  // clutter.
  const variables = useSessionValue<Variables>(VARIABLES_KEY) ?? NO_VARIABLES;
  const [unlinked, setUnlinked] = useSessionState<string[]>("unlinked", []);
  const [inputsShown, setInputsShown] = useSessionState<"shown" | "hidden" | undefined>("inputs", undefined);
  const sessionView = !!useSessionValue<boolean>("viewMode");
  const { sessions: allSessions } = useSessions();
  const viewer = allSessions.find((s) => s.id === address.session)?.role === "viewer";
  const viewOnly = viewer || (inputsShown ? inputsShown === "hidden" : sessionView);
  const unlinkedList = Array.isArray(unlinked) ? unlinked : [];
  const bound = boundBy(m, variables, unlinkedList);
  const boundKey = JSON.stringify(boundValues(m, variables, unlinkedList));
  const [clicked, setClicked] = useState<Outputs>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [options, setOptions] = useState<Record<string, Option[] | undefined>>({});
  const [flashed, setFlashed] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const errorsPlaced = useMemo(() => placedErrors(m), [m]);
  const targets = useTargets(m);
  const [examplesOpen, setExamplesOpen] = useState<Record<string, boolean>>({});
  const { flushAll } = useSessions();
  // A background run's id from its Run's reply until the server's write of
  // it arrives (a moment later, through the event stream): the button stays
  // busy across that gap instead of flickering back to "Run query".
  const [awaiting, setAwaiting] = useState<string | null>(null);

  const outputs: Values = {};
  for (const o of m.outputs) if (held[o.key] !== undefined) outputs[o.key] = held[o.key];
  Object.assign(outputs, live, clicked);
  const views: Values = {};
  for (const [v, [value]] of storedViews) views[v.key] = value;

  const run_ = (outputs.run ?? null) as RunState | null;
  useEffect(() => {
    if (awaiting && run_?.id === awaiting) setAwaiting(null);
  }, [awaiting, run_?.id]);
  useEffect(() => {
    // Never busy for good if that write never comes (the event stream down).
    if (!awaiting) return;
    const timer = window.setTimeout(() => setAwaiting(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [awaiting]);

  function running(action: ManifestAction): boolean {
    return !!action.poll && (awaiting !== null || run_?.status === "running");
  }

  async function stopRun(action: ManifestAction) {
    if (!address.session) return;
    setErrors((e) => ({ ...e, [action.id]: null }));
    try {
      await api.stopPaneRun(m.id, address.session, address.pane);
      setAwaiting(null);
    } catch (e) {
      setErrors((prev) => ({ ...prev, [action.id]: readableError(e) }));
    }
  }

  /** Changes an output in this tab only: what the server doesn't store (a
   * viewer's clicks) or hasn't answered yet (a reset). */
  function setOutput(key: string, value: SetStateAction<unknown>) {
    setLocal(outputsAt, address.pane, (values) => {
      const next = typeof value === "function" ? (value as (prev: unknown) => unknown)(values[key]) : value;
      if (Object.is(values[key], next)) return values;
      const out = { ...values };
      if (next === undefined) delete out[key];
      else out[key] = next;
      return out;
    });
  }

  /** What the server stored for this pane, from an action's own reply. */
  function took(result: Values): boolean {
    const stored = result.__outputs as PaneOutputs | undefined;
    if (!stored) return false;
    applyOutputs(outputsAt, { [address.pane]: stored });
    return true;
  }

  function setView(key: string, value: unknown) {
    storedViews.find(([v]) => v.key === key)?.[1][1](value);
  }

  /** Clears one `resets` entry (`in.search`, `out.items`, `view.expanded`):
   * an output only on screen -- the caller has the server clear it too. */
  function clear(ref: string) {
    const dot = ref.indexOf(".");
    const part = ref.slice(0, dot);
    const key = ref.slice(dot + 1);
    if (part === "in") {
      const input = m.inputs.find((i) => i.key === key);
      if (input) setInputValue(key, defaultOf(input));
    } else if (part === "out") {
      if (key !== "resultsVersion") setOutput(key, undefined);
    } else if (part === "view") {
      setView(key, (m.views ?? []).find((v) => v.key === key)?.default ?? null);
    }
  }

  /** Empties a results card (its manifest's `clear`), for everyone looking
   * -- on screen at once, then on the server, which tells the session's
   * other tabs and members. `ranAt` goes too, so nothing says the empty
   * card was "restored", and `resultsVersion`, so checked rows go with the
   * rows. A viewer's is refused there and stays on their screen only, as
   * their clicks do. */
  function clearOutputs(keys: string[]) {
    const all = [...keys, "ranAt", "resultsVersion"];
    for (const key of all) setOutput(key, undefined);
    setErrors({});
    if (!address.session) return;
    api.clearPaneOutputs(address.session, address.pane, all).then(
      (stored) => applyOutputs(outputsAt, { [address.pane]: stored }),
      () => undefined,
    );
  }

  function changeInputs(given: Values): string[] {
    // A choice that sets others too (IoT's mode puts its own default query
    // in), unless this same change sets them -- a saved item's query stands.
    const changes: Values = { ...given };
    for (const [key, value] of Object.entries(given)) {
      const input = m.inputs.find((i) => i.key === key);
      if (!input?.choice_sets || Object.is(inputs[key], value)) continue;
      for (const [other, setTo] of Object.entries(input.choice_sets[String(value)] ?? {})) {
        if (!(other in given)) changes[other] = setTo;
      }
    }
    const next: Values = { ...inputs, ...changes };
    for (const [key, value] of Object.entries(changes)) setInputValue(key, value);
    const cleared: string[] = [];
    for (const key of Object.keys(changes)) {
      if (Object.is(inputs[key], changes[key])) continue;
      for (const ref of m.inputs.find((i) => i.key === key)?.resets ?? []) {
        // Set in this same change (a saved item's prefix with its bucket):
        // that value stands.
        if (ref.startsWith("in.") && ref.slice(3) in changes) continue;
        clear(ref);
        if (ref.startsWith("out.") && held[ref.slice(4)] !== undefined) cleared.push(ref.slice(4));
        if (ref.startsWith("in.")) {
          const input = m.inputs.find((i) => i.key === ref.slice(3));
          if (input) next[input.key] = defaultOf(input);
        }
      }
    }
    const ran: string[] = [];
    for (const action of m.actions) {
      if (!(action.on_change ?? []).some((k) => k in changes && !Object.is(inputs[k], changes[k]))) continue;
      // The first action this sets off clears the stale outputs in the same
      // write as its own results; with none, they're cleared on their own.
      const first = ran.length === 0 && !isLoader(m, action) && !action.live && !action.poll;
      ran.push(action.id);
      run(action, { inputs: next, ...(first && cleared.length ? { clear: cleared.splice(0) } : {}) });
    }
    if (cleared.length && address.session) {
      api.clearPaneOutputs(address.session, address.pane, cleared).then(
        (stored) => applyOutputs(outputsAt, { [address.pane]: stored }),
        () => undefined, // a viewer's, or a pane not saved yet: it's cleared on screen
      );
    }
    // A connection going with the old topics reconnects with the new ones,
    // as whoever changed them -- never under the identity of whoever
    // connected (D54) -- keeping its messages.
    for (const action of m.actions) {
      if (!action.poll || !running(action) || ran.includes(action.id)) continue;
      if (!(action.restart_on ?? []).some((k) => k in changes && !Object.is(inputs[k], changes[k]))) continue;
      ran.push(action.id);
      run(action, { inputs: next, restart: true });
    }
    return ran;
  }

  function flash(message: string) {
    setFlashed(message);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashed(null), 2000);
  }

  async function runRow(action: ManifestAction, args: Values): Promise<Values> {
    const message = missingInput(action, args);
    if (message) throw new Error(message);
    return api.runPaneAction(m.id, action.id, plain(args) as Values);
  }

  /** Where the server stores what an action returns: this pane of its
   * session. */
  function storedIn(opts: RunOptions): { session: string; pane: string; clear?: string[] } | undefined {
    if (!address.session) return undefined;
    return { session: address.session, pane: address.pane, ...(opts.clear?.length ? { clear: opts.clear } : {}) };
  }

  /** An action the server stores the outputs of. A pane added a moment ago
   * is still in the debounced save, and the server says so (409) before
   * running anything: save, and ask again -- waiting for a save before every
   * action made each one a round trip slower. */
  async function runStored(action: ManifestAction, sent: Values, cursor: unknown, where: ReturnType<typeof storedIn>) {
    try {
      return await api.runPaneAction(m.id, action.id, sent, cursor, where);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409 && where)) throw e;
      await flushAll();
      return api.runPaneAction(m.id, action.id, sent, cursor, where);
    }
  }

  async function run(action: ManifestAction, opts: RunOptions = {}) {
    const current = opts.inputs ?? inputs;
    const sent = plain(current) as Values;
    const loadMore = opts.cursor !== undefined && opts.cursor !== null;
    if (action.handler) {
      const message = missingInput(action, current);
      if (message) {
        setErrors((prev) => ({ ...prev, [action.id]: message }));
        return;
      }
    }
    setBusy((b) => ({ ...b, [action.id]: true }));
    setErrors((e) => ({ ...e, [action.id]: null }));
    try {
      if (action.live) {
        const result = await LIVE_FUNCTIONS[action.live]?.(current);
        setClicked(result ?? {});
      } else if (action.poll) {
        // A background run (D51): the server starts it and polls it into the
        // session, so its results arrive the way any other write to the
        // session does -- here, in every other tab and member's browser
        // looking at it, and for the agent. All this gets back is the run.
        if (!address.session) throw new Error("This pane isn't in a session, so there's nowhere for its run to write.");
        // The pane must exist on the server before a run can write into it
        // (one added a moment ago is still in the debounced save).
        await flushAll();
        const timezone = hasTimeRange(m) ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
        const result = await api.runPaneAction(m.id, action.id, sent, undefined, {
          session: address.session,
          pane: address.pane,
          ...(timezone ? { timezone } : {}),
          ...(opts.restart ? { restart: true } : {}),
        });
        const started = (result.run as RunState | undefined)?.id;
        if (started && run_?.id !== started) setAwaiting(started);
      } else if (action.request) {
        const result = await runStored(action, sent, undefined, storedIn(opts));
        if (!took(result)) {
          for (const o of m.outputs) setOutput(o.key, result[o.key]);
          setOutput("ranAt", Date.now());
          setOutput("resultsVersion", (v: unknown) => (Number(v) || 0) + 1);
        }
      } else if (action.handler) {
        const loader = isLoader(m, action);
        if (!loadMore) for (const ref of action.resets ?? []) clear(ref);
        if (loader) setOptions((prev) => ({ ...prev, [action.id]: undefined }));
        // A picker's options are the tab's own (D47): nothing to store.
        const where = loader ? undefined : storedIn(opts);
        const result = await runStored(action, sent, loadMore ? opts.cursor : undefined, where);
        if (loader) {
          setOptions((prev) => ({ ...prev, [action.id]: (result.options as Option[] | undefined) ?? [] }));
          return;
        }
        if (took(result)) return;
        const page = action.page;
        for (const [key, value] of Object.entries(result)) {
          if (!m.outputs.some((o) => o.key === key)) continue;
          if (loadMore && page?.append.includes(key)) {
            setOutput(key, (prev: unknown) => [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(value) ? value : [])]);
          } else if (loadMore && page?.sum.includes(key)) {
            setOutput(key, (prev: unknown) => (Number(prev) || 0) + (Number(value) || 0));
          } else {
            setOutput(key, value);
          }
        }
        // A fresh run of what the pane is for: its results' age, and a new
        // version (which clears the row selection). Load more keeps both, so
        // the rows you checked stay checked; describing a table is neither.
        if (!loadMore && (action.main || action.page)) {
          setOutput("ranAt", Date.now());
          setOutput("resultsVersion", (v: unknown) => (Number(v) || 0) + 1);
        }
      }
    } catch (e) {
      setErrors((prev) => ({ ...prev, [action.id]: readableError(e) }));
    } finally {
      setBusy((b) => ({ ...b, [action.id]: false }));
    }
  }

  const pane: Pane = {
    m,
    inputs,
    outputs,
    views,
    changeInputs,
    setView,
    run,
    busy,
    errors,
    resultsVersion: resultsVersion ?? 0,
    ranAt: ranAt ?? null,
    flash,
    flashed,
    options,
    errorsPlaced,
    runRow,
    targets,
    examplesOpen,
    toggleExamples: (key) => setExamplesOpen((prev) => ({ ...prev, [key]: !prev[key] })),
    running,
    stopRun,
    clearOutputs,
    bound,
    unlink: (name) => setUnlinked([...unlinkedList.filter((n) => n !== name), name]),
    viewOnly,
  };
  // The pane holds the values of the variables it follows. Changed in this
  // tab, the change is a person's (resets, on_change) and what had run runs
  // again; changed elsewhere (another tab, a member, a pane just added), the
  // inputs are only brought in line -- whoever changed it runs, not every tab.
  useEffect(() => {
    if (viewer) return;
    const values = JSON.parse(boundKey) as Values;
    const diff: Values = {};
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(plain(inputs[key])) !== JSON.stringify(value)) diff[key] = value;
    }
    if (!Object.keys(diff).length) return;
    if (!changedInThisTab(address.session)) {
      for (const [key, value] of Object.entries(diff)) setInputValue(key, value);
      return;
    }
    const ran = changeInputs(diff);
    const main = m.actions.find((a) => a.main);
    const next = { ...inputs, ...diff };
    if (main && m.refresh && ranAt && !ran.includes(main.id) && missingInput(main, next) === null) run(main, { inputs: next });
    // Only when what the variables give changes; the inputs it reads are this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundKey, viewer]);

  return (
    <div>
      <PaneSettings
        pane={pane}
        refresh={refresh}
        saved={saved}
        follows={follows(m, variables, unlinkedList, (name, follow) =>
          setUnlinked(follow ? unlinkedList.filter((n) => n !== name) : [...unlinkedList.filter((n) => n !== name), name]),
        )}
        inputs={{ own: inputsShown, sessionView, viewer, set: setInputsShown }}
      />
      {viewOnly && (
        <ViewModeLine
          m={m}
          session={address.session}
          pane={address.pane}
          ranAt={ranAt ?? null}
          timezone={hasTimeRange(m) ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined}
        />
      )}
      {saved.error && <p className="error-text">{saved.error}</p>}
      <RefreshFailure state={refresh} />
      {m.layout.map((card, i) =>
        shown(card.when, pane) && (!viewOnly || showsInView(card.items, pane)) ? <CardView key={i} card={card} pane={pane} /> : null,
      )}
      {viewOnly && !!ranAt && !m.layout.some((card) => shown(card.when, pane) && showsInView(card.items, pane)) && (
        <p className="muted">Nothing to show from the last run.</p>
      )}
    </div>
  );
}

/**
 * The outputs of the pane's live actions, worked out from its inputs on every
 * change. A synchronous function answers in the same render, as the tools
 * always did (no flicker as you type); an asynchronous one (an HMAC through
 * WebCrypto) keeps showing its last answer until the new one arrives.
 */
function useLiveOutputs(m: PaneManifest, inputs: Values): Outputs {
  const key = JSON.stringify(inputs);
  const { now, later } = useMemo(() => {
    const now: Outputs = {};
    const later: Promise<Outputs>[] = [];
    for (const action of m.actions) {
      if (!action.live || action.run_on !== "change") continue;
      const fn = LIVE_FUNCTIONS[action.live];
      if (!fn) continue;
      const result = fn(inputs);
      if (result instanceof Promise) later.push(result);
      else Object.assign(now, result);
    }
    return { now, later };
    // `inputs` is rebuilt every render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, key]);
  const [awaited, setAwaited] = useState<Outputs>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(later).then((results) => {
      if (!cancelled) setAwaited(Object.assign({}, ...results));
    });
    return () => {
      cancelled = true;
    };
  }, [later]);
  return { ...awaited, ...now };
}

const NO_VARIABLES: Variables = {};

/** Whether an item is drawn in view mode (D61): a pane's outputs, and what
 * belongs to them (a chart's pickers, sort, copy, errors); never its inputs,
 * buttons, help or examples. Kept by its place in the manifest -- items are
 * keyed by it -- just not drawn. */
function inView(item: LayoutItem): boolean {
  if (item.row || item.toolbar || item.line) return [...(item.row ?? []), ...(item.toolbar ?? []), ...(item.line ?? [])].some(inView);
  return !!(item.output || item.chart || item.sort || item.error || item.copy || item.flash);
}

/** Whether a card has anything to show in view mode: an output holding
 * something, or an error. A card left with only its Sort, or an empty
 * results table, is a frame around nothing in a dashboard. */
/** A run's own output that draws nothing (RunNote shows only a failed or
 * stopped run): not a reason to draw its card -- CloudWatch's Query card
 * stayed in view mode for a finished run alone. */
function quietRun(pane: { m: PaneManifest; outputs: Values }, key: string): boolean {
  if (pane.m.outputs.find((o) => o.key === key)?.render !== "run") return false;
  const status = (pane.outputs[key] as { status?: string } | null)?.status;
  return status !== "failed" && status !== "stopped";
}

function showsInView(items: LayoutItem[], pane: { m: PaneManifest; outputs: Values; errors: Record<string, string | null> }): boolean {
  return items.some((item) =>
    item.row || item.toolbar || item.line
      ? showsInView([...(item.row ?? []), ...(item.toolbar ?? []), ...(item.line ?? [])], pane)
      : (!!item.output && present(pane.outputs[item.output]) && !quietRun(pane, item.output)) ||
        (!!item.chart && present(pane.outputs[item.chart])) ||
        (!!item.error && !!pane.errors[item.error]),
  );
}

/** The variables a pane could follow and does, for its ⚙. */
function follows(
  m: PaneManifest,
  variables: Variables,
  unlinked: string[],
  set: (name: VariableName, follow: boolean) => void,
): { name: VariableName; label: string; following: boolean; set: (follow: boolean) => void }[] {
  const names = Object.keys(targetsOf(m)) as VariableName[];
  return names
    .filter((name) => variables[name] !== undefined)
    .map((name) => ({ name, label: VARIABLE_LABELS[name], following: !unlinked.includes(name), set: (f) => set(name, f) }));
}

/** An input following a session variable: shown, not changeable here, saying
 * where its value comes from -- and how to make it the pane's own again. */
function Bound({ name, pane, inline, children }: { name: VariableName; pane: Pane; inline: boolean; children: ReactNode }) {
  const note = (
    <span className={`bound-note muted${inline ? "" : " block"}`}>
      From the session's {VARIABLE_LABELS[name]} ·{" "}
      <button className="link-button" onClick={() => pane.unlink(name)}>
        Unlink
      </button>
    </span>
  );
  return (
    <>
      <fieldset className="bound-input" disabled title={`Follows the session's ${VARIABLE_LABELS[name]}`}>
        {children}
      </fieldset>
      {note}
    </>
  );
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function shown(when: When | undefined, pane: PaneApi): boolean {
  if (!when) return true;
  if (when.input !== undefined) {
    const value = pane.inputs[when.input];
    if (when.equals !== undefined && value !== when.equals) return false;
    if (when.not_in !== undefined && when.not_in.includes(value)) return false;
    if (when.equals === undefined && when.not_in === undefined && present(value) !== (when.present ?? true)) {
      return false;
    }
  }
  if (when.error !== undefined && !pane.errors[when.error]) return false;
  if (when.output !== undefined && present(pane.outputs[when.output]) !== (when.present ?? true)) return false;
  return true;
}

/** Text with `code` in backticks, as manifests write help. */
function rich(source: string): ReactNode {
  const parts = source.split("`");
  return parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/** `saved` is the Saved ▾ menu, given to the pane's first card only: it sits
 * at the right of that card's title, after anything the manifest put there. */
function CardView({ card, pane }: { card: Card; pane: Pane }) {
  const title = textOf(card.title, pane.inputs);
  const aside = card.aside.filter((item) => shown(item.when, pane));
  // Clear, while there's something of the card's results to clear: an empty
  // card offering to empty itself is only noise. Not in view mode: it's an edit.
  const clear = !pane.viewOnly && card.clear.some((key) => present(pane.outputs[key])) ? (
    <button className="secondary" onClick={() => pane.clearOutputs(card.clear)} title="Clear these results, for everyone">
      Clear
    </button>
  ) : null;
  if (card.title === undefined) {
    // Its one output or error draws its own title row, or none.
    return (
      <div className="panel">
        <TitleExtra.Provider value={clear}>
          {card.items.map((item, i) => (
            <Item key={i} item={item} pane={pane} place="card" first={i === 0} />
          ))}
        </TitleExtra.Provider>
      </div>
    );
  }
  return (
    <div className="panel">
      {/* By whether the card has an aside at all, not whether it's showing:
          the title keeps one place as the aside comes and goes. */}
      {card.aside.length > 0 || clear ? (
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {clear ? (
            <span className="row" style={{ gap: 8 }}>
              {aside.map((item, i) => (
                <Item key={i} item={item} pane={pane} place="aside" />
              ))}
              {clear}
            </span>
          ) : (
            aside.map((item, i) => <Item key={i} item={item} pane={pane} place="aside" />)
          )}
        </div>
      ) : (
        <h2>{title}</h2>
      )}
      {/* Keyed by place in the manifest, not among those shown: two items
          that take turns by `when` (IoT's things and certificates lists)
          would otherwise be one component, handing the second the first's
          checked rows. */}
      {card.items
        .map((item, at) => ({ item, at }))
        .filter(({ item }) => shown(item.when, pane))
        .map(({ item, at }, i, items) => (
          <Item
            key={at}
            item={item}
            pane={pane}
            place="card"
            first={i === 0}
            prev={items[i - 1]?.item}
            last={items.slice(i + 1).every((later) => drawsNothing(later.item, pane))}
          />
        ))}
    </div>
  );
}

/** An item with nothing to see: the HTTP client's exchange, only offered to
 * the agent's chat. What comes before it is still the card's last line. */
function drawsNothing(item: LayoutItem, pane: Pane): boolean {
  return !!item.output && pane.m.outputs.find((o) => o.key === item.output)?.render === "attach";
}

function Item({
  item,
  pane,
  place,
  first,
  prev,
  last,
}: {
  item: LayoutItem;
  pane: Pane;
  place: Place;
  first?: boolean;
  prev?: LayoutItem;
  last?: boolean;
}) {
  // View mode draws a pane's outputs only (D61).
  if (pane.viewOnly && !inView(item)) return null;
  const children = (list: LayoutItem[], inner: Place) =>
    list.map((child, at) => (shown(child.when, pane) ? <Item key={at} item={child} pane={pane} place={inner} /> : null));

  if (item.toolbar) {
    // Beside a title a toolbar is a tight row; in a card, the app's toolbar
    // line, set off from a box above it (JWT's Generate under its payload).
    return place === "aside" ? (
      <div className="row" style={{ gap: 8 }}>
        {children(item.toolbar, "toolbar")}
      </div>
    ) : (
      <div className="toolbar" style={place === "card" && prev?.input ? { marginTop: 10 } : undefined}>
        {children(item.toolbar, "toolbar")}
      </div>
    );
  }
  if (item.line) {
    return (
      <div className="row" style={{ marginBottom: 10 }}>
        {children(item.line, "line")}
      </div>
    );
  }
  if (item.row) return <RowView items={item.row.filter((child) => shown(child.when, pane))} pane={pane} />;
  if (item.examples) return <Examples input={item.examples} pane={pane} place={place} />;
  if (item.text !== undefined) {
    const shownText = rich(render(item.text, { in: pane.inputs, out: pane.outputs }));
    if (place === "toolbar" || place === "aside") return <span className="muted">{shownText}</span>;
    // Ending its card under a toolbar, it sits closer than a paragraph would
    // (JWT's Mode card, the HTTP client's Request); between two toolbars
    // (IoT's mode help) it keeps a paragraph's margins.
    return (
      <p className="muted" style={(prev?.toolbar || prev?.line) && last ? { margin: "10px 0 0" } : undefined}>
        {shownText}
      </p>
    );
  }
  if (item.copy) return <CopyButton value={pane.outputs[item.copy]} />;
  if (item.error) {
    const error = pane.errors[item.error];
    // First in its card (the HTTP client's error card), it is the card.
    return error ? (
      <p className="error-text" style={first ? { margin: 0 } : undefined}>
        {error}
      </p>
    ) : null;
  }
  if (item.restored) {
    const action = actionById(pane, item.restored)!;
    return <RestoredResultsNote ranAt={pane.ranAt} onRerun={item.rerun ? () => pane.run(action) : undefined} />;
  }
  if (item.crumbs) return <Crumbs item={item} pane={pane} />;
  if (item.button !== undefined) {
    return (
      <button
        className="secondary"
        onClick={() => {
          const ran = pane.changeInputs(item.sets ?? {});
          const action = actionById(pane, item.runs);
          if (action && !ran.includes(action.id)) pane.run(action, { inputs: { ...pane.inputs, ...item.sets } });
        }}
      >
        {item.button}
      </button>
    );
  }
  if (item.busy) return pane.busy[item.busy] ? <span className="muted">Loading…</span> : null;
  if (item.flash) return pane.flashed ? <span className="muted">{pane.flashed}</span> : null;
  if (item.more) return <LoadMore action={actionById(pane, item.more)!} pane={pane} />;
  if (item.stop) {
    const action = actionById(pane, item.stop)!;
    return (
      <button className="secondary" onClick={() => pane.stopRun(action)} disabled={!pane.running(action)}>
        {action.stop_label ?? "Stop"}
      </button>
    );
  }
  if (item.time_range) {
    const name = pane.bound[item.time_range.preset];
    const range = <TimeRange spec={item.time_range} pane={pane} />;
    return name ? <Bound name={name} pane={pane} inline>{range}</Bound> : range;
  }
  if (item.chart) {
    const output = pane.m.outputs.find((o) => o.key === item.chart);
    return output ? <ChartItem output={output} pane={pane} place={place} /> : null;
  }
  if (item.sort) {
    const output = pane.m.outputs.find((o) => o.key === item.sort);
    return output ? <SortControl output={output} pane={pane} /> : null;
  }
  if (item.action) {
    const action = pane.m.actions.find((a) => a.id === item.action)!;
    return <ActionButton action={action} pane={pane} place={place} secondary={item.secondary} />;
  }
  if (item.input) {
    const input = pane.m.inputs.find((i) => i.key === item.input)!;
    const view = <InputView input={input} pane={pane} place={place} />;
    const name = pane.bound[input.key];
    return name ? <Bound name={name} pane={pane} inline={place === "toolbar" || place === "line" || place === "aside"}>{view}</Bound> : view;
  }
  if (item.output) {
    const output = pane.m.outputs.find((o) => o.key === item.output)!;
    const value = pane.outputs[output.key];
    if (!present(value) && item.empty) {
      return (
        <p className="muted" style={{ margin: 0 }}>
          {item.empty}
        </p>
      );
    }
    return <OutputView output={output} value={value} pane={pane} place={place} first={first} />;
  }
  return null;
}

/** Breadcrumbs over a path input (S3's prefix): the root, then each folder;
 * clicking one sets the path, and the pane's own `on_change` opens it. */
function Crumbs({ item, pane }: { item: LayoutItem; pane: Pane }) {
  const path = String(pane.inputs[item.crumbs!] ?? "");
  const root = String(pane.inputs[item.crumbs_root ?? ""] ?? "");
  const segments: { label: string; path: string }[] = [];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc += part + "/";
    segments.push({ label: part, path: acc });
  }
  const go = (to: string) => pane.changeInputs({ [item.crumbs!]: to });
  return (
    <div className="row" style={{ marginBottom: 10, gap: 4 }}>
      <button className="secondary" onClick={() => go("")}>
        {root}
      </button>
      {segments.map((seg, i) => (
        <span key={i} className="row" style={{ gap: 4 }}>
          <span className="muted">/</span>
          <button className="secondary" onClick={() => go(seg.path)}>
            {seg.label}
          </button>
        </span>
      ))}
    </div>
  );
}

/** A paged action's Load more, while its last run returned a cursor. */
function LoadMore({ action, pane }: { action: ManifestAction; pane: Pane }) {
  const page = action.page;
  if (!page) return null;
  const cursor = pane.outputs[page.cursor];
  if (!present(cursor)) return null;
  const busy = !!pane.busy[action.id];
  return (
    <div className="toolbar" style={{ marginTop: 10 }}>
      <button className="secondary" onClick={() => pane.run(action, { cursor })} disabled={busy}>
        {busy ? page.busy_label : page.label}
      </button>
    </div>
  );
}

function inputOf(item: LayoutItem, pane: Pane): ManifestInput | undefined {
  return item.input ? pane.m.inputs.find((i) => i.key === item.input) : undefined;
}

/**
 * Items side by side. Several labelled boxes (Diff's two texts, JWT's
 * algorithm and secret) each get a column with its label on top. One
 * labelled box with things beside it (JWT's secret and its verdict) keeps
 * its label above the whole row, so what's beside it lines up with the box
 * rather than with the label.
 */
function RowView({ items, pane }: { items: LayoutItem[]; pane: Pane }) {
  const labelled = items.filter((item) => textOf(inputOf(item, pane)?.label, pane.inputs));
  const hoisted = labelled.length === 1 && labelled[0] === items[0] ? inputOf(items[0], pane) : undefined;
  const wide = items.some((item) => inputOf(item, pane)?.rows);
  const style = hoisted ? undefined : { alignItems: "flex-start", ...(wide ? { gap: 12 } : {}) };
  const row = (
    <div className="row" style={style}>
      {items.map((child, i) => (
        <Item key={i} item={child} pane={pane} place={hoisted && i === 0 ? "bare" : "row"} />
      ))}
    </div>
  );
  if (!hoisted) return row;
  return (
    <>
      <span className="field-label">{textOf(hoisted.label, pane.inputs)}</span>
      {row}
    </>
  );
}

function CopyButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const text = typeof value === "string" ? value : present(value) ? JSON.stringify(value, null, 2) : "";
  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied or unavailable -- nothing more we can do
    }
  }
  return (
    <button className="secondary" onClick={copy} disabled={!text}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ActionButton({
  action,
  pane,
  place,
  secondary,
}: {
  action: ManifestAction;
  pane: Pane;
  place: Place;
  secondary?: boolean;
}) {
  const busy = !!pane.busy[action.id] || pane.running(action);
  const error = pane.errorsPlaced.has(action.id) ? null : pane.errors[action.id];
  const button = (
    <button className={secondary ? "secondary" : undefined} onClick={() => pane.run(action)} disabled={busy}>
      {busy ? action.busy_label ?? "Running…" : textOf(action.run_label, pane.inputs) || "Run"}
    </button>
  );
  const shownError = error ? <span className="error-text">{error}</span> : null;
  if (place === "toolbar" || place === "line") {
    return (
      <>
        {button}
        {shownError}
      </>
    );
  }
  return (
    <div className="toolbar">
      {button}
      {shownError}
    </div>
  );
}

// ---------------------------------------------------------------- inputs

/** An input under its label. In a row it is a column: one that grows when
 * `grow` gives its minimum width, otherwise only as wide as it is. A field
 * stacked in a card's column is `spaced` from the next (a text box carries
 * its own margin already). */
function Labelled({
  label,
  children,
  grow,
  spaced = false,
}: {
  label: string;
  children: ReactNode;
  grow: number | false;
  spaced?: boolean;
}) {
  if (grow === -1) return <>{children}</>;
  const style = grow ? { flex: 1, minWidth: grow } : spaced ? { marginBottom: 10 } : undefined;
  return (
    <div style={style}>
      {label && <span className="field-label">{label}</span>}
      {children}
    </div>
  );
}

function InputView({ input, pane, place }: { input: ManifestInput; pane: Pane; place: Place }) {
  const value = pane.inputs[input.key];
  const set = (v: unknown) => pane.changeInputs({ [input.key]: v });
  const submit = () => {
    const action = actionById(pane, input.submit);
    if (action) pane.run(action);
  };
  const inline = place === "toolbar" || place === "aside" || place === "line";
  // What a label beside a picker points at (two panes of one kind in a
  // session each have their own).
  const fieldId = useId();
  const label = textOf(input.label, pane.inputs);
  const placeholder = textIn(input.placeholder, pane) || undefined;
  const inRow = place === "row";
  const bare = place === "bare";
  const title = input.help || undefined;
  // A column in a row grows: a text box further than a line.
  const grow = (min: number): number | false => (bare ? -1 : inRow ? min : false);
  const spaced = place === "card" && !input.rows;

  // Two-level pickers: their options are a loader's groups, not a select's.
  if (input.type === "log_groups") return <LogGroupsPicker input={input} pane={pane} />;
  if (input.type === "opensearch_indices") return <IndicesPicker input={input} pane={pane} />;
  if (input.options) {
    const picker = <OptionsPicker input={input} pane={pane} value={value} onChange={set} />;
    return inline ? picker : <Labelled label={label} grow={grow(200)} spaced={spaced}>{picker}</Labelled>;
  }
  if (input.type === "connection" && input.connection_type === "aws") {
    const select = <AwsConnectionSelect value={value} onChange={set} placeholder={placeholder} label={label} />;
    return inline || bare ? select : <Labelled label={label} grow={grow(200)} spaced={spaced}>{select}</Labelled>;
  }

  if (input.type === "choice" && input.buttons) {
    // Labelled in a toolbar: "Search for [Things] [Certificates]".
    const lead =
      inline && label ? (
        <span className="field-label" style={{ marginRight: 4 }}>
          {label}
        </span>
      ) : null;
    const buttons = input.choices.map((choice) => (
      <button
        key={String(choice)}
        className={value === choice ? "" : "secondary"}
        onClick={() => set(choice)}
        title={title}
      >
        {input.choice_labels[String(choice)] ?? String(choice)}
      </button>
    ));
    return inline ? (
      <>
        {lead}
        {buttons}
      </>
    ) : (
      <div className="toolbar">{buttons}</div>
    );
  }
  if (input.type === "bool") {
    return (
      <label className="checkbox-item" title={title}>
        <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
        {label}
      </label>
    );
  }
  if (input.type === "choice") {
    const select = (
      <select value={String(value ?? "")} onChange={(e) => set(e.target.value)} aria-label={label || input.key} title={title}>
        {input.choices.map((choice) => (
          <option key={String(choice)} value={String(choice)}>
            {input.choice_labels[String(choice)] ?? String(choice)}
          </option>
        ))}
      </select>
    );
    if (inline || bare) return select;
    return (
      <Labelled label={label} grow={false} spaced={spaced}>
        {select}
      </Labelled>
    );
  }
  if (input.type === "topics") {
    return (
      <Labelled label={label} grow={false} spaced={spaced}>
        <TopicsEditor input={input} value={value} onChange={set} placeholder={placeholder} />
      </Labelled>
    );
  }
  if (input.type === "connections") {
    return <ConnectionsPicker input={input} pane={pane} value={value} onChange={set} />;
  }
  if (input.type === "connection") {
    const targets = pane.targets[input.connection_type ?? ""] ?? null;
    // An optional one (the HTTP client's Target) isn't offered at all while
    // the group has no connection of its type: there'd be nothing to pick.
    if (input.optional && (targets === null || targets.length === 0)) return null;
    const picker = (
      <ConnectionPicker
        id={fieldId}
        input={input}
        targets={targets}
        value={value}
        onChange={set}
        label={label}
        placeholder={placeholder}
      />
    );
    if (place === "line") {
      return (
        <>
          <label className="field-label" htmlFor={fieldId} style={{ margin: 0 }}>
            {label}
          </label>
          {picker}
          {input.hint && present(value) && targets?.some((t) => t.id === value) && <span className="muted">{input.hint}</span>}
        </>
      );
    }
    return (
      <Labelled label={label} grow={grow(200)} spaced={spaced}>
        {picker}
      </Labelled>
    );
  }
  if (input.type === "credential") {
    return <CredentialPicker input={input} value={value} onChange={set} label={label} placeholder={placeholder} place={place} />;
  }
  if (input.type === "headers") {
    const editor = <PairsEditor value={value} onChange={set} label={label} words={input.pairs ?? {}} />;
    // Unlabelled in a card of its own (the HTTP client's Headers), it is the card.
    if (!label && place === "card") return editor;
    return (
      <Labelled label={label} grow={grow(200)} spaced={spaced}>
        {editor}
      </Labelled>
    );
  }
  if (input.type === "int" && inline) {
    return (
      <label className="row" style={{ gap: 6 }}>
        {label && <span className="muted">{label}</span>}
        <input
          type="number"
          min={input.min}
          max={input.max}
          value={value == null ? "" : String(value)}
          onChange={(e) => set(Number(e.target.value))}
          title={title}
          style={{ width: input.width ?? 80 }}
        />
      </label>
    );
  }
  if (input.type === "int") {
    return (
      <Labelled label={label} grow={bare ? -1 : false} spaced={spaced}>
        <input
          type="number"
          min={input.min}
          max={input.max}
          value={value == null ? "" : String(value)}
          onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))}
          aria-label={label || input.key}
          title={title}
          style={{ width: 100 }}
        />
      </Labelled>
    );
  }
  if (input.type === "text" && inline && !input.rows) {
    const style = input.grow ? { flex: 1, minWidth: input.grow } : input.width ? { width: input.width } : undefined;
    return (
      <input
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={placeholder}
        aria-label={label || placeholder || input.key}
        title={title}
        style={style}
      />
    );
  }
  if (input.type === "text") {
    const text = typeof value === "string" ? value : "";
    const box = input.rows ? (
      <textarea
        rows={input.rows}
        value={text}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        aria-label={label || undefined}
        title={title}
        style={inRow ? { width: "100%" } : undefined}
      />
    ) : (
      <input
        type="text"
        value={text}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={placeholder}
        aria-label={label || placeholder || input.key}
        title={title}
        style={{ width: input.width ?? "100%" }}
      />
    );
    return (
      <Labelled label={label} grow={input.width ? (bare ? -1 : false) : grow(input.rows ? 240 : 200)} spaced={spaced}>
        {box}
      </Labelled>
    );
  }
  return <p className="muted">{label || input.key}: not drawn by manifests yet.</p>;
}

/**
 * An AWS connection, drawn as the environment picker always was:
 * "Prod (111122223333 · eu-west-1)", one per AWS connection the user can
 * reach (D34: its id is the environment's old id).
 */
function AwsConnectionSelect({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder?: string;
  label: string;
}) {
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  useEffect(() => {
    api.listEnvironments().then(setEnvironments, () => setEnvironments([]));
  }, []);
  const known = environments?.some((e) => e.id === value);
  return (
    <select
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      aria-label={label || "Environment"}
    >
      <option value="">{placeholder ?? "Choose environment…"}</option>
      {environments?.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name} ({e.account_id} · {e.region})
        </option>
      ))}
      {value != null && value !== "" && environments !== null && !known && (
        <option value={String(value)}>An environment you can't reach</option>
      )}
    </select>
  );
}

/**
 * A choice whose options a loader fetches (D47): "Load tables", then "Choose
 * table…". The options live in this tab only, so after a reload the select
 * shows just the value already chosen until the list is loaded again.
 */
function OptionsPicker({
  input,
  pane,
  value,
  onChange,
}: {
  input: ManifestInput;
  pane: Pane;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const spec = input.options!;
  const loader = actionById(pane, spec.action);
  const loaded = pane.options[spec.action];
  const busy = !!pane.busy[spec.action];
  const current = value == null ? "" : String(value);
  const options = loaded ?? [];
  // No button (the manifest's word for it): the loader runs once the select
  // is drawn with what it requires set -- the Workflow pane's list of
  // workflows needs nothing, and a Load button for it was one click too many.
  const auto = !spec.load_label && !!loader;
  const missing = loader ? missingInput(loader, pane.inputs) : null;
  const asked = useRef(false);
  useEffect(() => {
    if (!auto || !loader || asked.current || loaded !== undefined || busy || missing !== null) return;
    // Once per mount: a loader that fails leaves the options unset, and
    // asking again on every render would hammer the server with it.
    asked.current = true;
    pane.run(loader);
  }, [auto, loader, loaded, busy, missing, pane]);
  const showSelect = auto || options.length > 0 || current !== "";
  return (
    <>
      {spec.load_label && loader && (
        <button
          className="secondary"
          onClick={() => pane.run(loader)}
          disabled={busy || missingInput(loader, pane.inputs) !== null}
        >
          {busy ? spec.busy_label ?? spec.load_label : spec.load_label}
        </button>
      )}
      {showSelect && (
        <select value={current} onChange={(e) => onChange(e.target.value)} aria-label={input.key}>
          <option value="" disabled>
            {spec.placeholder ?? "Choose…"}
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {current !== "" && !options.some((o) => o.value === current) && <option value={current}>{current}</option>}
        </select>
      )}
    </>
  );
}

/** Each connection type the manifest's pickers use, fetched once when the
 * pane mounts: the pickers draw from it, and so does a placeholder naming the
 * chosen one's base URL. AWS connections come as environments (D34). */
function useTargets(m: PaneManifest): Record<string, Target[] | null> {
  const types = useMemo(
    () => [
      ...new Set(
        m.inputs
          // A single AWS one is drawn by AwsConnectionSelect, which fetches its own.
          .filter((i) => i.type === "connections" || (i.type === "connection" && i.connection_type !== "aws"))
          .map((i) => i.connection_type ?? ""),
      ),
    ],
    [m],
  );
  const [targets, setTargets] = useState<Record<string, Target[] | null>>(() =>
    Object.fromEntries(types.map((t) => [t, null])),
  );
  useEffect(() => {
    for (const type of types) {
      api.listTargets(type).then(
        (list) => setTargets((prev) => ({ ...prev, [type]: list })),
        () => setTargets((prev) => ({ ...prev, [type]: [] })),
      );
    }
  }, [types]);
  return targets;
}

/** A connection of the input's type the user can reach, by its label. An
 * optional one's empty choice is its placeholder ("Any URL"). */
function ConnectionPicker({
  id,
  input,
  targets,
  value,
  onChange,
  label,
  placeholder,
}: {
  id?: string;
  input: ManifestInput;
  targets: Target[] | null;
  value: unknown;
  onChange: (v: unknown) => void;
  label: string;
  placeholder?: string;
}) {
  const chosen = targets?.find((t) => t.id === value);
  return (
    <>
      <select
        id={id}
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        aria-label={label || input.key}
      >
        <option value="">{targets === null ? "Loading…" : placeholder ?? "Choose a connection…"}</option>
        {targets?.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
            {t.config.base_url ? ` (${t.config.base_url})` : ""}
          </option>
        ))}
        {value != null && targets !== null && !chosen && (
          <option value={String(value)}>A connection you can't reach</option>
        )}
      </select>
      {!input.optional && targets?.length === 0 && (
        <span className="muted" style={{ marginLeft: 8 }}>
          None of your environments has one.
        </span>
      )}
    </>
  );
}

/** Several AWS connections, as the environment checkbox list always was:
 * "Prod (111122223333 · eu-west-1)", and how many are ticked. Stored as a
 * plain sorted list; a session saved before the port holds a Set, read the
 * same. */
function ConnectionsPicker({
  input,
  pane,
  value,
  onChange,
}: {
  input: ManifestInput;
  pane: Pane;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const targets = pane.targets[input.connection_type ?? ""] ?? [];
  const chosen = new Set<number>(value instanceof Set ? (value as Set<number>) : Array.isArray(value) ? (value as number[]) : []);
  const toggle = (id: number) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next].sort((a, b) => a - b));
  };
  return (
    <div>
      {pane.targets[input.connection_type ?? ""] !== null && targets.length === 0 && (
        <p className="muted">No environments configured yet — add some under "Settings".</p>
      )}
      <div className="checkbox-list" style={{ maxHeight: 200 }}>
        {targets.map((t) => (
          <label key={t.id} className="checkbox-item">
            <input type="checkbox" checked={chosen.has(t.id)} onChange={() => toggle(t.id)} />
            {t.label} ({String(t.config.account_id ?? "")} · {String(t.config.region ?? "")})
          </label>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        {targets.filter((t) => chosen.has(t.id)).length} environment(s) selected.
      </p>
    </div>
  );
}

/**
 * A credential to authenticate with -- by id, never its value: the server
 * resolves it and applies it when the request is sent (PLATFORM_PLAN.md
 * §13.8), so nothing secret is in the pane, the session or the agent's
 * history. Only credentials whose type authenticates requests are offered.
 */
function CredentialPicker({
  input,
  value,
  onChange,
  label,
  placeholder,
  place,
}: {
  input: ManifestInput;
  value: unknown;
  onChange: (v: unknown) => void;
  label: string;
  placeholder?: string;
  place: Place;
}) {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const id = useId();
  useEffect(() => {
    // Admins get full rows and everyone else summaries; both say whether a
    // credential can authenticate a request, which is all this needs.
    api
      .listCredentials<CredentialSummary>()
      .then((rows) => setCredentials(rows.filter((c) => c.authenticates)))
      .catch(() => setCredentials([]));
  }, []);
  const chosen = credentials.find((c) => c.id === value) ?? null;
  const select = (
    <select
      id={id}
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      aria-label={label || input.key}
      title={input.help || undefined}
    >
      <option value="">{placeholder ?? "None"}</option>
      {credentials.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.type_label})
        </option>
      ))}
      {value != null && value !== "" && !chosen && <option value={String(value)}>A credential you can't use</option>}
    </select>
  );
  const hints = (
    <>
      {chosen && <span className="muted">Added by the server when sent; never shown here.</span>}
      {credentials.length === 0 && <span className="muted">No credentials your group can use for requests.</span>}
    </>
  );
  if (place === "line") {
    return (
      <>
        <label className="field-label" htmlFor={id} style={{ margin: 0 }}>
          {label}
        </label>
        {select}
        {hints}
      </>
    );
  }
  return (
    <div className="row" style={{ marginBottom: 10 }}>
      {label && <span className="field-label" style={{ margin: 0 }}>{label}</span>}
      {select}
      {hints}
    </div>
  );
}

/** An input's examples (`examples`, by another input's value): in a toolbar
 * the Show/Hide button, in a card the list with a Use button each. Whether
 * they're shown is this tab's, not the session's. */
function Examples({ input: key, pane, place }: { input: string; pane: Pane; place: Place }) {
  const input = pane.m.inputs.find((i) => i.key === key);
  const open = !!pane.examplesOpen[key];
  if (!input?.examples) return null;
  if (place === "toolbar" || place === "line" || place === "aside") {
    return (
      <button className="secondary" onClick={() => pane.toggleExamples(key)}>
        {open ? "Hide examples" : "Show examples"}
      </button>
    );
  }
  if (!open) return null;
  const examples = input.examples.values[String(pane.inputs[input.examples.by])] ?? [];
  return (
    <div className="checkbox-list" style={{ marginBottom: 10, maxHeight: 140 }}>
      {examples.map((example) => (
        <div key={example} className="row" style={{ justifyContent: "space-between" }}>
          <code style={{ fontSize: 12.5 }}>{example}</code>
          <button className="secondary" style={{ padding: "2px 8px" }} onClick={() => pane.changeInputs({ [key]: example })}>
            Use
          </button>
        </div>
      ))}
    </div>
  );
}

interface Pair {
  id: number;
  key: string;
  value: string;
}

/** Name/value rows, the HTTP client's header editor's shape, which the agent
 * writes the same way (`platform_tools/panes.convert`). */
function PairsEditor({
  value,
  onChange,
  label,
  words,
}: {
  value: unknown;
  onChange: (v: Pair[]) => void;
  label: string;
  /** The name box's placeholder and the add button's text (`pairs`). */
  words: Record<string, string>;
}) {
  const pairs: Pair[] = Array.isArray(value) ? (value as Pair[]) : [];
  const nextId = () => pairs.reduce((max, p) => Math.max(max, p.id), 0) + 1;
  const update = (id: number, field: "key" | "value", text: string) =>
    onChange(pairs.map((p) => (p.id === id ? { ...p, [field]: text } : p)));
  return (
    <>
      {pairs.map((pair) => (
        <div className="row" key={pair.id} style={{ marginBottom: 6 }}>
          <input
            type="text"
            placeholder={words.key ?? "Name"}
            aria-label={`${label || words.key || ""} name`.trim()}
            value={pair.key}
            onChange={(e) => update(pair.id, "key", e.target.value)}
            style={{ width: 200 }}
          />
          <input
            type="text"
            placeholder="Value"
            aria-label={`${label || words.key || ""} value`.trim()}
            value={pair.value}
            onChange={(e) => update(pair.id, "value", e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="danger" onClick={() => onChange(pairs.filter((p) => p.id !== pair.id))}>
            Remove
          </button>
        </div>
      ))}
      <button
        className="secondary"
        aria-label={words.add ? undefined : `Add a row to ${label || "the list"}`}
        onClick={() => onChange([...pairs, { id: nextId(), key: "", value: "" }])}
      >
        {words.add ?? "Add row"}
      </button>
    </>
  );
}

// ---------------------------------------------------------------- outputs

function OutputView({
  output,
  value,
  pane,
  place,
  first,
}: {
  output: ManifestOutput;
  value: unknown;
  pane: Pane;
  place: Place;
  first?: boolean;
}) {
  const inline = place === "toolbar" || place === "aside";
  const label = textOf(output.label, pane.inputs);
  switch (output.render) {
    case "error":
      if (!present(value)) return null;
      return inline ? (
        <span className="error-text">{String(value)}</span>
      ) : (
        <p className="error-text" style={first ? { margin: 0 } : { marginBottom: 0 }}>
          {String(value)}
        </p>
      );
    case "text":
      if (!present(value)) return null;
      return inline ? <span className="muted">{String(value)}</span> : <p className="muted">{String(value)}</p>;
    case "badge": {
      if (!present(value)) return null;
      const badge = output.badges[String(value)] ?? { text: String(value) };
      const tone = badge.tone === "ok" || badge.tone === "error" ? badge.tone : "";
      return <span className={`tag ${tone}`}>{badge.text}</span>;
    }
    case "code": {
      const text = typeof value === "string" ? value : present(value) ? JSON.stringify(value) : "";
      if (output.rows) return <textarea rows={output.rows} value={text} readOnly aria-label={label || output.key} />;
      if (!text) return null;
      return (
        <pre className="tool-json-output" style={{ wordBreak: "break-all", marginBottom: 0 }}>
          {text}
        </pre>
      );
    }
    case "json":
      if (value === undefined) return null;
      return (
        <>
          {label && <span className="field-label">{label}</span>}
          <pre className="tool-json-output">{JSON.stringify(value, null, 2)}</pre>
        </>
      );
    case "diff": {
      const viewInput = output.config.view;
      const view = (typeof viewInput === "string" ? pane.inputs[viewInput] : "unified") as DiffViewMode;
      return <DiffView rows={(value as DiffRow[]) ?? []} view={view || "unified"} />;
    }
    case "table":
      return <TableView output={output} rows={Array.isArray(value) ? (value as Values[]) : []} pane={pane} />;
    case "list":
      return <ListView output={output} value={value} pane={pane} />;
    case "files":
      return <FilesView output={output} value={value} pane={pane} />;
    case "tags":
      return present(value) ? <TagsView output={output} value={value} pane={pane} /> : null;
    case "http_response":
      return value && typeof value === "object" ? <HttpResponseView response={value as Values} /> : null;
    case "logs":
      return <LogsView output={output} value={value} pane={pane} />;
    case "run":
      return <RunNote value={value} />;
    case "histogram":
      return <HistogramView value={value} pane={pane} />;
    case "stream":
      return <StreamView output={output} value={value} pane={pane} />;
    case "attach": {
      // Always offered to the agent's chat, no checkbox: the HTTP client's
      // last exchange, to ask why a request came back the way it did.
      const rows = Array.isArray(value) ? (value as Values[]) : [];
      return <PaneSelectionShare domain={String(output.config.domain ?? pane.m.id)} selectedRows={rows} />;
    }
  }
}

/** Columns in order of first appearance, over enough rows to see them all in
 * practice without walking a huge result. */
const COLUMN_SCAN_ROWS = 200;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function TableView({ output, rows, pane }: { output: ManifestOutput; rows: Values[]; pane: Pane }) {
  const can = (a: ManifestOutput["actions"][number]) => output.actions.includes(a);
  const [shared, setShared] = useState<Values[]>([]);
  const keyed = useMemo(() => rows.map((row, index) => ({ key: String(index), row })), [rows]);
  const selection = useRowSelection({
    rows: keyed,
    keyOf: (r) => r.key,
    toObject: (r) => r.row,
    onSelectionChange: setShared,
    resetOn: pane.resultsVersion,
  });
  const displayed = selection.visibleRows;
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const { row } of keyed.slice(0, COLUMN_SCAN_ROWS)) {
      for (const key of Object.keys(row ?? {})) if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  }, [keyed]);
  const chosen = selection.selectedObjects;

  return (
    <div className="manifest-table">
      <div className="toolbar">
        {can("select") && <SelectAllCheckbox selection={selection} displayed={displayed} />}
        <span className="muted">
          {displayed.length} row{displayed.length === 1 ? "" : "s"}
          {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
          {selection.selectedCount > 0 && `, ${selection.selectedCount} selected`}
        </span>
        {can("select") && <HideSelectedButtons selection={selection} />}
        {can("copy") && <CopyButton value={chosen.length > 0 ? chosen : displayed.map((r) => r.row)} />}
        {can("export") && (
          <ExportMenu rows={displayed.map((r) => r.row)} selectedRows={chosen} filename={pane.m.id} />
        )}
      </div>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          The reply holds no rows.
        </p>
      ) : (
        <div className="manifest-table-scroll">
          <table>
            <thead>
              <tr>
                {can("select") && <th className="manifest-table-check" />}
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((r) => (
                <tr key={r.key} className={selection.isSelected(r) ? "selected" : undefined}>
                  {can("select") && (
                    <td className="manifest-table-check">
                      <input
                        type="checkbox"
                        checked={selection.isSelected(r)}
                        onChange={() => selection.toggle(r)}
                        aria-label={`Select row ${Number(r.key) + 1}`}
                      />
                    </td>
                  )}
                  {columns.map((c) => {
                    const text = cell(r.row?.[c]);
                    return (
                      <td key={c} title={text}>
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can("attach") && <PaneSelectionShare domain={pane.m.id} selectedRows={shared} />}
    </div>
  );
}
