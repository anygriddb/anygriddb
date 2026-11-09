/**
 * Form fields shown only when earlier answers match a condition. The same
 * function decides in the browser, as the person answers, and in the API,
 * when the answers arrive: there, a field not shown is never required and
 * its value is not written, whoever calls.
 *
 * - A field left out of the form is never shown.
 * - A field without a condition is shown.
 * - A condition counts only on fields placed before the field; the others
 *   are left out (the form's editor says so). A condition that applies to
 *   nothing shows the field.
 * - A condition reads only the answers of fields shown: a field hidden by
 *   its own condition reads as empty, so hiding it hides, in turn, the
 *   fields that depend on it.
 */
import {
  isFilterGroup,
  type FilterCondition,
  type FilterGroup,
} from "./filter";
import { evaluateFilter, type FilterEvalContext } from "./filter-eval";

export type FormFieldRule = {
  column: string;
  hidden?: boolean;
  showIf?: FilterGroup;
};

/** The fields shown, in the form's order, given the answers so far. */
export function visibleFormFields(
  fields: readonly FormFieldRule[],
  answers: Readonly<Record<string, unknown>>,
  context: FilterEvalContext,
): string[] {
  const shown: string[] = [];
  const before = new Set<string>();
  const read: Record<string, unknown> = {};
  for (const field of fields) {
    const placed = new Set(before);
    before.add(field.column);
    if (field.hidden) continue;
    const condition = field.showIf ? onFields(field.showIf, placed) : undefined;
    if (condition && evaluateFilter(condition, read, context) === false) {
      continue;
    }
    shown.push(field.column);
    read[field.column] = answers[field.column];
  }
  return shown;
}

/**
 * The fields a field's condition names that are not placed before it: a
 * condition on them is left out.
 */
export function misplacedConditionFields(
  fields: readonly FormFieldRule[],
): Map<string, string[]> {
  const misplaced = new Map<string, string[]>();
  const before = new Set<string>();
  for (const field of fields) {
    if (field.showIf) {
      const named = conditionFields(field.showIf).filter(
        (name) => !before.has(name),
      );
      if (named.length > 0) misplaced.set(field.column, named);
    }
    before.add(field.column);
  }
  return misplaced;
}

function conditionFields(group: FilterGroup): string[] {
  return group.conditions.flatMap((node) =>
    isFilterGroup(node) ? conditionFields(node) : [node.column],
  );
}

/** `group` without its conditions on fields outside `allowed`. */
function onFields(
  group: FilterGroup,
  allowed: ReadonlySet<string>,
): FilterGroup {
  return {
    conjunction: group.conjunction,
    conditions: group.conditions.flatMap(
      (node): Array<FilterCondition | FilterGroup> => {
        if (isFilterGroup(node)) return [onFields(node, allowed)];
        return allowed.has(node.column) ? [node] : [];
      },
    ),
  };
}
