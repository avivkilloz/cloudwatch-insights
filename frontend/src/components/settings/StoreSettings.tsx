import { useEffect, useState } from "react";
import { api, CredentialSummary, readableError, StoreDraft, StoreItem, StoreState, StoreStatus } from "../../api";
import { CardRow } from "../SessionCard";
import { Section } from "./settingsLayout";

/*
 * Settings → Store (PLATFORM_PLAN.md §21, D70): the git repo what's built here
 * is kept in, as a plugin. Where it is -- set by Helm (shown, locked) or here
 * -- how it stands (last push, what's waiting, why), and the items it keeps,
 * a conflict among them resolved by choosing a side after comparing both.
 *
 * Never a token or key on this page: the store names its credential, and a
 * Helm store says only which kind of auth it has.
 */

const AUTH_TYPES = ["api_token", "username_password", "secret_text", "ssh_key"];

function draftOf(s: StoreStatus | null): StoreDraft {
  return {
    url: s?.url ?? "",
    branch: s?.branch ?? "main",
    path: s?.path ?? "",
    namespace: s?.namespace ?? "",
    author_domain: s?.author_domain ?? "platform.local",
    username: s?.username ?? "",
    credential_id: s?.credential_id ?? null,
    known_hosts: s?.known_hosts ?? "",
  };
}

