import { PersistedSession } from "../sessions/storage";
import { useSessions } from "../sessions/SessionContext";
import { useSaveAsTemplate } from "../sessions/templates";

/**
 * What the ⋮ beside a session offers, wherever it is opened from.
 *
 * The panel's rows and the strip's current tab show the same three, because
 * they are the same three things you do to a session: name it, keep a template
 * of it, throw it away. Closing is not here -- that is the ✕ on the tab, and it
 * is about the strip rather than about the session.
 *
 * `onRename` is the caller's, because renaming happens in place and only the
 * surface the menu was opened from knows which row or tab to turn into a field.
 */
export default function SessionMenuItems({
  session,
  onRename,
  close,
}: {
  session: PersistedSession;
  onRename: () => void;
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
