# Accessibility

AnyGridDB aims to be usable by everyone, including people who use a keyboard
only or assistive technology. Accessibility is part of how the interface is
built ([ADR 0012](docs/adr/0012-react-aria-and-dom-grid.md)), not an optional
layer.

This statement sets expectations. It is **not** a claim of verified
conformance for every screen.

## Target

We work toward [WCAG 2.2 Level AA](https://www.w3.org/TR/WCAG22/). Automated
checks in the Playwright journeys use axe with that target
(`accessibilityViolations` in `apps/web/e2e/setup.ts`).

Priorities:

- **Keyboard** — interactive controls are reachable and operable without a
  mouse, with a visible focus indicator and a logical order.
- **Screen readers** — overlays and shared controls use [React Aria](https://react-spectrum.adobe.com/react-aria/);
  the grid follows the ARIA grid pattern.
- **Meaning without colour alone** — status and errors are named in text or
  semantics, not only by colour.
- **Motion** — the journeys run with reduced motion; new animation must respect
  the user's preference.

## For contributors

UI changes under `apps/web` or `packages/ui`:

- Prefer shared controls in `packages/ui` over one-off overlays.
- Keep `accessibilityViolations(page)` empty in any journey you touch.
- Do at least one keyboard-only pass on new interactive UI.
- Name every field with a visible label; wire descriptions and required state
  through `aria-describedby` / `aria-required`.
- Drag-and-drop (kanban, calendar) must stay usable by keyboard.

Details: [`CONTRIBUTING.md`](CONTRIBUTING.md), the pull request checklist, and
the product's UI accessibility conventions.

## Supported environments

Intended for:

- **Web (desktop):** current Chrome, Edge, Firefox, and Safari.
- **Web (narrow):** usable at about 390 px width (navigation folds away).
- **Assistive technology:** meant to work with VoiceOver on macOS and NVDA on
  Windows, through the patterns above. No screen reader runs in the automated
  journeys: tell us where one stumbles.

The automated journeys run in Chromium. Other browsers and assistive tools are
supported on a best-effort basis; please report gaps.

## Known limitations

- A virtualized grid of thousands of rows is harder for a screen reader than a
  short form: we keep row and column indexes and active descendant, but large
  tables remain demanding.
- Some dense administration tables are less polished than the grid and forms.
- Third-party content an operator embeds (for example a map tile provider's
  UI) is outside this project's control.

Workarounds and fixes belong in issues labelled `accessibility`.

## Reporting a barrier

1. Open an issue with the [accessibility template](https://github.com/anygriddb/anygriddb/issues/new?template=accessibility.yml).
2. Include, when you can: what you tried to do, what happened, steps, OS,
   browser, assistive technology and versions, and how severe it felt
   (blocks a core task / hard with a workaround / annoying / minor).
3. Do not put secrets, personal data, or security findings in a public issue;
   those go to [`SECURITY.md`](SECURITY.md).

Reports are treated as expertise. We acknowledge them and share a workaround
when we have one.

## Feedback on this statement

Suggestions that improve this document or our practices are welcome as an
issue or a pull request.
