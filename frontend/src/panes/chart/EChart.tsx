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

export default function EChart({ option, height, label }: { option: EChartsCoreOption; height: number; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;

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
          chart.current = echarts.init(el, undefined, { renderer: "canvas" });
          chart.current.setOption(optionRef.current, true);
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
    chart.current?.setOption(option, true);
  }, [option]);

  if (error) return <p className="error-text">{error}</p>;
  return <div ref={box} className="chart-box" style={{ height }} role="img" aria-label={label} />;
}
