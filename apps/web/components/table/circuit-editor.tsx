import {
  type CircuitDefinition,
  definitionOf,
  isWritableType,
  roleGrants,
} from "@anygriddb/core";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Select,
  Spinner,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { useState, type SubmitEvent } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "../../lib/trpc";
import { circuitWord } from "../record/circuit-labels";
import { Refusal, useRefusal } from "../shell/dialogs";
import {
  addState,
  addStep,
  type DraftStep,
  makeInitial,
  removeState,
  setStateRules,
  statesToMove,
} from "./circuit-draft";
import { useTable } from "./table-context";

/**
 * The table's status circuit, edited by whoever manages its structure
 * (ADR 0124, 0130): its states and what each lets a row do, its steps and
 * what each asks and whom it names. It starts from the circuit in place
 * or from a shipped one; nothing changes until it is saved, and rows of a
 * state that goes are moved where the editor says.
 */
export function CircuitEditor(props: { tableId: string; onClose: () => void }) {
  const { t } = useLingui();
  const api = useTRPC();
  // A client's rows are named by a key: a table without one has no states
  // (ADR 0137), and the editor says why rather than offer a circuit.
  const external = useTable().table.external;
  const keyless = external != null && !external.keyed;
  const circuit = useQuery({
    ...api.catalog.getCircuit.queryOptions({ tableId: props.tableId }),
    enabled: !keyless,
  });
  const counts = useQuery({
    ...api.catalog.circuitCounts.queryOptions({ tableId: props.tableId }),
    enabled: !keyless,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        title={t`Status circuit`}
        description={t`The states a row goes through and the steps between them: what each step asks, and who takes it.`}
        wide
      >
        {keyless ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t`This table has no primary key: AnyGridDB cannot tell its rows apart, so they have no states. Once its database gives it one, refresh its fields, and its rows take a circuit.`}
            </p>
            <DialogFooter>
              <Button type="button" onClick={props.onClose}>
                {t`Close`}
              </Button>
            </DialogFooter>
          </>
        ) : circuit.data && counts.data ? (
          <CircuitForm
            tableId={props.tableId}
            saved={circuit.data}
            counts={counts.data}
            onClose={props.onClose}
          />
        ) : (
          <Spinner />
        )}
      </DialogContent>
    </Dialog>
  );
}

type Saved = Parameters<typeof definitionOf>[0];

