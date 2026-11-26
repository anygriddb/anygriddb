import { MAX_CELL_FILES } from "@anygriddb/core";

/** A file a form sent ahead of its answer: the key the answer names, and what the form shows. */
export type SentFile = { key: string; filename: string; size: number };

/** Why the server refused a file, from its answer. */
type FileRefusal = "too_large" | "full" | "busy" | "too_many" | "refused";

/** A quota of storage the file would pass (ADR 0136). */
const FULL = new Set(["base_storage_full", "account_storage_full"]);

export class FileRefused extends Error {
  constructor(
    readonly reason: FileRefusal,
    /** The server's code, which `useErrorText` says in words. */
    readonly code?: string,
  ) {
    super(reason);
    this.name = "FileRefused";
  }
}

export function refusalOf(status: number, code?: string): FileRefusal {
  if (code !== undefined && FULL.has(code)) return "full";
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

/**
 * What a cell that already holds `held` files can still take of those
 * chosen, and how many are left out: nothing is sent that the cell would
 * refuse afterwards.
 */
export function filesThatFit<T>(
  chosen: readonly T[],
  held: number,
): { fit: T[]; left: number } {
  const room = Math.max(0, MAX_CELL_FILES - held);
  return {
    fit: chosen.slice(0, room),
    left: Math.max(0, chosen.length - room),
  };
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
  if (!response.ok) {
    const answer: unknown = await response.json().catch(() => null);
    const code =
      answer &&
      typeof answer === "object" &&
      "code" in answer &&
      typeof answer.code === "string"
        ? answer.code
        : undefined;
    throw new FileRefused(refusalOf(response.status, code), code);
  }
  const meta = (await response.json()) as SentFile;
  return { key: meta.key, filename: meta.filename, size: meta.size };
}
