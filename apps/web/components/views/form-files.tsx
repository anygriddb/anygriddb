import { Button, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Paperclip, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes } from "../../lib/format";
import { FileRefused, type SentFile } from "../../lib/send-file";

/** The most files an attachment field holds. */
const MAX_FILES = 20;

/**
 * An attachment field of a form: files are sent one by one as they are
 * chosen, and the answer names them. Named by the field's label, described
 * by its description.
 */
export function FormFiles({
  id,
  labelId,
  descriptionId,
  required,
  files,
  onChange,
  send,
}: {
  id: string;
  labelId: string;
  descriptionId?: string;
  required: boolean;
  files: readonly SentFile[];
  onChange: (files: SentFile[]) => void;
  send: (file: File) => Promise<SentFile>;
}) {
  const { t } = useLingui();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  function refusal(cause: unknown, name: string): string {
    const reason = cause instanceof FileRefused ? cause.reason : "refused";
    switch (reason) {
      case "too_large":
        return t`“${{ name }}” is too large`;
      case "busy":
        return t`Too many files are being sent right now. Try again in a moment.`;
      case "too_many":
        return t`Too many files were sent in a short time. Wait a minute, then try again.`;
      default:
        return t`“${{ name }}” could not be sent`;
    }
  }

  async function add(list: FileList) {
    const chosen = [...list].slice(0, Math.max(0, MAX_FILES - files.length));
    setBusy(true);
    setProblem("");
    let kept = [...files];
    try {
      for (const file of chosen) {
        try {
          kept = [...kept, await send(file)];
          onChange(kept);
        } catch (cause) {
          setProblem(refusal(cause, file.name));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      className="flex flex-col gap-2"
    >
      {required ? <span className="sr-only">{t`Required`}</span> : null}
      {files.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {files.map((file) => (
            <li key={file.key} className="flex min-w-0 items-center gap-2">
              <Paperclip className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{file.filename}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(file.size)}
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t`Remove ${{ name: file.filename }}`}
                disabled={busy}
                onClick={() =>
                  onChange(files.filter((item) => item.key !== file.key))
                }
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          if (event.target.files?.length) void add(event.target.files);
          event.target.value = "";
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={busy || files.length >= MAX_FILES}
        onClick={() => input.current?.click()}
      >
        {busy ? <Spinner /> : <Plus className="h-4 w-4" aria-hidden />}
        {t`Add a file`}
      </Button>
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
