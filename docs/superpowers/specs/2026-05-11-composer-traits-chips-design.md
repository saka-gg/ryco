# Composer Traits as Icon Chips

## Goal

Replace the single `TraitsPicker` trigger button (which today renders a joined
text label like `Fast · High · 200k`) with a row of small icon-led chips, each
of which represents one provider option and is its own click target. Reasoning
gets a configurable visual style (icon-and-dots by default, text-label as an
alternative) controlled from Appearance Settings.

The goal is a more scannable, more clickable composer bar — and to give
Reasoning, Fast Mode, Context Window, Thinking, and Agent each a dedicated
visual treatment instead of a comma-separated text blob.

## Non-goals

- **Replacing the compact (mobile/narrow) menu.** `CompactComposerControlsMenu`
  continues to render `TraitsMenuContent` (the combined radio-group popup) for
  narrow widths. The chip row is the wide-layout treatment only.
- **Changing the model picker or `ProviderModelPicker`.** The model selector
  to the left of the chip row is untouched.
- **Changing the descriptor data model.** `ProviderOptionDescriptor`,
  `optionDescriptors`, `buildProviderOptionSelectionsFromDescriptors`, and the
  capability shape stay as they are. We render existing data differently; we
  do not add new fields.
- **Auto-prefix on selecting Ultrathink.** The existing Ultrathink handling
  (prompt-injection via the `Ultrathink:` prefix, body-text detection) is
  preserved unchanged. Selecting Ultrathink from the Reasoning chip's menu
  has the same effect it has from `TraitsMenuContent` today.
- **Per-thread or per-provider override for the reasoning style.** The
  Reasoning indicator style is one user-level preference, persisted globally
  alongside other UI state.
- **Touching Codex's primary controls beyond surfacing the Agent select as a
  chip.** Codex models that expose `agent` get an Agent chip with the same
  click-to-open-menu behavior; nothing else changes for Codex.

## Scope

In scope:

- New `TraitsChips.tsx` component that renders one or more chip components
  based on the provider option descriptors for the active model.
- New chip components (each in its own small file or co-located in
  `TraitsChips.tsx`):
  - `ReasoningChip` — `effort` select. Renders in one of two styles based on
    the user's Appearance setting. Click opens a small radio menu.
  - `FastModeChip` — `fastMode` boolean. Yellow filled lightning when on,
    dimmed outline lightning when off. Click toggles in place.
  - `ContextWindowChip` — `contextWindow` select. Plain text chip (`200k`,
    `1M`). Click opens a small radio menu.
  - `ThinkingChip` — `thinking` boolean (Haiku 4.5). Cyan brain icon when on,
    dimmed outline when off. Click toggles in place.
  - `AgentChip` — `agent` select (Codex). Text chip with current agent label.
    Click opens a small radio menu.
- Wire `TraitsChips` into `ChatComposer.tsx` at the same site where
  `TraitsPicker` is rendered today, replacing it for wide layouts.
- Extend `uiStateStore.ts` with a new persisted field
  `reasoningIndicatorStyle: "icon-dots" | "text"` (default `"icon-dots"`),
  plus a setter `setReasoningIndicatorStyle(style)`.
- Add a new section to `AppearanceSettings.tsx`: "Reasoning indicator" with
  two radio-card options previewing each style.
- Keep `TraitsMenuContent` exported and used by
  `CompactComposerControlsMenu.browser.tsx` (compact width) — its API does not
  change.
- Update `TraitsPicker.tsx`: keep `shouldRenderTraitsControls` (still used by
  the compact menu visibility check); remove the `TraitsPicker` export's
  rendering of the joined `triggerLabel`. If no consumer remains for
  `TraitsPicker`, delete it. If a consumer remains (e.g. some legacy path),
  keep it but mark it for follow-up.

Out of scope:

- A "Hide chips at default" toggle. Chips are always visible whenever the
  model exposes the corresponding option; Fast Mode chip is the only one
  that's conditional (only renders when the model supports it, but always
  shown when supported regardless of on/off — dimmed when off).
