/**
 * The logs panes' pickers (PLATFORM_PLAN.md §16.9.3), drawn generically from
 * an input's `options` as `LogGroupSelector` and `OpenSearchIndexSelector`
 * drew them:
 *
 * - `LogGroupsPicker` (`type: log_groups`): "Load log groups" lists each
 *   chosen environment's groups (one loader call, a group per environment
 *   with its own error); a filter, a select-all per environment, and the
 *   selection, `{environment id: [names]}`.
 * - `IndicesPicker` (`type: opensearch_indices`): "Load OpenSearch domains"
 *   lists each environment's domains, and each domain's "Load indices" its
 *   indices (`options.children`, one call per domain); the selection,
 *   `{environment id: {domain: {domain_endpoint, indices: [names]}}}`.
 *
 * What was loaded is this tab's (D47): the selection is the session's, and
 * after a reload it shows by its count until the lists are loaded again. A
 * selection a session saved before the port holds Sets; it reads the same.
 */

import { useState } from "react";
import { readableError } from "../api";
import { ManifestInput } from "./manifest";
import { actionById, PaneApi, Values } from "./paneApi";
import { text } from "./template";

interface Group {
  environment_id: number;
  environment_name: string;
  account_id: string;
  region: string;
  items?: unknown[];
  error: string | null;
}

interface Domain {
  domain_name: string;
  endpoint: string | null;
  engine_version: string | null;
}

interface IndexOption {
  value: string;
  label: string;
  docs_count?: number | null;
}

function names(value: unknown): string[] {
  if (value instanceof Set) return [...value].map(String);
  return Array.isArray(value) ? value.map(String) : [];
}

function chosenConnections(pane: PaneApi): number[] {
  const value = pane.inputs.connections;
  if (value instanceof Set) return [...value] as number[];
  return Array.isArray(value) ? (value as number[]) : [];
}

function useLoader(pane: PaneApi, input: ManifestInput) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    const action = actionById(pane, input.options?.action);
    if (!action) return;
    setLoading(true);
    setError(null);
    try {
      const result = await pane.runRow(action, { connections: chosenConnections(pane) });
      setGroups(Array.isArray(result.groups) ? (result.groups as Group[]) : []);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setLoading(false);
    }
  }
  return { groups, loading, error, load };
}

function heading(g: Group): string {
  return `${g.environment_name} (${g.account_id} · ${g.region})`;
}

