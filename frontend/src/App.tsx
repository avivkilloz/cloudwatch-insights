import { useEffect, useState } from "react";
import { api, Settings } from "./api";
import EnvironmentsPage from "./pages/EnvironmentsPage";
import InsightsPage from "./pages/InsightsPage";
import IotPage from "./pages/IotPage";
import { applyTheme, getInitialTheme, THEMES, ThemeId } from "./theme";

type Tab = "insights" | "iot" | "environments";

const DEFAULT_APP_TITLE = "Cloud Insights";
const DEFAULT_SETTINGS: Settings = {
  default_role_name: null,
  app_title: null,
  app_logo_url: null,
  logs_enabled: true,
  iot_enabled: true,
};

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
    if (tab === "insights" && !settings.logs_enabled) setTab("environments");
    if (tab === "iot" && !settings.iot_enabled) setTab("environments");
  }, [tab, settings.logs_enabled, settings.iot_enabled]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {settings.app_logo_url && <img className="brand-logo" src={settings.app_logo_url} alt="" />}
          {appTitle}
        </div>
        <nav className="tabs">
          {settings.logs_enabled && (
            <button className={tab === "insights" ? "tab active" : "tab"} onClick={() => setTab("insights")}>
              Logs
            </button>
          )}
          {settings.iot_enabled && (
            <button className={tab === "iot" ? "tab active" : "tab"} onClick={() => setTab("iot")}>
              IoT
            </button>
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
        {tab === "insights" && settings.logs_enabled && <InsightsPage />}
        {tab === "iot" && settings.iot_enabled && <IotPage />}
        {tab === "environments" && <EnvironmentsPage onSettingsChange={setSettings} />}
      </main>
    </div>
  );
}
