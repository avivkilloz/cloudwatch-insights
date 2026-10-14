/**
 * Data frames and the chart spec (PLATFORM_PLAN.md §4.3, §16.11, D11/D53).
 *
 * A frame is worked out here from what an output already holds -- nothing
 * new is stored: a table's records (the API table), or a log list's
 * `{field, value}` rows flattened, with the target they came from as
 * `environment`. Each field gets a type from its values: number, time, or
 * string. A chart spec (the output's `chart` view key) then says which
 * fields to draw and how to fold the rows into them.
 */

export type FieldType = "number" | "time" | "string";

export interface Field {
  name: string;
  type: FieldType;
  /** How many different values it has, over the rows scanned. */
  distinct: number;
}

/** A column can split a chart into series when it has few values: one
 * coloured line per value. `@message` has one per row -- as series it drew
 * a legend of whole log lines over the chart. */
export const SERIES_MAX_DISTINCT = 20;

export function groupable(field: Field): boolean {
  return field.type === "string" && field.distinct <= SERIES_MAX_DISTINCT;
}

export type Row = Record<string, unknown>;

export interface Frame {
  fields: Field[];
  rows: Row[];
}

export type ChartType = "timeseries" | "bar" | "pie" | "stat";
export type Agg = "count" | "sum" | "avg" | "min" | "max";

/** The `chart` view key: what the agent's `set_pane_view` writes too. */
export interface ChartSpec {
  type: ChartType;
  x: string;
  /** A field, or "count" to count the rows. */
  y: string;
  agg: Agg;
  series?: string;
}

export const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "timeseries", label: "Time series" },
  { value: "bar", label: "Bar" },
  { value: "pie", label: "Pie" },
  { value: "stat", label: "Stat" },
];

export const AGGS: { value: Agg; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "count", label: "Count" },
];

/** The most series a chart shows (the palette's eight hues); the rest fold
 * into "Other" rather than reuse a colour. */
export const MAX_SERIES = 8;
export const OTHER = "Other";

/** Columns are found over this many rows: enough to see them all in practice
 * without walking a huge result. */
const SCAN_ROWS = 200;

// CloudWatch's own timestamps and bin() buckets, which are UTC.
const CLOUDWATCH_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A value as epoch milliseconds, if it reads as a time. A bare number only
 * counts in a field whose every value looks like epoch seconds or ms, which
 * `inferType` decides; here strings. */
