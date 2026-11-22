/**
 * Rows pasted from a spreadsheet, as a file the import reads: a tab in the
 * first line makes it TSV (what spreadsheets copy), a comma or a semicolon
 * CSV. A first line with none of them is one column, sent as TSV so that a
 * comma in a value stays in its cell. The first line names the columns, as
 * in a file. Undefined when nothing was pasted.
 */
export function pastedFile(text: string, name: string): File | undefined {
  const trimmed = text.replace(/^\s*\n/, "").trimEnd();
  if (!trimmed) return undefined;
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const tsv = firstLine.includes("\t") || !/[,;]/.test(firstLine);
  return new File([`${trimmed}\n`], `${name}.${tsv ? "tsv" : "csv"}`, {
    type: tsv ? "text/tab-separated-values" : "text/csv",
  });
}
