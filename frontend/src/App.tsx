import { useEffect, useState } from "react";
import { api, Settings } from "./api";
import BucketsPage from "./pages/BucketsPage";
import CognitoPage from "./pages/CognitoPage";
import EnvironmentsPage from "./pages/EnvironmentsPage";
import InsightsPage from "./pages/InsightsPage";
import IotPage from "./pages/IotPage";
import TablesPage from "./pages/TablesPage";
import ToolsPage from "./pages/ToolsPage";
import { applyTheme, getInitialTheme, THEMES, ThemeId } from "./theme";

type Tab = "insights" | "iot" | "tables" | "buckets" | "cognito" | "tools" | "environments";

const DEFAULT_APP_TITLE = "Cloud Insights";
const DEFAULT_SETTINGS: Settings = {
  default_role_name: null,
  app_title: null,
  app_logo_url: null,
  logs_enabled: true,
  iot_enabled: true,
  tables_enabled: true,
  buckets_enabled: true,
  cognito_enabled: true,
  tools_enabled: true,
};

const TOGGLEABLE_TABS: { id: Tab; label: string; enabledKey: keyof Settings; render: () => JSX.Element }[] = [
  { id: "insights", label: "Logs", enabledKey: "logs_enabled", render: () => <InsightsPage /> },
  { id: "iot", label: "IoT", enabledKey: "iot_enabled", render: () => <IotPage /> },
  { id: "tables", label: "Tables", enabledKey: "tables_enabled", render: () => <TablesPage /> },
  { id: "buckets", label: "Buckets", enabledKey: "buckets_enabled", render: () => <BucketsPage /> },
  { id: "cognito", label: "Cognito", enabledKey: "cognito_enabled", render: () => <CognitoPage /> },
  { id: "tools", label: "Tools", enabledKey: "tools_enabled", render: () => <ToolsPage /> },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("insights");
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

  // A tab that's just been disabled (e.g. from the Settings page itself)
  // shouldn't leave the user stranded on a page that's no longer reachable.
  useEffect(() => {
    const current = TOGGLEABLE_TABS.find((t) => t.id === tab);
    if (current && !settings[current.enabledKey]) setTab("environments");
  }, [tab, settings]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {settings.app_logo_url && <img className="brand-logo" src={settings.app_logo_url} alt="" />}
          {appTitle}
        </div>
        <nav className="tabs">
          {TOGGLEABLE_TABS.map(
            (t) =>
              settings[t.enabledKey] && (
                <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              )
          )}
          <button
            className={tab === "environments" ? "tab active" : "tab"}
            onClick={() => setTab("environments")}
          >
            Settings
          </button>
        </nav>
        <div className="topbar-right">
          <select
            className="theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeId)}
            aria-label="Theme"
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </header>
      <main className="content">
        {TOGGLEABLE_TABS.map((t) => tab === t.id && settings[t.enabledKey] && <div key={t.id}>{t.render()}</div>)}
        {tab === "environments" && <EnvironmentsPage onSettingsChange={setSettings} />}
      </main>
    </div>
  );
}
