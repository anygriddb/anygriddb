import {
  AtSign,
  Braces,
  Binary,
  Calendar,
  CalendarClock,
  CheckSquare,
  CircleDot,
  Clock,
  Fingerprint,
  FunctionSquare,
  Hash,
  Link2,
  List,
  ListChecks,
  MapPin,
  Palette,
  Paperclip,
  Phone,
  Search,
  Sigma,
  Star,
  Text,
  Timer,
  Type,
  User,
  UserCheck,
  Users,
  type LucideIcon,
  MousePointerClick,
  Waypoints,
} from "lucide-react";
import {
  FIELD_DEFINITIONS,
  isRelationType,
  type FieldType,
} from "@anygriddb/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** What the rows of another table are, in the picker: a link to be made. */
const LINKED_ROWS = msg`Rows of another table`;

/**
 * What a screen shows of each field type: its icon, its name (an English
 * source, translated by `t` where it is shown), what it holds under its
 * name in the picker, and the width its column starts at when not the
 * usual. `satisfies Record<FieldType, …>` refuses a type left out.
 */
const FIELD_UI = {
  text: { icon: Type, label: msg`Text`, description: msg`One line of text` },
  long_text: {
    icon: Text,
    label: msg`Long text`,
    description: msg`Paragraphs and notes`,
    width: 260,
  },
  number: {
    icon: Hash,
    label: msg`Number`,
    description: msg`Amounts, quantities, percentages`,
    width: 120,
  },
  boolean: {
    icon: CheckSquare,
    label: msg`Checkbox`,
    description: msg`Yes or no`,
    width: 90,
  },
  date: {
    icon: Calendar,
    label: msg`Date`,
    description: msg`A day`,
    width: 130,
  },
  datetime: {
    icon: CalendarClock,
    label: msg`Date and time`,
    description: msg`A day and a time`,
    width: 170,
  },
  single_select: {
    icon: CircleDot,
    label: msg`Single select`,
    description: msg`One option from a list`,
  },
  multi_select: {
    icon: ListChecks,
    label: msg`Multiple select`,
    description: msg`Several options from a list`,
  },
  email: {
    icon: AtSign,
    label: msg`Email`,
    description: msg`An email address, as a link`,
  },
  url: {
    icon: Link2,
    label: msg`URL`,
    description: msg`A web address, as a link`,
  },
  phone: { icon: Phone, label: msg`Phone`, description: msg`A phone number` },
  color: {
    icon: Palette,
    label: msg`Colour`,
    description: msg`A colour, shown with its swatch`,
  },
  place: {
    icon: MapPin,
    label: msg`Place`,
    description: msg`A point on the globe, which a map shows`,
  },
  json: {
    icon: Braces,
    label: msg`JSON`,
    description: msg`An object or a list, which a formula reads into`,
    width: 260,
  },
  rating: {
    icon: Star,
    label: msg`Rating`,
    description: msg`A score drawn as symbols`,
    width: 130,
  },
  duration: {
    icon: Timer,
    label: msg`Duration`,
    description: msg`Hours and minutes`,
    width: 110,
  },
  user: {
    icon: Users,
    label: msg`Collaborator`,
    description: msg`People of the base`,
  },
  attachment: {
    icon: Paperclip,
    label: msg`Attachment`,
    description: msg`Files and images`,
  },
  relation_one_to_many: {
    icon: Link2,
    label: msg`Link to a row`,
    description: LINKED_ROWS,
  },
  relation_many_to_many: {
    icon: Link2,
    label: msg`Link to rows`,
    description: LINKED_ROWS,
  },
  formula: {
    icon: FunctionSquare,
    label: msg`Formula`,
    description: msg`Computed from other fields`,
  },
  lookup: {
    icon: Search,
    label: msg`Lookup`,
    description: msg`A field of the linked rows`,
  },
  rollup: {
    icon: Sigma,
    label: msg`Rollup`,
    description: msg`A total over the linked rows`,
  },
  created_time: {
    icon: Clock,
    label: msg`Created time`,
    description: msg`When the row was created`,
  },
  last_modified_time: {
    icon: Clock,
    label: msg`Last modified time`,
    description: msg`When the row last changed`,
  },
  created_by: {
    icon: User,
    label: msg`Created by`,
    description: msg`Who created the row`,
  },
  last_modified_by: {
    icon: UserCheck,
    label: msg`Last modified by`,
    description: msg`Who last changed the row`,
  },
  autonumber: {
    icon: Binary,
    label: msg`Autonumber`,
    description: msg`A number given to each new row`,
    width: 90,
  },
  row_id: {
    icon: Fingerprint,
    label: msg`Row id`,
    description: msg`The id the API and links name the row by`,
    width: 290,
  },
  row_state: {
    icon: Waypoints,
    label: msg`Row state`,
    description: msg`Where the row stands in its table's circuit`,
  },
  button: {
    icon: MousePointerClick,
    label: msg`Button`,
    description: msg`Opens a link or runs an action for the row`,
  },
} satisfies Record<
  FieldType,
  {
    icon: LucideIcon;
    label: MessageDescriptor;
    description: MessageDescriptor;
    width?: number;
  }
