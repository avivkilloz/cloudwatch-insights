import { useRef } from "react";

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

export default function RestoredResultsNote({ ranAt, onRerun }: { ranAt: number | null; onRerun?: () => void }) {
  // Whatever ranAt was on the first render. While it still holds that value,
  // nothing has been re-run in this page load, so what's on screen is restored.
  const mountedWith = useRef(ranAt).current;
  const restored = mountedWith !== null && ranAt === mountedWith;
  if (!restored) return null;

  return (
    <p className="muted" style={{ marginTop: 0 }}>
      Showing results fetched <strong>{formatAge(mountedWith)}</strong> and restored with this session — they may be
      out of date.
      {onRerun && (
        <button className="secondary" style={{ marginLeft: 8, padding: "2px 8px" }} onClick={onRerun}>
          Run again
        </button>
      )}
    </p>
  );
}
