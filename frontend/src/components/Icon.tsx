/**
 * The icons of the app's small square buttons: a pane's header and tab, the
 * session card's header, the ✎ beside a name. Drawn on one 16-unit grid with
 * one stroke, so every button is the same box with the same weight of mark.
 *
 * They used to be text glyphs (✎ ⋮ − + ✕ ▲ ⇤): each took its width and height
 * from whatever font had it, so the buttons came out stretched sideways and
 * uneven -- ✎ taller than the rest in some fonts -- and ⋮ read as a smudge.
 */

export type IconName =
  | "pencil"
  | "gear"
  | "minus"
  | "plus"
  | "close"
  | "up"
  | "down"
  | "left"
  | "right"
  | "to-rail"
  | "from-rail"
  | "home"
  | "star"
  | "hide"
  | "workflow"
  | "builder";

// Generated: eight teeth between radii 5.2 and 6.9 around (8, 8).
const GEAR =
  "M12.97 6.47 L14.80 6.81 L14.80 9.19 L12.97 9.53 L12.60 10.43 L13.65 11.97 L11.97 13.65 L10.43 12.60 " +
  "L9.53 12.97 L9.19 14.80 L6.81 14.80 L6.47 12.97 L5.57 12.60 L4.03 13.65 L2.35 11.97 L3.40 10.43 " +
  "L3.03 9.53 L1.20 9.19 L1.20 6.81 L3.03 6.47 L3.40 5.57 L2.35 4.03 L4.03 2.35 L5.57 3.40 L6.47 3.03 " +
  "L6.81 1.20 L9.19 1.20 L9.53 3.03 L10.43 3.40 L11.97 2.35 L13.65 4.03 L12.60 5.57 Z";

const PATHS: Record<IconName, string> = {
  pencil: "M10.5 2.5 L13.5 5.5 L5.5 13.5 H2.5 V10.5 Z M8.75 4.25 L11.75 7.25",
  gear: GEAR,
  minus: "M3.5 8 H12.5",
  plus: "M8 3.5 V12.5 M3.5 8 H12.5",
  close: "M4 4 L12 12 M12 4 L4 12",
  up: "M3.5 10.25 L8 5.75 L12.5 10.25",
  down: "M3.5 5.75 L8 10.25 L12.5 5.75",
  left: "M10.25 3.5 L5.75 8 L10.25 12.5",
  right: "M5.75 3.5 L10.25 8 L5.75 12.5",
  // To the side panel and back: an arrow to (or from) the panel's edge.
  "to-rail": "M2.5 3 V13 M13.5 8 H5.5 M8.5 5 L5.5 8 L8.5 11",
  "from-rail": "M13.5 3 V13 M2.5 8 H10.5 M7.5 5 L10.5 8 L7.5 11",
  home: "M2.5 7.5 L8 2.75 L13.5 7.5 M4 6.25 V13.25 H12 V6.25 M6.75 13.25 V9.5 H9.25 V13.25",
  star: "M8 2.25 L9.7 5.8 L13.5 6.3 L10.7 8.9 L11.45 12.75 L8 10.85 L4.55 12.75 L5.3 8.9 L2.5 6.3 L6.3 5.8 Z",
  // An eye, struck through: hide this from my lists.
  // Two steps and the line from one to the next: a workflow.
  workflow: "M2.5 2.5 H7 V6.5 H2.5 Z M9 9.5 H13.5 V13.5 H9 Z M4.75 6.5 V11.5 H9",
  // Blocks, two set down and one on top: what you build with.
  builder: "M2.5 9 H7 V13.5 H2.5 Z M9 9 H13.5 V13.5 H9 Z M5.75 2.5 H10.25 V7 H5.75 Z",
  hide: "M1.75 8 C3.5 5 5.6 3.75 8 3.75 C10.4 3.75 12.5 5 14.25 8 C12.5 11 10.4 12.25 8 12.25 C5.6 12.25 3.5 11 1.75 8 Z M8 6.25 A1.75 1.75 0 1 0 8 9.75 A1.75 1.75 0 1 0 8 6.25 M2.5 13.5 L13.5 2.5",
};

export default function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
      {name === "gear" && <circle cx="8" cy="8" r="2.1" />}
    </svg>
  );
}
