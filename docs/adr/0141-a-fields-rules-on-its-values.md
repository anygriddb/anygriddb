# 0141 — A field's rules on its values

- Status: Accepted
- Date: 2026-11-28
- Relates to: 0023 (exact decimals), 0045 (field editors), 0103 (what a
  writer saw), 0138 (the SQL of each field type in one entry)

## Context

A number field may refuse negative numbers (`nonNegative`), and any field
of AnyGridDB's own tables may require a value. Nothing else holds a value
to a shape: a code typed `ab12` where the service writes `AB-0012`, an age
of 450, a name of three thousand characters where a forty-character code
is expected, all go in, from the grid, a form, the API or an import. Where
AnyGridDB is meant to run (hospitals, banks, administrations), a value's
shape is checked where it is typed, or the table fills with what someone
downstream must clean by hand.

A pattern is the usual way to say a shape, and a regular expression the
usual way to write one. A regular expression a person types, run by the
server on every write, can take the server's time on a crafted value
(backtracking), and few of the people who make a table write one.

## Decision

1. **A number field** takes a smallest and a largest value, each optional,
   bounds included, as exact decimals (ADR 0023): `min` and `max` in its
   settings, `min` never above `max`. "Refuse negative numbers" is a
   smallest value of 0: one rule, not two. A migration turns every
   `nonNegative: true` into `min: "0"`, and the key goes. A value outside
   is refused as `value_out_of_range`, naming the field.
2. **A short text field** takes a longest length, in characters, and a
   mask: `#` a digit, `A` a letter from A to Z in either case, `*` either,
   `\` the next character as itself, and every other character itself. The
   whole value fits the mask, character by character. A mask is read in
   one pass over the value: what a value costs to check grows with its
   length alone, and nothing a person types runs as an expression on the
   server. Refused as `value_too_long` and `value_mismatch`, naming the
   field.
3. **Checked where every value is checked** (`assertCellValue`): the grid,
   forms, the REST API, MCP, imports, automations and scripts; on a
   client's table, on what AnyGridDB writes there. A value already in the
   table stays until it is changed, as a required value does. A default
   the field would refuse is refused with its settings.
4. **Said where a value is typed**: the field's dialog sets the rules, a
   public form knows them (they are among what a link gets of a field), a
   refusal names the field and its rule, and the API's description of a
   table carries them (`minimum`, `maximum`, `maxLength`, a `pattern` the
   mask is written as).

## Not now

A date's range, a rule across several fields, a free regular expression,
and rules on long text, e-mail, URL or phone fields, which keep their own.

## Consequences

- **A break for API clients:** a negative number in a field that refuses
  one answers `value_out_of_range`, no longer `negative_number`, and a
  field's settings say `min: "0"` where they said `nonNegative: true`.
  Written to the CHANGELOG with what to do.
- One more place where a table's maker says what a value must be, read by
  every way in, with nothing to keep in step by hand.
