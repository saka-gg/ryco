# Interactive Keybindings Settings

## Goal

Replace the JSON-only keybindings workflow with an interactive Settings panel.
The user clicks a shortcut chip, presses the keys they want, and the binding is
saved. The panel covers the full editing surface: rebinding, adding a second
binding to a command, deleting, changing the `when` context, custom
project-script bindings, conflict warnings, and resets to defaults.

The existing JSON file at `~/.ryco/userdata/keybindings.json` remains the
source of truth — the panel reads it via the existing server-config push
pipeline and writes via a new RPC. The "Open file" escape hatch in
`General > Advanced` stays for users who want raw access.

## Scope

### In scope

- New Settings sidebar entry `Keybindings` with a `Keyboard` icon, slotted
  between `Appearance` and `Source Control`.
- One-click capture: the chip itself becomes the recorder (inline focus, indigo
  pulse) — no modal, no popover for capture.
- Multiple shortcuts per command (e.g. `chat.new` keeps `⌘N` and `⌘⇧O`),
  shown as separate chips on the same row with `+` to add another.
- `when`-clause editor as a popover with five presets: Always, Terminal
  focused, Not in terminal, Terminal open, Terminal not open.
- Conflict detection: soft warn + accept. Inline banner under the row names
  the conflicting command and lets the user jump to it; the bind still goes
  through (last-rule-wins matches existing runtime behavior).
- Custom project-script bindings (`script.{id}.run`): auto-listed under a
  `Project scripts` category, unbound scripts show a "No shortcut — click to
  set" placeholder chip.
- Per-binding undo and per-row "reset command to defaults"; panel-level
  `Restore defaults` already exists and gains the `keybindings` section.
- Search box that filters by command id, title, current shortcut, or `when`
  text.
- Server RPC `keybindingsReplaceCustom(rules)` for the panel. The existing
  `serverUpsertKeybinding` RPC is **kept** because `apps/web/src/components/ChatView.tsx`
  uses it for the inline "create project script with a keybinding" flow — removing
  it would force two-step UX. Both RPCs are routed through the same atomic
  write path and the file watcher behaves identically.

### Out of scope

- Editable raw expressions for `when` beyond the five presets. The chip
  displays parsed text for custom expressions and offers presets as
  replacements; the JSON file remains the way to author complex
  expressions like `terminalOpen && !terminalFocus`.
- Importing/exporting keybinding profiles.
- Per-project (workspace) keybindings — config stays global.
- Discovery of non-script custom commands beyond the static `KeybindingCommand`
  union.

## Architecture

```text
+--------------------------+    +-----------------------------+    +-------------------------+
| KeybindingsSettingsPanel | -> | keybindings RPC client      | -> | ws keybindingsReplace   |
| (apps/web)               |    | (apps/web/rpc)              |    | Custom (apps/server)    |
+--------------------------+    +-----------------------------+    +-------------------------+
            ^                                                                  |
            |                                                                  v
            |                                                       +-------------------------+
            |                                                       | Keybindings service     |
            |                                                       | (replaceCustomRules)    |
            |                                                       +-------------------------+
            |                                                                  |
            |                                                                  v
            |                                                       +-------------------------+
            |                                                       | atomic JSON write       |
            |                                                       | + cache invalidate      |
            |                                                       | + PubSub change event   |
            |                                                       +-------------------------+
            |                                                                  |
            +---<----- existing serverConfig WebSocket push stream  -----------+
```

The dataflow direction matches every other settings panel: the panel renders
from the server-config snapshot (`useServerConfig()`), mutates via RPC, and
reacts to the push of the new state. The panel keeps a short-lived local
draft so the chip can show the just-pressed shortcut immediately; on push
arrival we reconcile to the server's resolved list. Optimistic updates are
tagged so the existing `KeybindingsToast` does not double-fire while the
user is editing inside the panel.

## Contracts (`packages/contracts/src/keybindings.ts`)

- Existing schemas (`KeybindingRule`, `KeybindingsConfig`,
  `ResolvedKeybindingsConfig`) are unchanged.
- Add a new WS method constant:
  - `WS_METHODS.keybindingsReplaceCustom = "keybindings.replaceCustom"`.
