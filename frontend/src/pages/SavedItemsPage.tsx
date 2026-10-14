import { useEffect, useState } from "react";
import { api, SavedSession } from "../api";
import SavedItemsHub from "../components/SavedItemsHub";

export default function SavedItemsPage() {
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listSavedSessions()
      .then(setSavedSessions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function updateSavedSessionItem(id: number, payload: { name?: string; state?: Record<string, unknown> }) {
    const updated = await api.updateSavedSession(id, payload);
    setSavedSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }

  async function deleteSavedSessionItem(id: number) {
    await api.deleteSavedSession(id);
    setSavedSessions((prev) => prev.filter((s) => s.id !== id));
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error-text">{error}</p>;

  return (
    <SavedItemsHub
      savedSessions={savedSessions}
      onUpdateSession={updateSavedSessionItem}
      onDeleteSession={deleteSavedSessionItem}
    />
  );
}
