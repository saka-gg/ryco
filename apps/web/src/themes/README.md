# Theme System

A VS Code-style custom theming system for Ryco. Users can pick from built-in themes, install community themes, and author their own — overriding chrome color, scrollbar, and status tokens. Global interface controls such as font family, text size, corner radius, optional primary color override, and surface transparency live outside themes so they stay consistent while users switch palettes.

## Goal

End-state: a user can open **Settings → Appearance**, pick a theme from a dropdown, click "Edit" to fork it as a JSON file, tweak tokens with a live preview, and import/export `.json` files. All of this works offline (web + Electron) and persists across sessions.

The architecture is purely token-driven: themes are JSON objects of CSS-variable overrides applied via a single injected `<style>` tag. Light/dark variants live inside one theme.

---

## Architecture

```
apps/web/src/
├── index.css                  Defines default :root + .dark tokens (the fallback)
├── themes/
│   ├── types.ts               ThemeDefinition + token name allow-list
│   ├── builtin.ts             Default light/dark tokens as data
│   ├── registry.ts            Storage, lookup, CSS injection
│   ├── appearancePreferences.ts Global font/text-size/radius/primary/transparency preferences
│   └── README.md              You are here.
└── hooks/
    └── useTheme.ts            Light/dark toggle + active-theme application
```

**Data flow:**

1. `useTheme` reads `ryco:theme` (light/dark/system) → toggles `.dark` class on `<html>`
2. `useTheme` reads `ryco:active-theme` → looks up theme in registry → calls `applyThemeToDocument`
3. `applyThemeToDocument` writes a `<style id="ryco-active-theme">` tag containing `:root { --x: ... } :root.dark { --y: ... }`
4. `applyAppearancePreferencesToDocument` writes `<style id="ryco-appearance-preferences">` for global controls like `--font-family-sans`, `--font-family-mono`, `--font-size-base`, `--radius`, optional `--primary`/`--ring`, the `--app-*` surface transparency variables, the phone material tiers (`--app-glass-{sheet,chip}-*`) and the motion tokens (`--app-motion-*`)
5. Because these style tags are appended after `index.css`, their variables win — but only ones the theme or preference layer defines, so partial themes work.

**Effective vs stored preferences.** Two values are resolved from the environment rather than read straight out of storage: through `getEffectiveAppearancePreferences`, `surfaceTransparency` is pinned to `default` (Solid) on the desktop tier, which has no step control (its see-through setting is the translucent window, `windowTranslucency`), and on the phone tier honours the stored step or falls back to the phone's own default (`medium`), and the motion durations collapse under `prefers-reduced-motion`. `syncAppearancePreferenceEnvironment` (wired in `main.tsx`) republishes the variables when the tier or a media query changes.

`prefers-reduced-transparency` is deliberately **not** part of that derivation. It is enforced in the `prefers-reduced-transparency` block in `index.css`, so the emitted `--app-*` values are identical whether or not the OS setting is on. Folding it into the derivation would move desktop scrims the setting never used to touch, and would make the phone settings UI display — and on the next tap persist — a value the user never chose. `isSurfaceTransparencyReducedBySystem` exists so the UI can report the override instead.

**Key invariant:** `index.css` always contains the _full_ default token set. Any theme is a _patch_ on top, never a replacement. Global appearance preferences are a second patch after themes, so palette changes cannot unexpectedly change typography, resize, or reshape the UI.

---

## Phase 1 — Foundation ✅ DONE

What shipped:

- **Tokenized remaining hard-coded colors** in `index.css`: scrollbar thumbs (regular + thin variants) use CSS variables (`--scrollbar-thumb*`). The historical `--noise-opacity` token remains import-compatible with older custom themes, but the continuously composited noise overlay is no longer rendered or editable.
- **Theme schema** (`types.ts`): `ThemeDefinition` with `id`, `name`, `description`, `builtIn`, `light`, `dark`. Token names are an allow-list (`THEME_TOKEN_NAMES`) for type safety + future validation.
- **Default theme as data** (`builtin.ts`): mirrors current `index.css` values — so when the active theme is `default`, no overrides are injected and the CSS file does all the work.
- **Theme registry** (`registry.ts`): `getAllThemes()`, `findTheme()`, `getActiveThemeId()`, `setActiveThemeId()`, `getCustomThemes()`, `setCustomThemes()`, `applyThemeToDocument()`. Storage keys `ryco:active-theme` and `ryco:custom-themes`.
- **`useTheme` integration**: applies the active theme alongside the existing light/dark toggle. New API surface: `activeThemeId`, `setActiveTheme(id)`. Cross-tab sync works via the `storage` event listener.
- **Defensive guards**: `applyThemeToDocument` no-ops when DOM isn't available (Node test envs).

