import { createContext, useContext } from "react";
import { AiAssistMode, AiDomain } from "../api";

// The Aggregator page mounts several whole pages side by side, and each of
// those pages renders its own AiAssistantWidget -- which would stack five
// floating buttons in the same corner. Instead, a page rendered inside this
// context registers what it would have offered the assistant and renders
// nothing, and the Aggregator puts up a single widget spanning every pane.

export interface AiPane {
  id: string;
  domain: AiDomain;
  modes: AiAssistMode[];
  queryString?: string;
  /** Everything currently on screen in this pane. */
  rows: Record<string, unknown>[];
  selectedRows: Record<string, unknown>[];
  /** Applies a generated query to this pane's own search box. */
  onUseQuery?: (query: string) => void;
  /** Bumped by the pane when a new search supersedes its rows. */
  resultsVersion: number;
}

/** The reactive slice of a pane: what the shared widget's own UI renders.
 * Kept deliberately small and comparable so re-registering a pane on every
 * render doesn't re-render the Aggregator unless something really changed. */
export interface AiPaneSummary {
  id: string;
  domain: AiDomain;
  modes: AiAssistMode[];
  rowCount: number;
  selectedCount: number;
  resultsVersion: number;
}

export interface AiPaneRegistry {
  register: (pane: AiPane) => void;
  unregister: (id: string) => void;
}

export const AiPaneRegistryContext = createContext<AiPaneRegistry | null>(null);

export function useAiPaneRegistry(): AiPaneRegistry | null {
  return useContext(AiPaneRegistryContext);
}

export function summarizePane(pane: AiPane): AiPaneSummary {
  return {
    id: pane.id,
    domain: pane.domain,
    modes: pane.modes,
    rowCount: pane.rows.length,
    selectedCount: pane.selectedRows.length,
    resultsVersion: pane.resultsVersion,
  };
}

export function sameSummaries(a: AiPaneSummary[], b: AiPaneSummary[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.id === y.id &&
      x.domain === y.domain &&
      x.rowCount === y.rowCount &&
      x.selectedCount === y.selectedCount &&
      x.resultsVersion === y.resultsVersion &&
      x.modes.length === y.modes.length &&
      x.modes.every((m, j) => m === y.modes[j])
    );
  });
}

export const DOMAIN_LABELS: Record<AiDomain, string> = {
  "logs-cloudwatch": "Logs (CloudWatch)",
  "logs-opensearch": "Logs (OpenSearch)",
  "iot-things": "IoT things",
  "iot-certificates": "IoT certificates",
  tables: "Tables",
  buckets: "Buckets",
  cognito: "Cognito",
  aggregator: "All open services",
};