function CircuitForm(props: {
  tableId: string;
  saved: Saved;
  counts: Record<string, number>;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const table = useTable();
  const refusal = useRefusal();
  const templates = useQuery(api.catalog.listCircuitTemplates.queryOptions({}));
  const made = useQuery(api.catalog.madeRoles.queryOptions());
  const [draft, setDraft] = useState<CircuitDefinition>(() =>
    definitionOf(props.saved, circuitWord(i18n, "template", props.saved)),
  );
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toMove = statesToMove(props.saved.states, draft, props.counts);
  const fields = table.table.columns.filter((column) =>
    isWritableType(column.fieldType),
  );
  // A client's table: what AnyGridDB holds back, and what it only watches.
  const external = table.table.external ?? null;
  const written =
    external !== null &&
    (external.writes.update ||
      external.writes.delete ||
      table.table.columns.some((column) => column.side));
  // Only who takes steps at all may be named on one.
  const takers = (made.data?.roles ?? []).filter((role) =>
    roleGrants(role, "rows.transition"),
  );
  const stateName = (key: string) =>
    draft.states.find((state) => state.key === key)?.label ?? key;
  const setStep = (index: number, change: Partial<DraftStep>) =>
    setDraft({
      ...draft,
      steps: draft.steps.map((step, at) =>
        at === index ? { ...step, ...change } : step,
      ),
    });

  function startFrom(key: string) {
    const template = templates.data?.find((item) => item.key === key);
    if (template) {
      setDraft(definitionOf(template, circuitWord(i18n, "template", template)));
    } else if (key === "") {
      setDraft(
        definitionOf(props.saved, circuitWord(i18n, "template", props.saved)),
      );
    }
    setMoves({});
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    refusal.clear();
    setBusy(true);
    const remap = Object.fromEntries(
      toMove.flatMap((state) => {
        const to = moves[state.key];
        return to ? [[state.key, to]] : [];
      }),
    );
    try {
      await trpc.catalog.saveCircuit.mutate({
        tableId: props.tableId,
        circuit: draft,
        remap,
      });
      await queryClient.invalidateQueries({
        queryKey: api.catalog.getCircuit.queryKey({ tableId: props.tableId }),
      });
      toast.success(t`Circuit saved`);
      props.onClose();
    } catch (error: unknown) {
      refusal.say(error);
    }
    setBusy(false);
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="circuit-start">{t`Start from`}</Label>
          <Select
            id="circuit-start"
            className="w-56"
            defaultValue=""
            onChange={(event) => startFrom(event.target.value)}
          >
            <option value="">{t`The circuit in place`}</option>
            {(templates.data ?? []).map((template) => (
              <option key={template.key} value={template.key}>
                {circuitWord(i18n, "template", template)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor="circuit-name">{t`Name`}</Label>
          <Input
            id="circuit-name"
            value={draft.name}
            maxLength={60}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t`States`}</legend>
        {external ? (
          <p className="text-sm text-muted-foreground">
            {t`This table lives in a client's database: each row's state is kept beside it, and AnyGridDB refuses its own changes a state forbids. Other applications are not stopped; a sealed state keeps a fingerprint of the row, and a change made elsewhere is found and told.`}
            {written
              ? ""
              : ` ${t`AnyGridDB writes none of its rows: “Rows change” and “Rows are deleted” hold nothing back here.`}`}
          </p>
        ) : null}
        {draft.states.map((state, index) => (
          <div
            key={state.key}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border px-2 py-1.5 text-sm"
          >
            <Input
              aria-label={t`Name of state ${{ n: index + 1 }}`}
              className="h-8 w-44"
              value={state.label}
              maxLength={100}
              onChange={(event) =>
                setDraft(
                  setStateRules(draft, state.key, {
                    label: event.target.value,
                  }),
                )
              }
            />
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="circuit-initial"
                className="accent-primary"
                checked={state.initial}
                onChange={() => setDraft(makeInitial(draft, state.key))}
              />
              {t`First`}
            </label>
            <label className="flex items-center gap-1.5">
              <Checkbox
                checked={state.writable}
                disabled={state.seal}
                onChange={(event) =>
                  setDraft(
                    setStateRules(draft, state.key, {
                      writable: event.target.checked,
                    }),
                  )
                }
              />
              {t`Rows change`}
            </label>
            <label className="flex items-center gap-1.5">
              <Checkbox
                checked={state.delete}
                disabled={state.seal}
                onChange={(event) =>
                  setDraft(
                    setStateRules(draft, state.key, {
                      delete: event.target.checked,
                    }),
                  )
                }
              />
              {t`Rows are deleted`}
            </label>
            <label className="flex items-center gap-1.5">
              <Checkbox
                checked={state.seal}
                onChange={(event) =>
                  setDraft(
                    setStateRules(draft, state.key, {
                      seal: event.target.checked,
                    }),
                  )
                }
              />
              {t`Sealed`}
            </label>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="ml-auto"
              aria-label={t`Remove the state ${{ state: state.label }}`}
              disabled={draft.states.length === 1}
              onClick={() => setDraft(removeState(draft, state.key))}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={draft.states.length >= 30}
          onClick={() => setDraft(addState(draft, t`New state`))}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t`Add a state`}
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t`Steps`}</legend>
        {draft.steps.map((step, index) => (
          <div
            key={`${step.from} ${step.key} ${index}`}
            className="flex flex-col gap-2 rounded-md border border-border px-2 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={t`Name of step ${{ n: index + 1 }}`}
                className="h-8 w-44"
                value={step.label}
                maxLength={100}
                onChange={(event) =>
                  setStep(index, { label: event.target.value })
                }
              />
              <Select
                aria-label={t`From`}
                className="h-8 w-40"
                value={step.from}
                onChange={(event) =>
                  setStep(index, { from: event.target.value })
                }
              >
                {draft.states.map((state) => (
                  <option key={state.key} value={state.key}>
                    {state.label}
                  </option>
                ))}
              </Select>
              <ArrowRight
                className="h-4 w-4 text-muted-foreground"
                aria-hidden
              />
              <Select
                aria-label={t`To`}
                className="h-8 w-40"
                value={step.to}
                onChange={(event) => setStep(index, { to: event.target.value })}
              >
                {draft.states.map((state) => (
                  <option key={state.key} value={state.key}>
                    {state.label}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="ml-auto"
                aria-label={t`Remove the step ${{ step: step.label }}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    steps: draft.steps.filter((_, at) => at !== index),
                  })
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5">
                <Checkbox
                  checked={step.reason}
                  onChange={(event) =>
                    setStep(index, { reason: event.target.checked })
                  }
                />
                {t`Asks a reason`}
              </label>
              <label className="flex items-center gap-1.5">
                <Checkbox
                  checked={step.fourEyes}
                  onChange={(event) =>
                    setStep(index, { fourEyes: event.target.checked })
                  }
                />
                {t`Four eyes`}
              </label>
              <Select
                aria-label={t`Signature`}
                className="h-8 w-64"
                value={step.signature}
                onChange={(event) =>
                  setStep(index, {
                    signature: event.target.value as DraftStep["signature"],
                  })
                }
              >
                <option value="none">{t`No signature`}</option>
                <option value="password">{t`Signed with the password`}</option>
                <option value="step_up">
                  {t`Signed with the password or a second factor`}
                </option>
              </Select>
            </div>
            <fieldset className="flex flex-wrap items-center gap-3">
              <legend className="mb-1 text-xs text-muted-foreground">
                {t`Who takes it`}
              </legend>
              {(["owner", "editor", "contributor", "validator"] as const).map(
                (role) => (
                  <label key={role} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={step.roles.includes(role)}
                      onChange={(event) =>
                        setStep(index, {
                          roles: event.target.checked
                            ? [...step.roles, role]
                            : step.roles.filter((item) => item !== role),
                        })
                      }
                    />
                    {
                      {
                        owner: t`Owners`,
                        editor: t`Editors`,
                        contributor: t`Contributors`,
                        validator: t`Validators`,
                      }[role]
                    }
                  </label>
                ),
              )}
              {takers.map((role) => (
                <label key={role.id} className="flex items-center gap-1.5">
                  <Checkbox
                    checked={step.madeRoles.includes(role.id)}
                    onChange={(event) =>
                      setStep(index, {
                        madeRoles: event.target.checked
                          ? [...step.madeRoles, role.id]
                          : step.madeRoles.filter((id) => id !== role.id),
                      })
                    }
                  />
                  {role.name}
                </label>
              ))}
            </fieldset>
            {fields.length > 0 ? (
              <fieldset className="flex flex-wrap items-center gap-3">
                <legend className="mb-1 text-xs text-muted-foreground">
                  {t`Fields it needs filled`}
                </legend>
                {fields.map((column) => (
                  <label
                    key={column.name}
                    className="flex items-center gap-1.5"
                  >
                    <Checkbox
                      checked={step.fields.includes(column.name)}
                      onChange={(event) =>
                        setStep(index, {
                          fields: event.target.checked
                            ? [...step.fields, column.name]
                            : step.fields.filter(
                                (name) => name !== column.name,
                              ),
                        })
                      }
                    />
                    {column.label}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={draft.states.length < 2 || draft.steps.length >= 60}
          onClick={() => setDraft(addStep(draft, t`New step`))}
        >
          <Plus className="h-4 w-4" aria-hidden />
          {t`Add a step`}
        </Button>
      </fieldset>

      {toMove.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            {t`Rows of the states that go`}
          </legend>
          {toMove.map((state) => (
            <label
              key={state.key}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              {t`Rows in “${{ state: state.label }}” (${{ count: state.rows }}) move to`}
              <Select
                className="h-8 w-48"
                value={moves[state.key] ?? ""}
                onChange={(event) =>
                  setMoves({ ...moves, [state.key]: event.target.value })
                }
              >
                <option value="">—</option>
                {draft.states.map((kept) => (
                  <option key={kept.key} value={kept.key}>
                    {stateName(kept.key)}
                  </option>
                ))}
              </Select>
            </label>
          ))}
        </fieldset>
      ) : null}

      <Refusal text={refusal.text} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={props.onClose}>
          {t`Cancel`}
        </Button>
        <Button
          type="submit"
          disabled={busy || toMove.some((state) => !moves[state.key])}
        >
          {busy ? <Spinner /> : null}
          {t`Save`}
        </Button>
      </DialogFooter>
    </form>
  );
}
