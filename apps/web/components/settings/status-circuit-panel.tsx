import {
  SHIPPED_CIRCUIT_KEYS,
  type ShippedCircuitKey,
  type StatusCircuit,
} from "@anygriddb/core";
import { Button, Select, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { useLingui } from "@lingui/react/macro";
import { circuitWord } from "../record/circuit-labels";

function CircuitSummary({ circuit }: { circuit: StatusCircuit }) {
  const { t, i18n } = useLingui();
  const stateWord = (key: string) =>
    circuitWord(i18n, "state", {
      key,
      label: circuit.states.find((state) => state.key === key)?.label,
    });
  const states = [...circuit.states].sort((a, b) => a.position - b.position);
  const transitions = [...circuit.transitions].sort(
    (a, b) => a.position - b.position,
  );
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">
          {circuitWord(i18n, "template", circuit)}
        </span>
      </p>
      <div>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t`States`}
        </h4>
        <ul className="flex flex-col gap-0.5">
          {states.map((state) => (
            <li key={state.key} className="flex flex-wrap items-center gap-1">
              <span className="font-medium">
                {circuitWord(i18n, "state", state)}
              </span>
              {state.isInitial ? (
                <span className="text-xs text-muted-foreground">
                  {t`· initial`}
                </span>
              ) : null}
              {state.seal ? (
                <span className="text-xs text-muted-foreground">
                  {t`· sealed`}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t`Transitions`}
        </h4>
        <ul className="flex flex-col gap-1">
          {transitions.map((transition) => (
            <li
              key={transition.id}
              className="flex flex-wrap items-center gap-1"
            >
              <span className="font-medium">
                {circuitWord(i18n, "transition", transition)}
              </span>
              <span className="text-muted-foreground">
                {stateWord(transition.fromStateKey)}
              </span>
              <ArrowRight
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label={t`to`}
              />
              <span className="text-muted-foreground">
                {stateWord(transition.toStateKey)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Read-only summary of the table's status circuit and a picker to apply a
 * shipped template (ADR 0124).
 */
export function StatusCircuitPanel(props: { tableId: string }) {
  const { t, i18n } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const circuit = useQuery(
    api.catalog.getCircuit.queryOptions({ tableId: props.tableId }),
  );
  const templates = useQuery(api.catalog.listCircuitTemplates.queryOptions({}));
  const [templateKey, setTemplateKey] = useState<ShippedCircuitKey | "">("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");

  const templateOptions = (templates.data ?? []).filter((item) =>
    (SHIPPED_CIRCUIT_KEYS as readonly string[]).includes(item.key),
  );

  async function apply() {
    if (!templateKey) return;
    setBusy(true);
    setRefusal("");
    try {
      await trpc.catalog.applyCircuitTemplate.mutate({
        tableId: props.tableId,
        templateKey,
      });
      await queryClient.invalidateQueries({
        queryKey: api.catalog.getCircuit.queryKey({
          tableId: props.tableId,
        }),
      });
      toast.success(t`Status circuit updated`);
      setTemplateKey("");
    } catch (error: unknown) {
      // Said beside the button: a toast would cover it.
      setRefusal(errorText(error));
    }
    setBusy(false);
  }

  if (circuit.isPending || templates.isPending) {
    return <Spinner className="h-5 w-5" />;
  }

  if (circuit.isError) {
    return (
      <p className="text-sm text-danger">{t`Could not load the status circuit.`}</p>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-3">
      <h4 className="text-sm font-medium">{t`Status circuit`}</h4>
      <CircuitSummary circuit={circuit.data} />
      <div className="h-px bg-border" role="presentation" />
      <p className="text-xs text-muted-foreground">
        {t`Another template replaces this table's circuit. It is refused while a row is in a state the template does not have, and always while a row is sealed in one.`}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label
            htmlFor={`circuit-template-${props.tableId}`}
            className="text-xs font-medium"
          >
            {t`Shipped template`}
          </label>
          <Select
            id={`circuit-template-${props.tableId}`}
            className="h-9"
            value={templateKey}
            onChange={(event) =>
              setTemplateKey(event.target.value as ShippedCircuitKey | "")
            }
          >
            <option value="">{t`Choose a template…`}</option>
            {templateOptions.map((item) => (
              <option key={item.key} value={item.key}>
                {circuitWord(i18n, "template", item)}
              </option>
            ))}
          </Select>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !templateKey}
          onClick={() => void apply()}
        >
          {t`Apply template`}
        </Button>
      </div>
      {refusal ? (
        <p role="alert" className="text-sm text-danger">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
