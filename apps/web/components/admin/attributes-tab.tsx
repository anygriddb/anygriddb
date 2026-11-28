import { Button, Input, Label, Select, Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useNeeds } from "../../lib/form-needs";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog, Refusal } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { RuledSection } from "../shell/notebook-page";
import {
  attributeKeyOf,
  SCIM_FIELDS,
  scimFieldOf,
  useScimFieldLabel,
} from "./attributes";

/**
 * The attributes an instance knows of a person (ADR 0142): what a row
 * rule may name as the reader's own, a ward or a department. Each
 * account's values are set on its page, or sent by the identity provider
 * for an attribute bound to a field of SCIM's enterprise extension.
 */
export function AttributesTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const scimLabel = useScimFieldLabel();
  const listed = useQuery(api.admin.attributes.list.queryOptions());
  const [label, setLabel] = useState("");
  const [scimField, setScimField] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{
    key: string;
    label: string;
    holders: number;
  } | null>(null);
  const needs = useNeeds();

  if (listed.isError) {
    return (
      <LoadFailed error={listed.error} onRetry={() => void listed.refetch()} />
    );
  }
  if (!listed.data) return <Spinner />;

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.admin.attributes.list.queryKey(),
    });

  async function add() {
    const name = label.trim();
    const key = attributeKeyOf(name);
    const ready = needs.met([
      {
        missing: !name,
        say: t`Give the attribute a name.`,
        field: "attribute-label",
      },
      {
        missing: name !== "" && key === null,
        say: t`Start the name with a letter from A to Z.`,
        field: "attribute-label",
      },
    ]);
    if (!ready || key === null) return;
    const sent = scimFieldOf(scimField);
    setBusy(true);
    try {
      await trpc.admin.attributes.create.mutate({
        key,
        label: name,
        scimField: sent,
      });
      setLabel("");
      setScimField("");
      await refresh();
      toast.success(t`Attribute added`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
    setBusy(false);
  }

  async function bind(
    attribute: { key: string; label: string },
    field: string,
  ) {
    const sent = scimFieldOf(field);
    try {
      await trpc.admin.attributes.update.mutate({
        key: attribute.key,
        label: attribute.label,
        scimField: sent,
      });
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4 text-sm">
      <RuledSection
        title={t`Attributes of a person`}
        description={t`What a row rule may name as the reader's own: a ward, a branch, a department. Someone without a value reaches no row by such a rule. Each account's values are set on its page, or sent by your identity provider (SCIM) for an attribute bound to one of its fields.`}
      >
        {listed.data.attributes.length === 0 ? (
          <p className="text-muted-foreground">{t`No attribute yet.`}</p>
        ) : (
          <ul className="divide-y divide-border rounded-sm border border-border">
            {listed.data.attributes.map((attribute) => (
              <li
                key={attribute.key}
                className="flex flex-wrap items-center gap-3 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{attribute.label}</p>
                  <p className="text-xs text-muted-foreground">
                    <code>{attribute.key}</code>
                    {" · "}
                    {plural(attribute.holders, {
                      one: "# account holds a value",
                      other: "# accounts hold a value",
                    })}
                  </p>
                </div>
                <Select
                  aria-label={t`Sent by the identity provider as`}
                  className="h-8 w-48"
                  value={attribute.scimField ?? ""}
                  onChange={(event) => void bind(attribute, event.target.value)}
                >
                  <option value="">{t`Not sent (set here)`}</option>
                  {SCIM_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {scimLabel(field)}
                    </option>
                  ))}
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t`Remove the attribute ${{ name: attribute.label }}`}
                  onClick={() => setRemoving(attribute)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="flex min-w-56 flex-1 flex-col gap-1">
            <Label htmlFor="attribute-label">{t`New attribute`}</Label>
            <Input
              id="attribute-label"
              placeholder={t`Ward`}
              maxLength={60}
              aria-invalid={needs.invalid("attribute-label")}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <Select
            aria-label={t`Sent by the identity provider as`}
            className="w-48"
            value={scimField}
            onChange={(event) => setScimField(event.target.value)}
          >
            <option value="">{t`Not sent (set here)`}</option>
            {SCIM_FIELDS.map((field) => (
              <option key={field} value={field}>
                {scimLabel(field)}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={busy}>
            <Plus className="h-4 w-4" aria-hidden />
            {t`Add the attribute`}
          </Button>
        </form>
        <Refusal text={needs.said} />
      </RuledSection>
      {removing ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t`Remove the attribute ${{ name: removing.label }}?`}
          description={
            removing.holders > 0
              ? t`Every account's values go with it, and a rule that names it keeps no row from then on.`
              : t`A rule that names it keeps no row from then on.`
          }
          confirmLabel={t`Remove`}
          onConfirm={async () => {
            await trpc.admin.attributes.remove.mutate({ key: removing.key });
            setRemoving(null);
            await refresh();
            toast.success(t`Attribute removed`);
          }}
        />
      ) : null}
    </div>
  );
}
