import { useEffect, useRef, useState } from "react";
import { User } from "../api";
import Avatar from "./Avatar";

interface Props {
  user: User;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export default function UserMenu({ user, onOpenSettings, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="icon-popover-wrap" ref={ref}>
      <button
        type="button"
        className="user-menu-trigger"
        title={user.username}
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar username={user.username} avatarUrl={user.avatar_url} />
      </button>
      {open && (
        <div className="icon-popover user-menu-popover">
          <div className="user-menu-header">
            <Avatar username={user.username} avatarUrl={user.avatar_url} size={36} />
            <div>
              <div className="user-menu-name">{user.username}</div>
              <div className="user-menu-group">
                {user.group_name}
                {user.is_admin && " · Admin"}
              </div>
            </div>
          </div>
          <div className="icon-popover-divider" />
          <button
            className="icon-popover-item"
            onClick={() => {
              onOpenSettings();
              setOpen(false);
            }}
          >
            Settings
          </button>
          <div className="icon-popover-divider" />
          <button
            className="icon-popover-item"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
