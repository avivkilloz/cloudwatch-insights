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
  output?: string;
  present?: boolean;
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
  | "connection";

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
}

export type Render = "text" | "code" | "json" | "table" | "diff" | "badge" | "error";

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
  when?: When;
  empty?: string;
  copy?: string;
}

export interface Card {
  title: Text;
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
 * was never stored, so it has nothing to move. */
function legacyMap(m: PaneManifest): Record<string, string> {
  if (m.state !== "v2") return {};
  const out: Record<string, string> = {};
  for (const i of m.inputs) if (!i.sensitive) out[i.legacy_key ?? i.key] = `in.${i.key}`;
  for (const o of m.outputs) if (o.legacy_key) out[o.legacy_key] = `out.${o.key}`;
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
  }
  return out ?? state;
}
