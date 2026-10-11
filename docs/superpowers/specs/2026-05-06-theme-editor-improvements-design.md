# Theme Editor Improvements

## Goal

Make the theme customization UI in `apps/web/src/components/settings/ThemeEditor.tsx`:

1. Show the inherited/default value as a live preview, so users can see what they're customizing away from.
2. Cover more theme variables — font family (sans + mono) and base font size.
3. Render the right input control per token type — no color picker for an opacity value, a proper number+unit input for length values, etc.

## Scope

In scope:

- `apps/web/src/themes/types.ts` — token list + new per-token metadata (kind).
- `apps/web/src/themes/builtin.ts` — defaults for new tokens on `DEFAULT_THEME`.
- `apps/web/src/themes/registry.ts` — extend value validation to dispatch by kind.
- `apps/web/src/index.css` — declare the new CSS variables and consume them on `body` / `pre, code`.
- `apps/web/src/components/settings/ThemeEditor.tsx` — render per-kind input controls and inherited previews.
- `apps/web/src/components/settings/ThemeEditor.test.ts` — extend with tests for the new behavior.

Out of scope:

- Updating non-default built-in themes (`SOLARIZED_DARK`, `NORD`, `HIGH_CONTRAST`) with new tokens — they inherit from default.
- A new font picker component or curated font list.
- Localized fonts, variable-font axes, or per-component font overrides.
- Migrating existing custom themes — the new tokens are optional; absence means inherit.

## Token kinds

Five kinds, each driving one input control:

| kind          | tokens                                             | control                                        |
| ------------- | -------------------------------------------------- | ---------------------------------------------- |
| `color`       | every existing color token                         | `ColorPicker` + text input + reset             |
| `opacity`     | `noise-opacity`                                    | range slider (0–1, step 0.005) + number input  |
| `length`      | `radius`, `font-size-base` (new)                   | number input + unit selector (`px`/`rem`/`em`) |
| `font-family` | `font-family-sans` (new), `font-family-mono` (new) | text input rendered in the current font        |

A new `THEME_TOKEN_META` constant in `themes/types.ts` maps each token name to its kind:

```ts
export type ThemeTokenKind = "color" | "opacity" | "length" | "font-family";

export const THEME_TOKEN_META: Record<ThemeTokenName, { kind: ThemeTokenKind }> = {
  background: { kind: "color" },
  // ...
  "noise-opacity": { kind: "opacity" },
  radius: { kind: "length" },
  "font-family-sans": { kind: "font-family" },
  "font-family-mono": { kind: "font-family" },
  "font-size-base": { kind: "length" },
};
```

`THEME_TOKEN_NAMES` stays the source of truth; the `Record` keys are typed against it so adding a token without a kind is a type error.

## New tokens

Added to `THEME_TOKEN_NAMES` and to **both** `DEFAULT_THEME.light` and `DEFAULT_THEME.dark` with identical values, so `resolveTokens(theme, variant)` returns them in either variant and the editor's inherited preview shows the same default in both. (Users can still set different values per variant on a custom theme if they want.)

- `font-family-sans` — current `body` stack from `index.css:158`:
  `'"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'`
- `font-family-mono` — current `pre, code` stack from `index.css:203`:
  `'"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'`
