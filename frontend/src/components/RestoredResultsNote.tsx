/**
 * Says so when the rows on screen came back with the session rather than from
 * a search just run.
 *
 * Restoring results is the point of persisting a session, but AWS data goes
 * stale: a log search from yesterday, shown with no marker, reads exactly like
 * one from a minute ago. The one thing this must never do is let that pass
 * silently.
 */

function formatAge(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return "less than a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// When this page loaded. Results that ran before it came back with the
// session; anything run since -- here, in another tab, by the agent or a
// refresh -- is current. This used to be "whatever ranAt was on the first
// render", which held while results lived in the session's state; they are the
// server's own record now (D21) and reach a pane after the session's local
// copy has mounted it, so the first render had none and the note never showed.
// ranAt is stamped by the server; a clock behind the browser's by more than
// the time since loading would call a fresh run restored, which is the safe
// way to be wrong.
const LOADED_AT = Date.now();

export default function RestoredResultsNote({ ranAt, onRerun }: { ranAt: number | null; onRerun?: () => void }) {
  if (ranAt === null || ranAt >= LOADED_AT) return null;

  return (
    <p className="muted" style={{ marginTop: 0 }}>
      Showing results fetched <strong>{formatAge(ranAt)}</strong> and restored with this session — they may be
      out of date.
      {onRerun && (
        <button className="secondary" style={{ marginLeft: 8, padding: "2px 8px" }} onClick={onRerun}>
          Run again
        </button>
      )}
    </p>
  );
}