>;

function uiOf(fieldType: string) {
  return Object.hasOwn(FIELD_UI, fieldType)
    ? FIELD_UI[fieldType as FieldType]
    : undefined;
}

export function FieldIcon({
  fieldType,
  className,
}: {
  fieldType: string;
  className?: string;
}) {
  const Icon = uiOf(fieldType)?.icon ?? List;
  return (
    <Icon
      className={className ?? "h-3.5 w-3.5 shrink-0 opacity-60"}
      aria-hidden
    />
  );
}

/** English source labels, translated by `t` at the call site. */
export const FIELD_LABELS: Readonly<Record<string, MessageDescriptor>> =
  Object.fromEntries(
    Object.entries(FIELD_UI).map(([type, ui]) => [type, ui.label]),
  );

/**
 * What each type holds, in a few words, under its name in the picker; a
 * link to be made is offered as `link`.
 */
export const FIELD_DESCRIPTIONS: Readonly<Record<string, MessageDescriptor>> = {
  ...Object.fromEntries(
    Object.entries(FIELD_UI).map(([type, ui]) => [type, ui.description]),
  ),
  link: LINKED_ROWS,
};

export const FIELD_GROUPS: Array<{
  label: MessageDescriptor;
  types: string[];
}> = [
  {
    label: msg`Text`,
    types: [
      "text",
      "long_text",
      "email",
      "url",
      "phone",
      "color",
      "place",
      "json",
    ],
  },
  { label: msg`Numbers`, types: ["number", "rating", "duration", "boolean"] },
  { label: msg`Dates`, types: ["date", "datetime"] },
  {
    label: msg`Choices and people`,
    types: ["single_select", "multi_select", "user", "attachment"],
  },
  { label: msg`Relations`, types: ["link", "lookup", "rollup"] },
  {
    label: msg`Computed and system`,
    types: [
      "formula",
      "created_time",
      "last_modified_time",
      "created_by",
      "last_modified_by",
      "autonumber",
      "row_id",
      "row_state",
      "button",
    ],
  },
];

export const DEFAULT_WIDTH: Readonly<Record<string, number>> =
  Object.fromEntries(
    Object.entries(FIELD_UI).flatMap(([type, ui]) =>
      "width" in ui ? [[type, ui.width]] : [],
    ),
  );

/** A field nobody types into: computed, kept by the system, or a button. */
export function isComputedField(fieldType: string): boolean {
  if (!Object.hasOwn(FIELD_DEFINITIONS, fieldType)) return false;
  const { role } = FIELD_DEFINITIONS[fieldType as FieldType].physical;
  return role === "computed" || role === "system" || role === "virtual";
}

export function isLinkField(fieldType: string): boolean {
  return isRelationType(fieldType as FieldType);
}