- Request payload: `KeybindingsConfig` (already validated as a non-overflowing
  array of `KeybindingRule`s).
- Response payload: `ResolvedKeybindingsConfig` (the merged defaults + custom).

## Server (`apps/server/src/keybindings.ts`)

- Keep `upsertKeybindingRule` on `KeybindingsShape` for the inline single-rule
  caller in `ChatView.tsx`.
- Add `replaceCustomKeybindings(rules: KeybindingsConfig)` on `KeybindingsShape`
  with the existing `upsertSemaphore`-gated implementation:
  1. Validate each rule via `ResolvedKeybindingFromConfig` — fail the whole
     call if any rule is malformed (no partial writes).
  2. Cap to `MAX_KEYBINDINGS_COUNT`; log a warning and truncate the _oldest_
     entries (semantics chosen to match the existing
     `syncDefaultKeybindingsOnStartup` truncation rule — last entries win).
  3. Write atomically via `writeFileStringAtomically`.
  4. Compute the next resolved list via `mergeWithDefaultKeybindings`,
     publish a `KeybindingsChangeEvent` with `issues: []`, set the cache.
- `wsServer.ts` adds a route to `keybindings.replaceCustom` that calls the
  service method.
- No changes to the file watcher; the watcher continues to handle external
  edits exactly as today.

## Web — components

All new code lives under `apps/web/src/components/settings/` unless noted.

- `KeybindingsSettings.tsx` — top-level panel. Holds the draft state, the
  search input, the `useReplaceKeybindings` mutation hook, and the
  optimistic-update reconciliation. Exports `KeybindingsSettingsPanel` used
  from `SettingsDialog`.
- `KeybindingsSettings.commandGroup.tsx` — renders a category section
  (header + rows).
- `KeybindingsSettings.commandRow.tsx` — one command row (title,
  command id, status pill, list of chips, `+` button, row-level reset,
  conflict banner). Pill rules:
  - No pill when the row matches defaults exactly.
  - `Modified` (amber) when the command exists in `DEFAULT_KEYBINDINGS` but
    one or more of its bindings differ from the defaults (different shortcut,
    different `when`, removed, or extra).
  - `Custom` (indigo) when the command is not in `DEFAULT_KEYBINDINGS` at all
    (today: only `script.*` commands).
- `KeybindingsSettings.shortcutChip.tsx` — chip + inline recorder. States:
  `idle | recording | conflict | saved-flash`. Owns the local `keydown`
  capture handler.
- `KeybindingsSettings.whenPresetMenu.tsx` — popover with the five presets
  plus a read-only "Custom expression" header when the stored value
  doesn't match a preset.

Two new helpers in `apps/web/src/lib/`:

- `keybindingCategories.ts` — pure mapping `command → { category, sortWeight }`.
  Static table for known commands; `script.*` falls through to the
  `Project scripts` category.
- `shortcutCapture.ts` — pure functions:
  - `eventToShortcut(KeyboardEvent): KeybindingShortcut | null` —
    normalizes modifiers, returns `null` for modifier-only and "ignored
    keys" (Tab/Escape/Enter with no modifiers).
  - `formatShortcut(KeybindingShortcut, platform): string[]` — produces
    display tokens like `["⌘", "⇧", "K"]`.

Wiring:

- `apps/web/src/components/settings/SettingsDialog.tsx` — add the
  `{ id: "keybindings", label: "Keybindings", icon: KeyboardIcon }` entry
  to `NAV_ITEMS`, the `case "keybindings"` to `SectionPanel`, and
  `"keybindings"` to `SECTIONS_WITH_RESTORE`.
- `apps/web/src/settingsDialogStore.ts` — extend the
  `SettingsSectionId` union with `"keybindings"`.
- `apps/web/src/rpc/serverState.ts` — already exposes `useServerConfig()`
  with the resolved keybindings; no change. Add `useReplaceKeybindings` as
  a mutation hook calling the new RPC.

## Web — capture interaction

- **Idle** — chip shows formatted shortcut tokens. Tabbable button with
  `aria-label="Edit shortcut for <command title>"`.
