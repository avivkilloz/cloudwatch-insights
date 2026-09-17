import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./AuthContext";
import { applyTheme, getInitialTheme } from "./theme";
import "./styles.css";

// Applied before the first render so there's no flash of the default theme.
applyTheme(getInitialTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
