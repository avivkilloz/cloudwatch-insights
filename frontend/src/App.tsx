import { useEffect, useState } from "react";
import EnvironmentsPage from "./pages/EnvironmentsPage";
import InsightsPage from "./pages/InsightsPage";
import IotPage from "./pages/IotPage";
import { applyTheme, getInitialTheme, THEMES, ThemeId } from "./theme";

type Tab = "insights" | "iot" | "environments";

export default function App() {
  const [tab, setTab] = useState<Tab>("insights");
  const [theme, setTheme] = useState<ThemeId>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Cloud Insights</div>
        <nav className="tabs">
          <button className={tab === "insights" ? "tab active" : "tab"} onClick={() => setTab("insights")}>
            Logs
          </button>
          <button className={tab === "iot" ? "tab active" : "tab"} onClick={() => setTab("iot")}>
            IoT
          </button>
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
        {tab === "insights" && <InsightsPage />}
        {tab === "iot" && <IotPage />}
        {tab === "environments" && <EnvironmentsPage />}
      </main>
    </div>
  );
}
