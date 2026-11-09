import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { AlertTriangle, Lock, PenLine, Send, Unlock } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { reasonOf, useErrorText } from "../../lib/errors";
import { cellDisplay } from "../../lib/format";
import { trpc } from "../../lib/trpc";
import { canManage, canWrite, type RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";

const STATUS_LABELS: Record<string, MessageDescriptor> = {
  draft: msg`Draft`,
  submitted: msg`Submitted`,
  locked: msg`Locked`,
  signed: msg`Signed`,
};

type Status = "submitted" | "locked" | "draft";

/**
 * A row's status and what can move it: submit, lock, sign, unlock. On a
 * client's row, a lock seals the values; a change made elsewhere since
 * then shows here, with the values that were sealed (ADR 0033).
 */
export function RowStatus({ row }: { row: RowItem }) {
  const { t, i18n } = useLingui();
  const table = useTable();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [signing, setSigning] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const status = row.ag_status;
  // A client's table without a key names no row: it has no status.
  if (typeof status !== "string") return null;
  const external = table.table.external !== null;
  const write = canWrite(table.role);
  const manage = canManage(table.role);

  async function move(next: Status) {
    setBusy(true);
    try {
      await trpc.rows.setStatus.mutate({
        tableId: table.table.id,
        rowId: row.id,
        status: next,
      });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const drift = row.drift;
  const byName = new Map(
    table.table.columns.map((column) => [column.name, column]),
  );
  return (
    <section
      aria-label={t`Row status`}
      className="flex flex-col gap-2 border-b border-border px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            status === "signed" || status === "locked"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {status === "locked" || status === "signed" ? (
            <Lock className="h-3 w-3" aria-hidden />
          ) : null}
          {i18n._(STATUS_LABELS[status] ?? msg`Draft`)}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {write && status === "draft" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void move("submitted")}
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              {t`Submit`}
            </Button>
          ) : null}
          {manage && status === "submitted" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void move("locked")}
            >
              <Lock className="h-3.5 w-3.5" aria-hidden />
              {t`Lock`}
            </Button>
          ) : null}
          {manage && status === "locked" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || drift !== null}
              onClick={() => setSigning(true)}
            >
              <PenLine className="h-3.5 w-3.5" aria-hidden />
              {t`Sign`}
            </Button>
          ) : null}
          {manage && (status === "locked" || status === "signed") ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setUnlocking(true)}
            >
              <Unlock className="h-3.5 w-3.5" aria-hidden />
              {t`Unlock`}
            </Button>
          ) : null}
        </div>
      </div>
      {row.signature ? (
        <p className="text-xs text-muted-foreground">
          {t`Signed by ${{ name: row.signature.displayName }} on ${{
            date: new Date(row.signature.signedAt).toLocaleString(
              table.locale === "fr" ? "fr-FR" : "en-GB",
            ),
          }}: “${{ meaning: row.signature.meaning }}”`}
        </p>
      ) : null}
      {external && status === "locked" && !drift ? (
        <p className="text-xs text-muted-foreground">
          {t`AnyGridDB refuses any change to this row. The client's database can still be changed by its other applications: AnyGridDB compares the row with its locked values and warns if it changes.`}
        </p>
      ) : null}
      {drift ? (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-danger"
            aria-hidden
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium">
              {drift.missing
                ? t`This row has disappeared from the client's database since it was locked.`
                : t`This row was changed outside AnyGridDB since it was locked.`}
            </p>
            <p className="text-muted-foreground">
              {t`Found on ${{
                date: new Date(drift.at).toLocaleString(
                  table.locale === "fr" ? "fr-FR" : "en-GB",
                ),
              }}. An owner can unlock it, check it, then lock it again.`}
            </p>
            {drift.fields.length > 0 ? (
              <ul className="flex flex-col gap-0.5">
                {drift.fields.map((name) => {
                  const column = byName.get(name);
                  const sealed = drift.sealed[name];
                  return (
                    <li key={name}>
                      <span className="font-medium">
                        {column?.label ?? name}
                      </span>{" "}
                      :{" "}
                      {t`locked value ${{
                        value: column
                          ? cellDisplay(
                              sealed,
                              column,
                              table.locale,
                              table.people,
                            ) || "∅"
                          : JSON.stringify(sealed ?? null),
                      }}`}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
      <SignDialog
        open={signing}
        onOpenChange={setSigning}
        tableId={table.table.id}
        rowId={row.id}
      />
      <UnlockDialog
        open={unlocking}
        onOpenChange={setUnlocking}
        signed={status === "signed"}
        onConfirm={() => move("draft")}
      />
    </section>
  );
}

function UnlockDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signed: boolean;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        title={t`Unlock the row?`}
        description={
          props.signed
            ? t`The row goes back to draft and can be changed again. Its signature stays in the history.`
            : t`The row goes back to draft and can be changed again.`
        }
      >
        <DialogFooter className="mt-0">
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            {t`Cancel`}
          </Button>
          <Button
            onClick={async () => {
              await props.onConfirm();
              props.onOpenChange(false);
            }}
          >
            {t`Unlock`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SignDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  rowId: string;
}) {
  const { t } = useLingui();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        title={t`Sign the row`}
        description={t`Your signature commits you: enter your password again.`}
      >
        {/* Mounted while open only: each opening starts empty. */}
        <SignForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function SignForm(props: {
  onOpenChange: (open: boolean) => void;
  tableId: string;
  rowId: string;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [meaning, setMeaning] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!meaning.trim() || password.length < 12) return;
    setBusy(true);
    try {
      await trpc.rows.sign.mutate({
        tableId: props.tableId,
        rowId: props.rowId,
        meaning: meaning.trim(),
        password,
      });
      props.onOpenChange(false);
    } catch (error) {
      toast.error(errorText(error));
      // A row that cannot be signed now closes the dialog; a mistyped
      // password leaves it open, to type again.
      if (reasonOf(error).code !== "invalid_credentials") {
        props.onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor="sign-meaning">{t`Meaning`}</Label>
      <Input
        id="sign-meaning"
        autoFocus
        placeholder={t`For example: Approved, Verified, Reviewed`}
        value={meaning}
        maxLength={500}
        onChange={(event) => setMeaning(event.target.value)}
      />
      <Label htmlFor="sign-password">{t`Password`}</Label>
      <Input
        id="sign-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <DialogFooter>
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          {t`Cancel`}
        </Button>
        <Button
          type="submit"
          disabled={busy || !meaning.trim() || password.length < 12}
        >
          {t`Sign`}
        </Button>
      </DialogFooter>
    </form>
  );
}