- Drag-to-reorder chips.
- Keyboard chord shortcuts for individual chip toggles.
- An "always show as text" preference for chips other than Reasoning.
- Theming of chip colors via the theme system. Chip tints are fixed per state
  (yellow for fast, indigo gradient for reasoning levels, cyan for thinking).

## Architecture

### Setting persistence

Extend `PersistedUiState` and `UiState` in `apps/web/src/uiStateStore.ts`:

```ts
export type ReasoningIndicatorStyle = "icon-dots" | "text";

export interface PersistedUiState {
  // ...existing fields...
  reasoningIndicatorStyle?: ReasoningIndicatorStyle;
}

export interface UiState extends /* ... */ {
  reasoningIndicatorStyle: ReasoningIndicatorStyle;
}
```

`initialState.reasoningIndicatorStyle` is `"icon-dots"`. Hydration accepts
either valid value; anything else falls back to default. `persistState` writes
the field through. Add `setReasoningIndicatorStyle(style)` action to
`UiStateStore`.

Consumers read it via:

```ts
const reasoningStyle = useUiStateStore((s) => s.reasoningIndicatorStyle);
```

### Chip components

All chip components live in `apps/web/src/components/chat/TraitsChips.tsx`
unless a chip grows past ~80 lines, in which case it gets its own file. Each
chip:

- Takes the relevant descriptor as a prop and an `onChange` callback that
  takes the next descriptor list (same shape `TraitsMenuContent` uses).
- Renders a `Button` styled as a chip (rounded, small, with optional icon).
- For boolean chips (Fast, Thinking): `onClick` flips the boolean and calls
  `onChange`. No menu.
- For select chips (Reasoning, ContextWindow, Agent): wraps in a `Menu`
  with the chip as `MenuTrigger`. Menu popup is a `MenuRadioGroup` over the
  descriptor's options. Reasoning's popup also handles the Ultrathink
  prompt-injection path identically to `TraitsMenuContent`'s
  `handleSelectChange`. To avoid duplicating that logic, extract a small
  helper `applyDescriptorSelection(descriptors, descriptor, value, prompt,
  onPromptChange)` from `TraitsMenuContent` into a shared module
  (`TraitsMenuLogic.ts`) and call it from both places.

The chip ordering in the bar (left to right): **Reasoning → Fast Mode →
Context Window → Thinking → Agent**. Chips that don't apply to the current
model are simply not rendered (e.g. Haiku has no `effort`, so Reasoning chip
is absent; Sonnet has no `fastMode`, so Fast chip is absent).

### Reasoning chip — two styles

```tsx
function ReasoningChip({ descriptor, prompt, onPromptChange, onChange }) {
  const style = useUiStateStore((s) => s.reasoningIndicatorStyle);
  const level = currentLevel(descriptor, prompt); // includes "ultrathink"
  // from prompt detection
  // style === "icon-dots": render Brain SVG + 1-5 dots, plus sparkle outlier
  //   for ultrathink.
  // style === "text": render abbreviated text (Low/Med/High/XHi/Max/Ultra)
  //   with the same color-tint scheme.
  // Both styles share the same color palette below.
}
```

Color palette (used by both styles for consistency):

| Level      | Background tint                                                                                 | Text/icon color |
| ---------- | ----------------------------------------------------------------------------------------------- | --------------- |
| low        | `slate-400/18%`                                                                                 | `slate-600`     |
| medium     | `blue-500/14%`                                                                                  | `blue-700`      |
| high       | `indigo-500/14%`                                                                                | `indigo-700`    |
| xhigh      | `violet-500/16%`                                                                                | `violet-700`    |
| max        | `fuchsia-500/14%`                                                                               | `fuchsia-700`   |
| ultrathink | linear-gradient(135deg, `pink-500/18%`, `purple-500/20%`) with 1px `fuchsia-500/25%` inset ring | `fuchsia-700`   |

