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

| Token          | Light     | Dark      |
| -------------- | --------- | --------- |
| `--ag-primary` | `#0f766e` | `#2dd4bf` |

`theme-color` and the static icons keep the light teal, `#0f766e`.

## Rules

- Use `BrandMark` for the product in the app's chrome, not a generic grid
  icon.
- Keep the mark square.
- Pictures of the product are screenshots of the product, never generated
  images.
