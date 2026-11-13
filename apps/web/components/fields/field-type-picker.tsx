import {
  Button,
  ListPicker,
  Popover,
  PopoverContent,
  PopoverTrigger,
  type PickerOption,
} from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { raw } from "../../lib/known-text";
import { FIELD_DESCRIPTIONS, FIELD_LABELS, FieldIcon } from "./field-meta";

/** The icon of a type; a link to be made draws as the link it becomes. */
function iconType(type: string): string {
  return type === "link" ? "relation_many_to_many" : type;
}

/**
 * A field's type, picked from a list that says what each holds, with its
 * icon, in the order of its groups, filtered by typing.
 */
export function FieldTypePicker(props: {
  /** Named by the form's "Type" label. */
  id: string;
  value: string;
  types: readonly string[];
  onChange: (type: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const name = (type: string) =>
    type === "link"
      ? t`Link to another table`
      : t(FIELD_LABELS[type] ?? raw(type));
  const description = (type: string) => {
    const text = FIELD_DESCRIPTIONS[type];
    return text ? t(text) : "";
  };
  const options: PickerOption[] = props.types.map((type) => ({
    id: type,
    textValue: name(type),
    children: name(type),
    icon: (
      <FieldIcon
        fieldType={iconType(type)}
        className="h-4 w-4 shrink-0 opacity-70"
      />
    ),
    description: description(type),
  }));
  function close() {
    setOpen(false);
    setQuery("");
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <PopoverTrigger asChild>
        <Button
          id={props.id}
          variant="outline"
          className="w-full justify-start gap-2 font-normal"
        >
          <FieldIcon
            fieldType={iconType(props.value)}
            className="h-4 w-4 shrink-0 opacity-70"
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {name(props.value)}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      {/* The panel scrolls as one, its search on top: a list that
          scrolled on its own could not be reached by Tab. */}
      <PopoverContent className="max-h-96 w-80 p-0" aria-label={t`Field types`}>
        <ListPicker
          label={t`Search a type`}
          listLabel={t`Field types`}
          inputValue={query}
          onInputChange={setQuery}
          filter
          options={options}
          selectionMode="single"
          selected={[props.value]}
          onToggle={(type) => {
            props.onChange(type);
            close();
          }}
          empty={t`No type matches`}
        />
      </PopoverContent>
    </Popover>
  );
}