export function LogGroupsPicker({ input, pane }: { input: ManifestInput; pane: PaneApi }) {
  const { groups, loading, error, load } = useLoader(pane, input);
  const [filter, setFilter] = useState("");
  const selection = (pane.inputs[input.key] ?? {}) as Record<string, unknown>;
  const opts = input.options!;
  const set = (next: Values) => pane.changeInputs({ [input.key]: next });

  function toggle(env: number, name: string) {
    const current = new Set(names(selection[env]));
    if (current.has(name)) current.delete(name);
    else current.add(name);
    set({ ...selection, [env]: [...current] });
  }

  const totalSelected = Object.values(selection).reduce<number>((sum, s) => sum + names(s).length, 0);

  return (
    <div>
      <div className="toolbar">
        <button onClick={load} disabled={chosenConnections(pane).length === 0 || loading}>
          {loading ? opts.busy_label ?? opts.load_label : opts.load_label}
        </button>
        <input
          type="text"
          placeholder={opts.filter}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 220 }}
        />
        <span className="muted">{totalSelected} log group(s) selected</span>
      </div>
      {error && <p className="error-text">{error}</p>}
      {groups.length === 0 && !loading && <p className="muted">{opts.placeholder}</p>}
      <div className="checkbox-list">
        {groups.map((r) => {
          const all = (r.items ?? []).map(String);
          const filtered = all.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));
          const chosen = new Set(names(selection[r.environment_id]));
          const allChecked = filtered.length > 0 && filtered.every((n) => chosen.has(n));
          return (
            <div key={r.environment_id}>
              <div className="group-heading">
                {r.error ? (
                  <span className="tag error">error</span>
                ) : (
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) => set({ ...selection, [r.environment_id]: e.target.checked ? filtered : [] })}
                  />
                )}
                <span>{heading(r)}</span>
                {!r.error && <span className="muted">{filtered.length} log group(s)</span>}
              </div>
              {r.error && (
                <div className="error-text" style={{ marginLeft: 20 }}>
                  {r.error}
                </div>
              )}
              {filtered.map((n) => (
                <label key={n} className="checkbox-item" style={{ marginLeft: 20 }}>
                  <input type="checkbox" checked={chosen.has(n)} onChange={() => toggle(r.environment_id, n)} />
                  {n}
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type IndexSelection = Record<string, Record<string, { domain_endpoint: string; indices: unknown }>>;

export function IndicesPicker({ input, pane }: { input: ManifestInput; pane: PaneApi }) {
  const { groups, loading, error, load } = useLoader(pane, input);
  const [filter, setFilter] = useState("");
  // Per domain, "<environment>::<domain>": its indices, whether they're
  // loading, and why they couldn't be.
  const [indices, setIndices] = useState<Record<string, IndexOption[]>>({});
  const [loadingIndices, setLoadingIndices] = useState<Set<string>>(new Set());
  const [indicesError, setIndicesError] = useState<Record<string, string>>({});
  const selection = (pane.inputs[input.key] ?? {}) as IndexSelection;
  const opts = input.options!;

  async function loadIndices(env: number, domain: string, endpoint: string) {
    const key = `${env}::${domain}`;
    const action = actionById(pane, opts.children);
    if (!action) return;
    setLoadingIndices((prev) => new Set(prev).add(key));
    setIndicesError((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await pane.runRow(action, { connection: env, domainEndpoint: endpoint });
      setIndices((prev) => ({ ...prev, [key]: (result.options as IndexOption[] | undefined) ?? [] }));
    } catch (e) {
      setIndicesError((prev) => ({ ...prev, [key]: readableError(e) }));
    } finally {
      setLoadingIndices((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function write(env: number, domain: string, endpoint: string, chosen: string[]) {
    const forEnv = { ...(selection[env] ?? {}) };
    forEnv[domain] = { domain_endpoint: endpoint, indices: chosen };
    pane.changeInputs({ [input.key]: { ...selection, [env]: forEnv } });
  }

  function toggle(env: number, domain: string, endpoint: string, index: string) {
    const current = new Set(names(selection[env]?.[domain]?.indices));
    if (current.has(index)) current.delete(index);
    else current.add(index);
    write(env, domain, endpoint, [...current]);
  }

  const totalSelected = Object.values(selection).reduce(
    (sum, domains) => sum + Object.values(domains ?? {}).reduce((s, d) => s + names(d?.indices).length, 0),
    0,
  );

  return (
    <div>
      <div className="toolbar">
        <button onClick={load} disabled={chosenConnections(pane).length === 0 || loading}>
          {loading ? opts.busy_label ?? opts.load_label : opts.load_label}
        </button>
        <input
          type="text"
          placeholder={opts.filter}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 220 }}
        />
        <span className="muted">{totalSelected} index/indices selected</span>
      </div>
      {error && <p className="error-text">{error}</p>}
      {groups.length === 0 && !loading && <p className="muted">{opts.placeholder}</p>}
      <div className="checkbox-list">
        {groups.map((r) => {
          const domains = (r.items ?? []) as Domain[];
          return (
            <div key={r.environment_id}>
              <div className="group-heading">
                {r.error ? (
                  <span className="tag error">error</span>
                ) : (
                  <span className="tag">{domains.length} domain(s)</span>
                )}
                <span>{heading(r)}</span>
              </div>
              {r.error && (
                <div className="error-text" style={{ marginLeft: 20 }}>
                  {r.error}
                </div>
              )}
              {domains.map((d) => {
                if (!d.endpoint) {
                  return (
                    <div key={d.domain_name} style={{ marginLeft: 20 }} className="muted">
                      {d.domain_name} — no reachable endpoint reported for this domain
                    </div>
                  );
                }
                const endpoint = d.endpoint;
                const key = `${r.environment_id}::${d.domain_name}`;
                const listed = indices[key];
                const filtered = (listed ?? []).filter((i) => i.value.toLowerCase().includes(filter.toLowerCase()));
                const chosen = new Set(names(selection[r.environment_id]?.[d.domain_name]?.indices));
                const allChecked = filtered.length > 0 && filtered.every((i) => chosen.has(i.value));
                return (
                  <div key={d.domain_name} style={{ marginLeft: 20, marginBottom: 6 }}>
                    <div className="row" style={{ gap: 8 }}>
                      {listed && !indicesError[key] && (
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={(e) =>
                            write(r.environment_id, d.domain_name, endpoint, e.target.checked ? filtered.map((i) => i.value) : [])
                          }
                        />
                      )}
                      <strong>{d.domain_name}</strong>
                      {d.engine_version && <span className="muted">{d.engine_version}</span>}
                      <button
                        className="secondary"
                        onClick={() => loadIndices(r.environment_id, d.domain_name, endpoint)}
                        disabled={loadingIndices.has(key)}
                      >
                        {loadingIndices.has(key) ? "Loading indices…" : listed ? "Reload indices" : "Load indices"}
                      </button>
                      {listed && <span className="muted">{filtered.length} index/indices</span>}
                    </div>
                    {indicesError[key] && (
                      <div className="error-text" style={{ marginLeft: 20 }}>
                        {indicesError[key]}
                      </div>
                    )}
                    {filtered.map((i) => (
                      <label key={i.value} className="checkbox-item" style={{ marginLeft: 20 }}>
                        <input
                          type="checkbox"
                          checked={chosen.has(i.value)}
                          onChange={() => toggle(r.environment_id, d.domain_name, endpoint, i.value)}
                        />
                        {i.label}
                        {i.docs_count != null && <span className="muted"> ({text(i.docs_count)} docs)</span>}
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function localInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The time range (`time_range:` in a layout): the preset input as a select
 * of its choices, and with "Custom range…" its start and end as text in the
 * user's own local time. Choosing custom with neither set starts them at
 * the last 15 minutes, as the old page's defaults did.
 */
export function TimeRange({ spec, pane }: { spec: { preset: string; start: string; end: string }; pane: PaneApi }) {
  const presetInput = pane.m.inputs.find((i) => i.key === spec.preset);
  const preset = pane.inputs[spec.preset];
  const custom = preset === "custom";
  return (
    <>
      <select
        value={String(preset ?? "")}
        onChange={(e) => {
          const raw = e.target.value;
          const value = raw === "custom" ? "custom" : Number(raw);
          const changes: Values = { [spec.preset]: value };
          if (value === "custom" && !pane.inputs[spec.start] && !pane.inputs[spec.end]) {
            const now = Math.floor(Date.now() / 1000);
            changes[spec.start] = localInput(now - 15 * 60);
            changes[spec.end] = localInput(now);
          }
          pane.changeInputs(changes);
        }}
        aria-label="Time range"
      >
        {(presetInput?.choices ?? []).map((c) => (
          <option key={String(c)} value={String(c)}>
            {presetInput?.choice_labels[String(c)] ?? String(c)}
          </option>
        ))}
      </select>
      {custom && (
        <>
          <input
            type="text"
            value={text(pane.inputs[spec.start])}
            onChange={(e) => pane.changeInputs({ [spec.start]: e.target.value })}
            placeholder="YYYY-MM-DDTHH:mm"
            style={{ width: 170 }}
          />
          <span className="muted">to</span>
          <input
            type="text"
            value={text(pane.inputs[spec.end])}
            onChange={(e) => pane.changeInputs({ [spec.end]: e.target.value })}
            placeholder="YYYY-MM-DDTHH:mm"
            style={{ width: 170 }}
          />
        </>
      )}
    </>
  );
}
