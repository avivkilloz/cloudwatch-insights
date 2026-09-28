import { useEffect, useRef, useState } from "react";
import { User } from "../api";
import Avatar from "./Avatar";

interface Props {
  user: User;
  onOpenSettings: () => void;
  onLogout: () => void;
  /** "card": the avatar with the name beside it, at the foot of the side
   * panel, its menu opening upwards. "avatar": just the picture, for the
   * strip while the side panel is hidden. */
  variant?: "card" | "avatar";
}

export default function UserMenu({ user, onOpenSettings, onLogout, variant = "avatar" }: Props) {
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
    <div className={`icon-popover-wrap${variant === "card" ? " user-menu-card-wrap" : ""}`} ref={ref}>
      {variant === "card" ? (
        <button
          type="button"
          className="user-menu-card"
          aria-label="Account menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Avatar username={user.username} avatarUrl={user.avatar_url} size={30} />
          <span className="user-menu-card-text">
            <span className="user-menu-card-name">{user.username}</span>
            <span className="user-menu-card-group">{user.group_name}</span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          className="user-menu-trigger"
          title={user.username}
          aria-label="Account menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Avatar username={user.username} avatarUrl={user.avatar_url} size={24} />
        </button>
      )}
      {open && (
        <div className={`icon-popover user-menu-popover${variant === "card" ? " opens-up" : ""}`}>
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
