import { SessionCategory } from "../api";
import { PersistedSession } from "../sessions/storage";
import { useSessions } from "../sessions/SessionContext";
import { useSaveAsTemplate } from "../sessions/templates";

/**
 * What the ⋮ beside a session offers, wherever it is opened from.
 *
 * The panel's rows and the strip's current tab show the same set, because
 * they are the same things you do to a session: name it, group it, keep a
 * template of it, throw it away. Closing is not here -- that is the ✕ on the
 * tab, and it is about the strip rather than about the session.
 *
 * `onRename` is the caller's, because renaming happens in place and only the
 * surface the menu was opened from knows which row or tab to turn into a field.
 * `categories` and `onMoveToCategory` are omitted by callers that have no
 * concept of categories (the strip's tab), which just leaves that item out
 * rather than the menu offering something it can't do.
 */
export default function SessionMenuItems({
  session,
  categories,
  onRename,
  onMoveToCategory,
  close,
}: {
  session: PersistedSession;
  categories?: SessionCategory[];
  onRename: () => void;
  onMoveToCategory?: (categoryId: number | null) => void;
  close: () => void;
}) {
  const { remove } = useSessions();
  const saveAsTemplate = useSaveAsTemplate();

  return (
    <>
      <button
        onClick={() => {
          close();
          onRename();
        }}
        title="Rename it here, in place"
      >
        Rename
      </button>
      {categories && categories.length > 0 && onMoveToCategory && (
        <>
          {/* A thin rule would need its own CSS; a heading row does the same
              job of separating "what this session is" from "where it sits"
              with what the menu already has. */}
          <div className="rail-heading" style={{ padding: "4px 8px 2px" }}>
            Move to
          </div>
          {session.categoryId != null && (
            <button
              onClick={() => {
                close();
                onMoveToCategory(null);
              }}
            >
              No category
            </button>
          )}
          {categories
            .filter((c) => c.id !== session.categoryId)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  close();
                  onMoveToCategory(c.id);
                }}
              >
                {c.name}
              </button>
            ))}
        </>
      )}
      {/* Always offered: every session is an Aggregator, so there is one kind
          of thing to save and one key it is saved under. It used to depend on
          the session's type having a page to save against. */}
      <button
        onClick={() => {
          close();
          saveAsTemplate(session.id);
        }}
      >
        Save as template…
      </button>
      {/* The only one here that loses work, so it says so and asks first. */}
      <button
        className="rail-row-menu-danger"
        onClick={() => {
          close();
          if (window.confirm(`Delete "${session.title}"? This can't be undone.`)) remove(session.id);
        }}
        title="Throw the session away for good"
      >
        Delete
      </button>
    </>
  );
}