Verified: zero new test failures vs main (same 8 pre-existing env-dependent failures both before and after).

---

## Phase 2 — Theme Picker UI ✅ DONE

What shipped:

- **New `Settings → Appearance` route** at `apps/web/src/routes/settings.appearance.tsx`, sibling to `settings.general.tsx`.
- **Sidebar entry** in `SettingsSidebarNav` (`PaletteIcon`, between General and Source Control).
- **`AppearanceSettingsPanel`** component (`apps/web/src/components/settings/AppearanceSettings.tsx`):
  - Theme palette dropdown — populated from `getAllThemes()`, calls `setActiveTheme(id)`.
  - Color mode selector — light/dark/system (moved from General to consolidate appearance settings).
  - Active theme description + "Built-in" badge surfaced as the row's status text.
  - Reset-to-default chips on both rows when not at defaults.
- **Built-in themes** are curated in `BUILT_IN_THEMES`; the current set includes Default, Midnight Graphite, Nord, High Contrast, One Dark Pro, Dracula, GitHub, Catppuccin, and Tokyo Night.
- **Settings shell** (`routes/settings.tsx`) now shows "Restore defaults" on `/settings/appearance` in addition to `/settings/general`.
- **Unit tests** (`themes/registry.test.ts`): `findTheme` fallback, `resolveTokens` merging (overlay over base, partial themes), `tokensToCss` output shape.

Verified: 1011/1011 unit tests pass; typecheck shows only the pre-existing `SortableContext` error; in-browser eval confirms each new theme's tokens land on `:root` and the active id persists across reload.

---

## Phase 3 — Custom Theme Editor ✅ DONE

What shipped:

- **Registry helpers** (`registry.ts`):
  - `duplicateTheme(source)` — generates a `custom-<id>` (with collision avoidance) and `"<name> (Copy)"`, force-sets `builtIn: false`
  - `addCustomTheme`, `updateCustomTheme`, `deleteCustomTheme` — persist via `setCustomThemes`; `delete` falls back to `default` when the deleted theme was active; `update` rotates the active id when the theme is renamed; rename collisions throw
  - `isBuiltInThemeId(id)` for guarding edits/deletes
  - `isValidColorValue(value)` — rejects empty / >200 char / `javascript:` / `expression(` / `<script` / `url(javascript:)`
  - `isValidTheme` is now exported (used by the JSON editor)
- **Inline `<ThemeEditor>` panel** (`apps/web/src/components/settings/ThemeEditor.tsx`) rendered inside the Theme palette row. Includes:
  - Name + Description inputs
  - **Form mode**: tokens grouped by category (Surfaces, Brand & focus, Neutrals, Status, Borders & inputs, Scrollbars, Misc) with a swatch preview, raw value input (CSS expressions like `oklch(...)` / `var(...)` / `color-mix(...)` allowed), `×` to reset, `--token` label monospaced
  - **JSON mode**: schema-validated textarea using `isValidTheme`; Save disabled while invalid
  - **Variant tabs**: edit `light` / `dark` independently
  - **Live preview**: `applyThemeToDocument(draft)` runs on every draft/variant change; on cancel/unmount the source theme is re-applied so abandoned changes don't leak
  - Save/Cancel buttons; cancel prompts via `window.confirm` if the draft is dirty
  - Delete button (custom themes only) with a confirmation prompt
