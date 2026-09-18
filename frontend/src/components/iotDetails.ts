import { useEffect, useRef, useState } from "react";

// Both IoT result lists show a summary per row and fetch the full detail
// (shadows/certificates/jobs for a thing, attached things for a certificate)
// lazily, one call per row, when you expand it. The same cache backs the
// "include details" option, so a row you already expanded costs nothing to
// include, and a row fetched for an export is already there when you expand it.

export type DetailState<D> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: D };

// Detail is one AWS round trip per row, so a big selection is a burst of
// requests. Enough in flight to stay quick, few enough not to hammer the
// backend (or AWS's per-account API limits) when someone checks a hundred rows.
const CONCURRENCY = 5;

async function forEachWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(workers);
}

export interface DetailCache<TRow, TDetail> {
  detailFor: (row: TRow) => TDetail | undefined;
  stateFor: (row: TRow) => DetailState<TDetail> | undefined;
  /** Fetch one row's detail, for expanding it. Safe to call repeatedly. */
  loadOne: (row: TRow) => Promise<void>;
  /** Fetch detail for many rows at once, bounded, skipping any already fetched. */
  loadMany: (rows: TRow[]) => Promise<void>;
  /** Whether exports and the AI assistant should carry each row's detail. */
  includeDetails: boolean;
  setIncludeDetails: (value: boolean) => void;
  /** Requests still in flight, for a progress hint. */
  loadingCount: number;
  /** Rows whose detail fetch failed -- they fall back to their summary alone. */
  errorCount: number;
  /** Changes identity whenever the cache gains an entry. */
  details: Record<string, DetailState<TDetail>>;
}

export function useDetailCache<TRow, TDetail>(options: {
  keyOf: (row: TRow) => string;
  fetchDetail: (row: TRow) => Promise<TDetail>;
  /** A new result set invalidates every cached detail. */
  resetOn: unknown;
}): DetailCache<TRow, TDetail> {
  const { keyOf, fetchDetail, resetOn } = options;
  const [details, setDetails] = useState<Record<string, DetailState<TDetail>>>({});
  const [loadingCount, setLoadingCount] = useState(0);
  const [includeDetails, setIncludeDetails] = useState(false);
  // Which keys have been asked for, tracked outside React state so two callers
  // racing for the same row (expanding one an export is already fetching)
  // can't both fire a request.
  const requested = useRef(new Set<string>());

  useEffect(() => {
    requested.current = new Set();
    setDetails({});
    setLoadingCount(0);
  }, [resetOn]);

  async function loadOne(row: TRow) {
    const key = keyOf(row);
    if (requested.current.has(key)) return;
    requested.current.add(key);
    setDetails((prev) => ({ ...prev, [key]: { status: "loading" } }));
    setLoadingCount((n) => n + 1);
    try {
      const detail = await fetchDetail(row);
      setDetails((prev) => ({ ...prev, [key]: { status: "ready", detail } }));
    } catch (e: any) {
      setDetails((prev) => ({ ...prev, [key]: { status: "error", message: e.message } }));
    } finally {
      setLoadingCount((n) => n - 1);
    }
  }

  return {
    details,
    includeDetails,
    setIncludeDetails,
    loadingCount,
    errorCount: Object.values(details).filter((s) => s.status === "error").length,
    stateFor: (row) => details[keyOf(row)],
    detailFor: (row) => {
      const state = details[keyOf(row)];
      return state?.status === "ready" ? state.detail : undefined;
    },
    loadOne,
    loadMany: (rows) =>
      forEachWithLimit(
        rows.filter((r) => !requested.current.has(keyOf(r))),
        CONCURRENCY,
        loadOne
      ),
  };
}
