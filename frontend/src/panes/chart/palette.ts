/**
 * Chart colours: the dataviz reference palette's eight categorical hues,
 * in its validated order (adjacent pairs clear the colour-blind checks), with
 * its own steps for a dark surface -- chosen by the theme's `color-scheme`,
 * so every app theme gets the set it was validated against. Series take
 * slots in order and never cycle: past eight, the rest fold into "Other"
 * (`frame.ts`), which takes a neutral.
 *
 * Text, grid and surface come from the theme's own tokens.
 */

const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export interface ChartColours {
  dark: boolean;
  series: string[];
  other: string;
  text: string;
  textDim: string;
  grid: string;
  surface: string;
}

export function chartColours(): ChartColours {
  const style = getComputedStyle(document.documentElement);
  const dark = style.colorScheme.includes("dark");
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    dark,
    series: dark ? DARK : LIGHT,
    other: dark ? "#6b6b66" : "#9a9993",
    text: token("--text", dark ? "#e6e8eb" : "#1a1d23"),
    textDim: token("--text-dim", dark ? "#9aa2b1" : "#5b6474"),
    grid: token("--border", dark ? "#4a5166" : "#d5d9e0"),
    surface: token("--panel", dark ? "#171a21" : "#ffffff"),
  };
}
