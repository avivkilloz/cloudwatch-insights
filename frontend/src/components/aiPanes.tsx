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
  selectedRows: Record<string, unknown>[];
  /** Bumped by the pane whenever its selected rows are replaced. Counts alone
   * can't see a change of *content* -- fetching an IoT thing's shadows and
   * certificates re-emits the same number of rows with more in them -- so
   * without this the Aggregator never re-reads them and pools the pre-detail
   * version. */
  selectionVersion: number;
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
  selectedCount: number;
  selectionVersion: number;
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
    selectedCount: pane.selectedRows.length,
    selectionVersion: pane.selectionVersion,
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
      x.selectedCount === y.selectedCount &&
      x.selectionVersion === y.selectionVersion &&
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
  tables: "DynamoDB",
  buckets: "S3",
  cognito: "Cognito",
  aggregator: "All open services",
  // Never an Aggregator pane -- the Tools page isn't one of the services
  // offered there -- but the map is keyed by every domain.
  "tools-http": "HTTP client",
};
