# Brand

AnyGridDB's mark is a rounded square of the primary colour with a grid of
four cells. The source is [`apps/web/public/icon.svg`](../apps/web/public/icon.svg);
in the app, `BrandMark` (`apps/web/components/brand/brand-mark.tsx`) draws
it in the theme's primary colour, its cells in the colour written on the
primary, so it keeps its contrast in the light and dark themes.

| File                                   | Use                     |
| -------------------------------------- | ----------------------- |
| `apps/web/public/favicon.ico`          | Browser tab (16, 32 px) |
| `apps/web/public/icon.svg`             | Browser tab, any size   |
| `apps/web/public/apple-touch-icon.png` | Home screen (180 px)    |

The interface is a register: the page is ledger paper, the grid and the
panels are sheets laid on it, text is writing ink, and borders are its
rules. Tokens live in `packages/ui/src/styles.css`; `tokens.test.ts` holds
every text token at WCAG AA on each surface it is written on.

| Token             | Light     | Dark      | Role                                         |
| ----------------- | --------- | --------- | -------------------------------------------- |
| `--ag-background` | `#eaefea` | `#0f1715` | The page                                     |
| `--ag-card`       | `#fbfcfa` | `#151f1c` | Sheets: grid, panels, dialogs                |
| `--ag-foreground` | `#182832` | `#e6ece8` | Ink                                          |
| `--ag-border`     | `#c6d3cb` | `#2a3833` | Rules                                        |
| `--ag-primary`    | `#0f766e` | `#2dd4bf` | Actions and the mark                         |
| `--ag-margin`     | `#c94f47` | `#e07a73` | The red margin rule where frozen columns end |

`theme-color` and the static icons keep the light teal, `#0f766e`.

Type is Atkinson Hyperlegible Next, with Atkinson Hyperlegible Mono for
identifiers and code: its 0/O, 1/l/I, and 8/B cannot be mistaken for one
another. Figures are tabular everywhere. Radius says what a thing is:
sheets and panels 2 px, controls 4 px, chips round. Only what floats
(menus, dialogs) casts a shadow; what lies on the page is ruled.

## Rules

- Use `BrandMark` for the product in the app's chrome, not a generic grid
  icon.
- Keep the mark square.
- Pictures of the product are screenshots of the product, never generated
  images.
