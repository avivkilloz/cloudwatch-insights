import { useEffect, useState } from "react";
import { api, Settings } from "./api";
import { useAuth } from "./AuthContext";
import BucketsPage from "./pages/BucketsPage";
import CognitoPage from "./pages/CognitoPage";
import SettingsPage from "./pages/SettingsPage";
import InsightsPage from "./pages/InsightsPage";
import IotPage from "./pages/IotPage";
import LoginPage from "./pages/LoginPage";
import TablesPage from "./pages/TablesPage";
import ToolsPage from "./pages/ToolsPage";
import UserMenu from "./components/UserMenu";
import { applyTheme, getInitialTheme, ThemeId } from "./theme";

type Tab = "insights" | "iot" | "tables" | "buckets" | "cognito" | "tools" | "settings";

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

  if (loading) return null;
  if (!user) return <LoginPage />;

  return (
    <AppShell appTitle={appTitle} appLogoUrl={settings.app_logo_url} theme={theme} onThemeChange={setTheme} />
  );
}

interface ShellProps {
  appTitle: string;
  appLogoUrl: string | null;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

function AppShell({ appTitle, appLogoUrl, theme, onThemeChange }: ShellProps) {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("insights");

  const TOGGLEABLE_TABS: { id: Tab; label: string; enabled: boolean; render: () => JSX.Element }[] = [
    { id: "insights", label: "Logs", enabled: !!user?.logs_enabled, render: () => <InsightsPage /> },
    { id: "iot", label: "IoT", enabled: !!user?.iot_enabled, render: () => <IotPage /> },
    { id: "tables", label: "Tables", enabled: !!user?.tables_enabled, render: () => <TablesPage /> },
    { id: "buckets", label: "Buckets", enabled: !!user?.buckets_enabled, render: () => <BucketsPage /> },
    { id: "cognito", label: "Cognito", enabled: !!user?.cognito_enabled, render: () => <CognitoPage /> },
    { id: "tools", label: "Tools", enabled: !!user?.tools_enabled, render: () => <ToolsPage /> },
  ];

  // A tab that's just been disabled (e.g. by an admin changing this user's
  // group) shouldn't leave the user stranded on a page that's no longer
  // reachable.
  useEffect(() => {
    const current = TOGGLEABLE_TABS.find((t) => t.id === tab);
    if (current && !current.enabled) setTab("settings");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, user]);

  async function handleLogout() {
    await logout();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {appLogoUrl && <img className="brand-logo" src={appLogoUrl} alt="" />}
          {appTitle}
        </div>
        <nav className="tabs">
          {TOGGLEABLE_TABS.map(
            (t) =>
              t.enabled && (
                <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              )
          )}
        </nav>
        <div className="topbar-right">
          {user && (
            <UserMenu
              user={user}
              theme={theme}
              onThemeChange={onThemeChange}
              onOpenSettings={() => setTab("settings")}
              onLogout={handleLogout}
            />
          )}
        </div>
      </header>
      <main className="content">
        {TOGGLEABLE_TABS.map((t) => tab === t.id && t.enabled && <div key={t.id}>{t.render()}</div>)}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
