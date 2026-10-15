/**
 * A pane's ⋮: its settings, in its header (or its tab, in the tabs layout),
 * through the spot the frame leaves for it (components/paneMenuSlot.ts).
 *
 * Auto-refresh and saved inputs sat beside the first card's title, a select
 * and a menu side by side over the pane's own inputs; here they're out of the
 * way and in one place, which has room for what comes next (hiding a pane's
 * inputs on a dashboard, PLATFORM_PLAN.md §18). A pane's results keep their
 * Clear in their own card: that's about what's on screen, not a setting.
 */

import { createPortal } from "react-dom";
import Icon from "../components/Icon";
import Popover from "../components/Popover";
import { usePaneMenuSlot } from "../components/paneMenuSlot";
import { PaneApi } from "./paneApi";
import { RefreshBadge, RefreshSection, RefreshState } from "./refresh";
import { SavedInputs, SavedInputsSection } from "./SavedInputsMenu";

export default function PaneSettings({ pane, refresh, saved }: { pane: PaneApi; refresh: RefreshState; saved: SavedInputs }) {
  const { el: slot, label: own } = usePaneMenuSlot();
  if (!slot) return null;
  const label = own || pane.m.label;
  return createPortal(
    <span className="pane-menu">
      <RefreshBadge state={refresh} />
      <Popover
        glyph={<Icon name="gear" />}
        label={`${label} settings`}
        title="Auto-refresh, saved inputs"
        buttonClass="secondary icon-btn pane-menu-button"
        menuClass="rail-row-menu pane-menu-list"
        width={240}
        onOpen={saved.load}
      >
        {(close) => (
          <>
            <RefreshSection m={pane.m} state={refresh} />
            <SavedInputsSection pane={pane} saved={saved} close={close} />
          </>
        )}
      </Popover>
    </span>,
    slot,
  );
}
