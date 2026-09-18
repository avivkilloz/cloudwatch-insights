// Client-side result exports (CSV/XLSX/JSON) -- everything here runs
// entirely in the browser against data already fetched from the backend,
// no server endpoint involved. XLSX generation is dynamically imported so
// its (small but non-zero) bundle cost is only paid by users who actually
// click "Export as Excel".

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

// Objects/arrays (e.g. a thing's attributes, a certificate's policies) are
// flattened to their JSON text -- there's no generic tabular shape for them
// otherwise, and CSV/XLSX have no native concept of a nested cell.
function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function exportJson(filename: string, rows: Record<string, unknown>[]) {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  triggerDownload(`${filename}.json`, blob);
}

export function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  const columns = collectColumns(rows);
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(cellToString(row[c]))).join(","));
  }
  // A leading UTF-8 BOM so Excel (not just browsers) opens non-ASCII text
  // in the export correctly instead of guessing the wrong encoding.
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  triggerDownload(`${filename}.csv`, blob);
}

export async function exportXlsx(filename: string, rows: Record<string, unknown>[]) {
  const writeXlsxFile = (await import("write-excel-file/browser")).default;
  const columns = collectColumns(rows);
  const headerRow = columns.map((c) => ({ value: c, fontWeight: "bold" as const }));
  const dataRows = rows.map((row) => columns.map((c) => ({ value: cellToString(row[c]), type: String })));
  await writeXlsxFile([headerRow, ...dataRows]).toFile(`${filename}.xlsx`);
}
