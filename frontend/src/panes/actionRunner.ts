import { createContext } from "react";
import { api } from "../api";

/**
 * How a pane runs its server actions: the action endpoint, normally. The
 * Builder's preview (D112) draws a draft no server knows as a pane type, so
 * it provides one that sends the draft along to `/api/builder/preview/actions`
 * -- the renderer itself stays the one every pane uses.
 */
export type ActionRunner = typeof api.runPaneAction;

export const ActionRunnerContext = createContext<ActionRunner | null>(null);
