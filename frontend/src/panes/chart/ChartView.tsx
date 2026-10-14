/**
 * A chart over a pane's rows (D53), and the log-volume histogram (D52).
 *
 * The `chart:` layout item names the output it charts; the spec lives in
 * that output's `chart` view key, so it syncs to everyone looking and the
 * agent sets it (`set_pane_view`). Beside a card's title the item is only
 * the type picker ("Chart: None") -- an unused chart adds no row of its own;
 * in the card, once a type is chosen, it is the x / y / series pickers and
 * the chart.
 */

import { useMemo } from "react";
import type { EChartsCoreOption } from "echarts/core";
import { ManifestOutput } from "../manifest";
import { PaneApi } from "../paneApi";
import {
  AGGS,
  Agg,
  Chart,
  CHART_TYPES,
  ChartSpec,
  ChartType,
  chartOf,
  formatNumber,
  Frame,
  frameOfLogs,
  frameOfRecords,
  OTHER,
  statOf,
} from "../frame";
import EChart, { useChartColours } from "./EChart";
import { ChartColours } from "./palette";

const CHART_HEIGHT = 260;

function frameFor(output: ManifestOutput, value: unknown): Frame {
  return output.render === "logs" ? frameOfLogs(value) : frameOfRecords(value);
}

function specOf(value: unknown): ChartSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ChartSpec>;
  if (!CHART_TYPES.some((t) => t.value === v.type)) return null;
  return { type: v.type as ChartType, x: String(v.x ?? ""), y: String(v.y ?? "count"), agg: (v.agg as Agg) ?? "count", series: v.series || undefined };
}

/** A new chart of `type`, its fields guessed from the frame: over time when
 * there's a time column, else by the first text column; summing the first
 * number column if there is one (a `stats ... by bin()` result is one row
 * per bar, so counting its rows would draw a flat 1), else counting rows. */
function starter(type: ChartType, frame: Frame, previous: ChartSpec | null): ChartSpec {
  const time = frame.fields.find((f) => f.type === "time")?.name;
  const text = frame.fields.find((f) => f.type === "string")?.name;
  // An id is a number but never a measure.
  const number = frame.fields.find((f) => f.type === "number" && !/(^|[_-])id$/i.test(f.name))?.name;
  const keep = previous
    ? { y: previous.y, agg: previous.agg }
    : number
      ? { y: number, agg: "sum" as Agg }
      : { y: "count", agg: "count" as Agg };
  if (type === "timeseries") return { type, x: time ?? frame.fields[0]?.name ?? "", ...keep };
  if (type === "stat") return { type, x: time ?? "", ...keep };
  return { type, x: text ?? frame.fields[0]?.name ?? "", ...keep };
}

