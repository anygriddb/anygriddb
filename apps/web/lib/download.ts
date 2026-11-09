/** Saves text the app built (a CSV export, a support bundle) as a file. */
export function downloadText(
  filename: string,
  body: string,
  type = "text/plain;charset=utf-8",
): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // The click has handed the blob to the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadCsv(filename: string, csv: string): void {
  downloadText(filename, csv, "text/csv;charset=utf-8");
}

export function downloadJson(filename: string, value: unknown): void {
  downloadText(
    filename,
    `${JSON.stringify(value, null, 2)}\n`,
    "application/json;charset=utf-8",
  );
}

/** `name-2026-11-09.ext`, in the reader's day. */
export function datedName(name: string, extension: string): string {
  const day = new Date().toLocaleDateString("sv-SE");
  return `${name}-${day}.${extension}`;
}
