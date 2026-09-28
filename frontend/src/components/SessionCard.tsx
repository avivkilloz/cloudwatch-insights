import { ReactNode, useRef, useState } from "react";

/**
 * A session's own card: its name and description, both editable in place, and
 * (as children) what it holds and how that's laid out -- the adds and the
 * layout picker. It replaced two cards that each said half of this: the Panes
 * card at the top of the body, and a title-and-description card under the
 * side panel.
 *
 * It lives either at the top of the body or in the side panel (⇤ / ⇥, per
 * browser, `railSlot.ts`), and stays wherever it was put -- in the side panel
 * even while that's hidden -- until it's moved back.
 */
export default function SessionCard({
  title,
  description,
  inRail,
  onRename,
  onDescribe,
  onMove,
  children,
}: {
  title: string;
  description: string;
  inRail: boolean;
  onRename: (title: string) => void;
  onDescribe: (description: string) => void;
  onMove: () => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState<"title" | "description" | null>(null);
  // Escape and Enter both unmount the field, and the blur that fires as it goes
  // must neither save what Escape threw away nor save twice.
  const skipBlur = useRef(false);

  function finish(field: "title" | "description", value: string) {
    skipBlur.current = true;
    setEditing(null);
    const next = value.trim();
    if (field === "title") {
      if (next && next !== title) onRename(next);
    } else if (next !== description.trim()) {
      onDescribe(next);
    }
  }

  function keys(field: "title" | "description") {
    return (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // Enter saves; in the description Shift+Enter is a new line.
      if (e.key === "Enter" && !(field === "description" && e.shiftKey)) {
        e.preventDefault();
        finish(field, e.currentTarget.value);
      }
      if (e.key === "Escape") {
        skipBlur.current = true;
        setEditing(null);
      }
    };
  }

  function blur(field: "title" | "description") {
    return (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (skipBlur.current) {
        skipBlur.current = false;
        return;
      }
      finish(field, e.currentTarget.value);
    };
  }

  return (
    <div className={`panel session-card${inRail ? " in-rail" : ""}`}>
      <div className="session-card-head">
        <span className="session-card-kicker">Session</span>
        <button
          className="session-card-move"
          onClick={onMove}
          aria-label={inRail ? "Move the session card back above the panes" : "Move the session card to the side panel"}
          title={inRail ? "Move back above the panes" : "Move to the side panel"}
        >
          {inRail ? "⇥" : "⇤"}
        </button>
      </div>

      {editing === "title" ? (
        <input
          className="session-card-title-input"
          autoFocus
          defaultValue={title}
          aria-label="Session name"
          onKeyDown={keys("title")}
          onBlur={blur("title")}
        />
      ) : (
        <div className="session-card-line">
          <h2 className="session-card-title">{title}</h2>
          <button className="session-card-edit" onClick={() => setEditing("title")} aria-label="Rename the session" title="Rename">
            ✎
          </button>
        </div>
      )}

      {editing === "description" ? (
        <textarea
          className="session-card-description-input"
          autoFocus
          rows={3}
          defaultValue={description}
          placeholder="What this session is for"
          aria-label="Session description"
          onKeyDown={keys("description")}
          onBlur={blur("description")}
        />
      ) : (
        <div className="session-card-line">
          {description.trim() ? (
            <p className="session-card-description">{description}</p>
          ) : (
            <p className="session-card-description muted">No description yet.</p>
          )}
          <button
            className="session-card-edit"
            onClick={() => setEditing("description")}
            aria-label={description.trim() ? "Edit the description" : "Add a description"}
            title={description.trim() ? "Edit the description" : "Add a description"}
          >
            ✎
          </button>
        </div>
      )}

      {children}
    </div>
  );
}