- `font-size-base` — `16px` (browser default; chosen so existing layout doesn't shift).

CSS wiring (`index.css`):

```css
:root {
  --font-family-sans: "DM Sans", -apple-system /* ... */;
  --font-family-mono: "SF Mono" /* ... */;
  --font-size-base: 16px;
}
html {
  font-size: var(--font-size-base);
}
body {
  font-family: var(--font-family-sans);
}
pre,
code {
  font-family: var(--font-family-mono);
}
```

Setting `font-size` on `html` makes Tailwind's `rem`-based text classes (`text-sm`, `text-xs`) scale with the user's choice — that's the whole point of exposing it.

## Inherited preview

Resolution order for what to show as "current value":

1. `draft[variant][token]` — the user's override.
2. If absent, `DEFAULT_THEME[variant][token]` (or `DEFAULT_THEME.light[token]` as a final fallback for tokens like `font-size-base` that only exist on `light`).

Existing helper `resolveTokens(theme, variant)` in `registry.ts:181` already does step 1+2 — the editor calls it once per render and reads from the result whenever the override is empty.

Per kind, the preview behavior:

- **color**: swatch always renders the resolved value via `deriveHex`. Text input placeholder shows the inherited raw string (e.g. `var(--color-white)`).
- **opacity**: number badge shows resolved value (e.g. `0.035`). Slider thumb sits at the inherited position when no override.
- **length**: number input placeholder shows inherited number; unit selector defaults to inherited unit when no override.
- **font-family**: input renders text in `font-family: <current value>`. Placeholder shows the inherited stack (truncated by CSS).

Reset `×` button: unchanged. Visible only when an override exists.

## Per-kind input control details

### Color

No UX change beyond the swatch-source fix above. The existing flow stays: hex from picker → `handleTokenChange(token, hex)`; raw text → same handler.

### Opacity

```tsx
<Slider value={[asNumber(value)]} min={0} max={1} step={0.005} onValueChange={…} />
<Input type="number" min={0} max={1} step={0.005} value={value} … />
```

If `<Slider>` isn't already a UI primitive, fall back to native `<input type="range" />` styled to match other controls. (`apps/web/src/components/ui/` does not have one today, so native is the path.)

Stored as the plain decimal string the slider produces (`"0.035"`). Validation: must parse to a finite number in `[0, 1]`.

### Length

Editor-side state model: `{ number: number; unit: "px" | "rem" | "em" }`. Parsed from the stored string on render, re-serialized on change as `${number}${unit}`.

Parser:

```ts
function parseLength(value: string): { number: number; unit: string } | null {
  const match = /^(-?\d*\.?\d+)\s*([a-z%]+)$/i.exec(value.trim());
  if (!match) return null;
  return { number: Number(match[1]), unit: match[2].toLowerCase() };
}
```

If `parseLength` returns `null` OR the unit is not in our supported set (`px`/`rem`/`em`), render a plain text input for that token instead of the number+unit pair. Graceful degrade for advanced values like `clamp(...)` or `100%`.

### Font family

Single text input, free-form CSS font-family value. The input element's own `style.fontFamily` is set to the current resolved value, so users see what their stack actually renders as. Placeholder = inherited stack, truncated by `text-overflow: ellipsis` (the `Input` component already truncates).

Validation: same `FORBIDDEN_VALUE_PATTERN` check as colors (block `javascript:`, `<script`, etc.), plus a max length of 200 chars (matches existing `isValidColorValue`).

## Validation

Replace `isValidColorValue` exports with per-kind dispatch:

```ts
export function isValidTokenValue(kind: ThemeTokenKind, value: string): boolean {
  // length checks + forbidden-pattern + per-kind shape check
}
```

`isValidColorValue` remains exported (unchanged) for backwards-compat with `tokensToCss` and `ThemeEditor`'s "any invalid value" check. Internally `tokensToCss` now uses `isValidTokenValue(kind, value)` so non-color tokens with invalid shapes (e.g. `noise-opacity: "blue"`) are dropped from the emitted CSS.

The `saveDisabled` calculation in `ThemeEditor` switches to per-kind validation too.

## Layout

Inside the form-mode grid, token rows render as before — two per row on `sm:` and up. Two exceptions for wider controls:

- Opacity row: `sm:col-span-2` (slider + number side-by-side reads better full-width).
- Font-family rows: `sm:col-span-2` (font stacks are long).

Length rows fit the existing single-column slot.

A new category appended to `TOKEN_CATEGORIES`:

```ts
{ title: "Typography", tokens: ["font-family-sans", "font-family-mono", "font-size-base"] }
```

`Misc` keeps `noise-opacity` and `radius`.

## Tests

Add to `ThemeEditor.test.ts`:

- `setTokenValue` already covered for color tokens; add a case for `font-family-sans` and `font-size-base` to confirm the same shape works for non-color kinds.
- New `parseLength` test: round-trips `"0.625rem"`, `"16px"`, returns `null` for `"clamp(1rem, 2vw, 2rem)"`.
- New `isValidTokenValue` test:
  - `("opacity", "0.5")` → true
  - `("opacity", "1.2")` → false
  - `("opacity", "blue")` → false
  - `("length", "16px")` → true
  - `("length", "javascript:alert(1)")` → false
  - `("font-family", "DM Sans, sans-serif")` → true
  - `("font-family", "<script>")` → false

End-to-end UI test (whether vitest+testing-library or just a manual checklist) is out of scope for this spec — verification will be by running the dev server.

## Migration / backwards compat

- New tokens are _optional_ on `ThemeDefinition` (everything in `light`/`dark` is already partial). Existing custom themes in `localStorage` keep working — they just don't have entries for the three new tokens, and the editor shows them as inheriting from default.
- `isValidTheme` validation in `registry.ts:229` allows arbitrary string-keyed maps already, so loading an old theme via JSON import still passes.

## Risks

- **Tailwind rem scaling**: setting `html { font-size: var(--font-size-base); }` cascades into every rem-based size. Default of `16px` matches browser default so layout is identical at the default; non-default values will scale the entire UI, which is the intent. Worth a manual smoke test.
- **Live preview cost**: typing in a font-family input updates the input's own `style.fontFamily` on every keystroke. Cheap — no measurement of risk needed.
- **Slider not in primitives**: using a native `<input type="range">` means slightly different look-and-feel from other controls. Acceptable for the one opacity field.

## Acceptance criteria

1. Opening the editor on a custom theme shows non-color rows (radius, opacity, fonts) with controls appropriate to their kind — no color picker on `noise-opacity`, no color picker on `radius`.
2. Each token row shows its inherited value as a live preview when no override is set.
3. Editing `font-family-sans` to a new stack updates the body font in the live preview.
4. Editing `font-size-base` to `18px` scales `text-sm` / `text-xs` text proportionally everywhere in the app.
5. Saving + reloading restores all custom values, including new typography tokens.
6. JSON-mode still parses + validates (no regression).
7. Existing tests still pass; new tests for `parseLength` and `isValidTokenValue` pass.
