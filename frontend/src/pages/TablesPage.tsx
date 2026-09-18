import { useEffect, useState } from "react";
import { api, DynamoTableInfo, Environment, SavedSession } from "../api";
import AiAssistantWidget from "../components/AiAssistantWidget";
import ExportMenu from "../components/ExportMenu";
import { HideSelectedButtons, RowCheckbox, SelectAllCheckbox, useRowSelection } from "../components/rowSelection";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const SESSION_PAGE = "tables";

interface TableShortcutState {
  environment_id: number;
  table_name: string;
}

export default function TablesPage() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<number | "">("");

  const [tables, setTables] = useState<string[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState<string | null>(null);

  const [tableName, setTableName] = useState("");
  const [tableInfo, setTableInfo] = useState<DynamoTableInfo | null>(null);

  const [queryString, setQueryString] = useState("");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);

  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [lastEvaluatedKey, setLastEvaluatedKey] = useState<string | null>(null);
  const [scannedCount, setScannedCount] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // Bumped only when a fresh scan replaces the items, so that "Load more"
  // (which appends) doesn't throw away the rows the user has checked.
  const [resultsVersion, setResultsVersion] = useState(0);
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([]);

  const [savedTables, setSavedTables] = useState<SavedSession<TableShortcutState>[]>([]);

  useEffect(() => {
    api.listEnvironments().then(setEnvironments);
    api.listSavedSessions<TableShortcutState>(SESSION_PAGE).then(setSavedTables);
  }, []);

  async function loadTables() {
    if (environmentId === "") return;
    setTablesLoading(true);
    setTablesError(null);
    setTables([]);
    setTableName("");
    setTableInfo(null);
    try {
      const resp = await api.listTables(environmentId);
      setTables(resp.tables);
    } catch (e: any) {
      setTablesError(e.message);
    } finally {
      setTablesLoading(false);
    }
  }

  async function selectTable(name: string, envIdOverride?: number) {
    // envIdOverride lets loading a saved table shortcut describe the table
    // in an environment other than the currently-selected one immediately,
    // without waiting on the setEnvironmentId state update to land first.
    const envId = envIdOverride ?? environmentId;
    setTableName(name);
    setTableInfo(null);
    setItems([]);
    setLastEvaluatedKey(null);
    setScanError(null);
    setResultsVersion((v) => v + 1);
    if (envId === "" || !name) return;
    try {
      const info = await api.describeTable({ environment_id: envId, table_name: name });
      setTableInfo(info);
    } catch (e: any) {
      setTablesError(e.message);
    }
  }

  async function saveCurrentTable() {
    if (environmentId === "" || !tableName) return;
    const name = prompt("Save table as:", tableName);
    if (!name) return;
    const saved = await api.createSavedSession<TableShortcutState>({
      page: SESSION_PAGE,
      name,
      state: { environment_id: environmentId, table_name: tableName },
    });
    setSavedTables((prev) => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function loadSavedTable(state: TableShortcutState) {
    setEnvironmentId(state.environment_id);
    selectTable(state.table_name, state.environment_id);
  }

  async function runScan(loadMore: boolean) {
    if (environmentId === "" || !tableName) return;
    setScanError(null);
    setIsScanning(true);
    try {
      const resp = await api.scanTable({
        environment_id: environmentId,
        table_name: tableName,
        query_string: queryString,
        limit,
        exclusive_start_key: loadMore ? lastEvaluatedKey : null,
      });
      setItems((prev) => (loadMore ? [...prev, ...resp.items] : resp.items));
      setLastEvaluatedKey(resp.last_evaluated_key);
      setScannedCount((prev) => (loadMore ? prev + resp.scanned_count : resp.scanned_count));
      if (!loadMore) {
        setExpanded(new Set());
        setResultsVersion((v) => v + 1);
      }
    } catch (e: any) {
      setScanError(e.message);
    } finally {
      setIsScanning(false);
    }
  }

  function toggleExpanded(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function itemSummary(item: Record<string, unknown>): string {
    const parts: string[] = [];
    if (tableInfo?.partition_key && item[tableInfo.partition_key] !== undefined) {
      parts.push(String(item[tableInfo.partition_key]));
    }
    if (tableInfo?.sort_key && item[tableInfo.sort_key] !== undefined) {
      parts.push(String(item[tableInfo.sort_key]));
    }
    if (parts.length > 0) return parts.join(" / ");
    const firstKey = Object.keys(item)[0];
    return firstKey ? `${firstKey}: ${String(item[firstKey])}` : "(empty item)";
  }

  // A scanned DynamoDB item has no field guaranteed to be unique, so rows are
  // identified by their position in the scan -- which is stable because
  // "Load more" only ever appends.
  const rows = items.map((item, index) => ({ key: String(index), index, item }));
  const selection = useRowSelection({
    rows,
    keyOf: (r) => r.key,
    toObject: (r) => r.item,
    onSelectionChange: setSelectedRows,
    resetOn: resultsVersion,
  });
  const displayRows = selection.visibleRows;

  return (
    <div>
      <div className="panel">
        <h2>Saved tables</h2>
        <p className="muted">Jump straight back to a table you use often, without reselecting its environment.</p>
        <div className="toolbar">
          <select
            onChange={(e) => {
              const s = savedTables.find((x) => String(x.id) === e.target.value);
              if (s) loadSavedTable(s.state);
              e.target.value = "";
            }}
            defaultValue=""
          >
            <option value="" disabled>
              Load saved table…
            </option>
            {savedTables.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveCurrentTable} disabled={!tableName}>
            Save current table
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>1. Choose environment and table</h2>
        <p className="muted">
          DynamoDB tables belong to a single account/region, so pick one environment (unlike Logs/IoT, this page
          doesn't fan out across several at once).
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
          <button className="secondary" onClick={loadTables} disabled={environmentId === "" || tablesLoading}>
            {tablesLoading ? "Loading tables…" : "Load tables"}
          </button>
          {tables.length > 0 && (
            <select value={tableName} onChange={(e) => selectTable(e.target.value)}>
              <option value="" disabled>
                Choose table…
              </option>
              {tables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </div>
        {tablesError && <p className="error-text">{tablesError}</p>}
        {tableInfo && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="tag">status: {tableInfo.status ?? "unknown"}</span>
            <span className="tag">~{tableInfo.item_count ?? "?"} items</span>
            <span className="tag">partition key: {tableInfo.partition_key ?? "—"}</span>
            {tableInfo.sort_key && <span className="tag">sort key: {tableInfo.sort_key}</span>}
          </div>
        )}
      </div>

      {tableName && (
        <div className="panel">
          <h2>2. Search items</h2>
          <p className="muted">
            Filter with <code>field:value</code> tokens (exact match, ANDed), e.g. <code>status:ACTIVE region:us</code>
            . This scans the table and filters server-side — leave blank to browse it unfiltered.
          </p>
          <div className="toolbar">
            <input
              type="text"
              value={queryString}
              onChange={(e) => setQueryString(e.target.value)}
              placeholder="field:value field2:value2"
              style={{ width: 320 }}
            />
            <label className="row" style={{ gap: 6 }}>
              <span className="muted">Page size</span>
              <input
                type="number"
                min={1}
                max={MAX_LIMIT}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                style={{ width: 80 }}
              />
            </label>
            <button onClick={() => runScan(false)} disabled={isScanning}>
              {isScanning ? "Scanning…" : "Scan"}
            </button>
            {scanError && <span className="error-text">{scanError}</span>}
          </div>

          <div className="toolbar">
            <SelectAllCheckbox selection={selection} displayed={displayRows} />
            <span className="muted">
              {displayRows.length} item(s) loaded, {scannedCount} scanned so far
              {selection.hiddenCount > 0 && ` (${selection.hiddenCount} hidden)`}
            </span>
            <HideSelectedButtons selection={selection} />
            <ExportMenu
              rows={displayRows.map((r) => r.item)}
              selectedRows={selection.selectedObjects}
              filename={`table-${tableName}`}
            />
          </div>

          {items.length === 0 && !isScanning && <p className="muted">No items loaded yet — click Scan.</p>}
          {displayRows.map((row) => {
            const isOpen = expanded.has(row.index);
            return (
              <div className="result-row" key={row.key}>
                <div className="result-row-summary" onClick={() => toggleExpanded(row.index)}>
                  <RowCheckbox selection={selection} row={row} />
                  <span className={`chevron ${isOpen ? "open" : ""}`}>▶</span>
                  <span className="msg">{itemSummary(row.item)}</span>
                </div>
                {isOpen && (
                  <div className="result-row-detail">
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {JSON.stringify(row.item, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}

          {lastEvaluatedKey && (
            <div className="toolbar" style={{ marginTop: 10 }}>
              <button className="secondary" onClick={() => runScan(true)} disabled={isScanning}>
                {isScanning ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

      <AiAssistantWidget
        domain="tables"
        queryString={queryString}
        onUseQuery={setQueryString}
        sampleRows={items}
        rowCount={items.length}
        selectedRows={selectedRows}
        resultsVersion={resultsVersion}
      />
    </div>
  );
}