(Dark-mode equivalents resolve through the existing theme tokens; we use
`--accent`-style adjustments where they apply, but the chip palette is
explicit rather than theme-driven.)

For `icon-dots` style: brain icon + a row of 5 small dots (4.5px), filled to
the level's ordinal position (low=1, medium=2, high=3, xhigh=4, max=5). For
`ultrathink`, replace the dot row with a sparkle icon and the text "Ultra".

For `text` style: abbreviated label only (`Low`, `Med`, `High`, `XHi`, `Max`,
`✦ Ultra`). The sparkle prefix on Ultrathink distinguishes it.

### Fast Mode chip

- Capability check: only render when `descriptor.id === "fastMode"` exists in
  the model's `optionDescriptors`.
- On: yellow filled lightning icon (`Zap`), background
  `yellow-500/16%`, text `yellow-900` (light) / `yellow-300` (dark via
  `dark:`).
- Off: outline-only lightning, transparent background, muted-foreground at
  50% opacity, 1px ring at `border` color. Click toggles to on.
- No menu; click toggles in place.
- `aria-pressed` reflects current state; `title` is `"Fast mode: on (click
  to disable)"` / `"Fast mode: off (click to enable)"`.

### Context Window chip

- Renders the current value as plain text (e.g. `200k`, `1M`) inside a
  neutral-tinted chip.
- Click opens a small `MenuRadioGroup` of the available options.
- No icon (the value itself reads as a label).

### Thinking chip (Haiku)

- Mirrors Fast Mode's interaction model (click-to-toggle in place).
- On: cyan brain icon, background `sky-500/14%`, text `sky-800`.
- Off: dimmed outline brain, identical visual language to Fast off.
- `aria-pressed`, `title` follow the same pattern.

### Agent chip (Codex)

- Renders the current agent's label as text, e.g. `gpt-5-codex`.
- Click opens a small `MenuRadioGroup` of the available agents (from
  `descriptor.options`).
- No icon.

### Appearance settings entry

Append a new `SettingsSection` to `AppearanceSettings.tsx` titled "Reasoning
indicator":

- Two radio cards rendered as a `SettingsRow` body.
- Each card shows: a radio dot on the left, a name + 1-line description in
  the middle, and a live preview chip on the right (at the "High" level for
  consistent comparison).
- Selecting a card immediately calls `setReasoningIndicatorStyle(style)`. No
  Apply button.
- A `SettingResetButton` next to the row resets to `"icon-dots"`.

### TraitsPicker / triggerLabel removal

`TraitsPicker.tsx` lines 381-396 build a joined `triggerLabel` string. After
this change, no wide-layout caller invokes `TraitsPicker`. Remove the
`triggerLabel` construction and the `TraitsPicker` export itself **only if**
no other call site references it. If any reference remains, keep
`TraitsPicker` exported but file a TODO; do not delete in this change.

`TraitsMenuContent` and `shouldRenderTraitsControls` are unchanged and remain
used by `CompactComposerControlsMenu`.

### Chip click-into-menu plumbing

For Reasoning / Context Window / Agent, each chip is a `MenuTrigger`
controlling a small `Menu` instance whose `MenuPopup` contains a single
`MenuRadioGroup`. The `onValueChange` handler applies the change via
`applyDescriptorSelection` (the helper extracted from `TraitsMenuContent`).
For Reasoning, the same helper takes care of Ultrathink prompt-injection.

The menus open at `align="start"` below their trigger chip, matching the
existing `TraitsMenuContent` menu positioning.

## Behavior table

| Chip           | Click behavior                      | Visible when                         |
| -------------- | ----------------------------------- | ------------------------------------ |
| Reasoning      | Opens small radio menu (4-6 levels) | Model has `effort` descriptor        |
| Fast Mode      | Toggles boolean in place            | Model has `fastMode` descriptor      |
| Context Window | Opens small radio menu (2 options)  | Model has `contextWindow` descriptor |
| Thinking       | Toggles boolean in place            | Model has `thinking` descriptor      |
| Agent          | Opens small radio menu              | Model has `agent` descriptor         |

