import { useState } from "react";
import AccountsPage from "./pages/AccountsPage";
import InsightsPage from "./pages/InsightsPage";

type Tab = "insights" | "accounts";

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
          <button className={tab === "accounts" ? "tab active" : "tab"} onClick={() => setTab("accounts")}>
            Accounts &amp; Settings
          </button>
        </nav>
      </header>
      <main className="content">{tab === "insights" ? <InsightsPage /> : <AccountsPage />}</main>
    </div>
  );
}
