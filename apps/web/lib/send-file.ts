/** A file a form sent ahead of its answer: the key the answer names, and what the form shows. */
export type SentFile = { key: string; filename: string; size: number };

/** Why the server refused a file, from its answer's status. */
type FileRefusal = "too_large" | "busy" | "too_many" | "refused";

export class FileRefused extends Error {
  constructor(readonly reason: FileRefusal) {
    super(reason);
    this.name = "FileRefused";
  }
}

export function refusalOf(status: number): FileRefusal {
  if (status === 413) return "too_large";
  if (status === 503) return "busy";
  if (status === 429) return "too_many";
  return "refused";
}

/** Where a public form's link sends a file for one of its fields (ADR 0062). */
export function formFileUrl(token: string, field: string): string {
  return `/api/shares/${encodeURIComponent(token)}/attachments?field=${encodeURIComponent(field)}`;
}

/** Where a member sends a file for a table. */
export function tableFileUrl(tableId: string): string {
  return `/api/attachments?tableId=${encodeURIComponent(tableId)}`;
}

/** Sends one file, and returns what the server kept of it. */
export async function sendFile(
  url: string,
  file: File,
  headers?: Record<string, string>,
): Promise<SentFile> {
  const body = new FormData();
  body.append("file", file, file.name);
  const response = await fetch(url, { method: "POST", body, headers });
  if (!response.ok) throw new FileRefused(refusalOf(response.status));
  const meta = (await response.json()) as SentFile;
  return { key: meta.key, filename: meta.filename, size: meta.size };
}
