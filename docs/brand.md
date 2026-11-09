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

The interface is a notebook: the chrome is the desk, the grid is a ruled
page laid on it, text is ink, the grid's lines are the page's rules, and
the red line where the frozen columns end is its margin. Everything else
is white, ink, and one blue for actions. Tokens live in
`packages/ui/src/styles.css`; `tokens.test.ts` holds every text token at
WCAG AA on each surface it is written on.

| Token                | Light     | Dark      | Role                                  |
| -------------------- | --------- | --------- | ------------------------------------- |
| `--ag-background`    | `#f3f4f7` | `#141822` | The desk: sidebar, page backgrounds   |
| `--ag-card`          | `#ffffff` | `#1b2030` | The sheet: grid, panels, dialogs      |
| `--ag-head`          | `#f7f8fb` | `#1f2537` | A sheet's header, gutter, and summary |
| `--ag-foreground`    | `#15213a` | `#e7eaf3` | Ink                                   |
| `--ag-border`        | `#dde1ea` | `#283046` | Lines of the chrome                   |
| `--ag-rule`          | `#ccd3ee` | `#2f3852` | The sheet's rules                     |
| `--ag-strong-border` | `#b3bde8` | `#414c72` | The rule under a header               |
| `--ag-primary`       | `#1f3fae` | `#93a7ff` | Actions, focus, and the mark          |
| `--ag-margin`        | `#d9626a` | `#e38a90` | The margin where frozen columns end   |
| `--ag-warning`       | `#8f4f08` | `#e2a84b` | Notices, on `--ag-warning-surface`    |

`theme-color` and the static icons take the light primary, `#1f3fae`.

Type is IBM Plex Sans, with IBM Plex Mono kept for what comes from the
database as is: identifiers, table names, SQL. Figures are tabular
everywhere. Radius says what a thing is: sheets and panels 2 px, controls
4 px, chips round. Only what floats (menus, dialogs) casts a shadow; what
lies on the desk is ruled.

## Rules

- Use `BrandMark` for the product in the app's chrome, not a generic grid
  icon.
- Keep the mark square.
- Pictures of the product are screenshots of the product, never generated
  images.