- **Enter recording** — click, or focus + Enter/Space. Sets state to
  `recording`. Attaches a `keydown` listener on `window` with `capture:
  true` and `preventDefault: true` so global app shortcuts (the existing
  `keybindings.ts` runtime) do not fire while recording.
- **Capture** — first non-modifier `keydown` becomes the shortcut. Modifiers
  held at that moment populate `metaKey/ctrlKey/altKey/shiftKey`. To keep
  bindings cross-platform, the recorder collapses the platform's primary
  modifier into `mod`: on macOS, `metaKey` (Cmd) becomes `mod`; on Linux/Windows,
  `ctrlKey` becomes `mod`. The other modifiers (`shift`, `alt`/`option`, and
  the _non-primary_ `meta`/`ctrl`) are recorded verbatim, mirroring how the
  existing `parseKeybindingShortcut` decodes `mod` at runtime. Modifier-only
  events (just `Shift`, just `Cmd`, etc.) do not commit.
- **Special-key escape hatches** —
  - `Escape` (no modifiers): cancel without saving.
  - `Tab` (no modifiers): exit recording without saving so keyboard nav
    still works.
  - `Backspace` (no modifiers): clear this binding. If it's the only chip
    on the row, the chip becomes a "No shortcut — click to set"
    placeholder; if it's a secondary, the chip is removed.
  - `Enter` (no modifiers): no-op (do not bind to plain Enter; require a
    modifier to bind it).
- **Commit** — chip flashes a subtle green ring for ~180 ms, the draft is
  updated, and `keybindingsReplaceCustom` is dispatched with the full draft
  list. On RPC error the draft reverts (server snapshot wins) and a toast
  surfaces via the existing `toastManager` with the error detail.
- **Conflict detection** — runs synchronously on the candidate shortcut
  against the draft. A rule conflicts when its serialized shortcut equals
  another rule's _and_ their `when` contexts overlap (`undefined` overlaps
  with anything, identical `when` strings overlap, otherwise we treat them
  as non-overlapping for the v1 detector — same heuristic the server's
  `hasSameShortcutContext` already uses).
- **Accessibility** — recording state announces "Recording shortcut for
  <command>" via an `aria-live="polite"` region. All animations respect
  `prefers-reduced-motion`.

## Web — `when` editor

Click the inline `when` chip on a `ShortcutChip`. `WhenPresetMenu` opens
anchored to the chip with these entries:

| Label             | Stored value     |
| ----------------- | ---------------- |
| Always            | `undefined`      |
| Terminal focused  | `terminalFocus`  |
| Not in terminal   | `!terminalFocus` |
| Terminal open     | `terminalOpen`   |
| Terminal not open | `!terminalOpen`  |

If the on-disk `when` is something outside this set (e.g.
`terminalOpen && !terminalFocus`), the menu shows a non-interactive header
"Current: <parsed expression>" above the presets. Selecting any preset
replaces the custom expression — no silent overwriting.

## Web — conflict and reset UX

- **Conflict banner** — slim red banner rendered at the bottom of the
  command row (below the chips, full row width) that owns at least one
  chip whose shortcut conflicts with another command in an overlapping
  `when` context. The banner lists each conflict once: "`⌘T` also bound to
  **New chat (chat.new)**". The command name is a button that scrolls to
  and highlights the conflicting row. The save is not blocked. If a row
  has multiple conflicts, the banner shows one line per conflict and
  caps at three with a "+ N more" suffix.
- **Per-binding reset** — `Undo2Icon` button beside the chip appears only
  when this binding differs from the default. Reuses the
  `SettingResetButton` component pattern from `settingsLayout.tsx`.
- **Per-command reset** — same icon at the row-end level, visible only when
  any binding on this command differs from defaults. Resets all bindings
  for the command back to defaults.
- **Panel-level restore** — the existing "Restore defaults" button in the
  settings dialog header gains the `keybindings` section. Clicking it
  empties the custom list (server then merges in all defaults).

## Web — search

`<input>` at the top of the panel, debounced 80 ms. Matches case-insensitively
against:

- the command id (e.g. `terminal.toggle`)
- the human-readable title (e.g. "Toggle terminal drawer")
- the serialized current shortcut string (e.g. `mod+j`)
- the parsed `when` preset label (e.g. "not in terminal")

