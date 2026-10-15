/**
 * A pane's ⚙: its settings, in its header (or its tab, in the tabs layout),
 * through the spot the frame leaves for it (components/paneMenuSlot.ts).
 *
 * Auto-refresh and saved inputs sat beside the first card's title, a select
 * and a menu side by side over the pane's own inputs; here they're out of the
 * way and in one place, with which session variables the pane follows (D60)
 * and whether it shows its inputs in a dashboard (D61). A pane's results keep
 * their Clear in their own card: that's about what's on screen, not a setting.
 */

import { createPortal } from "react-dom";
import Icon from "../components/Icon";
import Popover from "../components/Popover";
import { usePaneMenuSlot } from "../components/paneMenuSlot";
import { PaneApi } from "./paneApi";
import { RefreshBadge, RefreshSection, RefreshState } from "./refresh";
import { SavedInputs, SavedInputsSection } from "./SavedInputsMenu";
import { VariableName } from "./variables";

export interface Follow {
  name: VariableName;
  label: string;
  following: boolean;
  set: (follow: boolean) => void;
}

export interface InputsShown {
  /** The pane's own choice; undefined follows the session's view mode. */
  own: "shown" | "hidden" | undefined;
  sessionView: boolean;
  viewer: boolean;
  set: (value: "shown" | "hidden" | undefined) => void;
}

export default function PaneSettings({
  pane,
  refresh,
  saved,
  follows,
  inputs,
}: {
  pane: PaneApi;
  refresh: RefreshState;
  saved: SavedInputs;
  follows: Follow[];
  inputs: InputsShown;
}) {
  const { el: slot, label: own } = usePaneMenuSlot();
  if (!slot) return null;
  const label = own || pane.m.label;
  return createPortal(
    <span className="pane-menu">
      <RefreshBadge state={refresh} />
      <Popover
        glyph={<Icon name="gear" />}
        label={`${label} settings`}
        title="Settings: auto-refresh, session variables, inputs, saved inputs"
        buttonClass="secondary icon-btn pane-menu-button"
        menuClass="rail-row-menu pane-menu-list"
        width={260}
        onOpen={saved.load}
      >
        {(close) => (
          <>
            <RefreshSection m={pane.m} state={refresh} />
            {follows.length > 0 && !inputs.viewer && (
              <>
                <div className="pane-menu-heading">Session variables</div>
                {follows.map((f) => (
                  <label key={f.name} className="pane-menu-check">
                    <input type="checkbox" checked={f.following} onChange={(e) => f.set(e.target.checked)} /> Follow the
                    session's {f.label}
                  </label>
                ))}
              </>
            )}
            {!inputs.viewer && (
              <>
                <div className="pane-menu-heading">Inputs</div>
                <label className="pane-menu-field">
                  <select
                    aria-label="This pane's inputs"
                    value={inputs.own ?? "session"}
                    onChange={(e) => inputs.set(e.target.value === "session" ? undefined : (e.target.value as "shown" | "hidden"))}
                  >
                    <option value="session">As the session ({inputs.sessionView ? "hidden" : "shown"})</option>
                    <option value="shown">Shown</option>
                    <option value="hidden">Hidden: outputs only</option>
                  </select>
                </label>
              </>
            )}
            <SavedInputsSection pane={pane} saved={saved} close={close} />
          </>
        )}
      </Popover>
    </span>,
    slot,
  );
}