- **Appearance settings wiring** (`AppearanceSettings.tsx`):
  - "Duplicate" button forks the active theme and immediately enters edit mode on the copy
  - "Edit" button on a built-in fork-and-edits; on a custom theme edits in place
  - Active palette badge shows "Built-in" or "Custom"
- **Tests** added:
  - `themes/registry.test.ts` — 16 new tests for `isBuiltInThemeId`, `isValidColorValue`, `isValidTheme`, custom-theme storage (add/update/delete/active rotation/rename collision), `duplicateTheme`, `generateCustomThemeId`
  - `components/settings/ThemeEditor.test.ts` — pure helpers `setTokenValue`, `setThemeName`, `setThemeDescription` (variant isolation, empty-value removal, immutability)

Verified: 1033/1033 unit tests pass; `tsc --noEmit` clean (only the pre-existing `Sidebar.tsx` `SortableContext` error). In-browser eval against the live Vite bundle confirmed the full acceptance path: forked default → set `light.primary` to `red` → saved → `getComputedStyle(:root).--primary === "red"` → full page reload still shows `red` and `localStorage["ryco:active-theme"] === "custom-default"`. Collision avoidance, value validation, and active-theme fallback after delete were all confirmed live.

---

## Phase 4 — Import / Export & Sharing ✅ DONE

What shipped:

- **`themes/transport.ts`** — single module that owns all serialization:
  - `serializeTheme(theme)` — strips `builtIn`, emits stable JSON (id, name, description?, light?, dark?)
  - `parseTheme(raw)` — reuses `isValidTheme`, returns a fresh `ThemeDefinition` with `builtIn: false`
  - `themeFilename(theme)` — slugifies name into `<slug>.rycotheme.json`
  - `downloadTheme(theme)` — uses a `Blob` + `<a download>` to push the file to disk
  - `importTheme(raw, collision)` — `"rename"` (default; always safe) or `"replace"`. Built-in id collisions are always renamed since you can't replace a built-in. Returns `{ theme, action }` where action is `added | renamed | replaced`.
  - `importThemeFromFile(file, { collision, activate })` — async helper; can immediately switch the active theme to the imported one
  - `encodeThemeToBase64` / `decodeThemeFromBase64` — UTF-8-safe round-trip; works in both browser (`btoa`/`atob` + `TextEncoder`) and Node (`Buffer`)
  - `copyThemeToClipboard(theme)` — `navigator.clipboard.writeText(serializeTheme(theme))`
- **Appearance row "Share & sync"** in `AppearanceSettings.tsx`:
  - **Export** — downloads `<name>.rycotheme.json`
  - **Import** — hidden `<input type="file">` triggered from the button; on success the imported theme becomes active and a toast announces add/rename
  - **Copy JSON** — clipboard copy with a success toast
  - All errors surface through `toastManager.add({ type: "error", ... })`
- **Schema documentation** added below — authors can hand-write `.rycotheme.json` files
- **Tests** (`themes/transport.test.ts`): 18 new tests covering filename slugging, serialize/parse round-trips, parse error paths, base64 round-trips (including UTF-8 names), `importTheme` for added/renamed/replaced (including built-in id collision), and `getCustomThemes` reflecting writes after import

Verified: `bun --cwd apps/web run test` → 1051/1051 pass; `bun --cwd apps/web run typecheck` clean (only pre-existing Sidebar.tsx error). Live browser eval confirmed the round-trip end-to-end: export the active theme to a string → wipe localStorage → import the string → activate → reload → identical computed `--primary` value.

---

## Theme JSON schema

