import { useEffect, useState } from "react";
import { api, LogsBackend, SavedQuery, SavedSession } from "../api";
import SavedItemsHub from "../components/SavedItemsHub";

export default function SavedItemsPage() {
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.listSavedQueries(), api.listSavedSessions()])
      .then(([queries, sessions]) => {
        setSavedQueries(queries);
        setSavedSessions(sessions);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function createSavedQuery(payload: { name: string; query_string: string; backend?: string }) {
    const saved = await api.createSavedQuery({ ...payload, backend: payload.backend as LogsBackend | undefined });
    setSavedQueries((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function updateSavedQueryItem(id: number, payload: { name: string; query_string: string; backend?: string }) {
    const updated = await api.updateSavedQuery(id, { ...payload, backend: payload.backend as LogsBackend | undefined });
    setSavedQueries((prev) => prev.map((q) => (q.id === id ? updated : q)));
  }

  async function deleteSavedQueryItem(id: number) {
    await api.deleteSavedQuery(id);
    setSavedQueries((prev) => prev.filter((q) => q.id !== id));
  }

  async function createSavedSessionItem(page: string, name: string, state: Record<string, unknown>) {
    const saved = await api.createSavedSession({ page, name, state });
    setSavedSessions((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

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
      savedQueries={savedQueries}
      onCreateSavedQuery={createSavedQuery}
      onUpdateSavedQuery={updateSavedQueryItem}
      onDeleteSavedQuery={deleteSavedQueryItem}
      savedSessions={savedSessions}
      onCreateSession={createSavedSessionItem}
      onUpdateSession={updateSavedSessionItem}
      onDeleteSession={deleteSavedSessionItem}
    />
  );
}
