import { useEffect, useState } from "react";
import { api, Environment, S3BucketInfo, S3FileInfo, S3FolderInfo, SavedSession } from "../api";
import ExportMenu from "../components/ExportMenu";
import { HideSelectedButtons, RowCheckbox, SelectAllCheckbox, useRowSelection } from "../components/rowSelection";

const SESSION_PAGE = "buckets";

interface BucketShortcutState {
  environment_id: number;
  bucket: string;
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatTimestamp(epochSeconds: number | null): string {
  if (epochSeconds == null) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function encodeKeyForUrl(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function breadcrumbSegments(prefix: string): { label: string; prefix: string }[] {
  const parts = prefix.split("/").filter(Boolean);
  const segments: { label: string; prefix: string }[] = [];
  let acc = "";
  for (const part of parts) {
    acc += part + "/";
    segments.push({ label: part, prefix: acc });
  }
  return segments;
}

export default function BucketsPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<number | "">("");

  const [buckets, setBuckets] = useState<S3BucketInfo[]>([]);
  const [bucketsLoading, setBucketsLoading] = useState(false);
  const [bucketsError, setBucketsError] = useState<string | null>(null);

  const [bucket, setBucket] = useState("");
  const [bucketRegion, setBucketRegion] = useState("");
  const [prefix, setPrefix] = useState("");
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");

  const [folders, setFolders] = useState<S3FolderInfo[]>([]);
  const [files, setFiles] = useState<S3FileInfo[]>([]);
  const [continuationToken, setContinuationToken] = useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  // Bumped only when a fresh browse/search replaces the listing, so that
  // "Load more" (which appends) doesn't throw away the checked files.
  const [resultsVersion, setResultsVersion] = useState(0);

  const [savedBuckets, setSavedBuckets] = useState<SavedSession<BucketShortcutState>[]>([]);

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    api.listSavedSessions<BucketShortcutState>(SESSION_PAGE).then(setSavedBuckets);
  }, []);

  async function loadBuckets() {
    if (environmentId === "") return;
    setBucketsLoading(true);
    setBucketsError(null);
    setBuckets([]);
    setBucket("");
    setFolders([]);
    setFiles([]);
    try {
      const resp = await api.listBuckets(environmentId);
      setBuckets(resp.buckets);
    } catch (e: any) {
      setBucketsError(e.message);
    } finally {
      setBucketsLoading(false);
    }
  }

  async function browse(
    nextBucket: string,
    nextPrefix: string,
    searchTerm: string,
    loadMore: boolean,
    envIdOverride?: number
  ) {
    // envIdOverride lets loading a saved bucket shortcut browse into an
    // environment other than the currently-selected one immediately,
    // without waiting on the setEnvironmentId state update to land first.
    const envId = envIdOverride ?? environmentId;
    if (envId === "") return;
    setIsBrowsing(true);
    setBrowseError(null);
    try {
      const resp = await api.browseBucket({
        environment_id: envId,
        bucket: nextBucket,
        prefix: nextPrefix,
        search: searchTerm,
        continuation_token: loadMore ? continuationToken : null,
      });
      setBucket(resp.bucket);
      setBucketRegion(resp.bucket_region);
      setPrefix(resp.prefix);
      setActiveSearch(searchTerm);
      setFolders((prev) => (loadMore ? [...prev, ...resp.folders] : resp.folders));
      setFiles((prev) => (loadMore ? [...prev, ...resp.files] : resp.files));
      setContinuationToken(resp.continuation_token);
      if (!loadMore) setResultsVersion((v) => v + 1);
    } catch (e: any) {
      setBrowseError(e.message);
    } finally {
      setIsBrowsing(false);
    }
  }

  function openBucket(name: string) {
    setSearch("");
    browse(name, "", "", false);
  }

