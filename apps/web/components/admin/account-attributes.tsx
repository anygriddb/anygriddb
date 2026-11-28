import { Button, Label, Textarea } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { useScimFieldLabel } from "./attributes";

/** Values as typed: one a line, blank lines and repeats left out. */
function valuesOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ];
}

/**
 * An account's values of the instance's attributes (ADR 0142), which a
 * row rule may name: set here by whoever gives access, except those the
 * identity provider sends for an account it provisions.
 */
export function AccountAttributes(props: {
  userId: string;
  /** Provisioned by SCIM: the bound attributes are the provider's. */
  managed: boolean;
  canChange: boolean;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const scimLabel = useScimFieldLabel();
  const catalogue = useQuery(api.admin.attributes.list.queryOptions());
  const held = useQuery(
    api.admin.attributes.ofAccount.queryOptions({ userId: props.userId }),
  );
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const attributes = catalogue.data?.attributes ?? [];
  if (attributes.length === 0 || !held.data) return null;
  const values = held.data.values;
  const textOf = (key: string) => draft[key] ?? (values[key] ?? []).join("\n");
  const changed = Object.keys(draft).filter(
    (key) =>
      valuesOf(draft[key] ?? "").join("\n") !== (values[key] ?? []).join("\n"),
  );

  async function save() {
    setBusy(true);
    try {
      await trpc.admin.attributes.setForAccount.mutate({
        userId: props.userId,
        values: Object.fromEntries(
          changed.map((key) => [key, valuesOf(draft[key] ?? "")]),
        ),
      });
      setDraft({});
      await queryClient.invalidateQueries({
        queryKey: api.admin.attributes.ofAccount.queryKey({
          userId: props.userId,
        }),
      });
      toast.success(t`Attributes saved`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
    setBusy(false);
  }

  return (
    <section
      className="flex flex-col gap-2 text-sm"
      aria-labelledby="account-attributes"
    >
      <h3
        id="account-attributes"
        className="text-xs font-medium text-muted-foreground"
      >
        {t`Attributes`}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t`What a row rule may name as this person's own. Without a value, such a rule gives them no row.`}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {attributes.map((attribute) => {
          const provided = props.managed && attribute.scimField !== null;
          const id = `attribute-${attribute.key}`;
          return (
            <div key={attribute.key} className="flex flex-col gap-1">
              <Label htmlFor={id}>{attribute.label}</Label>
              {provided || !props.canChange ? (
                <p id={id} className="text-sm">
                  {(values[attribute.key] ?? []).join(", ") || t`No value`}
                  {provided && attribute.scimField ? (
                    <span className="block text-xs text-muted-foreground">
                      {t`Sent by your identity provider, as ${{ field: scimLabel(attribute.scimField) }}`}
                    </span>
                  ) : null}
                </p>
              ) : (
                <>
                  <Textarea
                    id={id}
                    rows={2}
                    aria-describedby={`${id}-hint`}
                    value={textOf(attribute.key)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        [attribute.key]: event.target.value,
                      })
                    }
                  />
                  <span
                    id={`${id}-hint`}
                    className="text-xs text-muted-foreground"
                  >
                    {t`One value a line`}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {props.canChange && changed.length > 0 ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {t`Save the attributes`}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft({})}>
            {t`Cancel`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
