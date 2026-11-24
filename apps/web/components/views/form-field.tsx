import { Label } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useRefusedText } from "../../lib/cell-reading";
import type { AnswerProblem } from "./form-answers";

/** The ids a form field's label, description and error carry. */
export function formFieldIds(name: string) {
  const id = `form-${name}`;
  return {
    id,
    label: `${id}-label`,
    description: `${id}-description`,
    error: `${id}-error`,
  };
}

/** What describes a field's control: its description, then what is wrong. */
export function describedBy(
  name: string,
  described: boolean,
  invalid: boolean,
): string | undefined {
  const ids = formFieldIds(name);
  const parts = [
    ...(described ? [ids.description] : []),
    ...(invalid ? [ids.error] : []),
  ];
  return parts.length > 0 ? parts.join(" ") : undefined;
}

const FOCUSABLE = "input, select, textarea, button, [tabindex]";

/** Whether the keyboard can reach an element: focusable, drawn, enabled. */
function reachable(element: HTMLElement): boolean {
  return (
    element.matches(FOCUSABLE) &&
    !element.matches(":disabled") &&
    element.getAttribute("tabindex") !== "-1" &&
    element.getClientRects().length > 0
  );
}

/** Takes the keyboard to a field of the form, to the first part it holds. */
export function focusFormField(name: string): void {
  const element = document.getElementById(formFieldIds(name).id);
  if (!element) return;
  const target = reachable(element)
    ? element
    : [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].find(reachable);
  (target ?? element).focus();
}

/** What a person is told about an answer missing or refused. */
export function useAnswerProblemText(): (problem: AnswerProblem) => string {
  const { t } = useLingui();
  const refusedText = useRefusedText();
  return (problem) =>
    problem.kind === "required"
      ? t`“${{ field: problem.label }}” is required`
      : refusedText(problem.label, problem.refused);
}

/**
 * One field of a form as a person fills it: its label, the mark of an
 * answer that is required, its description when it has one, then the
 * control, which names itself by the same ids (`formFieldIds`). A public
 * form, the form view, and the dialog of a new row draw their fields here.
 */
export function FormField(props: {
  name: string;
  label: string;
  description?: string | null | undefined;
  required: boolean;
  labelClassName?: string;
  /** What is wrong with the answer, said under the control. */
  error?: string | undefined;
  children: ReactNode;
}) {
  const ids = formFieldIds(props.name);
  return (
    <div className="flex flex-col gap-1">
      <Label
        id={ids.label}
        htmlFor={ids.id}
        {...(props.labelClassName ? { className: props.labelClassName } : {})}
      >
        {props.label}
        {props.required ? (
          <span className="text-danger" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
      </Label>
      {props.description ? (
        <p id={ids.description} className="text-xs text-muted-foreground">
          {props.description}
        </p>
      ) : null}
      {props.children}
      {props.error ? (
        <p id={ids.error} className="text-xs text-danger">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Said at the foot of a form sent with fields to correct, each marked under
 * its control; the keyboard is taken to the first of them.
 */
export function FormProblems({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {plural(count, {
        one: "One field needs correcting, marked above.",
        other: "# fields need correcting, marked above.",
      })}
    </p>
  );
}