Empty-result state shows "No commands match" inside the panel — categories
are hidden when all their rows are filtered out.

## Animation polish

All transitions are short, snappy, and use existing Tailwind utility classes
or the project's CSS keyframes:

- Chip hover: 150 ms `bg-` transition.
- Recording pulse: 1.4 s infinite indigo ring (already in mockup).
- Saved confirmation: 180 ms green ring + `scale-[1.04]`, then settles.
- Conflict banner: 220 ms slide-down + opacity fade-in.
- Add-chip (`+` → new chip): 200 ms scale-in from the `+` button's
  position.
- Category section open/close (only on search): 150 ms height + opacity.
- All animations respect `prefers-reduced-motion: reduce`.

## Error handling

- **Server validation rejects** — toast with the failure detail; draft
  reverts to the last server snapshot. Examples: a rule whose `key` cannot
  be parsed, a `script.<id>.run` whose id is malformed.
- **RPC transport error** — same revert + toast path with a generic
  "Could not save keybindings" message.
- **Concurrent external JSON edit** — file watcher fires, server publishes
  the new resolved list, panel reconciles. If the user has an unsaved draft
  in progress (chip in recording state), the recording is cancelled, the
  panel reconciles to the new state, and a brief inline notice appears
  ("Keybindings file changed externally"). This piggybacks on the existing
  `KeybindingsToast` change-detection.
- **Resolved-config has issues** — when `useServerConfig().issues` contains
  `keybindings.*` issues, the panel renders a top-of-panel callout with the
  detail text and a button to open the JSON file. Same toast behavior as
  today is preserved.

## Testing

### Pure unit (Vitest, no DOM)

- `keybindingCategories.test.ts` — every static command and the `script.*`
  pattern routes to the expected category and sort weight.
- `shortcutCapture.test.ts` — `eventToShortcut` for every modifier combo,
  `cmd`→`mod` macOS normalization, `space` token, modifier-only rejection,
  plain Enter/Escape rejection.
- `whenPresetMapping.test.ts` — bidirectional mapping between presets and
  stored `when` strings; "Custom expression" passthrough.
- `conflictDetection.test.ts` — `detectConflicts(draft)` over fixtures with
  overlapping/non-overlapping `when` contexts.

### Server (`apps/server/src/keybindings.test.ts` — extend existing)

- `replaceCustomKeybindings` happy path: writes file, publishes change.
- Empty list call resets to defaults (file is rewritten with empty user
  list; defaults merge in).
- Rejects partial-valid lists atomically (no file write, no publish).
- Atomic-write failure surfaces via existing error path.
- File watcher does not double-fire after an in-process write (single
  publish per call).

### Browser harness (`*.browser.tsx`)

- `KeybindingsSettings.browser.tsx`:
  - Render the panel, click a chip, press `mod+t`, assert RPC payload and
    chip update.
  - Esc cancels recording, draft unchanged.
  - Backspace clears the binding; secondary chip is removed, primary
    becomes placeholder.
  - Conflict banner appears when binding `mod+t` to a second command in
    the same context.
  - `when` preset menu changes stored value and updates the chip's `when`
    pill.
  - Per-row reset restores all default bindings for the command.
  - Panel-level "Restore defaults" empties the custom list (server merges
    defaults back).
  - Search filters by command id, title, shortcut, and `when` text.
  - Inline notice appears when an external file change arrives mid-edit.

- `KeybindingsToast.browser.tsx` — extend to assert no duplicate toast
  fires for in-panel optimistic updates that match the subsequent server
  push.

### Manual smoke

- Start dev app, navigate to Settings > Keybindings.
- Rebind `chat.new` from `⌘N` to `⌘T`; observe conflict banner pointing
  at a Terminal command in the same context; accept.
- Add a second binding to `chat.new`; delete the first; reset to defaults.
- Change `when` for `terminal.new` to "Always"; verify behavior in app.
- Hand-edit `~/.ryco/userdata/keybindings.json`; observe the panel
  updating live and no toast spam during in-panel edits.
- Confirm `prefers-reduced-motion` disables the pulse and slides.

## Open questions

None at design time. Anything ambiguous in implementation (specific
animation timings, exact category labels) is locked above and can be tuned
during code review.
