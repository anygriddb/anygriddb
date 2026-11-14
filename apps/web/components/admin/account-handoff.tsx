import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  ListPicker,
  Spinner,
} from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import {
  AccountName,
  useAccountChoices,
  type AccountChoice,
} from "./account-choices";

type Kept = RouterOutputs["admin"]["handOver"]["automations"]["kept"];

/** Automations or webhooks, each with the table and the base it is on. */
function Made({ title, items }: { title: string; items: Kept }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="mt-1 list-disc pl-4 text-xs">
        {items.map((item) => (
          <li key={item.id}>
            {item.name || "—"} · {item.base} / {item.table}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Hands a leaving person's work to someone who stays (ROADMAP #21): the
 * bases they alone own, and the automations and webhooks they made. It
 * says first what there is, then what moved and what could not: an
 * automation or a webhook runs with its author's rights, so it moves only
 * where the successor may manage its table.
 */
export function AccountHandoff({
  target,
  onClose,
}: {
  target: { id: string; displayName: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Mounted while open only: each opening starts afresh. */}
      {target ? <HandoffForm target={target} onClose={onClose} /> : null}
    </Dialog>
  );
}

function HandoffForm({
  target,
  onClose,
}: {
  target: { id: string; displayName: string };
  onClose: () => void;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [successor, setSuccessor] = useState<AccountChoice | null>(null);
  const [revokeTokens, setRevokeTokens] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    RouterOutputs["admin"]["handOver"] | null
  >(null);
  const info = useQuery(
    api.admin.handoffInfo.queryOptions({ userId: target.id }),
  );
  // Looked up once something is typed: an instance may hold hundreds of
  // accounts, and the one who takes over is known by name.
  const searching = typed.trim() !== "";
  const choices = useAccountChoices(typed, successor === null && searching);
  const options = searching
    ? choices.options.filter((option) => option.id !== target.id)
    : [];
  const name = target.displayName;

  async function confirm() {
    if (!successor) return;
    setBusy(true);
    try {
      const done = await trpc.admin.handOver.mutate({
        fromUserId: target.id,
        toUserId: successor.id,
        revokeTokens,
      });
      setResult(done);
      await Promise.all(
        [api.admin.account, api.admin.users, api.admin.handoffInfo].map(
          (procedure) =>
            queryClient.invalidateQueries({ queryKey: procedure.queryKey() }),
        ),
      );
      toast.success(t`Handed over to ${{ successor: successor.displayName }}`);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (result && successor) {
    const kept = result.automations.kept.length + result.webhooks.kept.length;
    return (
      <DialogContent
        className="max-w-md"
        title={t`Handed over to ${{ successor: successor.displayName }}`}
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {plural(result.bases, {
              one: "# base",
              other: "# bases",
            })}
            {", "}
            {plural(result.automations.moved, {
              one: "# automation",
              other: "# automations",
            })}
            {", "}
            {plural(result.webhooks.moved, {
              one: "# webhook",
              other: "# webhooks",
            })}
            {result.tokensRevoked > 0
              ? ` · ${plural(result.tokensRevoked, { one: "# API token revoked", other: "# API tokens revoked" })}`
              : ""}
          </p>
          {kept > 0 ? (
            <>
              <p className="rounded-sm border border-warning/40 bg-warning-surface px-3 py-2">
                {t`These stay with ${name}: ${{ successor: successor.displayName }} has no role to manage their tables. They stop working when ${name}'s account is disabled. Give ${{ successor: successor.displayName }} a role on those bases, then hand over again.`}
              </p>
              <Made title={t`Automations`} items={result.automations.kept} />
              <Made title={t`Webhooks`} items={result.webhooks.kept} />
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t`Done`}</Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  const data = info.data;
  const nothing =
    data !== undefined &&
    data.bases.length === 0 &&
    data.automations.length === 0 &&
    data.webhooks.length === 0 &&
    data.tokens === 0;
  return (
    <DialogContent
      className="max-w-md"
      title={t`Hand over what ${name} owns?`}
      description={t`Someone who stays becomes an owner of the bases ${name} alone owns, and the author of the automations and webhooks ${name} made, where they may manage them. ${name}'s account and roles are left as they are.`}
    >
      {info.isError ? (
        <p className="text-sm text-danger">{errorText(info.error)}</p>
      ) : !data ? (
        <Spinner />
      ) : nothing ? (
        <p className="text-sm text-muted-foreground">
          {t`Nothing to hand over: no base owned alone, no automation, no webhook, no API token.`}
        </p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {data.bases.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t`Bases owned alone`}
              </p>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {data.bases.map((base) => (
                  <li key={base.id}>{base.name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Made title={t`Automations`} items={data.automations} />
          <Made title={t`Webhooks`} items={data.webhooks} />
          {successor ? (
            <div className="flex items-center justify-between gap-2 rounded-sm border border-border px-3 py-2">
              <AccountName
                name={successor.displayName}
                email={successor.email}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setSuccessor(null)}
              >
                {t`Change`}
              </Button>
            </div>
          ) : (
            <ListPicker
              label={t`Who takes over`}
              listLabel={t`Accounts of the instance`}
              inputValue={typed}
              onInputChange={setTyped}
              options={options}
              selectionMode="single"
              selected={[]}
              onToggle={(id) =>
                setSuccessor(
                  choices.found.find((account) => account.id === id) ?? null,
                )
              }
              className="max-h-40"
              empty={
                !searching ? (
                  t`Type a name or an address`
                ) : choices.loading ? (
                  <span className="flex justify-center">
                    <Spinner />
                  </span>
                ) : (
                  t`No account by that name`
                )
              }
            />
          )}
          {data.tokens > 0 ? (
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={revokeTokens}
                onChange={(event) => setRevokeTokens(event.target.checked)}
              />
              <span>
                {plural(data.tokens, {
                  one: "Revoke their API token too: a token is never handed over",
                  other:
                    "Revoke their # API tokens too: a token is never handed over",
                })}
              </span>
            </label>
          ) : null}
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t`Cancel`}
        </Button>
        <Button
          onClick={() => void confirm()}
          disabled={busy || !successor || nothing || !data}
        >
          {t`Hand over`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
