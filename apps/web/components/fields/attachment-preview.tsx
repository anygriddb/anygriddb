import { attachmentPreviewKind } from "@anygriddb/core";
import { Button, Dialog, DialogContent } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight, Download, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";
import { type AttachmentValue } from "../../lib/format";
import { useFormatBytes } from "../../lib/format-bytes";
import { stepFile } from "./attachment-preview-model";

/** Above this, the text preview asks for a download instead of loading. */
const TEXT_PREVIEW_BYTES = 1_048_576;

/**
 * A file of a cell, large: images, PDFs, and plain text in full; any other
 * type as a download. Arrows and left/right keys move between files.
 */
export function AttachmentPreview({
  files,
  index,
  onIndex,
  onClose,
}: {
  files: readonly AttachmentValue[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const formatBytes = useFormatBytes();
  const file = files[index];
  const many = files.length > 1;
  useEffect(() => {
    if (!many) return;
    // Captured before the grid or a cell editor below can stop the key.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      onIndex(
        stepFile(index, event.key === "ArrowLeft" ? -1 : 1, files.length),
      );
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [many, index, files.length, onIndex]);
  if (!file) return null;
  const url = `/api/attachments/${file.key}`;
  const downloadUrl = `${url}?download=1`;
  const kind = attachmentPreviewKind(file.mime);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        wide
        title={file.filename}
        description={[
          many
            ? t`${{ position: index + 1 }} of ${{ total: files.length }}`
            : "",
          file.size > 0 ? formatBytes(file.size) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <div className="flex flex-col gap-3">
          <div className="flex min-h-48 items-center justify-center rounded-md bg-muted">
            {kind === "image" ? (
              <img
                src={url}
                alt={file.filename}
                className="max-h-[60vh] max-w-full object-contain"
              />
            ) : kind === "pdf" ? (
              <iframe
                title={file.filename}
                src={url}
                className="h-[60vh] w-full rounded-md border-0 bg-background"
              />
            ) : kind === "text" ? (
              <TextPreview key={file.key} url={url} size={file.size} />
            ) : (
              <div className="flex flex-col items-center gap-2 p-8 text-sm text-muted-foreground">
                <Paperclip className="h-8 w-8" aria-hidden />
                {t`No preview for this file type: download it.`}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {many ? (
              <>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={t`Previous file`}
                  onClick={() => onIndex(stepFile(index, -1, files.length))}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label={t`Next file`}
                  onClick={() => onIndex(stepFile(index, 1, files.length))}
                >
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </>
            ) : null}
            <a
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
              href={downloadUrl}
              download={file.filename}
            >
              <Download className="h-4 w-4" aria-hidden />
              {t`Download`}
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TextPreview({ url, size }: { url: string; size: number }) {
  const { t } = useLingui();
  const tooLarge = size > TEXT_PREVIEW_BYTES;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; text: string }
    | { status: "error" }
  >(() => ({ status: tooLarge ? "error" : "loading" }));
  useEffect(() => {
    if (tooLarge) return;
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("preview failed");
        const length = Number(response.headers.get("content-length") ?? "0");
        if (length > TEXT_PREVIEW_BYTES) throw new Error("too large");
        const text = await response.text();
        if (new TextEncoder().encode(text).length > TEXT_PREVIEW_BYTES) {
          throw new Error("too large");
        }
        if (!controller.signal.aborted) setState({ status: "ready", text });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [url, tooLarge]);
  if (tooLarge || state.status === "error") {
    return (
      <div className="flex flex-col items-center gap-2 p-8 text-sm text-muted-foreground">
        <Paperclip className="h-8 w-8" aria-hidden />
        {t`This text file cannot be previewed: download it.`}
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <p className="p-8 text-sm text-muted-foreground">{t`Loading preview…`}</p>
    );
  }
  return (
    <pre className="max-h-[60vh] w-full overflow-auto rounded-md bg-background p-4 text-left text-xs whitespace-pre-wrap break-words text-foreground">
      {state.text}
    </pre>
  );
}
