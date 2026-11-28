import {
  Button,
  type CalendarDate,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  getLocalTimeZone,
  Label,
  parseAbsolute,
  toCalendarDate,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useNeeds } from "../../lib/form-needs";
import { intlLocale } from "../../lib/format";
import { useWhen } from "../../lib/i18n";
import { trpc } from "../../lib/trpc";
import { Refusal, useAction } from "../shell/dialogs";

/** Whose role on what, as the server is told (ADR 0146). */
export type RoleEndTarget = {
  scope: "base" | "table";
  scopeId: string;
} & ({ userId: string } | { groupId: string });

/**
 * The last day a role gives: the day before the instant it stops giving
 * anything, in the reader's zone.
 */
export function lastDayOf(endsAt: string, zone: string): CalendarDate {
  return toCalendarDate(
    parseAbsolute(endsAt, zone).subtract({ milliseconds: 1 }),
  );
}

/** The instant a role stops giving: the start of the day after its last. */
export function endAfter(lastDay: CalendarDate, zone: string): string {
  return lastDay.add({ days: 1 }).toDate(zone).toISOString();
}

/**
 * When a role ends (ADR 0146): "No end", or the last day it gives, set by
 * whoever could give it. An owner's role does not end: no control for it.
 */
export function RoleEnd(props: {
  target: RoleEndTarget;
  endsAt: string | null;
  /** Whose role it is, a person or a group, as the list names them. */
  name: string;
  onChanged: () => Promise<unknown>;
}) {
  const { t, i18n } = useLingui();
  const when = useWhen();
  const zone = getLocalTimeZone();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<CalendarDate | null>(null);
  const { run, refusal } = useAction();
  const needs = useNeeds();
  const last = props.endsAt ? lastDayOf(props.endsAt, zone) : null;
  const shown = last ? when.day(last.toDate(zone)) : null;

  async function save(lastDay: CalendarDate | null) {
    const done = await run(async () => {
      await trpc.catalog.setRoleEnd.mutate({
        ...props.target,
        endsAt: lastDay ? endAfter(lastDay, zone) : null,
      });
      await props.onChanged();
    });
    if (done) setOpen(false);
  }

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        className="w-32 justify-start font-normal text-muted-foreground"
        // Its name starts with what it shows, and says whose role it is.
        aria-label={
          shown
            ? t`Until ${{ day: shown }} for the role of ${{ name: props.name }}`
            : t`No end for the role of ${{ name: props.name }}`
        }
        onClick={() => {
          setDay(last);
          needs.clear();
          setOpen(true);
        }}
      >
        {shown ? t`Until ${{ day: shown }}` : t`No end`}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={t`When does the role of ${{ name: props.name }} end?`}
          description={t`It gives nothing from the day after the last one, and goes within the hour.`}
        >
          <div className="flex flex-col gap-1">
            <Label id="role-end-day">{t`Last day`}</Label>
            <DatePicker
              id="role-end-day-field"
              aria-labelledby="role-end-day"
              locale={intlLocale(i18n.locale)}
              className="w-56"
              isInvalid={needs.invalid("role-end-day-field")}
              value={day}
              onChange={(next) => {
                setDay(next ? toCalendarDate(next) : null);
                needs.clear();
              }}
            />
          </div>
          <Refusal text={needs.said ?? refusal} className="mt-3 mb-0" />
          <DialogFooter>
            {props.endsAt ? (
              <Button variant="ghost" onClick={() => void save(null)}>
                {t`No end`}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t`Cancel`}
            </Button>
            <Button
              onClick={() => {
                const chosen = needs.met([
                  {
                    missing: day === null,
                    say: t`Choose the last day the role gives.`,
                    field: "role-end-day-field",
                  },
                ]);
                if (chosen) void save(day);
              }}
            >
              {t`Save`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
