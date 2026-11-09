/**
 * A list to pick from, filtered by typing (React Aria's Autocomplete over
 * a ListBox, ADR 0012). Focus stays in the search field while the arrows
 * move through the options (`aria-activedescendant`); Enter or a click
 * picks one, and each option says whether it is chosen.
 */
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  Autocomplete,
  Input as AriaInput,
  ListBox,
  ListBoxItem,
  TextField,
  useFilter,
  type Selection,
} from "react-aria-components";
import { cn } from "./cn";

export type PickerOption = {
  id: string;
  /** What typing matches, and what a screen reader reads. */
  textValue: string;
  children: ReactNode;
};

export type ListPickerProps = {
  /** The search field's name, also its placeholder. */
  label: string;
  /** The list's name. */
  listLabel: string;
  inputValue: string;
  onInputChange: (text: string) => void;
  /** Filters the options by what is typed; off when the caller did. */
  filter?: boolean;
  options: readonly PickerOption[];
  selectionMode: "single" | "multiple";
  selected: readonly string[];
  /** The option picked, or unpicked. */
  onToggle: (id: string) => void;
  /** Shown when no option is listed. */
  empty: ReactNode;
  className?: string;
};

export function ListPicker(props: ListPickerProps) {
  const { contains } = useFilter({ sensitivity: "base" });
  const { selected, onToggle } = props;
  const change = (keys: Selection) => {
    if (keys === "all") return;
    const next = new Set([...keys].map(String));
    const toggled =
      [...next].find((id) => !selected.includes(id)) ??
      selected.find((id) => !next.has(id));
    if (toggled !== undefined) onToggle(toggled);
  };
  return (
    <Autocomplete
      inputValue={props.inputValue}
      onInputChange={props.onInputChange}
      filter={props.filter ? contains : undefined}
    >
      <TextField aria-label={props.label} autoFocus className="flex">
        <AriaInput
          placeholder={props.label}
          className="h-9 w-full border-b border-border bg-transparent px-3 text-sm outline-none"
        />
      </TextField>
      <ListBox
        aria-label={props.listLabel}
        items={props.options}
        selectionMode={props.selectionMode}
        selectedKeys={new Set(selected)}
        onSelectionChange={change}
        escapeKeyBehavior="none"
        renderEmptyState={() => (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            {props.empty}
          </div>
        )}
        className={cn(
          "min-h-0 overflow-y-auto p-1 outline-none",
          props.className,
        )}
      >
        {(option) => (
          <ListBoxItem
            id={option.id}
            textValue={option.textValue}
            className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[focused]:bg-muted data-[hovered]:bg-muted"
          >
            {({ isSelected }) => (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {option.children}
                </span>
                {isSelected ? (
                  <Check
                    className="h-4 w-4 shrink-0 text-primary"
                    aria-hidden
                  />
                ) : null}
              </>
            )}
          </ListBoxItem>
        )}
      </ListBox>
    </Autocomplete>
  );
}
