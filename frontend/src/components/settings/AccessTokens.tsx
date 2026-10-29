/**
 * Personal access tokens (D156), in My account: how Claude Code -- or any MCP
 * client someone runs -- uses the platform's tools as them, at /api/mcp.
 *
 * A token is shown once, as it's made, with the lines that set Claude Code up
 * with it; afterwards only its name and first characters are. The tools are
 * the agent's, so a group without the agent can't make one (the server says
 * so too). An admin also sees everyone's, to revoke one that leaked.
 */

import { useCallback, useEffect, useState } from "react";
import { AccessToken, AccessTokenMade, api, readableError } from "../../api";

const LIFETIMES: [number, string][] = [
  [30, "30 days"],
  [90, "90 days"],
  [180, "180 days"],
  [365, "1 year"],
];

function day(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso.endsWith("Z") ? iso : `${iso}Z`).toLocaleDateString();
}

function state(t: AccessToken): "revoked" | "expired" | "active" {
  if (t.revoked_at) return "revoked";
  if (t.expires_at && new Date(t.expires_at.endsWith("Z") ? t.expires_at : `${t.expires_at}Z`) < new Date()) return "expired";
  return "active";
}

/** The address Claude Code calls: this app's own, then /api/mcp -- where
 * the frontend's proxy and the ingress already pass /api on. */
export function mcpUrl(): string {
  return `${window.location.origin}/api/mcp`;
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          // A browser without clipboard access: the text is there to select.
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function Setup({ made }: { made: AccessTokenMade }) {
  const add = `claude mcp add --transport http platform ${mcpUrl()} --header "Authorization: Bearer ${made.token}"`;
  const json = JSON.stringify(
    { mcpServers: { platform: { type: "http", url: mcpUrl(), headers: { Authorization: "Bearer ${PLATFORM_TOKEN}" } } } },
    null,
    2,
  );
  return (
    <div className="access-token-made" data-token-made={made.id}>
      <p>
        <strong>{made.name}</strong> — copy it now: it isn't shown again. Keep it like a password; anyone holding it
        acts as you.
      </p>
      <div className="access-token-line">
        <input type="text" className="access-token-value" readOnly value={made.token} onFocus={(e) => e.currentTarget.select()} />
        <Copy text={made.token} />
      </div>
      <span className="field-label">Add it to Claude Code</span>
      <div className="access-token-line">
        <pre className="access-token-command">{add}</pre>
        <Copy text={add} />
      </div>
      <span className="field-label">
        Or, for a project, in its <code>.mcp.json</code> — the token then comes from <code>PLATFORM_TOKEN</code>, never
        the repo
      </span>
      <div className="access-token-line">
        <pre className="access-token-command">{json}</pre>
        <Copy text={json} />
      </div>
      <p className="muted">
        Then ask Claude to read the platform's guide (the <code>read_guide</code> tool, or <code>@platform:platform://guide</code>),
        or start with <code>/platform:build_pane</code>. What it builds lands in your Builder as a draft for you to review
        and save.
      </p>
    </div>
  );
}

function TokenTable({ tokens, revoke, everyone }: { tokens: AccessToken[]; revoke: (t: AccessToken) => void; everyone?: boolean }) {
  return (
    <table className="credentials-table access-tokens-table">
      <thead>
        <tr>
          {everyone && <th>User</th>}
          <th>Name</th>
          <th>Token</th>
          <th>Created</th>
          <th>Expires</th>
          <th>Last used</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {tokens.map((t) => {
          const now = state(t);
          return (
            <tr key={t.id} data-access-token={t.id} className={now !== "active" ? "muted" : undefined}>
              {everyone && <td>{t.username}</td>}
              <td className="credential-name">{t.name}</td>
              <td>
                <code>{t.prefix}…</code>
              </td>
              <td>{day(t.created_at)}</td>
              <td>{day(t.expires_at) || "Never"}</td>
              <td>{day(t.last_used_at) || "Never"}</td>
              <td>
                {now === "active" ? (
                  <button className="danger" onClick={() => revoke(t)}>
                    Revoke
                  </button>
                ) : (
                  <span className="tag">{now === "revoked" ? "Revoked" : "Expired"}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function AccessTokens({ allowed, isAdmin }: { allowed: boolean; isAdmin: boolean }) {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null);
  const [everyone, setEveryone] = useState<AccessToken[] | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [made, setMade] = useState<AccessTokenMade | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await api.listAccessTokens());
      if (isAdmin) setEveryone(await api.listAllAccessTokens());
    } catch (e) {
      setError(readableError(e));
    }
  }, [isAdmin]);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMade(await api.createAccessToken(name.trim(), days));
      setName("");
      await load();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: AccessToken) {
    if (!confirm(`Revoke ${t.name}${t.username ? ` (${t.username}'s)` : ""}? Whatever uses it stops working at once.`)) return;
    setError(null);
    try {
      await api.revokeAccessToken(t.id);
      if (made?.id === t.id) setMade(null);
      await load();
    } catch (err) {
      setError(readableError(err));
    }
  }

  return (
    <>
      <div className="panel access-tokens">
        <h2>Access tokens</h2>
        <p className="muted" style={{ maxWidth: "80ch" }}>
          A token lets Claude Code, or another MCP client you run, use the platform's tools as you: your sessions and
          panes, your group's environments, workflows, and building panes in your Builder drafts. It reaches what you can,
          nothing more, and stops working when it's revoked or expires.
        </p>
        {!allowed ? (
          <p className="muted">The tools are the agent's, and the agent isn't turned on for your group — ask an admin.</p>
        ) : (
          <form className="row access-token-form" onSubmit={create}>
            <div>
              <span className="field-label">Name</span>
              <input
                type="text"
                className="access-token-name"
                value={name}
                placeholder="Claude Code on my laptop"
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                style={{ width: 260 }}
              />
            </div>
            <div>
              <span className="field-label">Expires after</span>
              <select className="access-token-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {LIFETIMES.map(([n, label]) => (
                  <option key={n} value={n}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={busy || !name.trim()}>
              Create token
            </button>
          </form>
        )}
        {error && <p className="error-text">{error}</p>}
        {made && <Setup made={made} />}
        {tokens !== null && tokens.length > 0 && <TokenTable tokens={tokens} revoke={revoke} />}
      </div>
      {isAdmin && everyone !== null && (
        <div className="panel access-tokens-everyone">
          <h2>Everyone's access tokens</h2>
          <p className="muted">Names and first characters only — never the tokens. Revoke one that leaked.</p>
          {everyone.length === 0 ? <p className="muted">None made yet.</p> : <TokenTable tokens={everyone} revoke={revoke} everyone />}
        </div>
      )}
    </>
  );
}
