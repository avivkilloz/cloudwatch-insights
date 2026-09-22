import { useEffect, useState } from "react";
import { api, Settings } from "./api";
import { useAuth } from "./AuthContext";
import { openingExchange } from "./pages/AgentPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import SettingsPage from "./pages/SettingsPage";
import PageInfo from "./components/PageInfo";
import SessionBar from "./components/SessionBar";
import Sidebar from "./components/Sidebar";

/** Whether the left rail is showing. A per-browser preference, not workspace state. */
const RAIL_STORAGE_KEY = "cwi-rail";
import UserMenu from "./components/UserMenu";
import { SessionScopeProvider, SessionsProvider, SessionType, useSessions } from "./sessions/SessionContext";
import { TemplatesProvider } from "./sessions/templates";
import { SESSION_TYPES, sessionType } from "./sessions/registry";
import { PersistedSession } from "./sessions/storage";
import { applyTheme, getInitialTheme, ThemeId } from "./theme";

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
    <SessionsProvider userId={user.id}>
      {/* Templates are offered in two places -- the panel's catalogue and the
          strip's ＋ -- so they are fetched once here rather than per list. */}
      <TemplatesProvider>
        <AppShell
          appTitle={appTitle}
          appLogoUrl={settings.app_logo_url}
          theme={theme}
          onThemeChange={setTheme}
          onSettingsChange={setSettings}
        />
      </TemplatesProvider>
    </SessionsProvider>
  );
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
  const { sessions, activeId, view, ready, show, open } = useSessions();
  const [prompt, setPrompt] = useState("");

  async function handleLogout() {
    await logout();
  }

  function askAgent() {
    const text = prompt.trim();
    if (!text) return;
    setPrompt("");
    // A question in the header starts an agent session and arrives as its
    // first message, rather than being answered somewhere with no history.
    const taken = sessions.map((s) => s.title);
    let title = "Agent";
    for (let n = 2; taken.includes(title); n++) title = `Agent ${n}`;
    open("agent", title, { "agent.messages": openingExchange(text) });
  }

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

  // Nothing renders until the workspace has been read back, so a restored
  // session never flashes as empty first.
  if (!ready) return null;

  return (
    <div className="app">
      <header className="topbar">
        {/* The panel has its own toggle in the strip below now, so the brand
            is free to do the obvious thing and take you home. */}
        <button className="brand" onClick={() => show("home")} title="Go to the home page">
          {appLogoUrl && <img className="brand-logo" src={appLogoUrl} alt="" />}
          {appTitle}
        </button>
        {/* Where the service tabs used to be. Those are sessions now, in the
            bar below; this is the way in to the agent that works across them. */}
        <div className="agent-bar">
          <input
            type="text"
            className="agent-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") askAgent();
            }}
            placeholder="Ask the agent…"
            aria-label="Ask the agent"
          />
        </div>
        <div className="topbar-right">
          {user && <UserMenu user={user} onOpenSettings={() => show("settings")} onLogout={handleLogout} />}
        </div>
      </header>

      <div className="shell">
        {/* The panel and the page's own title share a column: "what I have"
            above, "what I am looking at" below. Below rather than above so the
            panel's own rows stay put instead of shifting down whenever a
            description is longer. */}
        {railOpen && (
          <div className="rail-column">
            <Sidebar open={railOpen} />
            <PageInfo />
          </div>
        )}

        {/* The strip lives inside the scrolling body, not above it: a classic
            scrollbar takes its width out of .content, so a strip outside it
            ended up wider than the cards by exactly the scrollbar. Sticky, so
            it still behaves like a header. */}
        <main className="content">
          <SessionBar railOpen={railOpen} onToggleRail={() => setRailOpen((v) => !v)} />

        {view === "home" && <HomePage />}
        {view === "settings" && (
          <SettingsPage theme={theme} onThemeChange={onThemeChange} onSettingsChange={onSettingsChange} />
        )}
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
      </div>
    </div>
  );
}

function SessionBody({ session, hidden }: { session: PersistedSession; hidden: boolean }) {
  const { user } = useAuth();
  // An admin can revoke a service while a session for it is open; the session
  // stays in the strip (closing it silently would lose work the user can't see
  // to save) but says why it won't render.
  const def = sessionType(session.type);

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
        {def && def.enabledFor(user) ? (
          <>
            {/* No title here: it lives in the card under the side panel, so
                the body starts with the thing you came to use. */}
            {def.render()}
          </>
        ) : (
          <div className="panel">
            <p className="muted" style={{ margin: 0 }}>
              {def
                ? "This session's service is no longer enabled for your account."
                : "This session is of a kind this version no longer knows how to open."}
            </p>
          </div>
        )}
      </SessionScopeProvider>
    </div>
  );
}
