import { ReactNode, useRef, useState } from "react";

/**
 * A session's own card: what it is (name and description, both editable in
 * place), what it holds (the adds) and how that's laid out -- three sections,
 * ruled apart, every row a label in one column and its values in the next, so
 * the card reads as one form rather than a heap of buttons. In the side panel,
 * which is narrow, each label sits over its values instead.
 *
 * It lives either at the top of the body or in the side panel (the corner
 * button, per browser, `railSlot.ts`), and stays wherever it was put -- in the
 * side panel even while that's hidden -- until it's moved back.
 */

/** One row: its label, and whatever it holds. */
export function CardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="session-card-row">
      <span className="session-card-label">{label}</span>
      <div className="session-card-values">{children}</div>
    </div>
  );
}

/** A group of rows, ruled off from the one before it. */
export function CardSection({ children }: { children: ReactNode }) {
  return <div className="session-card-section">{children}</div>;
}

export default function SessionCard({
  title,
  description,
  inRail,
  collapsed,
  onToggleCollapsed,
  onRename,
  onDescribe,
  onMove,
  children,
}: {
  title: string;
  description: string;
  inRail: boolean;
  /** Folded down to its header (and the session's name). Only in the body:
   * in the side panel it's out of the way already. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
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

  const hasDescription = description.trim() !== "";
  const folded = collapsed && !inRail;

  return (
    <div className={`panel session-card${inRail ? " in-rail" : ""}${folded ? " collapsed" : ""}`}>
      <div className="session-card-head">
        <span className="session-card-kicker">Session</span>
        {/* Folded, the name is all that's left to say which session this is. */}
        {folded && <span className="session-card-folded-title">{title}</span>}
        <div className="session-card-actions">
          {!inRail && (
            <button
              className="session-card-fold"
              onClick={onToggleCollapsed}
              aria-expanded={!folded}
              aria-label={folded ? "Expand the session card" : "Collapse the session card"}
              title={folded ? "Expand" : "Collapse"}
            >
              {folded ? "▸" : "▾"}
            </button>
          )}
          <button
            className="session-card-move"
            onClick={onMove}
            aria-label={inRail ? "Move the session card back above the panes" : "Move the session card to the side panel"}
            title={inRail ? "Move back above the panes" : "Move to the side panel"}
          >
            {inRail ? "⇥" : "⇤"}
          </button>
        </div>
      </div>
      {folded ? null : (
        <>

          <CardSection>
            <CardRow label="Name">
              {editing === "title" ? (
                <input
                  className="session-card-input session-card-title-input"
                  autoFocus
                  defaultValue={title}
                  aria-label="Session name"
                  onKeyDown={keys("title")}
                  onBlur={blur("title")}
                />
              ) : (
                <div className="session-card-text">
                  <h2 className="session-card-title">{title}</h2>
                  <button className="session-card-edit" onClick={() => setEditing("title")} aria-label="Rename the session" title="Rename">
                    ✎
                  </button>
                </div>
              )}
            </CardRow>
            <CardRow label="Description">
              {editing === "description" ? (
                <textarea
                  className="session-card-input session-card-description-input"
                  autoFocus
                  rows={3}
                  defaultValue={description}
                  placeholder="What this session is for"
                  aria-label="Session description"
                  onKeyDown={keys("description")}
                  onBlur={blur("description")}
                />
              ) : (
                <div className="session-card-text">
                  <p className={`session-card-description${hasDescription ? "" : " muted"}`}>
                    {hasDescription ? description : "No description yet."}
                  </p>
                  <button
                    className="session-card-edit"
                    onClick={() => setEditing("description")}
                    aria-label={hasDescription ? "Edit the description" : "Add a description"}
                    title={hasDescription ? "Edit the description" : "Add a description"}
                  >
                    ✎
                  </button>
                </div>
              )}
            </CardRow>
          </CardSection>

          {children}
        </>
      )}
    </div>
  );
}