export function timeOf(value: unknown): number | null {
  if (typeof value === "number") return value > 1e11 ? value : value * 1000;
  if (typeof value !== "string") return null;
  const cw = CLOUDWATCH_TIME.exec(value);
  if (cw) return Date.parse(`${cw[1]}T${cw[2]}Z`);
  if (ISO_TIME.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function inferType(values: unknown[]): FieldType {
  const present = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (present.length === 0) return "string";
  if (present.every((v) => typeof v === "string" && timeOf(v) !== null)) return "time";
  if (present.every((v) => numberOf(v) !== null)) {
    // Epoch seconds or milliseconds of this century read as times; any other
    // number is a measure.
    const nums = present.map((v) => numberOf(v) as number);
    const epoch = nums.every((n) => (n > 9.4e8 && n < 4.1e9) || (n > 9.4e11 && n < 4.1e12));
    return epoch ? "time" : "number";
  }
  return "string";
}

function framed(rows: Row[]): Frame {
  const names: string[] = [];
  for (const row of rows.slice(0, SCAN_ROWS)) for (const k of Object.keys(row)) if (!names.includes(k)) names.push(k);
  const sample = rows.slice(0, SCAN_ROWS);
  return {
    fields: names.map((name) => {
      const values = sample.map((r) => r[name]);
      return { name, type: inferType(values), distinct: new Set(values.map((v) => String(v ?? ""))).size };
    }),
    rows,
  };
}

/** A table's records: plain objects, anything else in the list skipped. */
export function frameOfRecords(value: unknown): Frame {
  const rows = Array.isArray(value)
    ? (value.filter((r) => r && typeof r === "object" && !Array.isArray(r)) as Row[])
    : [];
  return framed(rows);
}

interface LogGroup {
  environment_name?: string;
  rows?: { field: string; value: string }[][];
}

/** A log list's groups of `{field, value}` rows, flattened; `@ptr` (a cursor,
 * not data) left out, and the target each row came from as `environment`. */
export function frameOfLogs(value: unknown): Frame {
  const rows: Row[] = [];
  for (const group of Array.isArray(value) ? (value as LogGroup[]) : []) {
    for (const fields of group?.rows ?? []) {
      const row: Row = { environment: group.environment_name ?? "" };
      for (const f of fields) if (f.field !== "@ptr") row[f.field] = f.value;
      rows.push(row);
    }
  }
  return framed(rows);
}

// ---------------------------------------------------------------- folding rows into a chart

export interface Series {
  name: string;
  /** One value per x, in the order of `Chart.xs`; null where a series has none. */
  values: (number | null)[];
}

export interface Chart {
  /** The x values, ordered: times ascending, numbers ascending, else by total. */
  xs: (string | number)[];
  xType: FieldType;
  /** A time x folded into bars of this width ("30s"), when the rows weren't
   * already one per bar. */
  step?: string;
  series: Series[];
  /** Why there is nothing to draw, said in the pane. */
  problem?: string;
}

function fold(agg: Agg, values: number[]): number | null {
  if (values.length === 0) return null;
  switch (agg) {
    case "count":
      return values.length;
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

/** The value a row adds to y: 1 for a count, else the field as a number. */
function measure(row: Row, spec: ChartSpec): number | null {
  return spec.y === "count" ? 1 : numberOf(row[spec.y]);
}

function aggOf(spec: ChartSpec): Agg {
  return spec.y === "count" ? "count" : spec.agg;
}

/** Problems that leave nothing to draw, by name, so the pane can say which. */
function missing(frame: Frame, spec: ChartSpec): string | undefined {
  const known = new Set(frame.fields.map((f) => f.name));
  for (const [role, name] of [
    ["x", spec.type === "stat" ? "" : spec.x],
    ["y", spec.y === "count" ? "" : spec.y],
    ["series", spec.series ?? ""],
  ] as const) {
    if (name && !known.has(name)) return `There's no column "${name}" (the chart's ${role}) in these rows.`;
  }
  if (frame.rows.length === 0) return "There are no rows to chart.";
  return undefined;
}

/** The rows folded into series over x, as the spec says. */
// The histogram's steps (backend panes/timewindow.STEPS): a time series over
// raw rows is folded into about BARS of them.
const STEPS: [number, string][] = [
  [1, "1s"], [5, "5s"], [10, "10s"], [30, "30s"], [60, "1m"], [300, "5m"], [600, "10m"], [1800, "30m"],
  [3600, "1h"], [10800, "3h"], [21600, "6h"], [43200, "12h"], [86400, "1d"],
];
const BARS = 60;

/** The bar width for times spread over [min, max] ms. */
function stepFor(min: number, max: number): [number, string] {
  const wanted = Math.max(1, (max - min) / 1000 / BARS);
  return STEPS.find(([seconds]) => seconds >= wanted) ?? STEPS[STEPS.length - 1];
}

export function chartOf(frame: Frame, spec: ChartSpec): Chart {
  const xType = frame.fields.find((f) => f.name === spec.x)?.type ?? "string";
  const problem = missing(frame, spec);
  if (problem) return { xs: [], xType, series: [], problem };
  const agg = aggOf(spec);
  // Raw rows over time -- a log line each, most at their own millisecond --
  // drew one spike per row. Folded into bars of one width they read as a
  // rate; a result already one row per bar (`stats ... by bin()`) is left
  // as it is.
  let bucket: [number, string] | null = null;
  if (xType === "time") {
    const times = new Set<number>();
    for (const row of frame.rows) {
      const t = timeOf(row[spec.x]);
      if (t !== null) times.add(t);
    }
    if (times.size > BARS) bucket = stepFor(Math.min(...times), Math.max(...times));
  }
  const stepMs = bucket ? bucket[0] * 1000 : 0;
  // x -> series -> the values folded into it.
  const cells = new Map<string | number, Map<string, number[]>>();
  const totals = new Map<string, number>();
  for (const row of frame.rows) {
    const raw = row[spec.x];
    let x = xType === "time" ? timeOf(raw) : xType === "number" ? numberOf(raw) : raw == null ? "" : String(raw);
    if (x === null) continue;
    if (stepMs && typeof x === "number") x = x - (x % stepMs);
    const v = measure(row, spec);
    if (v === null) continue;
    const name = spec.series ? String(row[spec.series] ?? "") || "(none)" : spec.y === "count" ? "Count" : spec.y;
    let byName = cells.get(x);
    if (!byName) cells.set(x, (byName = new Map()));
    const list = byName.get(name) ?? [];
    list.push(v);
    byName.set(name, list);
    totals.set(name, (totals.get(name) ?? 0) + Math.abs(v));
  }
  if (cells.size === 0) {
    const which = spec.y === "count" ? `"${spec.x}"` : `"${spec.x}" and "${spec.y}"`;
    return { xs: [], xType, series: [], problem: `No row has a usable ${which} to chart.` };
  }
  // The biggest series keep their own colour; past the palette, the rest
  // are one "Other" (the palette is never extended with made-up hues).
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const kept = new Set(ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked);
  const names = ranked.filter((n) => kept.has(n));
  if (ranked.length > kept.size) names.push(OTHER);
  let xs = [...cells.keys()];
  if (stepMs) {
    // Every bar of the span, empty ones too: a line drawn straight across a
    // quiet spell reads as activity there.
    const first = Math.min(...(xs as number[]));
    const last = Math.max(...(xs as number[]));
    xs = [];
    for (let t = first; t <= last; t += stepMs) xs.push(t);
  } else if (xType === "string") {
    const xTotal = (x: string | number) =>
      [...(cells.get(x)?.values() ?? [])].reduce((sum, list) => sum + list.reduce((a, b) => a + Math.abs(b), 0), 0);
    xs.sort((a, b) => xTotal(b) - xTotal(a));
  } else {
    xs = xs.sort((a, b) => (a as number) - (b as number));
  }
  const series = names.map((name) => ({
    name,
    values: xs.map((x) => {
      const byName = cells.get(x);
      if (!byName) return agg === "count" || agg === "sum" ? 0 : null;
      const values =
        name === OTHER
          ? [...byName.entries()].filter(([n]) => !kept.has(n)).flatMap(([, list]) => list)
          : byName.get(name) ?? [];
      // Other's sum, not its average of averages: folded series add up.
      return fold(name === OTHER && agg !== "min" && agg !== "max" ? (agg === "count" ? "count" : "sum") : agg, values);
    }),
  }));
  return { xs, xType, series, ...(bucket ? { step: bucket[1] } : {}) };
}

/** A stat tile's one number: y folded over every row; and, when x is a time,
 * the same fold per x for its sparkline. */
export function statOf(frame: Frame, spec: ChartSpec): { value: number | null; spark: [number, number][]; problem?: string } {
  const problem = missing(frame, { ...spec, x: "", series: undefined });
  if (problem) return { value: null, spark: [], problem };
  const agg = aggOf(spec);
  const values = frame.rows.map((r) => measure(r, spec)).filter((v): v is number => v !== null);
  const spark: [number, number][] = [];
  if (spec.x && frame.fields.find((f) => f.name === spec.x)?.type === "time") {
    const chart = chartOf(frame, { ...spec, type: "timeseries", series: undefined });
    for (let i = 0; i < chart.xs.length; i++) {
      const v = chart.series[0]?.values[i];
      if (v !== null && v !== undefined) spark.push([chart.xs[i] as number, v]);
    }
  }
  return { value: fold(agg, values), spark };
}

/** A number as a tile or tooltip shows it: grouped, at most two decimals. */
export function formatNumber(n: number | null): string {
  if (n === null) return "–";
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : Math.abs(n) < 1000 ? 1 : 0 });
}