Files use the `.rycotheme.json` extension and follow this shape:

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "description": "Optional one-liner",
  "light": {
    "primary": "#ff0000",
    "background": "#fafafa"
  },
  "dark": {
    "primary": "oklch(0.6 0.2 264)"
  }
}
```

Rules:

- `id` and `name` must be non-empty strings.
- `light` and `dark` are both optional. Tokens missing from a variant fall back to the default theme's values for that variant.
- Token values must be strings. Allowed: any CSS color, `var(...)`, `oklch(...)`, `color-mix(...)`, percentages, `rgba(...)`, etc.
- `font-family-sans`, `font-family-mono`, `font-size-base`, `radius`, and app surface transparency are global appearance preferences. Legacy theme files may still contain the token-shaped values, but theme CSS emission ignores them.
- The full token allow-list lives in `types.ts` (`THEME_TOKEN_NAMES`). Tokens outside that set are ignored on save by the editor; on import they're preserved but won't be emitted to CSS.
- `builtIn` is ignored on import — every imported theme becomes a custom theme.

---

## Phase 5 — Syntax Highlighting Integration (Optional)

**Goal:** Themes also restyle code blocks.

Current state: code highlighting is shiki-based (see `chat-markdown-shiki` rule and `ChatMarkdown.tsx`). Today shiki uses its own theme list independent of chrome.

Tasks:

- [ ] Extend `ThemeDefinition` with an optional `syntax` field — either a shiki theme name (e.g. `"github-dark"`) or an inline TextMate-style theme JSON
- [ ] Plumb the active theme's `syntax` value into the shiki highlighter call site
- [ ] Provide a sensible default per theme variant (light → `github-light`, dark → `github-dark`)
- [ ] Ship one full theme (chrome + syntax) end-to-end as a reference

Acceptance: switching theme also re-colors code blocks; falls back gracefully if the syntax theme is missing.

---

## Phase 6 — Polish

- [ ] Add a "Reset to default" button per setting in the editor
- [ ] Validate color values at save time (reject `--primary: javascript:alert(1)` etc.) — token values must match a CSS-color/length grammar
- [ ] Animate transitions on theme switch (already partially handled by `.no-transitions` class)
- [ ] Sync custom themes to disk in Electron via `desktopBridge` so they survive uninstall/clearStorage (separate file, e.g. `userdata/themes/`)
- [ ] Telemetry: count theme installs/exports if useful
- [ ] Marketplace stub: a curated list rendered in the picker, fetched from a GitHub-hosted JSON index

---

## File reference (current Phase 1 state)

| File                                           | Purpose                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/web/src/index.css`                       | Default tokens for `:root` and `.dark` (the fallback every theme patches)                    |
| `apps/web/src/themes/types.ts`                 | `ThemeDefinition`, `ThemeTokens`, `THEME_TOKEN_NAMES`                                        |
| `apps/web/src/themes/builtin.ts`               | `DEFAULT_THEME` + `BUILT_IN_THEMES`                                                          |
| `apps/web/src/themes/registry.ts`              | Storage, lookup, CSS injection (`applyThemeToDocument`)                                      |
| `apps/web/src/themes/appearancePreferences.ts` | Global font/text-size/radius/transparency storage and CSS injection                          |
| `apps/web/src/hooks/useTheme.ts`               | React hook — exposes `theme`, `setTheme`, `resolvedTheme`, `activeThemeId`, `setActiveTheme` |

## Storage keys

| Key                           | Type                                                                                      | Purpose                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `ryco:theme`                  | `"light" \| "dark" \| "system"`                                                           | Light/dark/system mode (existing)                   |
| `ryco:active-theme`           | string (theme id)                                                                         | Which theme to apply (new — Phase 1)                |
| `ryco:custom-themes`          | `ThemeDefinition[]` JSON                                                                  | User-authored themes (new — Phase 1)                |
| `ryco:appearance-preferences` | `{ fontFamilySans?, fontFamilyMono?, fontSizeBase?, radius?, surfaceTransparency? }` JSON | Global font/text-size/radius/transparency overrides |

## Hook API

```ts
const { theme, setTheme, resolvedTheme, activeThemeId, setActiveTheme } = useTheme();

// theme:          "light" | "dark" | "system"  (the variant)
// resolvedTheme:  "light" | "dark"             (system resolved)
// activeThemeId:  string                       (which palette is active)
// setTheme(v):    change variant
// setActiveTheme(id): change palette
```

## Token allow-list

Defined in `types.ts`. Adding a new token requires:

1. Append to `THEME_TOKEN_NAMES`
2. Add the variable to `:root` (and `.dark` if needed) in `index.css`
3. Add to `DEFAULT_THEME.light` / `.dark` in `builtin.ts` so existing themes don't break

This enforces a single source of truth for what's themable.
