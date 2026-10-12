/**
 * What the renderer's parts get from the pane they draw (ManifestPane.tsx):
 * its manifest, its values, and the few things they may do to it. Kept apart
 * so the list and file components don't import the renderer back.
 */

import { ManifestAction, PaneManifest } from "./manifest";

export type Values = Record<string, unknown>;

export interface Option {
  value: string;
  label: string;
}

export interface RunOptions {
  /** Load more: the cursor the last run returned. */
  cursor?: unknown;
  /** Inputs as they will be once a change being made now has landed. */
  inputs?: Values;
}

export interface PaneApi {
  m: PaneManifest;
  inputs: Values;
  outputs: Values;
  /** How the pane looks (expanded rows): session state, synced (D48). */
  views: Values;
  /**
   * A change a person (or a saved item, or a breadcrumb) makes to inputs:
   * sets them, clears what each one `resets`, and runs the actions whose
   * `on_change` names one of them -- once each, with the new values.
   * Returns the ids of the actions it ran.
   */
  changeInputs: (changes: Values) => string[];
  setView: (key: string, value: unknown) => void;
  run: (action: ManifestAction, options?: RunOptions) => void;
  busy: Record<string, boolean>;
  errors: Record<string, string | null>;
  /** Bumped by every fresh run: what resets a list's selection. */
  resultsVersion: number;
  ranAt: number | null;
  /** A short-lived message ("S3 URI copied to clipboard"), shown where the layout's `flash` is. */
  flash: (message: string) => void;
  flashed: string | null;
  /** Each loader's options, by its action's id: in the tab's memory only (D47). */
  options: Record<string, Option[] | undefined>;
  /** A row action (§16.4.2) with the inputs its args read from a row: its
   * outputs come back to the caller, never into the pane's state. */
  runRow: (action: ManifestAction, inputs: Values) => Promise<Values>;
}

export function actionById(pane: PaneApi, id: string | undefined): ManifestAction | undefined {
  return id ? pane.m.actions.find((a) => a.id === id) : undefined;
}

/** A value as JSON can carry it: a Set (a `connections` input a session saved
 * before its port still decodes to one) becomes a list -- JSON.stringify
 * would make it {}. */
export function plain(value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Values).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}
