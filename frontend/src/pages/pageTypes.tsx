import { JSX } from "react";
import AgentPage from "./AgentPage";

/**
 * The pages that are not sessions.
 *
 * A session is an Aggregator holding panes over AWS services and tools. These
 * are the rest of the platform: things you go to rather than open a copy of.
 * Settings is the one that already existed; the agent moved here because a
 * conversation about the whole workspace is a place, not one more thing open
 * inside it.
 *
 * Everything below `home` shows as a card on the home page, under Platform.
 */

export type PageId = "home" | "settings" | "agent" | "workflows" | "chat" | "code";

export interface PageDef {
  id: PageId;
  label: string;
  /** One line for the home card. */
  description: string;
  /** A sentence or two for the card under the side panel. */
  help: string;
  /** Whether it appears as a card on the home page. Home itself does not. */
  onHome: boolean;
  enabledFor: (user: any) => boolean;
  /** Absent for pages the shell renders itself because they need its props --
   * settings, which owns the theme and the app's own settings. */
  render?: () => JSX.Element;
}

/** A page that is named and reachable but not built. Better than leaving it out
 * of the list: you can see what the platform is going to hold, and it says
 * plainly that it is not here yet rather than pretending. */
function ComingSoon({ label, what }: { label: string; what: string }) {
  return (
    <div className="panel">
      <h2>{label}</h2>
      <p className="muted" style={{ margin: 0, maxWidth: "70ch" }}>
        {what} It isn't built yet — this page is here so the shape of the platform is visible, not to stand in for
        something that works.
      </p>
    </div>
  );
}

export const PAGES: PageDef[] = [
  {
    id: "home",
    label: "Home",
    description: "Everything you can open.",
    help:
      "Start a session over the services and tools you need, and reach the rest of the platform. A session holds " +
      "as many of them as you like and lets one assistant see across all of them at once.",
    onHome: false,
    enabledFor: () => true,
  },
  {
    id: "agent",
    label: "Agent",
    description: "Ask across the whole workspace, not one service.",
    help:
      "Ask about anything in the platform and — once it is connected to a model — have it do the work: open the " +
      "sessions you need, run the searches and answer across all of them. It sees the workspace from outside, " +
      "unlike the assistant inside a session, which only ever sees that session's own panes.",
    onHome: true,
    enabledFor: () => true,
    render: () => <AgentPage />,
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "Steps you run more than once.",
    help: "Sequences of searches and actions you run more than once, saved so they run the same way each time.",
    onHome: true,
    enabledFor: () => true,
    render: () => (
      <ComingSoon
        label="Workflows"
        what="Sequences of searches and actions you run more than once, saved so they run the same way each time."
      />
    ),
  },
  {
    id: "chat",
    label: "Chat",
    description: "Talk to the people you work with.",
    help: "Conversations alongside the work, so what you found and who you told about it live in the same place.",
    onHome: true,
    enabledFor: () => true,
    render: () => (
      <ComingSoon
        label="Chat"
        what="Conversations alongside the work, so what you found and who you told about it live in the same place."
      />
    ),
  },
  {
    id: "code",
    label: "Code",
    description: "Read the code behind what you're debugging.",
    help: "Read the code behind the service you are looking at, without leaving the session you found the problem in.",
    onHome: true,
    enabledFor: () => true,
    render: () => (
      <ComingSoon
        label="Code"
        what="Read the code behind the service you are looking at, without leaving the session you found the problem in."
      />
    ),
  },
  {
    id: "settings",
    label: "Settings",
    description: "Your account, environments and saved items.",
    help:
      "Your account and how the app looks, the environments and saved items you work with, and — if you are an " +
      "admin — the users, groups and which pages each group can see.",
    onHome: true,
    enabledFor: () => true,
  },
];

export function pageDef(id: string): PageDef | undefined {
  return PAGES.find((p) => p.id === id);
}

export function isPageId(view: string): view is PageId {
  return PAGES.some((p) => p.id === view);
}
