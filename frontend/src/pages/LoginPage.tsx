import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../AuthContext";

const DEFAULT_APP_TITLE = "Cloud Insights";

export default function LoginPage() {
  const { login } = useAuth();
  const [appTitle, setAppTitle] = useState(DEFAULT_APP_TITLE);
  const [appLogoUrl, setAppLogoUrl] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setAppTitle(s.app_title?.trim() || DEFAULT_APP_TITLE);
        setAppLogoUrl(s.app_logo_url);
      })
      .catch(() => {
        // Branding is best-effort -- fall back to defaults if it can't be fetched.
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "Invalid username or password." : "Login failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card panel" onSubmit={handleSubmit}>
        <div className="login-brand">
          {appLogoUrl && <img className="brand-logo" src={appLogoUrl} alt="" />}
          <h1>{appTitle}</h1>
        </div>
        <div className="login-field">
          <span className="field-label">Username</span>
          <input
            type="text"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="login-field">
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" disabled={submitting || !username.trim() || !password} style={{ width: "100%" }}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
