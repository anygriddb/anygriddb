import type {
  BooleanAppearance,
  MultiSelectAppearance,
  OptionColor,
  SingleSelectAppearance,
} from "@anygriddb/core";
import {
  BOOLEAN_APPEARANCES,
  MULTI_SELECT_APPEARANCES,
  OPTION_COLORS,
  RATING_ICONS,
  SINGLE_SELECT_APPEARANCES,
} from "@anygriddb/core";
import {
  Flag,
  Flame,
  Heart,
  Star,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react";
import type { CatalogColumn } from "../../lib/types";

/** Lucide icon for each configured rating glyph. */
export const RATING_ICON: Record<(typeof RATING_ICONS)[number], LucideIcon> = {
  star: Star,
  heart: Heart,
  thumb: ThumbsUp,
  flag: Flag,
  fire: Flame,
};

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Single-select presentation; omitted config → badge. */
export function singleSelectAppearance(
  column: CatalogColumn,
): SingleSelectAppearance {
  const raw = (column.config as { appearance?: unknown }).appearance;
  return asEnum(raw, SINGLE_SELECT_APPEARANCES) ?? "badge";
}

/** Multi-select presentation; omitted config → badge. */
export function multiSelectAppearance(
  column: CatalogColumn,
): MultiSelectAppearance {
  const raw = (column.config as { appearance?: unknown }).appearance;
  return asEnum(raw, MULTI_SELECT_APPEARANCES) ?? "badge";
}

/** Boolean presentation; omitted config → check. */
export function booleanAppearance(column: CatalogColumn): BooleanAppearance {
  const raw = (column.config as { appearance?: unknown }).appearance;
  return asEnum(raw, BOOLEAN_APPEARANCES) ?? "check";
}

type RatingVisual = {
  max: number;
  icon: (typeof RATING_ICONS)[number];
  color: OptionColor | null;
};

/** Rating max, icon, and colour from the column config. */
export function ratingVisual(column: CatalogColumn): RatingVisual {
  const config = column.config as {
    ratingMax?: unknown;
    ratingIcon?: unknown;
    ratingColor?: unknown;
  };
  const max =
    typeof config.ratingMax === "number" &&
    Number.isInteger(config.ratingMax) &&
    config.ratingMax >= 1 &&
    config.ratingMax <= 10
      ? config.ratingMax
      : 5;
  return {
    max,
    icon: asEnum(config.ratingIcon, RATING_ICONS) ?? "star",
    color: asEnum(config.ratingColor, OPTION_COLORS) ?? null,
  };
}
