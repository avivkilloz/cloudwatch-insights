/**
 * Pane manifests in the browser (PLATFORM_PLAN.md §15.2).
 *
 * The backend's YAML manifests (backend/app/panes/manifests), as
 * `GET /api/pane-types` hands them over: only the types the user's group may
 * use. They are loaded once, before any session mounts (App.tsx), because the
 * catalogue, the renderer and the state migration all read them -- a session
 * drawn before they arrive would show its ported panes empty and then migrate
 * under itself.
 *
 * The types mirror `backend/app/panes/manifest.py`; that model is the one that
 * validates, so these only describe what a valid manifest holds.
 */

export type Text = string | { by: string; values: Record<string, string> };

export interface When {
  input?: string;
  equals?: unknown;
  not_in?: unknown[];
  output?: string;
  present?: boolean;
  /** Shown while this action's last run failed. */
  error?: string;
}

export type InputType =
  | "text"
  | "int"
  | "choice"
  | "bool"
  | "environments"
  | "environment"
  | "log_groups"
  | "opensearch_indices"
  | "headers"
  | "credential"
  | "connection"
  | "connections";

/** A choice whose options come from a server action (a loader). */
export interface Options {
  action: string;
  load_label?: string;
  busy_label?: string;
  placeholder?: string;
  /** A two-level picker's second level: the action listing one item's options. */
  children?: string;
  /** A two-level picker's filter box placeholder. */
  filter?: string;
}

export interface ManifestInput {
  key: string;
  type: InputType;
  label?: Text;
  help: string;
  placeholder?: Text;
  default?: unknown;
  choices: unknown[];
  choice_labels: Record<string, string>;
  buttons: boolean;
  min?: number;
  max?: number;
  rows?: number;
  width?: number;
  sensitive: boolean;
  agent: boolean;
  connection_type?: string;
  legacy_key?: string;
  options?: Options;
  resets: string[];
  submit?: string;
  /** What choosing a value sets besides: value -> {input: value}. */
  choice_sets: Record<string, Record<string, unknown>>;
  /** A connection that may be left unset ("Any URL"); not drawn without any. */
  optional: boolean;
  examples?: { by: string; values: Record<string, string[]> };
  grow?: number;
  hint?: string;
  pairs: Record<string, string>;
}

export interface Page {
  cursor: string;
  append: string[];
  sum: string[];
  label: string;
  busy_label: string;
}

export interface ManifestView {
  key: string;
  default?: unknown;
  legacy_key?: string;
}

export interface ManifestAction {
  id: string;
  run_label?: Text;
  busy_label?: string;
  handler?: string;
  live?: string;
  request?: Record<string, unknown>;
  effects?: "external";
  run_on: "change" | "click";
  on_change: string[];
  requires: Record<string, string>;
  page?: Page;
  resets: string[];
  main: boolean;
  /** A row action's inputs, as paths into `row.` and `group.`. */
  args: Record<string, string>;
  /** Run in the background, polled by the server into the session (D51). */
  poll?: { handler: string; stop: string };
}

export type Render =
  | "text"
  | "code"
  | "json"
  | "table"
  | "diff"
  | "badge"
  | "error"
  | "list"
  | "files"
  | "tags"
  | "http_response"
  | "attach"
  | "logs"
  | "run";

export interface ManifestOutput {
  key: string;
  render: Render;
  label?: Text;
  actions: ("copy" | "export" | "attach" | "select")[];
  rows?: number;
  badges: Record<string, { text: string; tone?: string }>;
  config: Record<string, unknown>;
  inspect: boolean;
  legacy_key?: string;
}

export interface LayoutItem {
  input?: string;
  output?: string;
  action?: string;
  text?: string;
  row?: LayoutItem[];
  toolbar?: LayoutItem[];
  line?: LayoutItem[];
  when?: When;
  empty?: string;
  copy?: string;
  error?: string;
  restored?: string;
  rerun: boolean;
  crumbs?: string;
  crumbs_root?: string;
  button?: string;
  sets: Record<string, unknown>;
  runs?: string;
  more?: string;
  secondary: boolean;
  busy?: string;
  flash: boolean;
  examples?: string;
  /** The Stop button of a background action's run. */
  stop?: string;
  /** A time range control over these inputs. */
  time_range?: { preset: string; start: string; end: string };
  /** "Sort by" this output's fields, bound to its sort view keys. */
  sort?: string;
}

