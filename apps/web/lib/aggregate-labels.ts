import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** What each aggregate is called, under a grid's column and on a dashboard. */
export const AGGREGATE_LABELS: Record<string, MessageDescriptor> = {
  count_all: msg`Number`,
  count_empty: msg`Empty`,
  count_filled: msg`Filled`,
  count_unique: msg`Unique`,
  percent_empty: msg`% empty`,
  percent_filled: msg`% filled`,
  percent_unique: msg`% unique`,
  sum: msg`Sum`,
  avg: msg`Average`,
  median: msg`Median`,
  min: msg`Min`,
  max: msg`Max`,
  std_dev: msg`Standard deviation`,
  earliest: msg`Earliest`,
  latest: msg`Latest`,
  date_range_days: msg`Range (days)`,
  checked: msg`Checked`,
  unchecked: msg`Unchecked`,
  percent_checked: msg`% checked`,
  percent_unchecked: msg`% unchecked`,
};
