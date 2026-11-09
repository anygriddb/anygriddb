# 0012 — React Aria Components and a DOM grid

- Status: Accepted
- Date: 2026-11-07

## Context

The target clients are regulated: audit trails, signatures, public sector.
Accessibility is an obligation for them: the European Accessibility Act has
applied since June 2025, and the RGAA applies to the French public sector.
The UI uses Radix primitives (their pace has slowed) and dnd-kit 6 (being
replaced upstream by `@dnd-kit/react`).

## Decision

- **[React Aria Components](https://react-spectrum.adobe.com/react-aria/)**
  (Apache-2.0) replaces Radix and dnd-kit. It brings, in one tested
  library:
  - dialogs, popovers, menus, and tooltips;
  - localized date and number fields, for date fields and the calendar view;
  - a combo box, for picking links;
  - accessible drag and drop, for kanban and calendar.
- **cmdk** stays for the command palette.
- **The grid stays a DOM grid**, virtualized with TanStack Virtual, with the
  ARIA grid pattern.
  - Selection moves to a store outside React state, so a selection change
    does not re-render the grid.
  - The React Compiler memoizes cells.

## Consequences

- `packages/ui` (about 560 lines) is rewritten.
- The grid component is restructured.

## Rejected

- **Base UI 1.0** (by Radix's authors). The shortest migration, but it
  covers less of a spreadsheet's needs: dates, localized numbers, and drag
  and drop.
- **A canvas grid** (Glide Data Grid, or a canvas table of our own).
  Faster raw rendering, but it breaks screen readers, text selection, and
  browser extensions.
