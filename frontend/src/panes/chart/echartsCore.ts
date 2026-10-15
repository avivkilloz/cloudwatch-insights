/**
 * The parts of ECharts the panes draw with (D11), and nothing else: imported
 * only by `EChart.tsx`'s dynamic `import()`, so this is its own chunk, fetched
 * the first time a chart is on screen -- a session with no chart never
 * downloads it.
 */

import { BarChart, LineChart, PieChart } from "echarts/charts";
import { BrushComponent, GridComponent, LegendComponent, ToolboxComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

// The brush (drag across a time axis to zoom, chart/zoom.ts) needs the
// toolbox registered, though its buttons stay hidden: a plain drag selects.
echarts.use([BarChart, LineChart, PieChart, BrushComponent, GridComponent, LegendComponent, ToolboxComponent, TooltipComponent, CanvasRenderer]);

export default echarts;
