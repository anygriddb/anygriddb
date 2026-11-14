import {
  PEOPLE_FILE_MAX,
  PEOPLE_FILE_MAX_BYTES,
  PEOPLE_FILE_SAMPLE,
  type PeopleFileProblem,
} from "@anygriddb/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Spinner,
} from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Download, FileUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { downloadCsv } from "../../lib/download";
import { useErrorText } from "../../lib/errors";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { useStepUp } from "./step-up";

type Preview = RouterOutputs["admin"]["people"]["preview"];
type Line = Preview["lines"][number];

/** Why a line of the file adds nobody, in the reader's words. */
function useProblemText() {
  const { t } = useLingui();
  return (problem: PeopleFileProblem, base: string | null): string => {
    switch (problem) {
      case "invalid_email":
        return t`Not an email address`;
      case "invalid_name":
        return t`The name is missing, or holds a sign a name cannot`;
      case "twice":
        return t`This address is in the file twice`;
      case "invalid_bases":
        return t`Bases are written "Base name:role", with a role among owner, editor, commenter, viewer, each base once`;
      case "too_many_bases":
        return t`More than 20 bases for one person`;
      case "account_exists":
        return t`This address already has an account`;
      case "unknown_base":
        return t`No base is named ${{ base: base ?? "" }}`;
      case "ambiguous_base":
        return t`Several bases are named ${{ base: base ?? "" }}: write the id from its address instead`;
      case "domain_not_allowed":
        return t`Roles are limited to the instance's domains, and this address is outside them`;
    }
  };
}

/**
 * People added from a file (ROADMAP #36): the file is read and shown line
 * by line before anything is written, then the lines in order are added.
 * Nobody becomes an administrator this way, and each person gets their
 * first link by email: without email set up there is nothing to add.
 */
export function PeopleFileDialog({
  mails,
  onClose,
  onAdded,
}: {
  mails: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const roleLabel = useRoleLabel();
  const problemText = useProblemText();
  const stepUp = useStepUp();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  async function read(chosen: File) {
    if (chosen.size > PEOPLE_FILE_MAX_BYTES) {
      toast.error(errorText({ code: "people_file_too_long" }));
      return;
    }
    setBusy(true);
    try {
      const text = await chosen.text();
      setPreview(await trpc.admin.people.preview.mutate({ file: text }));
      setFile({ name: chosen.name, text });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!file || busy) return;
    setBusy(true);
    try {
      if (!(await stepUp.ensure())) return;
      const { added } = await trpc.admin.people.add.mutate({
        file: file.text,
      });
      onAdded();
      onClose();
      toast.success(
        plural(added, {
          one: "# person added. Their link is on its way by email.",
          other: "# people added. Their links are on their way by email.",
        }),
      );
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const ready = preview?.ready ?? 0;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      {stepUp.dialog}
      <DialogContent
        title={t`Add people from a file`}
        description={t`One line per person, at most ${PEOPLE_FILE_MAX}. Each gets a link by email to choose their password, valid a week. Nobody becomes an administrator this way.`}
      >
        <div className="flex flex-col gap-3 text-sm">
          {!mails ? (
            <p className="rounded-sm border border-border bg-muted px-3 py-2">
              {t`Email is not set up, and each person gets their link by email: set it up under Connections first.`}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {t`The first line names the columns: email, name, and bases to give roles from the start, written "Base name:role; Other base:role" (owner, editor, commenter, viewer).`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={`inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 font-medium focus-within:ring-2 focus-within:ring-ring ${
                mails && !busy
                  ? "cursor-pointer hover:bg-muted"
                  : "cursor-not-allowed opacity-60"
              }`}
            >
              {busy ? <Spinner /> : <FileUp className="h-4 w-4" aria-hidden />}
              {file ? t`Choose another file` : t`Choose a file`}
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="sr-only"
                disabled={!mails || busy}
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  if (chosen) void read(chosen);
                  event.target.value = "";
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                downloadCsv("anygriddb-people.csv", PEOPLE_FILE_SAMPLE)
              }
            >
              <Download className="h-4 w-4" aria-hidden />
              {t`Download a sample`}
            </Button>
          </div>
          {file && preview ? (
            <>
              <p aria-live="polite">
                {t`${{ name: file.name }}: ${ready} of ${{ total: preview.lines.length }} lines in order.`}
              </p>
              <div className="max-h-72 overflow-auto rounded-sm border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted text-left text-xs">
                    <tr>
                      <th className="px-2 py-1.5">{t`File line`}</th>
                      <th className="px-2 py-1.5">{t`Person`}</th>
                      <th className="px-2 py-1.5">{t`Bases`}</th>
                      <th className="px-2 py-1.5">{t`Status`}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((line: Line) => (
                      <tr
                        key={line.line}
                        className="border-t border-border align-top"
                      >
                        <td className="px-2 py-1.5 text-xs tabular-nums">
                          {line.line}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="block">{line.displayName}</span>
                          <span className="block text-xs text-muted-foreground">
                            {line.email}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {line.bases.length === 0
                            ? "—"
                            : line.bases.map((base) => (
                                <span key={base.baseId} className="block">
                                  {t`${{ base: base.name }}: ${{ role: roleLabel(base.role) }}`}
                                </span>
                              ))}
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {line.problem ? (
                            <span className="text-danger">
                              {problemText(line.problem, line.base)}
                            </span>
                          ) : (
                            t`In order`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button disabled={busy || ready === 0} onClick={() => void add()}>
            {ready === 0
              ? t`Add people`
              : plural(ready, {
                  one: "Add # person",
                  other: "Add # people",
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
