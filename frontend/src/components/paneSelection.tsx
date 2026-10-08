import { createContext, useContext, useEffect, useId, useRef } from "react";
import { manifest } from "../panes/manifest";

/**
 * How a pane tells its session what it has checked in its results, so the
 * platform agent's session chat can attach those rows to a question.
 *
 * Every pane is rendered inside an Aggregator, which collects these
 * registrations (one per pane) and publishes the session's pooled selection
 * for the agent panel (agent/selection.ts). This used to feed the ✦ Ask AI
 * assistant, which the agent replaced: it can do everything the assistant
 * did -- write a query into a pane, answer about checked rows -- and act on
 * the session besides.
 */

/** What kind of rows a pane's selection holds, for labelling them. */
export type PaneDomain =
  | "logs-cloudwatch"
  | "logs-opensearch"
  | "iot-things"
  | "iot-certificates"
  | "tables"
  | "buckets"
  | "cognito"
  | "tools-http"
  // A manifest pane's rows, by its type's id (PLATFORM_PLAN.md §15): labelled
  // by its manifest, since panes added that way aren't known here.
  | (string & {});

export interface PaneSelection {
  id: string;
  domain: PaneDomain;
  /** The pane's own name in the session, stamped on by the Aggregator (the
   * page inside doesn't know it). */
  label?: string;
  selectedRows: Record<string, unknown>[];
  /** Bumped whenever the rows are replaced. Counts alone can't see a change
   * of *content* -- fetching an IoT thing's detail re-emits the same number
   * of rows with more in them. */
  selectionVersion: number;
}

export interface PaneSelectionRegistry {
  register: (pane: PaneSelection) => void;
  unregister: (id: string) => void;
}

export const PaneSelectionContext = createContext<PaneSelectionRegistry | null>(null);

export const DOMAIN_LABELS: Record<string, string> = {
  "logs-cloudwatch": "Logs (CloudWatch)",
  "logs-opensearch": "Logs (OpenSearch)",
  "iot-things": "IoT things",
  "iot-certificates": "IoT certificates",
  tables: "DynamoDB",
  buckets: "S3",
  cognito: "Cognito",
  "tools-http": "HTTP client",
};

export function domainLabel(domain: PaneDomain): string {
  return DOMAIN_LABELS[domain] ?? manifest(domain)?.label ?? domain;
}

/** Registers a pane's checked rows with its session. Renders nothing. */
export function PaneSelectionShare({ domain, selectedRows }: { domain: PaneDomain; selectedRows?: Record<string, unknown>[] }) {
  const registry = useContext(PaneSelectionContext);
  const id = useId();
  // Compared by identity: a page that never passes rows leaves it at zero
  // instead of churning every render.
  const lastRows = useRef(selectedRows);
  const version = useRef(0);
  if (lastRows.current !== selectedRows) {
    lastRows.current = selectedRows;
    version.current += 1;
  }
  // Every render, since the row arrays are rebuilt each time; the Aggregator
  // compares before re-rendering, so an unchanged registration costs nothing.
  useEffect(() => {
    registry?.register({ id, domain, selectedRows: selectedRows ?? [], selectionVersion: version.current });
  });
  // Its own effect with stable deps: as the cleanup of the one above it would
  // run every render, and the remove/re-add churn would spin.
  useEffect(() => {
    if (!registry) return;
    return () => registry.unregister(id);
  }, [registry, id]);
  return null;
}