  async function saveCurrentBucket() {
    if (environmentId === "" || !bucket) return;
    const name = prompt("Save bucket as:", bucket);
    if (!name) return;
    const saved = await api.createSavedSession<BucketShortcutState>({
      page: SESSION_PAGE,
      name,
      state: { environment_id: environmentId, bucket },
    });
    setSavedBuckets((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function loadSavedBucket(state: BucketShortcutState) {
    setEnvironmentId(state.environment_id);
    setSearch("");
    browse(state.bucket, "", "", false, state.environment_id);
  }

  function openFolder(nextPrefix: string) {
    setSearch("");
    browse(bucket, nextPrefix, "", false);
  }

  function runSearch() {
    browse(bucket, prefix, search, false);
  }

  function clearSearch() {
    setSearch("");
    browse(bucket, prefix, "", false);
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessage(`${label} copied to clipboard`);
    } catch {
      setCopiedMessage(`Could not copy automatically — ${label}: ${text}`);
    }
    setTimeout(() => setCopiedMessage(null), 2000);
  }

  // Folders are navigation targets rather than data, so only files are
  // selectable -- matching what export already covers.
  const selection = useRowSelection({
    rows: files,
    keyOf: (f) => f.key,
    toObject: (f) => ({ ...f }),
    resetOn: resultsVersion,
  });
  const displayFiles = selection.visibleRows;

  return (
    <div>
      <div className="panel">
        <h2>Saved buckets</h2>
        <p className="muted">Jump straight back to a bucket you use often, without reselecting its environment.</p>
        <div className="toolbar">
          <select
            onChange={(e) => {
              const s = savedBuckets.find((x) => String(x.id) === e.target.value);
              if (s) loadSavedBucket(s.state);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved bucket…
            </option>
            {savedBuckets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentBucket} disabled={!bucket}>
            Save current bucket
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>1. Choose environment and bucket</h2>
        <p className="muted">
          S3 buckets belong to a single account (and each bucket has its own region, resolved automatically), so
          pick one environment at a time.
        </p>
        <div className="toolbar">
          <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Choose environment…</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.account_id} · {e.region})
              </option>
            ))}
          </select>
          <button className="secondary" onClick={loadBuckets} disabled={environmentId === "" || bucketsLoading}>
            {bucketsLoading ? "Loading buckets…" : "Load buckets"}
          </button>
          {buckets.length > 0 && (
            <select value={bucket} onChange={(e) => openBucket(e.target.value)}>
              <option value="" disabled>
                Choose bucket…
              </option>
              {buckets.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {bucketsError && <p className="error-text">{bucketsError}</p>}
      </div>

      {bucket && (
        <div className="panel">
          <h2>2. Browse</h2>
          <div className="row" style={{ marginBottom: 10, gap: 4 }}>
            <button className="secondary" onClick={() => openFolder("")}>
              {bucket}
            </button>
            {breadcrumbSegments(prefix).map((seg, i) => (
              <span key={i} className="row" style={{ gap: 4 }}>
                <span className="muted">/</span>
                <button className="secondary" onClick={() => openFolder(seg.prefix)}>
                  {seg.label}
                </button>
              </span>
            ))}
          </div>

          <div className="toolbar">
            <input
              type="text"
              placeholder="Search filenames under this folder…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              style={{ width: 280 }}
            />
            <button className="secondary" onClick={runSearch} disabled={isBrowsing}>
              Search
            </button>
            {activeSearch && (
              <button className="secondary" onClick={clearSearch}>
                Clear search
              </button>
            )}
            {isBrowsing && <span className="muted">Loading…</span>}
            {copiedMessage && <span className="muted">{copiedMessage}</span>}
          </div>
          {browseError && <p className="error-text">{browseError}</p>}
          {activeSearch && (
            <p className="muted">
              Searching recursively under "{prefix || "/"}" for filenames containing "{activeSearch}".
            </p>
          )}

          {(folders.length > 0 || files.length > 0) && (
            <div className="toolbar">
              <SelectAllCheckbox selection={selection} displayed={displayFiles} />
              <span className="muted">
                {folders.length} folder(s), {displayFiles.length} file(s)
                {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
              </span>
              <HideSelectedButtons selection={selection} />
              <ExportMenu
                rows={displayFiles}
                selectedRows={selection.selectedObjects}
                filename={`bucket-${bucket}`}
              />
            </div>
          )}

          {folders.length === 0 && files.length === 0 && !isBrowsing && (
            <p className="muted">Nothing here.</p>
          )}

          {folders.map((f) => (
            <div className="result-row" key={f.prefix}>
              <div className="result-row-summary" style={{ cursor: "pointer" }} onClick={() => openFolder(f.prefix)}>
                <span className="tag">folder</span>
                <span className="msg">{f.name}/</span>
              </div>
            </div>
          ))}

          {displayFiles.map((f) => {
            const uri = `s3://${bucket}/${f.key}`;
            const url = `https://${bucket}.s3.${bucketRegion}.amazonaws.com/${encodeKeyForUrl(f.key)}`;
            return (
              <div className="result-row" key={f.key}>
                <div className="result-row-summary" style={{ cursor: "default" }}>
                  <RowCheckbox selection={selection} row={f} />
                  <span className="tag">{formatSize(f.size)}</span>
                  <span className="msg">{activeSearch ? f.key : f.name}</span>
                  <span className="muted">{formatTimestamp(f.last_modified)}</span>
                  <button className="secondary" style={{ padding: "2px 8px" }} onClick={() => copy(uri, "S3 URI")}>
                    Copy S3 URI
                  </button>
                  <button className="secondary" style={{ padding: "2px 8px" }} onClick={() => copy(url, "Object URL")}>
                    Copy object URL
                  </button>
                </div>
              </div>
            );
          })}

          {continuationToken && (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button
                className="secondary"
                onClick={() => browse(bucket, prefix, activeSearch, true)}
                disabled={isBrowsing}
              >
                {isBrowsing ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
