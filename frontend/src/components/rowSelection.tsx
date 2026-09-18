import { useEffect, useState } from "react";

// Shared row-selection machinery for every results list in the app (Logs,
// IoT things/certificates, Tables, Buckets, Cognito). Each list has its own
// row type and its own idea of a stable row key, so the hook is generic over
// both and the caller supplies `keyOf`/`toObject`.

export interface RowSelection<T> {
  /** Every row except the ones the user hid. */
  visibleRows: T[];
  /** The selected rows themselves, rather than their exported shape. */
  selectedRows: T[];
  /** A stable signature of which rows are selected -- a cheap effect dependency
   * for work that should redo itself when the selection changes. */
  selectionKey: string;
  /** Re-emits the current selection. For when what the selected rows serialize
   * to has changed (e.g. extra detail was fetched for them) rather than which
   * rows are selected. */
  resend: () => void;
  selectedCount: number;
  hiddenCount: number;
  isSelected: (row: T) => boolean;
  toggle: (row: T) => void;
  /** Select (or, when all are already selected, deselect) the rows on screen. */
  toggleAll: (displayed: T[]) => void;
  allSelected: (displayed: T[]) => boolean;
  hideSelected: () => void;
  showAllHidden: () => void;
  /** The selected rows as plain objects -- what export and the AI assistant consume. */
  selectedObjects: Record<string, unknown>[];
}

export function useRowSelection<T>(options: {
  rows: T[];
  keyOf: (row: T) => string;
  toObject: (row: T) => Record<string, unknown>;
  onSelectionChange?: (rows: Record<string, unknown>[]) => void;
  /** Selection and hides are cleared whenever this value's identity changes:
   * a new result set makes the old row keys meaningless. */
  resetOn: unknown;
}): RowSelection<T> {
  const { rows, keyOf, toObject, onSelectionChange, resetOn } = options;
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelectedKeys(new Set());
    setHiddenKeys(new Set());
    onSelectionChange?.([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetOn]);

  const selectedRows = rows.filter((r) => selectedKeys.has(keyOf(r)));

  function commit(keys: Set<string>) {
    setSelectedKeys(keys);
    onSelectionChange?.(rows.filter((r) => keys.has(keyOf(r))).map(toObject));
  }

  return {
    visibleRows: rows.filter((r) => !hiddenKeys.has(keyOf(r))),
    selectedRows,
    selectionKey: Array.from(selectedKeys).sort().join("|"),
    resend: () => onSelectionChange?.(selectedRows.map(toObject)),
    selectedCount: selectedKeys.size,
    hiddenCount: hiddenKeys.size,
    selectedObjects: selectedRows.map(toObject),
    isSelected: (row) => selectedKeys.has(keyOf(row)),
    toggle(row) {
      const next = new Set(selectedKeys);
      const key = keyOf(row);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      commit(next);
    },
    allSelected: (displayed) => displayed.length > 0 && displayed.every((r) => selectedKeys.has(keyOf(r))),
    toggleAll(displayed) {
      const deselect = displayed.length > 0 && displayed.every((r) => selectedKeys.has(keyOf(r)));
      const next = new Set(selectedKeys);
      for (const row of displayed) {
        if (deselect) next.delete(keyOf(row));
        else next.add(keyOf(row));
      }
      commit(next);
    },
    hideSelected() {
      setHiddenKeys(new Set([...hiddenKeys, ...selectedKeys]));
      commit(new Set());
    },
    showAllHidden() {
      setHiddenKeys(new Set());
    },
  };
}

export function SelectAllCheckbox<T>({ selection, displayed }: { selection: RowSelection<T>; displayed: T[] }) {
  return (
    <label className="checkbox-item" title="Select all currently shown rows">
      <input
        type="checkbox"
        checked={selection.allSelected(displayed)}
        onChange={() => selection.toggleAll(displayed)}
        disabled={displayed.length === 0}
      />
      Select all
    </label>
  );
}

export function HideSelectedButtons<T>({ selection }: { selection: RowSelection<T> }) {
  return (
    <>
      {selection.selectedCount > 0 && (
        <button className="secondary" onClick={selection.hideSelected}>
          Hide selected ({selection.selectedCount})
        </button>
      )}
      {selection.hiddenCount > 0 && (
        <button className="secondary" onClick={selection.showAllHidden}>
          Show {selection.hiddenCount} hidden
        </button>
      )}
    </>
  );
}

// Rendered inside `.result-row-summary`, whose own click handler expands the
// row -- so the checkbox has to stop the click from bubbling up to it.
export function RowCheckbox<T>({ selection, row }: { selection: RowSelection<T>; row: T }) {
  return (
    <input
      type="checkbox"
      checked={selection.isSelected(row)}
      onClick={(e) => e.stopPropagation()}
      onChange={() => selection.toggle(row)}
    />
  );
}
