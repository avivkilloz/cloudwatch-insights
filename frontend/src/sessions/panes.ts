/**
 * Panes as instances rather than types.
 *
 * A session used to hold at most one pane of each kind, and a pane's id *was*
 * its type ("logs-cloudwatch"): `services` listed types, and a pane's inputs
 * lived under "<type>.<key>". Now a session can hold several of one kind, each
 * with its own name, so a pane has an id of its own:
 *
 * - `services` is still the ordered list of pane ids -- the key every layout,
 *   the dashboard's rects and the minimised set are already keyed by.
 * - `paneTypes` maps a pane id to its type, `paneTitles` to its name.
 *
 * A pane missing from `paneTypes` is one whose id is its type, and one missing
 * from `paneTitles` is called by its type's label -- which is exactly every
 * session and template saved before this, so none of them needs migrating.
 * The first pane of a kind still gets the type as its id for the same reason:
 * its keys read the way they always have. Later ones get "<type>~2", "~3"; a
 * "~" can't appear in a type, and a "." (which splits a pane's id from its
 * keys) can't appear in either.
 *
 * Imports the catalogue from ./paneTypes rather than ./registry: AggregatorPage
 * reads this, and going through the registry is a cycle that has failed at
 * module-evaluation time before.
 */

import { nextTitle } from "./naming";
import { PANE_TYPES } from "./paneTypes";

export type PaneTypes = Record<string, string>;
export type PaneTitles = Record<string, string>;

export function paneType(id: string, types: PaneTypes): string {
  return types[id] ?? id;
}

function typeLabel(type: string): string {
  return PANE_TYPES.find((t) => t.type === type)?.label ?? type;
}

export function paneTitle(id: string, types: PaneTypes, titles: PaneTitles): string {
  return titles[id] ?? typeLabel(paneType(id, types));
}

/** A new pane of `type`, given the ids and titles already in the session. Its
 * name follows the rule sessions' names do -- "CloudWatch", then "CloudWatch
 * 2" -- so a second pane of a kind can be told apart before anyone renames it. */
export function newPane(type: string, ids: string[], titles: string[]): { id: string; title: string } {
  let id = type;
  for (let n = 2; ids.includes(id); n++) id = `${type}~${n}`;
  return { id, title: nextTitle(typeLabel(type), titles) };
}

/** The pane keys of a brand-new session holding `types`, repeats and all. */
export function initialPanes(types: string[]): { services: string[]; paneTypes: PaneTypes; paneTitles: PaneTitles } {
  const services: string[] = [];
  const paneTypes: PaneTypes = {};
  const paneTitles: PaneTitles = {};
  for (const type of types) {
    const { id, title } = newPane(type, services, Object.values(paneTitles));
    services.push(id);
    paneTypes[id] = type;
    paneTitles[id] = title;
  }
  return { services, paneTypes, paneTitles };
}
