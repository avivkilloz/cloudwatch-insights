/**
 * A username box that suggests usernames as you type (`/api/users/suggest`):
 * the session card's invite field, and a built thing's (D161). Debounced --
 * one request per pause in typing, not one per keystroke -- and filtered
 * against who's already in (`exclude`): suggesting someone already a member
 * would only 409 on invite.
 */

import { useEffect, useRef, useState } from "react";
import { api, UserSuggestion } from "../api";

export default function UsernameField({
  value,
  onChange,
  exclude,
  label,
  className = "session-card-input",
}: {
  value: string;
  onChange: (value: string) => void;
  /** User ids not to suggest. */
  exclude: number[];
  label: string;
  className?: string;
}) {
  const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  // Picking a suggestion sets the value to that exact username, which would
  // otherwise re-trigger the fetch below and reopen the dropdown with the one
  // match that name now finds -- this skips exactly that one re-run, so the
  // dropdown only comes back once the user actually types more.
  const suppressNext = useRef(false);
  const excluded = exclude.join(",");

  useEffect(() => {
    if (suppressNext.current) {
      suppressNext.current = false;
      return;
    }
    const prefix = value.trim();
    if (!prefix) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const skip = new Set(excluded ? excluded.split(",").map(Number) : []);
      api
        .suggestUsers(prefix)
        .then((matches) => {
          if (cancelled) return;
          setSuggestions(matches.filter((u) => !skip.has(u.id)));
          setOpen(true);
          setHighlighted(-1);
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, excluded]);

  function pick(user: UserSuggestion) {
    suppressNext.current = true;
    onChange(user.username);
    setSuggestions([]);
    setOpen(false);
    setHighlighted(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && highlighted >= 0) {
      e.preventDefault();
      pick(suggestions[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setHighlighted(-1);
    }
  }

  return (
    <div className="session-member-invite-field">
      <input
        type="text"
        className={className}
        placeholder="Username"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div className="username-suggestions" role="listbox">
          {suggestions.map((u, i) => (
            <button
              key={u.id}
              type="button"
              role="option"
              aria-selected={i === highlighted}
              className={"username-suggestion" + (i === highlighted ? " active" : "")}
              onMouseDown={(e) => {
                // Picks the suggestion before the input's onBlur can close
                // the dropdown out from under this click.
                e.preventDefault();
                pick(u);
              }}
            >
              {u.username}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