export interface Card {
  title?: Text;
  when?: When;
  aside: LayoutItem[];
  items: LayoutItem[];
}

export interface PaneManifest {
  id: string;
  label: string;
  order: number;
  group: "Services" | "Tools" | "Platform";
  flag: string;
  about: string;
  help: string;
  description: string;
  state?: "v2";
  rendered: boolean;
  inputs: ManifestInput[];
  actions: ManifestAction[];
  outputs: ManifestOutput[];
  layout: Card[];
  implies?: string;
  views: ManifestView[];
  legacy_drop: string[];
}

let loaded: PaneManifest[] = [];

/** Called once, with what `/api/pane-types` returned, before sessions mount. */
export function setManifests(list: PaneManifest[]): void {
  loaded = [...list].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function manifests(): PaneManifest[] {
  return loaded;
}

export function manifest(type: string): PaneManifest | undefined {
  return loaded.find((m) => m.id === type);
}

/** A manifest string that may depend on an input (`{by: mode, values: …}`). */
export function textOf(text: Text | undefined, inputs: Record<string, unknown>): string {
  if (text == null) return "";
  if (typeof text === "string") return text;
  return text.values[String(inputs[text.by])] ?? "";
}

/** `{now}` in a default is the current Unix time, when the pane first draws it. */
export function defaultOf(input: ManifestInput): unknown {
  const value = input.default ?? (input.type === "bool" ? false : input.type === "headers" ? [] : "");
  return typeof value === "string" ? value.replace(/\{now\}/g, String(Math.floor(Date.now() / 1000))) : value;
}

/** Old key -> new key, for a v2 pane's migration (§15.4). A sensitive input
 * was never stored, so it has nothing to move; every run's bookkeeping does. */
function legacyMap(m: PaneManifest): Record<string, string> {
  if (m.state !== "v2") return {};
  const out: Record<string, string> = { ranAt: "out.ranAt", resultsVersion: "out.resultsVersion" };
  for (const i of m.inputs) if (!i.sensitive) out[i.legacy_key ?? i.key] = `in.${i.key}`;
  for (const o of m.outputs) if (o.legacy_key) out[o.legacy_key] = `out.${o.key}`;
  for (const v of m.views ?? []) if (v.legacy_key) out[v.legacy_key] = `view.${v.key}`;
  return out;
}

/**
 * Moves a ported pane's keys to the v2 shape: "<pane>.input" becomes
 * "<pane>.in.input". The browser's twin of `backend/app/panes/state.migrate`,
 * and like it idempotent and unmarked -- a tab left open across the deploy
 * keeps writing old keys, so there is no "done" to record. A new key already
 * there wins: it is what the pane has been showing. Returns `state` itself
 * when there is nothing to move, so a caller comparing by identity sees no
 * change.
 */
export function migratePaneKeys(state: Record<string, unknown>): Record<string, unknown> {
  const services = Array.isArray(state.services) ? (state.services as unknown[]) : [];
  const types = (state.paneTypes && typeof state.paneTypes === "object" ? state.paneTypes : {}) as Record<
    string,
    string
  >;
  let out: Record<string, unknown> | null = null;
  for (const paneId of services) {
    if (typeof paneId !== "string") continue;
    const m = manifest(types[paneId] ?? paneId);
    if (!m) continue;
    for (const [oldKey, newKey] of Object.entries(legacyMap(m))) {
      const from = `${paneId}.${oldKey}`;
      if (!(from in state)) continue;
      out ??= { ...state };
      const value = out[from];
      delete out[from];
      const to = `${paneId}.${newKey}`;
      if (!(to in out)) out[to] = value;
    }
    // What the pane no longer keeps in the session (picker options, D47).
    for (const old of m.legacy_drop ?? []) {
      const from = `${paneId}.${old}`;
      if (!(from in state)) continue;
      out ??= { ...state };
      delete out[from];
    }
  }
  return out ?? state;
}
