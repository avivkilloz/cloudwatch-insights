/**
 * The session's variables (PLATFORM_PLAN.md §18.7, D60): an Environment and a
 * Time range that every pane with such an input follows. Set in the session
 * card's Variables row, and in its header while the card is folded -- what a
 * dashboard is driven by stays at hand however the card is put away. They used
 * to be a bar of their own under the card, which read as a stray card and
 * stayed behind when the card moved to the side panel. A viewer sees them but
 * can't change them.
 */

import { useEffect, useState } from "react";
import { api, Environment } from "../api";
import { timePresets, TimeValue, VARIABLE_LABELS, VariableName, Variables } from "../panes/variables";
import Icon from "./Icon";

function localInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SessionVariables({
  variables,
  onChange,
  readOnly,
  removable,
}: {
  variables: Variables;
  /** The new variables, and which of them changed. */
  onChange: (next: Variables, changed: VariableName[]) => void;
  readOnly: boolean;
  /** Each with its ✕ (the card's row), or only the controls (its header). */
  removable: boolean;
}) {
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  useEffect(() => {
    if (variables.environment !== undefined) api.listEnvironments().then(setEnvironments, () => setEnvironments([]));
  }, [variables.environment !== undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = (["environment", "time"] as VariableName[]).filter((n) => variables[n] !== undefined);
  if (!names.length) return null;

  function set(name: VariableName, value: unknown) {
    onChange({ ...variables, [name]: value }, [name]);
  }
  function remove(name: VariableName) {
    const next = { ...variables };
    delete next[name];
    onChange(next, []);
  }

  const time = variables.time;
  return (
    <>
      {names.map((name) => (
        <span key={name} className="session-variable" role="group" aria-label={`Session ${VARIABLE_LABELS[name]}`}>
          <span className="session-variable-label">{VARIABLE_LABELS[name]}</span>
          <fieldset disabled={readOnly} className="session-variable-control">
            {name === "environment" ? (
              <select
                aria-label="Session environment"
                value={variables.environment == null ? "" : String(variables.environment)}
                onChange={(e) => set("environment", e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Choose environment…</option>
                {environments?.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.account_id} · {e.region})
                  </option>
                ))}
              </select>
            ) : (
              <>
                <select
                  aria-label="Session time range"
                  value={String(time?.preset ?? "")}
                  onChange={(e) => {
                    const preset = e.target.value === "custom" ? "custom" : Number(e.target.value);
                    const now = Math.floor(Date.now() / 1000);
                    const next: TimeValue =
                      preset === "custom"
                        ? { preset, start: time?.start || localInput(now - 15 * 60), end: time?.end || localInput(now) }
                        : { preset, start: "", end: "" };
                    set("time", next);
                  }}
                >
                  {timePresets().map((p) => (
                    <option key={String(p.value)} value={String(p.value)}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {time?.preset === "custom" && (
                  <>
                    <input
                      type="text"
                      aria-label="Session time range start"
                      value={time.start}
                      onChange={(e) => set("time", { ...time, start: e.target.value })}
                      placeholder="YYYY-MM-DDTHH:mm"
                    />
                    <span className="muted">to</span>
                    <input
                      type="text"
                      aria-label="Session time range end"
                      value={time.end}
                      onChange={(e) => set("time", { ...time, end: e.target.value })}
                      placeholder="YYYY-MM-DDTHH:mm"
                    />
                  </>
                )}
              </>
            )}
          </fieldset>
          {removable && !readOnly && (
            <button
              className="icon-btn session-variable-remove"
              onClick={() => remove(name)}
              aria-label={`Remove the ${VARIABLE_LABELS[name]} variable`}
              title={`Remove the ${VARIABLE_LABELS[name]} variable (panes keep the value they have)`}
            >
              <Icon name="close" />
            </button>
          )}
        </span>
      ))}
    </>
  );
}
