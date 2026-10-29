/**
 * Who works on something built (D161): its owner and the members they added,
 * in each Builder editor -- a pane type's, a step type's, a workflow's, a
 * credential or connection type's -- as a session's card shows its members.
 * Its owner and admins add and remove members and hand it on; a member may
 * leave. Everyone listed changes it and works in its one draft, live, and
 * talks in its chat (D163).
 *
 * `target` is a saved one's id, or `draft:<id>` for one still being made;
 * none yet (a new one nobody has typed in) has nothing to share.
 */

import { useCallback, useEffect, useState } from "react";
import { api, BuildDraft, BuildMembers as Members, readableError } from "../api";
import { useAuth } from "../AuthContext";
import { BUILD_MEMBERS_EVENT, LiveEvent } from "../sessions/liveEvents";
import Avatar from "./Avatar";
import Icon from "./Icon";
import { CardRow } from "./SessionCard";
import { Section } from "./settings/settingsLayout";
import UsernameField from "./UsernameField";

/** Tells the editor's chat that who works on it changed: shared or not. */
export const MEMBERS_CHANGED = "cwi:build-members-changed";

export default function BuildMembers({ kind, target }: { kind: BuildDraft["kind"]; target: string | null }) {
  const { user } = useAuth();
  const [data, setData] = useState<Members | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState("");
  const [handOn, setHandOn] = useState("");
  const [left, setLeft] = useState(false);

  const load = useCallback(() => {
    if (!target) return;
    api.buildMembers(kind, target).then(
      (m) => {
        setData(m);
        setError(null);
      },
      // Not one of the people who change it: there's nothing to show them.
      () => setData(null),
    );
  }, [kind, target]);

  useEffect(() => {
    setData(null);
    setLeft(false);
    load();
  }, [load]);

  // Added, removed or handed on elsewhere (another tab, the owner): look again.
  useEffect(() => {
    function onEvent(e: Event) {
      const event = (e as CustomEvent<LiveEvent>).detail;
      if (event.build_kind === kind && (event.target_id === target || event.target_id === data?.target)) load();
    }
    window.addEventListener(BUILD_MEMBERS_EVENT, onEvent);
    return () => window.removeEventListener(BUILD_MEMBERS_EVENT, onEvent);
  }, [kind, target, data?.target, load]);

  async function act(fn: () => Promise<Members | { left: true }>) {
    setError(null);
    try {
      const out = await fn();
      if ("left" in out) setLeft(true);
      else setData(out);
      window.dispatchEvent(new CustomEvent(MEMBERS_CHANGED, { detail: { kind, target } }));
    } catch (e) {
      setError(readableError(e));
    }
  }

  if (!target || !data) {
    return left ? (
      <Section title="Members">
        <p className="muted">You left it: it's its owner's and members' to change now.</p>
      </Section>
    ) : null;
  }
  const key = data.target;
  const isOwner = data.owner?.id === user?.id;
  const others = [data.owner?.id, ...data.members.map((m) => m.id)].filter((id): id is number => id != null);
  const saved = !key.startsWith("draft:");

  return (
    <Section title="Members">
      <CardRow label="Owner">
        {data.owner ? (
          <span className="session-member-name build-owner">
            <Avatar username={data.owner.username} avatarUrl={data.owner.avatar_url} size={22} />
            <span className="session-member-username">{data.owner.username}</span>
            {isOwner && <span className="muted">(you)</span>}
          </span>
        ) : (
          <span className="muted">Admins: made before owners, or restored from the store.</span>
        )}
      </CardRow>
      <CardRow label="Members">
        <div className="session-members build-members">
          {data.members.map((m) => (
            <div className="session-member" key={m.id}>
              <span className="session-member-name">
                <Avatar username={m.username} avatarUrl={m.avatar_url} size={22} />
                <span className="session-member-username">{m.username}</span>
              </span>
              {(data.can_manage || m.id === user?.id) && (
                <button
                  className="session-member-remove icon-btn"
                  onClick={() => act(() => api.removeBuildMember(kind, key, m.id))}
                  aria-label={m.id === user?.id ? "Leave" : `Remove ${m.username}`}
                  title={m.id === user?.id ? "Leave: stop working on it" : `Remove ${m.username}`}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
          ))}
          {data.members.length === 0 && !data.can_manage && <span className="muted">None</span>}
          {data.can_manage && (
            <form
              className="session-member-invite"
              onSubmit={(e) => {
                e.preventDefault();
                const name = invite.trim();
                if (!name) return;
                act(async () => {
                  const out = await api.inviteBuildMember(kind, key, name);
                  setInvite("");
                  return out;
                });
              }}
            >
              <UsernameField value={invite} onChange={setInvite} exclude={others} label="Username to add" />
              <button type="submit" className="secondary" disabled={!invite.trim()}>
                Add
              </button>
            </form>
          )}
        </div>
      </CardRow>
      {data.can_manage && saved && (
        <CardRow label="Hand on">
          <form
            className="session-member-invite build-hand-on"
            onSubmit={(e) => {
              e.preventDefault();
              const name = handOn.trim();
              if (!name || !window.confirm(`Make ${name} its owner? You stay on as a member.`)) return;
              act(async () => {
                const out = await api.handBuildOn(kind, key, name);
                setHandOn("");
                return out;
              });
            }}
          >
            <UsernameField value={handOn} onChange={setHandOn} exclude={data.owner ? [data.owner.id] : []} label="New owner" />
            <button type="submit" className="secondary" disabled={!handOn.trim()}>
              Hand on
            </button>
          </form>
        </CardRow>
      )}
      {error && <p className="error-text">{error}</p>}
    </Section>
  );
}
