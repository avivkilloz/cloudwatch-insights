import { useState } from "react";
import EnvironmentsPage from "./pages/EnvironmentsPage";
import InsightsPage from "./pages/InsightsPage";

type Tab = "insights" | "environments";

export default function App() {
  const [tab, setTab] = useState<Tab>("insights");

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">CloudWatch Insights — Multi-Account</div>
        <nav className="tabs">
          <button className={tab === "insights" ? "tab active" : "tab"} onClick={() => setTab("insights")}>
            Insights
          </button>
          <button className={tab === "environments" ? "tab active" : "tab"} onClick={() => setTab("environments")}>
            Environments &amp; Settings
          </button>
        </nav>
      </header>
      <main className="content">{tab === "insights" ? <InsightsPage /> : <EnvironmentsPage />}</main>
    </div>
  );
}
