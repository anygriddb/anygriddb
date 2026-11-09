/**
 * Copying text, wherever AnyGridDB is opened. Browsers give the clipboard
 * API to HTTPS and localhost only: on a plain-HTTP address of the local
 * network, a copy button falls back to a selected, hidden text area.
 */
import { useLingui } from "@lingui/react/macro";
import { useCallback } from "react";
import { toast } from "sonner";

function copyBySelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    // The only way left without a secure context.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Whether `text` reached the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && "clipboard" in navigator) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyBySelection(text);
    }
  }
  return copyBySelection(text);
}

/** Copies, then says whether it worked: `done` on success. */
export function useCopy(): (text: string, done?: string) => void {
  const { t } = useLingui();
  return useCallback(
    (text: string, done?: string) => {
      void copyText(text).then((copied) => {
        if (copied) {
          toast.success(done ?? t`Copied`);
        } else {
          toast.error(
            t`The browser refused to copy: select the text and copy it.`,
          );
        }
      });
    },
    [t],
  );
}
