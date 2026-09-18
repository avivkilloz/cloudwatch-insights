import { useEffect, useRef, useState } from "react";
import { exportCsv, exportJson, exportXlsx } from "../export";

interface Props {
  /** The exact rows currently on screen -- callers should pass post-filter/
   * sort/limit data so the export matches what the user is looking at.
   * Typed loosely (rather than Record<string, unknown>[]) so callers can
   * pass any concrete result-item array (S3FileInfo[], CognitoUserInfo[],
   * etc.) without a cast at every call site -- export.ts only ever reads
   * these via Object.keys/values, which works on any plain object shape. */
  rows: object[];
  /** When the user has checked rows in the results list, export exports just
   * those instead of everything on screen. */
  selectedRows?: object[];
  /** Used as the downloaded file's base name (without extension). */
  filename: string;
}

export default function ExportMenu({ rows, selectedRows, filename }: Props) {
  const exportingSelection = (selectedRows?.length ?? 0) > 0;
  const objectRows = (exportingSelection ? selectedRows! : rows) as Record<string, unknown>[];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function handle(kind: "csv" | "xlsx" | "json") {
    setOpen(false);
    if (objectRows.length === 0) return;
    setBusy(true);
    try {
      if (kind === "csv") exportCsv(filename, objectRows);
      else if (kind === "json") exportJson(filename, objectRows);
      else await exportXlsx(filename, objectRows);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="icon-popover-wrap">
      <div ref={ref}>
        <button
          className="secondary"
          onClick={() => setOpen((o) => !o)}
          disabled={objectRows.length === 0 || busy}
          title={exportingSelection ? "Exporting only the rows you checked" : undefined}
        >
          {busy ? "Exporting…" : exportingSelection ? `Export ${objectRows.length} selected ▾` : "Export ▾"}
        </button>
        {open && (
          <div className="icon-popover" style={{ minWidth: 140 }}>
            <button className="icon-popover-item" onClick={() => handle("csv")}>
              CSV
            </button>
            <button className="icon-popover-item" onClick={() => handle("xlsx")}>
              Excel (.xlsx)
            </button>
            <button className="icon-popover-item" onClick={() => handle("json")}>
              JSON
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