export function ChartItem({ output, pane, place }: { output: ManifestOutput; pane: PaneApi; place: string }) {
  const viewKey = String(output.config.chart ?? "chart");
  const value = pane.outputs[output.key];
  const frame = useMemo(() => frameFor(output, value), [output, value]);
  const spec = specOf(pane.views[viewKey]);
  const set = (next: ChartSpec | null) => pane.setView(viewKey, next);

  if (place === "aside" || place === "toolbar") {
    return (
      <label className="row" style={{ gap: 6 }}>
        <span className="muted">Chart</span>
        <select
          aria-label="Chart type"
          value={spec?.type ?? ""}
          onChange={(e) => set(e.target.value ? starter(e.target.value as ChartType, frame, spec) : null)}
        >
          <option value="">None</option>
          {CHART_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (!spec) return null;
  return (
    <div className="chart-section">
      <ChartPickers spec={spec} frame={frame} onChange={set} />
      {spec.type === "stat" ? <StatTile frame={frame} spec={spec} /> : <ChartBody frame={frame} spec={spec} />}
    </div>
  );
}

function ChartPickers({ spec, frame, onChange }: { spec: ChartSpec; frame: Frame; onChange: (s: ChartSpec) => void }) {
  const fields = frame.fields;
  const numbers = fields.filter((f) => f.type === "number");
  const texts = fields.filter((f) => f.type === "string");
  // A name the rows don't have (set by the agent, or an older run's) is kept
  // as a choice, so the select shows what's set rather than jumping.
  const choices = (names: string[], current: string) => (current && !names.includes(current) ? [...names, current] : names);
  const xNames = choices(
    (spec.type === "timeseries" ? [...fields].sort((a, b) => Number(b.type === "time") - Number(a.type === "time")) : fields).map(
      (f) => f.name,
    ),
    spec.x,
  );
  const yNames = choices(numbers.map((f) => f.name), spec.y === "count" ? "" : spec.y);
  const seriesNames = choices(texts.map((f) => f.name), spec.series ?? "");
  const pick = (label: string, value: string, names: string[], set: (v: string) => void, extra?: [string, string]) => (
    <label className="row" style={{ gap: 6 }}>
      <span className="muted">{label}</span>
      <select aria-label={`Chart ${label.toLowerCase()}`} value={value} onChange={(e) => set(e.target.value)}>
        {extra && <option value={extra[0]}>{extra[1]}</option>}
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="toolbar">
      {spec.type !== "stat"
        ? pick(spec.type === "pie" ? "Slices" : "X", spec.x, xNames, (x) => onChange({ ...spec, x }))
        : pick("Over", spec.x, xNames, (x) => onChange({ ...spec, x }), ["", "Nothing"])}
      {pick("Y", spec.y, yNames, (y) => onChange({ ...spec, y, agg: y === "count" ? "count" : spec.agg === "count" ? "sum" : spec.agg }), [
        "count",
        "Count rows",
      ])}
      {spec.y !== "count" &&
        pick(
          "Of",
          spec.agg,
          AGGS.filter((a) => a.value !== "count").map((a) => a.value),
          (agg) => onChange({ ...spec, agg: agg as Agg }),
        )}
      {spec.type !== "pie" &&
        spec.type !== "stat" &&
        pick("Series", spec.series ?? "", seriesNames, (series) => onChange({ ...spec, series: series || undefined }), [
          "",
          "None",
        ])}
    </div>
  );
}

function axisText(c: ChartColours) {
  return { color: c.textDim, fontSize: 11 };
}

// A time axis's ticks as words, in the viewer's own zone: ECharts' defaults
// label a day by its bare number ("2", "3"), which reads as a count.
const TIME_LABELS = {
  year: "{yyyy}",
  month: "{MMM} {yyyy}",
  day: "{MMM} {d}",
  hour: "{HH}:{mm}",
  minute: "{HH}:{mm}",
  second: "{HH}:{mm}:{ss}",
  millisecond: "{HH}:{mm}:{ss}",
};

function colourOf(c: ChartColours, name: string, index: number): string {
  return name === OTHER ? c.other : c.series[index % c.series.length];
}

function chartOption(chart: Chart, spec: ChartSpec, c: ChartColours): EChartsCoreOption {
  const many = chart.series.length > 1;
  const tooltip = {
    backgroundColor: c.surface,
    borderColor: c.grid,
    textStyle: { color: c.text, fontSize: 12 },
    valueFormatter: (v: unknown) => formatNumber(typeof v === "number" ? v : null),
  };
  const legend = many ? { top: 0, textStyle: { color: c.textDim }, itemWidth: 12, itemHeight: 8, icon: "roundRect" } : undefined;
  if (spec.type === "pie") {
    const s = chart.series[0];
    // One ring, a slice per x; past the palette, the smallest share "Other".
    const slices = chart.xs.map((x, i) => ({ name: String(x), value: s?.values[i] ?? 0 }));
    slices.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const kept = slices.length > c.series.length ? slices.slice(0, c.series.length - 1) : slices;
    if (slices.length > kept.length) {
      kept.push({ name: OTHER, value: slices.slice(kept.length).reduce((sum, d) => sum + (d.value ?? 0), 0) });
    }
    return {
      color: kept.map((d, i) => colourOf(c, d.name, i)),
      tooltip: { ...tooltip, trigger: "item" },
      legend: { ...legend, type: "scroll", top: 0, textStyle: { color: c.textDim } },
      series: [
        {
          type: "pie",
          radius: ["45%", "72%"],
          center: ["50%", "56%"],
          // A 2px surface gap between slices.
          itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          data: kept,
        },
      ],
    };
  }
  const time = chart.xType === "time";
  const data = (values: (number | null)[]) => (time ? chart.xs.map((x, i) => [x, values[i]]) : values);
  return {
    color: chart.series.map((s, i) => colourOf(c, s.name, i)),
    tooltip: { ...tooltip, trigger: "axis", axisPointer: { type: spec.type === "bar" ? "shadow" : "line" } },
    legend,
    grid: { left: 8, right: 16, top: many ? 32 : 12, bottom: 8, containLabel: true },
    xAxis: time
      ? { type: "time", axisLabel: { ...axisText(c), formatter: TIME_LABELS, hideOverlap: true }, axisLine: { lineStyle: { color: c.grid } } }
      : { type: "category", data: chart.xs.map(String), axisLabel: { ...axisText(c), hideOverlap: true }, axisLine: { lineStyle: { color: c.grid } } },
    yAxis: { type: "value", axisLabel: axisText(c), splitLine: { lineStyle: { color: c.grid, opacity: 0.35 } } },
    series: chart.series.map((s) =>
      spec.type === "bar"
        ? {
            type: "bar",
            name: s.name,
            data: data(s.values),
            barMaxWidth: 28,
            itemStyle: { borderRadius: [4, 4, 0, 0] },
          }
        : {
            type: "line",
            name: s.name,
            data: data(s.values),
            showSymbol: chart.xs.length <= 1,
            symbolSize: 8,
            lineStyle: { width: 2 },
            connectNulls: false,
          },
    ),
  };
}

function ChartBody({ frame, spec }: { frame: Frame; spec: ChartSpec }) {
  const colours = useChartColours();
  const chart = useMemo(() => chartOf(frame, spec), [frame, spec]);
  const option = useMemo(() => chartOption(chart, spec, colours), [chart, spec, colours]);
  if (chart.problem) return <p className="muted">{chart.problem}</p>;
  const what = spec.y === "count" ? "count of rows" : `${spec.agg} of ${spec.y}`;
  return <EChart option={option} height={CHART_HEIGHT} label={`${what} by ${spec.x}`} />;
}

function StatTile({ frame, spec }: { frame: Frame; spec: ChartSpec }) {
  const colours = useChartColours();
  const stat = useMemo(() => statOf(frame, spec), [frame, spec]);
  const spark = useMemo<EChartsCoreOption>(
    () => ({
      grid: { left: 0, right: 0, top: 4, bottom: 4 },
      xAxis: { type: "time", show: false, min: "dataMin", max: "dataMax" },
      yAxis: { type: "value", show: false, min: 0 },
      tooltip: {
        trigger: "axis",
        backgroundColor: colours.surface,
        borderColor: colours.grid,
        textStyle: { color: colours.text, fontSize: 12 },
        valueFormatter: (v: unknown) => formatNumber(typeof v === "number" ? v : null),
      },
      series: [
        {
          type: "line",
          data: stat.spark,
          showSymbol: false,
          lineStyle: { width: 2, color: colours.series[0] },
          areaStyle: { color: colours.series[0], opacity: 0.12 },
        },
      ],
    }),
    [stat.spark, colours],
  );
  if (stat.problem) return <p className="muted">{stat.problem}</p>;
  const what = spec.y === "count" ? "Rows" : `${AGGS.find((a) => a.value === spec.agg)?.label} of ${spec.y}`;
  return (
    <div className="stat-tile">
      <div>
        <div className="stat-value">{formatNumber(stat.value)}</div>
        <div className="muted">{what}</div>
      </div>
      {stat.spark.length > 1 && (
        <div className="stat-spark">
          <EChart option={spark} height={56} label={`${what} over ${spec.x}`} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the log-volume histogram

interface Bars {
  environment_name: string;
  buckets: { t: number; count: number }[];
  error: string | null;
}

interface Volume {
  start: number;
  end: number;
  interval: string;
  groups: Bars[];
  note: string | null;
}

/** Every match over time, bars stacked by environment (D52), above the list. */
export function HistogramView({ value }: { value: unknown }) {
  const colours = useChartColours();
  const volume = value && typeof value === "object" ? (value as Volume) : null;
  const groups = (volume?.groups ?? []).filter((g) => !g.error);
  const total = groups.reduce((sum, g) => sum + g.buckets.reduce((s, b) => s + b.count, 0), 0);
  const option = useMemo<EChartsCoreOption>(() => {
    const many = groups.length > 1;
    return {
      color: groups.map((_, i) => colours.series[i % colours.series.length]),
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: colours.surface,
        borderColor: colours.grid,
        textStyle: { color: colours.text, fontSize: 12 },
        valueFormatter: (v: unknown) => formatNumber(typeof v === "number" ? v : null),
      },
      legend: many ? { top: 0, textStyle: { color: colours.textDim }, itemWidth: 12, itemHeight: 8, icon: "roundRect" } : undefined,
      grid: { left: 8, right: 16, top: many ? 28 : 8, bottom: 4, containLabel: true },
      xAxis: {
        type: "time",
        min: volume?.start,
        max: volume?.end,
        axisLabel: { ...axisText(colours), formatter: TIME_LABELS, hideOverlap: true },
        axisLine: { lineStyle: { color: colours.grid } },
      },
      yAxis: { type: "value", minInterval: 1, axisLabel: axisText(colours), splitLine: { lineStyle: { color: colours.grid, opacity: 0.35 } } },
      series: groups.map((g, i) => ({
        type: "bar",
        name: g.environment_name,
        stack: "volume",
        data: g.buckets.map((b) => [b.t, b.count]),
        barCategoryGap: "20%",
        // Only the top of the stack is rounded; a 2px surface gap between segments.
        itemStyle: { borderColor: colours.surface, borderWidth: many ? 1 : 0, borderRadius: i === groups.length - 1 ? [3, 3, 0, 0] : 0 },
      })),
    };
  }, [groups, volume?.start, volume?.end, colours]);
  if (!volume) return null;
  const errors = (volume.groups ?? []).filter((g) => g.error);
  return (
    <div className="chart-section histogram">
      {volume.note ? (
        <p className="muted" style={{ margin: 0 }}>
          {volume.note}
        </p>
      ) : (
        <span className="muted">
          {formatNumber(total)} match{total === 1 ? "" : "es"} over time, per {volume.interval}
        </span>
      )}
      {errors.map((g, i) => (
        <p key={i} className="error-text">
          {g.environment_name}: couldn't count ({g.error})
        </p>
      ))}
      {groups.length > 0 && <EChart option={option} height={120} label={`Matches over time, per ${volume.interval}`} />}
    </div>
  );
}