/** The store's namespace, which a new type's id goes under (D78); null without a store. */
export function useStoreNamespace(): string | null {
  const [ns, setNs] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getStore()
      .then((s) => live && setNs(s.configured && !s.problem ? s.namespace : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return ns;
}

const BADGES: Partial<Record<StoreState, [string, string]>> = {
  pending: ["Not pushed", "Saved here; the store repo gets it as soon as it can be reached."],
  conflict: ["Conflict", "Changed in the store repo too: Settings → Store compares and resolves it."],
};

/** Beside an item's name in a list, while the store repo doesn't have it as it is here. */
export function StoreBadge({ state }: { state?: StoreState | null }) {
  const badge = state ? BADGES[state] : undefined;
  if (!badge) return null;
  return (
    <span className={`tag store-badge store-badge-${state}`} title={badge[1]}>
      {badge[0]}
    </span>
  );
}

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function StoreSettings() {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [draft, setDraft] = useState<StoreDraft>(draftOf(null));
  const [editing, setEditing] = useState(false);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comparing, setComparing] = useState<{ item: StoreItem; mine: string | null; theirs: string | null } | null>(null);

  function take(s: StoreStatus, message?: string) {
    setStatus(s);
    setDraft(draftOf(s));
    if (message) setNotice(message);
  }

  useEffect(() => {
    // An answer arriving after this effect is gone is dropped: taken late, it
    // reset a form someone had already started filling in.
    let live = true;
    api
      .getStore()
      .then((s) => {
        if (!live) return;
        take(s);
        setEditing(!s.configured);
      })
      .catch((e) => live && setError(readableError(e)));
    api
      .listCredentials<CredentialSummary>()
      .then((all) => live && setCredentials(all.filter((c) => AUTH_TYPES.includes(c.type_id))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // While anything is waiting to be pushed, the background writer is at it:
  // "Sync now" may have found it busy and answered with how things stood. Read
  // again until nothing is pending (a conflict waits for a person, not this).
  const waiting = !!status?.items.some((i) => i.state === "pending");
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .getStore()
        .then((s) => live && setStatus(s))
        .catch(() => undefined);
    }, 2000);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [waiting, status]);

  async function act(fn: () => Promise<StoreStatus | void>, message?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const s = await fn();
      take(s ?? (await api.getStore()), message);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    await act(async () => {
      const s = await api.putStore(draft);
      setEditing(false);
      return s;
    }, "Saved. What the repo holds was brought in, and what this platform had is on its way there.");
  }

  async function stop() {
    if (!window.confirm("Stop keeping definitions in this repo? Nothing in the repo is deleted.")) return;
    await act(async () => {
      await api.deleteStore();
      setEditing(true);
    }, "The store is off. Definitions stay here, and in the repo.");
  }

  async function compare(item: StoreItem) {
    setError(null);
    try {
      const sides = await api.storeSides(item.kind, item.item_id);
      setComparing({ item, mine: sides.mine, theirs: sides.theirs });
    } catch (e) {
      setError(readableError(e));
    }
  }

  async function resolve(side: "mine" | "theirs") {
    if (!comparing) return;
    const { item } = comparing;
    await act(
      () => api.resolveStoreItem(item.kind, item.item_id, side),
      side === "mine" ? `Kept this platform's ${item.label}.` : `Took the repo's ${item.label}.`,
    );
    setComparing(null);
  }

  if (!status) {
    return <div className="panel">{error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>}</div>;
  }

  const locked = status.locked;
  const ssh = credentials.find((c) => c.id === draft.credential_id)?.type_id === "ssh_key";
  const field = (key: keyof StoreDraft) => ({
    value: String(draft[key] ?? ""),
    onChange: (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value }),
  });

  return (
    <div className="panel credential-view store-settings">
      <div className="credential-list-head">
        <span className="muted">
          The git repo the types and, later, the workflows and panes made here are kept in, as a plugin, so they
          outlive this deployment. Credential values, connections, users and sessions never go there.
        </span>
      </div>
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <Section
        title="Repo"
        aside={
          status.configured && !locked && !editing ? (
            <div className="row">
              <button className="secondary" onClick={() => setEditing(true)}>
                Change
              </button>
              <button className="secondary" onClick={stop} disabled={busy}>
                Stop using
              </button>
            </div>
          ) : undefined
        }
      >
        {locked && <p className="muted store-locked">Set by the deployment (Helm): change it there.</p>}
        {editing && !locked ? (
          <>
            <CardRow label="URL">
              <input id="store-url" type="text" placeholder="https://github.com/acme/platform-store.git" {...field("url")} />
            </CardRow>
            <CardRow label="Branch">
              <input id="store-branch" type="text" {...field("branch")} />
            </CardRow>
            <CardRow label="Path">
              <input id="store-path" type="text" placeholder="The repo's root" {...field("path")} />
            </CardRow>
            <CardRow label="Namespace">
              <input id="store-namespace" type="text" placeholder="e.g. devops" {...field("namespace")} />
            </CardRow>
            <CardRow label="Credential">
              <select
                id="store-credential"
                value={draft.credential_id ?? ""}
                onChange={(e) => setDraft({ ...draft, credential_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">None (a public repo, or one the platform can reach without)</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </CardRow>
            {ssh ? (
              <CardRow label="Known hosts">
                <textarea
                  id="store-known-hosts"
                  rows={3}
                  placeholder="The host's key line(s); empty trusts the first key seen"
                  {...field("known_hosts")}
                />
              </CardRow>
            ) : (
              <CardRow label="Username">
                <input id="store-username" type="text" placeholder="x-access-token (GitHub), oauth2 (GitLab)…" {...field("username")} />
              </CardRow>
            )}
            <CardRow label="Author domain">
              <input id="store-author-domain" type="text" {...field("author_domain")} />
            </CardRow>
            <p className="muted connection-type-note">
              Each change is committed as whoever saved it, as name@{draft.author_domain || "platform.local"}. New types are
              named {draft.namespace || "namespace"}:name.
            </p>
            <div className="row credential-view-foot">
              <button onClick={save} disabled={busy || !draft.url.trim() || !draft.namespace.trim()}>
                {busy ? "Saving…" : "Save"}
              </button>
              {status.configured && (
                <button className="secondary" onClick={() => (setEditing(false), setDraft(draftOf(status)))}>
                  Cancel
                </button>
              )}
            </div>
          </>
        ) : status.configured ? (
          <>
            <CardRow label="URL">
              <code className="credential-static" data-store-url>
                {status.url}
              </code>
            </CardRow>
            <CardRow label="Branch">
              <span className="credential-static">
                {status.branch}
                {status.path ? ` · ${status.path}/` : ""}
              </span>
            </CardRow>
            <CardRow label="Namespace">
              <code className="credential-static">{status.namespace}</code>
            </CardRow>
            <CardRow label="Auth">
              <span className="credential-static">{status.credential_name ?? status.auth}</span>
            </CardRow>
          </>
        ) : null}
        {status.problem && <p className="error-text">{status.problem}</p>}
      </Section>

      {status.configured && (
        <Section
          title="Status"
          aside={
            <button className="secondary" onClick={() => act(() => api.syncStore())} disabled={busy}>
              {busy ? "Syncing…" : "Sync now"}
            </button>
          }
        >
          <CardRow label="Last pushed">
            <span className="credential-static" data-store-last-sync>
              {when(status.last_sync_at)}
            </span>
          </CardRow>
          <CardRow label="Waiting">
            <span className="credential-static" data-store-pending>
              {status.pending === 0 ? "Nothing" : `${status.pending} change${status.pending === 1 ? "" : "s"}`}
            </span>
          </CardRow>
          {status.last_error && (
            <p className="error-text" data-store-error>
              {status.last_error}
            </p>
          )}
        </Section>
      )}

      {status.configured && (
        <Section title="Kept in the repo">
          {status.items.length === 0 ? (
            <p className="muted">Nothing yet: a credential or connection type made here will be.</p>
          ) : (
            <table className="credentials-table store-items">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>File</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {status.items.map((item) => (
                  <tr key={`${item.kind}:${item.item_id}`} data-store-item={item.item_id} data-store-state={item.state}>
                    <td>
                      {item.label} <span className="muted">· {item.noun}</span>
                    </td>
                    <td>
                      <code>{item.path}</code>
                    </td>
                    <td>
                      {item.state === "synced" && <span className="muted">In the repo</span>}
                      {item.state === "pending" && <span title={item.error ?? undefined}>Not pushed{item.error ? " (retrying)" : ""}</span>}
                      {item.state === "conflict" && (
                        <button className="secondary" onClick={() => compare(item)}>
                          Conflict: compare…
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {comparing && (
        <Section title={`${comparing.item.label}: here and in the repo`}>
          <p className="muted">{comparing.item.error}</p>
          <div className="store-sides">
            <div>
              <h4>This platform</h4>
              <pre data-store-mine>{comparing.mine ?? "(deleted here)"}</pre>
            </div>
            <div>
              <h4>The repo</h4>
              <pre data-store-theirs>{comparing.theirs ?? "(deleted in the repo)"}</pre>
            </div>
          </div>
          <div className="row credential-view-foot">
            <button onClick={() => resolve("mine")} disabled={busy}>
              Keep this platform's
            </button>
            <button className="secondary" onClick={() => resolve("theirs")} disabled={busy}>
              Take the repo's
            </button>
            <button className="secondary" onClick={() => setComparing(null)}>
              Cancel
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}