## Edge cases

- **Prompt-injected Ultrathink.** When the prompt body contains
  "ultrathink", the Reasoning chip displays the Ultrathink variant (sparkle
  - gradient) and the menu's other options are disabled, identical to the
    current `TraitsMenuContent` behavior (lines 292-310 of `TraitsPicker.tsx`).
    The shared `applyDescriptorSelection` helper carries this branching.
- **Custom Claude models.** `selectDescriptor("effort", ...)` may have an
  arbitrary subset of levels for custom models. The chip's color falls back
  to `medium`'s palette if the value doesn't match a known level.
- **No descriptors at all.** When the model exposes nothing, `TraitsChips`
  renders nothing; the composer bar collapses around it. No empty wrapper.
- **Multi-line wrapping.** If the bar is too narrow to fit all chips, they
  wrap to a second line (same `flex-wrap: wrap` rule used today). The
  `CompactComposerControlsMenu` is still the right answer below the small
  breakpoint, so this wrapping is a tablet-range concern, not a phone-range
  one.
- **First-paint flicker on hydration.** `uiStateStore` hydrates synchronously
  from localStorage at module load, so `reasoningIndicatorStyle` is available
  before the composer renders. No flicker, no SSR hydration mismatch (chat
  composer is browser-only).

## Testing plan

- **Unit:** A new `TraitsChips.test.tsx` (vitest-browser-react like the
  existing `CompactComposerControlsMenu.browser.tsx` tests). Covers:
  - Each chip renders for the right capability shape and is absent
    otherwise.
  - Clicking Fast/Thinking toggles the boolean.
  - Clicking Reasoning/Context/Agent opens the menu and selecting an option
    fires the right `onChange`.
  - The Reasoning chip's rendered output differs between `icon-dots` and
    `text` styles (snapshot or DOM assertion of the rendered chip content).
  - Ultrathink prompt-injection: when prompt contains "ultrathink", the
    Reasoning chip shows the Ultra variant and the menu disables other
    options.
- **Integration:** Extend `ChatComposer` tests (if present) to assert the
  chip row replaces the joined `TraitsPicker` trigger.
- **uiStateStore:** Add a unit test asserting `reasoningIndicatorStyle`
  persists and hydrates through `persistState` / `readPersistedState`, and
  that an invalid value falls back to default.
- **AppearanceSettings:** Snapshot or DOM test that the new "Reasoning
  indicator" section renders and that clicking a card calls the setter.

## Migration / cleanup

- Existing users land on `"icon-dots"` (the default). No migration needed.
- Old persisted `ryco:ui-state:v1` blobs without the new field hydrate to
  default — already handled by the `?? initialState.x` fallback pattern in
  `readPersistedState`.
- No bump to the `PERSISTED_STATE_KEY` version is required (additive field).

## Acceptance criteria

1. The composer bar in `ChatComposer` renders a row of chips for each
   applicable provider option of the active model, in the order Reasoning,
   Fast, Context, Thinking, Agent.
2. Reasoning chip respects the user's selected indicator style; switching
   the setting updates the chip without a reload.
3. Fast Mode chip is rendered only when the model supports it; clicking
   toggles between on (yellow filled lightning) and off (dim outline).
4. Context Window chip opens a menu listing the model's available windows;
   selecting one persists via the existing draft store.
5. Ultrathink continues to round-trip through the prompt prefix path, and
   the chip's appearance and menu disable-state mirror today's
   `TraitsMenuContent` behavior.
6. Appearance Settings contains a "Reasoning indicator" row with two radio
   cards that preview each style; the setting persists across reloads.
7. `CompactComposerControlsMenu` continues to function unchanged — the
   combined menu still works for narrow widths.
