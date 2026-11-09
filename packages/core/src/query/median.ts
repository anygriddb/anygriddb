/**
 * The middle value of `sql` over `source` (a FROM item and its WHERE), or
 * the mean of the two middle ones: blanks sorted last, whatever the engine
 * sorts first, and left out of the count. The same SQL on every engine,
 * exact: PERCENTILE_CONT would compute in floating point.
 */
export function exactMedian(sql: string, source: string): string {
  return `(select avg(m.v) from (select ${sql} as v, row_number() over (order by case when ${sql} is null then 1 else 0 end, ${sql}) as rn, count(${sql}) over () as c from ${source}) m where m.v is not null and 2 * m.rn in (m.c, m.c + 1, m.c + 2))`;
}
