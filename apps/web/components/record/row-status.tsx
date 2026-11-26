import type { StatusCircuit, StatusTransition } from "@anygriddb/core";
import { stateByKey } from "@anygriddb/core";
import { Button, cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { AlertTriangle, Lock, PenLine, Unlock } from "lucide-react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { cellDisplay, formatInstant } from "../../lib/format";
import { trpc } from "../../lib/trpc";
import { grants, type RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import {
  allowedTransitions,
  statusSealed,
  statusShown,
  submitTransition,
} from "./row-status-model";
import { circuitWord } from "./circuit-labels";
import { useTableCircuit } from "./use-table-circuit";
import { useTakeStep } from "./take-step";

const STATUS_LABELS: Record<string, MessageDescriptor> = {
  draft: msg`Draft`,
  submitted: msg`Submitted`,
  locked: msg`Locked`,
  signed: msg`Signed`,
};

/** Submits a draft row: the first allowed transition from the initial state. */
export function useSubmitRow(): (rowId: string) => Promise<void> {
  const table = useTable();
  const circuit = useTableCircuit(table.table.id);
  const errorText = useErrorText();
  return async (rowId) => {
    try {
      const data = circuit.data;
      if (data) {
        const transition = submitTransition(data, table.role);
        if (!transition) return;
        await trpc.rows.transition.mutate({
          tableId: table.table.id,
          rowId,
          transitionKey: transition.key,
        });
      } else {
        await trpc.rows.setStatus.mutate({
          tableId: table.table.id,
          rowId,
          status: "submitted",
        });
      }
    } catch (error: unknown) {
      toast.error(errorText(error));
    }
  };
}

/** Label for the panel menu's submit action. */
export function useSubmitRowLabel(): string | null {
  const { t, i18n } = useLingui();
  const table = useTable();
  const circuit = useTableCircuit(table.table.id);
  const transition = circuit.data
    ? submitTransition(circuit.data, table.role)
    : undefined;
  // In a menu, "Submit" alone says too little.
  if (transition?.key === "submit") return t`Submit the row for review`;
  if (transition) return circuitWord(i18n, "transition", transition);
  return circuit.data ? null : t`Submit the row for review`;
}

/**
 * A row's status once its review has begun, and what moves it on through the
 * table's circuit. A draft is submitted from the panel's menu. On a client's
 * row, a seal locks values; drift since then shows here (ADR 0033).
 */
export function RowStatus({ row }: { row: RowItem }) {
  const { t, i18n } = useLingui();
  const table = useTable();
  const circuitQuery = useTableCircuit(table.table.id);
  const circuit = circuitQuery.data;
  const status = row.ag_status;
  if (!statusShown(row, circuit) || typeof status !== "string") return null;

  const current = circuit ? stateByKey(circuit, status) : undefined;
  const sealed = statusSealed(circuit, status);
  const external = table.table.external !== null;
  const drift = row.ag_drift;
  const byName = new Map(
    table.table.columns.map((column) => [column.name, column]),
  );

  const badgeLabel = current
    ? circuitWord(i18n, "state", current)
    : i18n._(STATUS_LABELS[status] ?? msg`Draft`);
  const actions =
    circuit && table.role && grants(table.role, "rows.transition")
      ? allowedTransitions(circuit, status, table.role)
      : [];

  return (
    <section
      aria-label={t`Row status`}
      className="flex flex-col gap-2 border-b border-border px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            sealed
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {sealed ? <Lock className="h-3 w-3" aria-hidden /> : null}
          {badgeLabel}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {circuit
            ? actions.map((transition) => (
                <TransitionAction
                  key={transition.id}
                  row={row}
                  circuit={circuit}
                  transition={transition}
                  drift={drift}
                />
              ))
            : null}
        </div>
      </div>
      {row.ag_signature ? (
        <p className="text-xs text-muted-foreground">
          {t`Signed by ${{ name: row.ag_signature.displayName }} on ${{
            date: formatInstant(row.ag_signature.signedAt, table.locale),
          }}: “${{ meaning: row.ag_signature.meaning }}”`}
        </p>
      ) : null}
      {external && sealed && status === "locked" && !drift ? (
        <p className="text-xs text-muted-foreground">
          {t`AnyGridDB refuses any change to this row. The client's database can still be changed by its other applications: AnyGridDB compares the row with its locked values and warns if it changes.`}
        </p>
      ) : null}
      {drift ? (
        <DriftAlert
          drift={drift}
          byName={byName}
          table={table}
          locale={table.locale}
        />
      ) : null}
    </section>
  );
}

function TransitionAction(props: {
  row: RowItem;
  circuit: StatusCircuit;
  transition: StatusTransition;
  drift: RowItem["ag_drift"];
}) {
  const { i18n } = useLingui();
  const steps = useTakeStep();
  const label = circuitWord(i18n, "transition", props.transition);
  const iconKey = props.transition.key;
  const disabled =
    steps.busy || (props.transition.key === "sign" && props.drift !== null);
  return (
    <>
      <Button
        size="xs"
        variant={props.transition.key === "unlock" ? "ghost" : "outline"}
        disabled={disabled}
        onClick={() => steps.take(props.row, props.circuit, props.transition)}
      >
        {iconKey === "lock" ? (
          <Lock className="h-3.5 w-3.5" aria-hidden />
        ) : iconKey === "unlock" ? (
          <Unlock className="h-3.5 w-3.5" aria-hidden />
        ) : iconKey === "sign" ? (
          <PenLine className="h-3.5 w-3.5" aria-hidden />
        ) : null}
        {label}
      </Button>
      {steps.dialogs}
    </>
  );
}

function DriftAlert({
  drift,
  byName,
  table,
  locale,
}: {
  drift: NonNullable<RowItem["ag_drift"]>;
  byName: Map<string, (typeof table.table.columns)[number]>;
  table: ReturnType<typeof useTable>;
  locale: "fr" | "en";
}) {
  const { t } = useLingui();
  return (
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
            date: formatInstant(drift.at, locale),
          }}. An owner can unlock it, check it, then lock it again.`}
        </p>
        {drift.fields.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {drift.fields.map((name) => {
              const column = byName.get(name);
              const sealed = drift.sealed[name];
              return (
                <li key={name}>
                  <span className="font-medium">{column?.label ?? name}</span> :{" "}
                  {t`locked value ${{
                    value: column
                      ? cellDisplay(sealed, column, locale, table.people) || "∅"
                      : JSON.stringify(sealed ?? null),
                  }}`}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
