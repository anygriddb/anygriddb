import type { AirtableNote } from "@anygriddb/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

/** What did not come over from Airtable as it was, in a sentence each. */
export const AIRTABLE_NOTE_TEXT: Record<AirtableNote, MessageDescriptor> = {
  attachments_as_names: msg`attachments carried over by name: the files are not copied`,
  people_as_text: msg`people carried over as text (name and address)`,
  rollup_as_values: msg`rollup carried over as values: Airtable's API does not give its calculation`,
  formula_as_values: msg`formula carried over as values: it reads a field or a function AnyGridDB does not have`,
  lookup_as_values: msg`lookup carried over as values`,
  system_as_values: msg`created time, modified time, or number carried over as values`,
  unknown_as_text: msg`type without an equivalent carried over as text`,
  button_skipped: msg`button not carried over`,
  view_settings: msg`view filters, sorts, and hidden fields not carried over: Airtable's API does not give them`,
  view_skipped: msg`view not carried over: its type has no equivalent`,
};

type Item = {
  table?: unknown;
  field?: unknown;
  view?: unknown;
  note?: unknown;
};

/** The import's report, as a list a person reads before using the base. */
export function AirtableReport({ report }: { report: unknown }) {
  const { t } = useLingui();
  const items = (Array.isArray(report) ? report : []) as Item[];
  if (items.length === 0) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {t`${{ count: items.length }} points to check`}
      </summary>
      <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-4">
        {items.map((item, index) => {
          const where = [item.table, item.field ?? item.view]
            .filter((part): part is string => typeof part === "string")
            .join(" › ");
          const note: MessageDescriptor | undefined =
            typeof item.note === "string" && item.note in AIRTABLE_NOTE_TEXT
              ? AIRTABLE_NOTE_TEXT[item.note as AirtableNote]
              : undefined;
          return (
            <li key={index}>
              {where ? <span className="font-medium">{where} : </span> : null}
              {note ? t(note) : JSON.stringify(item.note)}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
