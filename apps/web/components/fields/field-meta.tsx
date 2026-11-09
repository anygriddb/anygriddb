import {
  AtSign,
  Binary,
  Calendar,
  CalendarClock,
  CheckSquare,
  CircleDot,
  Clock,
  FunctionSquare,
  Hash,
  Link2,
  List,
  ListChecks,
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
} from "lucide-react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export const FIELD_ICONS: Record<string, LucideIcon> = {
  text: Type,
  long_text: Text,
  number: Hash,
  boolean: CheckSquare,
  date: Calendar,
  datetime: CalendarClock,
  single_select: CircleDot,
  multi_select: ListChecks,
  email: AtSign,
  url: Link2,
  phone: Phone,
  rating: Star,
  duration: Timer,
  user: Users,
  attachment: Paperclip,
  relation_one_to_many: Link2,
  relation_many_to_many: Link2,
  formula: FunctionSquare,
  lookup: Search,
  rollup: Sigma,
  created_time: Clock,
  last_modified_time: Clock,
  created_by: User,
  last_modified_by: UserCheck,
  autonumber: Binary,
  button: MousePointerClick,
};

export function FieldIcon({
  fieldType,
  className,
}: {
  fieldType: string;
  className?: string;
}) {
  const Icon = FIELD_ICONS[fieldType] ?? List;
  return (
    <Icon
      className={className ?? "h-3.5 w-3.5 shrink-0 opacity-60"}
      aria-hidden
    />
  );
}

/** English source labels, translated by `t` at the call site. */
export const FIELD_LABELS: Record<string, MessageDescriptor> = {
  text: msg`Text`,
  long_text: msg`Long text`,
  number: msg`Number`,
  boolean: msg`Checkbox`,
  date: msg`Date`,
  datetime: msg`Date and time`,
  single_select: msg`Single select`,
  multi_select: msg`Multiple select`,
  email: msg`Email`,
  url: msg`URL`,
  phone: msg`Phone`,
  rating: msg`Rating`,
  duration: msg`Duration`,
  user: msg`Collaborator`,
  attachment: msg`Attachment`,
  relation_one_to_many: msg`Link to a row`,
  relation_many_to_many: msg`Link to rows`,
  formula: msg`Formula`,
  lookup: msg`Lookup`,
  rollup: msg`Rollup`,
  created_time: msg`Created time`,
  last_modified_time: msg`Last modified time`,
  created_by: msg`Created by`,
  last_modified_by: msg`Last modified by`,
  autonumber: msg`Autonumber`,
  button: msg`Button`,
};

export const FIELD_GROUPS: Array<{
  label: MessageDescriptor;
  types: string[];
}> = [
  { label: msg`Text`, types: ["text", "long_text", "email", "url", "phone"] },
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
      "button",
    ],
  },
];

export const DEFAULT_WIDTH: Record<string, number> = {
  boolean: 90,
  rating: 130,
  number: 120,
  autonumber: 90,
  date: 130,
  datetime: 170,
  long_text: 260,
  duration: 110,
};

export function isComputedField(fieldType: string): boolean {
  return (
    fieldType === "formula" ||
    fieldType === "lookup" ||
    fieldType === "rollup" ||
    fieldType === "created_time" ||
    fieldType === "last_modified_time" ||
    fieldType === "created_by" ||
    fieldType === "last_modified_by" ||
    fieldType === "autonumber" ||
    fieldType === "button"
  );
}

export function isLinkField(fieldType: string): boolean {
  return (
    fieldType === "relation_one_to_many" ||
    fieldType === "relation_many_to_many"
  );
}
