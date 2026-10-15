/**
 * One ECharts instance in a box, ECharts loaded the first time any chart is
 * drawn (its own chunk, `echartsCore.ts`).
 *
 * Panes stay mounted while hidden, and a hidden box measures 0: the chart is
 * made only once its box has a size, and resized whenever the box changes
 * (a dock opening, a dashboard pane dragged wider). A theme change rebuilds
 * the option, since its colours come from the theme's tokens.
 */

import { useEffect, useRef, useState } from "react";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import { ChartColours, chartColours } from "./palette";

type Echarts = typeof import("./echartsCore").default;

let loading: Promise<Echarts> | null = null;
function loadEcharts(): Promise<Echarts> {
  loading ??= import("./echartsCore").then((m) => m.default);
  return loading;
}

/** The theme's chart colours, again whenever the theme changes. */
export function useChartColours(): ChartColours {
  const [colours, setColours] = useState(chartColours);
  useEffect(() => {
    const observer = new MutationObserver(() => setColours(chartColours()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => observer.disconnect();
  }, []);
  return colours;
}

/** A time axis's range picked by dragging across it (`onRange`): ECharts'
 * brush, armed as the cursor so a plain drag selects -- no toolbox button to
 * find first -- and cleared once read. */
function withBrush(option: EChartsCoreOption): EChartsCoreOption {
  return {
    ...option,
    toolbox: { show: false },
    brush: { xAxisIndex: 0, brushType: "lineX", brushMode: "single", transformable: false },
  };
}

function arm(chart: EChartsType) {
  chart.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "lineX", brushMode: "single" } });
}

export default function EChart({
  option,
  height,
  label,
  onRange,
}: {
  option: EChartsCoreOption;
  height: number;
  label: string;
  /** Called with the dragged range of a time x axis, in epoch ms. */
  onRange?: (start: number, end: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = onRange ? withBrush(option) : option;
  const optionRef = useRef(shown);
  optionRef.current = shown;
  const onRangeRef = useRef(onRange);
  onRangeRef.current = onRange;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === 0) return; // hidden: wait until it has a size
      if (chart.current) {
        chart.current.resize();
        return;
      }
      loadEcharts().then(
        (echarts) => {
          if (cancelled || chart.current || el.clientWidth === 0) return;
          const made = echarts.init(el, undefined, { renderer: "canvas" });
          chart.current = made;
          made.setOption(optionRef.current, true);
          made.on("brushEnd", (params: unknown) => {
            const range = (params as { areas?: { coordRange?: [number, number] }[] }).areas?.[0]?.coordRange;
            made.dispatchAction({ type: "brush", areas: [] });
            if (range && onRangeRef.current && range[1] > range[0]) onRangeRef.current(range[0], range[1]);
          });
          if (onRangeRef.current) arm(made);
        },
        () => setError("The chart library couldn't be loaded; reload the page to try again."),
      );
    });
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chart.current) return;
    chart.current.setOption(shown, true);
    // setOption with notMerge drops the armed cursor along with the old option.
    if (onRangeRef.current) arm(chart.current);
    // `shown` is rebuilt from `option` each render; `option` is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option, !!onRange]);

  if (error) return <p className="error-text">{error}</p>;
  return <div ref={box} className="chart-box" style={{ height }} role="img" aria-label={label} />;
}
