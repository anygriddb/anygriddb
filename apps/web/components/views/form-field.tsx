import { Label } from "@anygriddb/ui";
import type { ReactNode } from "react";

/** The ids a form field's label and description carry. */
export function formFieldIds(name: string) {
  const id = `form-${name}`;
  return { id, label: `${id}-label`, description: `${id}-description` };
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
    </div>
  );
}
