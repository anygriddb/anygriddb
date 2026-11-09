import { Button, Dialog, DialogContent } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight, Download, Paperclip } from "lucide-react";
import { useEffect } from "react";
import { formatBytes, type AttachmentValue } from "../../lib/format";
import { isPreviewableImage, stepFile } from "./attachment-preview-model";

/**
 * A file of a cell, large: images in full, any other type as a download.
 * The arrows and the left and right keys move between the cell's files.
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
            {isPreviewableImage(file.mime) ? (
              <img
                src={url}
                alt={file.filename}
                className="max-h-[60vh] max-w-full object-contain"
              />
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
              href={url}
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
