# 0045 — Cell editors on React Aria; exact numbers stay text

- Status: Accepted (amends 0012 for number fields); ratings and list
  appearances amended 2026-11-10
- Date: 2026-11-09

## Context

ADR 0012 chose React Aria for, among others, localized date and number
fields and a combo box. The cell editors still used the browser's date
inputs, free text for numbers, and lists of buttons that the arrows did
not walk. ADR 0023 makes numbers exact: a decimal travels as a string,
never as a float, because client tables hold `numeric(38,10)` and 64-bit
keys.

## Decision

- **Dates**: React Aria's DatePicker in the grid, the record panel, the
  forms, and the new-row dialog. Segments follow the field's format
  (`us` month first, `iso` year first) in the reader's language; a date
  and time is edited in its field's time zone, shown when set. The key
  that opens a grid editor goes into the first segment.
- **Lists** (options, people, links): React Aria's Autocomplete over a
  ListBox. Focus stays in the search field, the arrows move through the
  options (`aria-activedescendant`), Enter picks, Escape closes, Tab
  closes and moves to the next cell. A link's "create" is an option of
  the list.
- **Ratings** (amended 2026-11-10): a slider of the field's own icons
  (`role="slider"`, 0 to the maximum, its value said as `3/5`), the same
  control in the grid, the record panel, and the forms. The arrows,
  Home, End, and a digit change it; Enter or Tab keeps it, Escape leaves
  it; a click on an icon sets it, and on the current one clears it. The
  icons are drawn, not controls of their own. It replaced React Aria's
  NumberField once ratings took an icon and a colour: a spin button
  showed a number where the cell showed stars.
- **Lists shown as radio buttons or a checklist** (amended 2026-11-10):
  a single or multiple choice whose field asks for that appearance is
  edited with native radio buttons or checkboxes in a labelled group;
  the default appearance keeps the Autocomplete list.
- **Numbers stay a text field**, checked as typed (`aria-invalid`) and
  parsed by `coerceCellValue`. React Aria's NumberField holds a float:
  past 15 significant digits it would round what the person typed, which
  ADR 0023 forbids.
- React Aria is given the app's language (`fr-FR` or `en-GB`), so its
  own words and its dates follow the person's choice, not the browser's.
- The e2e journey `editors.spec.ts` checks the grid, the editors, the
  record panel, and a form with axe (WCAG 2.2 A and AA) and from the
  keyboard.

## Consequences

- A number cell has no arrow-key increments and no locale formatting
  while it is edited; it shows the value as stored (`1234.5`) and reads
  `1 234,5` or `1,234.5` back.
- A date and time field without a time zone is edited in the browser's,
  as it is shown.
- The editors stop the grid from taking a click inside them, so a click
  moves a caret or picks an option instead of ending the edit.

## Rejected

- **NumberField for every number**: rounds decimals beyond float
  precision (ADR 0023).
- **A NumberField fed by a decimal library**: React Aria's number state
  has no string mode; wrapping it would re-implement its parser.
- **The browser's date inputs**: their segments, calendar, and time zone
  handling differ per browser, and none follows a field's own zone.
