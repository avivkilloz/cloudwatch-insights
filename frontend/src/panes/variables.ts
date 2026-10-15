/**
 * Session variables (PLATFORM_PLAN.md §18.7, D60): an Environment and a Time
 * range at the session's level that every pane with a matching input follows,
 * unless it is unlinked. The twin of backend/app/panes/variables.py, which the
 * agent and a new pane added there use: which inputs a variable binds is
 * worked out from the manifest by input type, never named per pane.
 *
 * The value is copied into the pane's own inputs (ManifestPane does it), so
 * inputs stay the one truth and a refresh, the agent and templates see an
 * ordinary value.
 */

import { manifests, PaneManifest, LayoutItem } from "./manifest";

export const VARIABLES_KEY = "variables";
export type VariableName = "environment" | "time";
export const VARIABLE_NAMES: VariableName[] = ["environment", "time"];
export const VARIABLE_LABELS: Record<VariableName, string> = { environment: "Environment", time: "Time range" };

export interface TimeValue {
  preset: number | "custom";
  start: string;
  end: string;
}

/** What a session defines: a key present is a variable defined (its value may
 * still be unset -- an Environment not picked yet). */
export interface Variables {
  environment?: number | null;
  time?: TimeValue;
}

function timeRanges(items: LayoutItem[]): { preset: string; start: string; end: string }[] {
  const out: { preset: string; start: string; end: string }[] = [];
  for (const item of items) {
    if (item.time_range) out.push(item.time_range);
    out.push(...timeRanges([...(item.row ?? []), ...(item.toolbar ?? []), ...(item.line ?? [])]));
  }
  return out;
}

/** Per variable, the inputs it binds: input key -> what of it goes there. */
export function targets(m: PaneManifest): Partial<Record<VariableName, Record<string, string>>> {
  const out: Partial<Record<VariableName, Record<string, string>>> = {};
  const environment: Record<string, string> = {};
  for (const i of m.inputs) {
    if ((i.type === "connection" || i.type === "connections") && i.connection_type === "aws") {
      environment[i.key] = i.type === "connections" ? "list" : "value";
    }
  }
  if (Object.keys(environment).length) out.environment = environment;
  for (const card of m.layout) {
    const [range] = timeRanges([...card.aside, ...card.items]);
    if (range) {
      out.time = { [range.preset]: "preset", [range.start]: "start", [range.end]: "end" };
      break;
    }
  }
  return out;
}

/** Input key -> the value a variable gives it, for every defined variable
 * with a value that the pane follows. */
export function boundValues(m: PaneManifest, variables: Variables, unlinked: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bound = targets(m);
  if (bound.environment && !unlinked.includes("environment") && variables.environment != null) {
    for (const [key, how] of Object.entries(bound.environment)) {
      out[key] = how === "list" ? [variables.environment] : variables.environment;
    }
  }
  if (bound.time && !unlinked.includes("time") && variables.time) {
    for (const [key, part] of Object.entries(bound.time)) out[key] = variables.time[part as keyof TimeValue];
  }
  return out;
}

/** Input key -> the variable it follows now. */
export function boundBy(m: PaneManifest, variables: Variables, unlinked: string[]): Record<string, VariableName> {
  const out: Record<string, VariableName> = {};
  const bound = targets(m);
  for (const name of VARIABLE_NAMES) {
    const value = name === "environment" ? variables.environment : variables.time;
    if (!bound[name] || unlinked.includes(name) || value == null) continue;
    for (const key of Object.keys(bound[name]!)) out[key] = name;
  }
  return out;
}

/** The time range presets panes offer, with their labels: what a Time range
 * variable may be. */
export function timePresets(): { value: number | "custom"; label: string }[] {
  for (const m of manifests()) {
    const preset = targets(m).time;
    const key = preset && Object.entries(preset).find(([, part]) => part === "preset")?.[0];
    const input = key ? m.inputs.find((i) => i.key === key) : undefined;
    if (input) {
      return input.choices.map((c) => ({
        value: c === "custom" ? "custom" : Number(c),
        label: input.choice_labels[String(c)] ?? String(c),
      }));
    }
  }
  return [];
}

// A variable changed in this tab: its panes re-run what they had run (D60).
// Every tab follows the inputs, but only the one that changed the variable
// runs anything -- otherwise each open tab would run every pane again.
const changedHere = new Map<string, number>();
const RERUN_WINDOW_MS = 5000;

export function announceVariableChange(session: string): void {
  changedHere.set(session, Date.now());
}

export function changedInThisTab(session: string | null): boolean {
  if (!session) return false;
  const at = changedHere.get(session);
  return at !== undefined && Date.now() - at < RERUN_WINDOW_MS;
}
