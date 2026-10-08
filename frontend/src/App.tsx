import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";
import { api, readableError, Settings } from "./api";
import { useAuth } from "./AuthContext";
import { useStaleBuild } from "./appBuild";
import { AgentProvider, useAgent } from "./agent/AgentContext";
import AgentDock, { DOCK_WIDTH } from "./components/AgentDock";
import AgentFloat from "./components/AgentFloat";
import { BrandInfo } from "./components/Brand";
import ColumnResizer, { storedWidth, storeWidth } from "./components/ColumnResizer";
import AgentPage from "./pages/AgentPage";
import AggregatorPage from "./pages/AggregatorPage";
import HomePage from "./pages/HomePage";
import { PAGES } from "./pages/pageTypes";
import LoginPage from "./pages/LoginPage";
import SettingsPage from "./pages/SettingsPage";
import PageInfo from "./components/PageInfo";
import { setRailSlot } from "./components/railSlot";
import SessionBar from "./components/SessionBar";
import Sidebar from "./components/Sidebar";

import UserMenu from "./components/UserMenu";
import { SessionScopeProvider, SessionsProvider, SessionType, useSessions } from "./sessions/SessionContext";
import { TemplatesProvider } from "./sessions/templates";
import { PersistedSession } from "./sessions/storage";
import { setManifests } from "./panes/manifest";
import { registerManifestPanes } from "./sessions/paneTypes";
import { applyTheme, getInitialTheme, ThemeId } from "./theme";

/** Whether the left rail is showing, and how wide it and the agent's dock are.
 * Per-browser preferences, not workspace state. */
const RAIL_STORAGE_KEY = "cwi-rail";
const RAIL_WIDTH_KEY = "cwi-rail-width";
const DOCK_WIDTH_KEY = "cwi-agent-width";
const RAIL_WIDTH = { initial: 212, min: 160, max: 420 };

/** The narrowest the body's scroll box gets squeezed by the columns beside it:
 * room for one 420px pane (the side-by-side layout's column) and the 16px gap
 * after it. Without a floor, a wide rail and a wide dock on a laptop screen
 * left the body a few hundred pixels, its panes ran on under the dock, and
 * the body scrolled sideways behind it. A width you chose is kept, and comes
 * back when the window has room for it again; it's only drawn narrower. */
const BODY_MIN_WIDTH = 440;

/** The window's width, followed as it changes, for the limit above. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

const DEFAULT_APP_TITLE = "Cloud Insights";
const DEFAULT_SETTINGS: Settings = { app_title: null, app_logo_url: null };

export default function App() {
  const { user, loading } = useAuth();
  const [theme, setTheme] = useState<ThemeId>(getInitialTheme);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    api.getSettings().then(setSettings);
  }, []);

  const appTitle = settings.app_title?.trim() || DEFAULT_APP_TITLE;

  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  useEffect(() => {
    // Reuses the same logo shown next to the app title as the browser tab's
    // favicon. There's no bundled default to fall back to -- removing the
    // link on logo removal just leaves the browser's own default, same as
    // before any logo was ever set.
    const FAVICON_ID = "app-favicon";
    let link = document.getElementById(FAVICON_ID) as HTMLLinkElement | null;
    if (settings.app_logo_url) {
      if (!link) {
        link = document.createElement("link");
        link.id = FAVICON_ID;
        link.rel = "icon";
        document.head.appendChild(link);
      }
      const mime = settings.app_logo_url.match(/^data:([^;,]+)/);
      if (mime) link.type = mime[1];
      link.href = settings.app_logo_url;
    } else if (link) {
      link.remove();
    }
  }, [settings.app_logo_url]);

  if (loading) return null;
  if (!user) return <LoginPage />;

  return (
    <PaneTypesGate userId={user.id}>
      <SessionsProvider userId={user.id}>
        {/* Templates are offered in two places -- the panel's catalogue and the
            strip's ＋ -- so they are fetched once here rather than per list. */}
        <TemplatesProvider>
          {/* One conversation with the agent, for the page and the dock alike. */}
          <AgentProvider>
            <AppShell
              appTitle={appTitle}
              appLogoUrl={settings.app_logo_url}
              theme={theme}
              onThemeChange={setTheme}
              onSettingsChange={setSettings}
            />
          </AgentProvider>
        </TemplatesProvider>
      </SessionsProvider>
    </PaneTypesGate>
  );
}

/**
 * Holds the app back until the pane manifests are in (PLATFORM_PLAN.md §15):
 * the catalogue lists the panes they describe, the renderer draws from them,
 * and loading a session migrates its ported panes' keys by them -- a session
 * mounted first would draw those panes empty and then move their keys under
 * them. Per user, since which manifests come back depends on their group.
 */
function PaneTypesGate({ userId, children }: { userId: number; children: ReactNode }) {
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listPaneTypes()
      .then((list) => {
        if (cancelled) return;
        setManifests(list);
        registerManifestPanes(list);
        setLoadedFor(userId);
      })
      .catch((e) => {
        if (!cancelled) setError(readableError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt]);

  if (error) {
    return (
      <div className="panel" style={{ margin: 16 }}>
        <p className="error-text">The app couldn't load its pane types: {error}</p>
        <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>
      </div>
    );
  }
  return loadedFor === userId ? <>{children}</> : null;
}

interface ShellProps {
  appTitle: string;
  appLogoUrl: string | null;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  onSettingsChange: (settings: Settings) => void;
}

function AppShell({ appTitle, appLogoUrl, theme, onThemeChange, onSettingsChange }: ShellProps) {
  const { user, logout } = useAuth();
  const { sessions, activeId, view, ready, show, open, flushAll } = useSessions();

  async function handleLogout() {
    await logout();
  }

  const agent = useAgent();
  const brand: BrandInfo = { title: appTitle, logoUrl: appLogoUrl };

  // A newer build is deployed: say so, and reload at the next move to another
  // page or session -- a natural break, never in the middle of typing. Every
  // session is saved first: the debounced save would be cut off by the
  // reload, and the server's older copy is what the new page would load.
  const stale = useStaleBuild();
  const place = `${view}:${activeId ?? ""}`;
  const staleAt = useRef<string | null>(null);
  const reload = async () => {
    await flushAll();
    window.location.reload();
  };
  useEffect(() => {
    if (!stale) return;
    if (staleAt.current === null) staleAt.current = place;
    else if (staleAt.current !== place) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, place]);

  const [railWidth, setRailWidth] = useState(() =>
    storedWidth(RAIL_WIDTH_KEY, RAIL_WIDTH.initial, RAIL_WIDTH.min, RAIL_WIDTH.max),
  );
  const [dockWidth, setDockWidth] = useState(() =>
    storedWidth(DOCK_WIDTH_KEY, DOCK_WIDTH.initial, DOCK_WIDTH.min, DOCK_WIDTH.max),
  );
  const windowWidth = useWindowWidth();

  // Remembered per browser: collapsing the rail is a working preference, not
  // workspace data, so it never goes near the session store.
  const [railOpen, setRailOpen] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_STORAGE_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_STORAGE_KEY, railOpen ? "open" : "closed");
    } catch {
      // best-effort persistence only
    }
  }, [railOpen]);

  // The account's picture, at the far right of whatever reaches the window's
  // right edge: the docked agent panel's header when it's open, otherwise the
  // strip (a floating agent panel is over the page, not a column, so it
  // leaves the picture on the strip).
  const account = user ? <UserMenu user={user} onOpenSettings={() => show("settings")} onLogout={handleLogout} /> : null;

  // The widths actually drawn, and how far each resizer may go, so the body
  // keeps BODY_MIN_WIDTH. The shell is its 16px left padding, the rail and the
  // gap after it, the body, and the dock (whose own margin takes back the gap
  // before it, and whose 16px right padding is inside its width).
  const dockShown = agent.layout === "dock" && agent.open && view !== "agent";
  const railRoom = (dockWidthNow: number) =>
    windowWidth - 16 - 16 - BODY_MIN_WIDTH - (dockShown ? dockWidthNow : 0);
  const railMax = Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, railRoom(DOCK_WIDTH.min)));
  const railShown = Math.min(railWidth, railMax);
  const dockMax = Math.max(
    DOCK_WIDTH.min,
    Math.min(DOCK_WIDTH.max, windowWidth - 16 - (railOpen ? railShown + 16 : 0) - BODY_MIN_WIDTH),
  );
  const dockShownWidth = Math.min(dockWidth, dockMax);

  // Nothing renders until the workspace has been read back, so a restored
  // session never flashes as empty first.
  if (!ready) return null;

  return (
    <div className="app">
      {/* No header bar: the brand heads the side panel (or starts the strip
          while it's hidden), the account's picture ends the strip (or the
          docked agent panel's header), and a question for the agent goes in
          the agent panel's Global tab. */}
      <div className="shell">
        {/* The panel and the page's own title share a column: "what I have"
            above, "what I am looking at" below. Below rather than above so the
            panel's own rows stay put instead of shifting down whenever a
            description is longer. */}
        {railOpen && (
          <div className="rail-column" style={{ width: railShown }}>
            <Sidebar open={railOpen} brand={brand} />
            <PageInfo />
            {/* The session's Panes card, when it's been moved here (railSlot). */}
            <div className="rail-session-slot" ref={setRailSlot} />
            <ColumnResizer
              className="rail-resizer"
              label="Resize the side panel"
              width={railShown}
              {...RAIL_WIDTH}
              max={Math.max(RAIL_WIDTH.min, Math.min(RAIL_WIDTH.max, railRoom(dockShownWidth)))}
              grow={1}
              onResize={setRailWidth}
              onCommit={(w) => storeWidth(RAIL_WIDTH_KEY, w)}
            />
          </div>
        )}

        {/* The strip lives inside the scrolling body, not above it: a classic
            scrollbar takes its width out of .content, so a strip outside it
            ended up wider than the cards by exactly the scrollbar. Sticky, so
            it still behaves like a header. */}
        {/* The body's scroll box runs to the window's right edge whether or not
            the agent panel is docked, so its scrollbar always sits against the
            window: the docked panel is drawn over the right of it (fixed, see
            .agent-dock) and the body pads itself clear of it by its width. */}
        <main
          className="content"
          style={{ "--dock-width": `${dockShown ? dockShownWidth : 0}px` } as CSSProperties}
        >
          <SessionBar
            railOpen={railOpen}
            onToggleRail={() => setRailOpen((v) => !v)}
            brand={brand}
            account={dockShown ? null : account}
          />
          {stale && (
            <div className="panel app-update" role="status">
              <span>A new version of the app is available. It loads when you next switch page or session.</span>
              <button onClick={reload}>Reload now</button>
            </div>
          )}

        {view === "home" && <HomePage />}
        {view === "settings" && (
          <SettingsPage theme={theme} onThemeChange={onThemeChange} onSettingsChange={onSettingsChange} />
        )}
        {/* The conversation itself lives in AgentProvider, so this page can
            come and go; kept mounted anyway so its scroll position does too. */}
        <div hidden={view !== "agent"}>
          <AgentPage />
        </div>
        {PAGES.filter((p) => p.render && p.id !== "agent").map((p) => (
          <div key={p.id} hidden={view !== p.id}>
            {p.render!()}
          </div>
        ))}
        {/* Every open session stays mounted, hidden rather than unmounted, so
            switching tabs never interrupts a running query or throws away a
            scroll position -- the same reason Aggregator panes stay mounted. */}
        {sessions.map((session) => (
          <SessionBody
            key={session.id}
            session={session}
            hidden={view !== "session" || activeId !== session.id}
          />
          ))}
        </main>
        {/* Docked: beside the body rather than over it, so nothing it's
            showing you is hidden behind it -- a dashboard re-measures its
            canvas and fits. Floating: a corner button and a panel over the
            page. Neither on the Agent page, which is the global chat already. */}
        {dockShown && (
          <AgentDock
            width={dockShownWidth}
            max={dockMax}
            onResize={setDockWidth}
            onCommit={(w) => storeWidth(DOCK_WIDTH_KEY, w)}
            account={account}
          />
        )}
        {agent.layout === "float" && view !== "agent" && <AgentFloat />}
      </div>
    </div>
  );
}

function SessionBody({ session, hidden }: { session: PersistedSession; hidden: boolean }) {
  return (
    <div className="session-body" hidden={hidden}>
      <SessionScopeProvider session={session}>
        {session.truncated && (
          <div className="panel">
            <p className="muted" style={{ margin: 0 }}>
              This session's results were too large to keep between page loads, so only its inputs came back. Run the
              search again to repopulate it.
            </p>
          </div>
        )}
        {/* Every session is an Aggregator. Which panes it holds is its own
            state, and the page itself is what says a service is no longer
            enabled -- it only offers the ones you can see. */}
        <AggregatorPage />
      </SessionScopeProvider>
    </div>
  );
}
