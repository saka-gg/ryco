# Horizontal Terminal Tabs and Top-Bar Terminal Count

## Goal

Make multi-terminal usage discoverable and easy to manage:

1. Replace the right-side vertical terminal list inside the terminal drawer
   with a horizontal tab strip at the top of the drawer.
2. Show a count badge next to the existing `Open Terminal` / `Close Terminal`
   button in the top bar so the number of open terminals is visible without
   opening the drawer.

Resolves issue [#21](https://github.com/sak0a/ryco/issues/21).

## Non-goals

- **New tab-switching keybinds.** No "next/previous tab" shortcuts.
- **Drag-to-reorder tabs.**
- **Per-terminal close button inside split-view viewports.** Closing a
  specific terminal inside a split group still works via focus-then-close
  (click the terminal, then `Close` action / shortcut).
- **Mobile UI work.** The existing top-bar terminal toggle is already hidden
  on mobile, and the drawer is desktop-only.
- **Server / contract changes.** The terminal store already tracks
  everything we need; this is a UI-only change.

## Scope

In scope:

- Add a `terminalCount` prop to `BranchToolbar` and render a `· N` badge
  inside the terminal toggle button when `terminalCount >= 2`.
- Replace the terminal drawer's right sidebar (in `ThreadTerminalDrawer.tsx`)
  and the floating top-right action overlay with a unified horizontal tab
  strip at the top of the drawer.
- Tab strip is always visible whenever the drawer is open.
- One tab per `ThreadTerminalGroup`. Label: `Terminal N` for single-terminal
  groups, `Split N` for multi-terminal groups.
- Per-tab affordances: terminal icon, label, running-state dot (when any
  terminal in the group is running a subprocess), close (`×`) on hover when
  more than one group exists. Closing a tab closes every terminal in that
  group (iterating `onCloseTerminal` over `group.terminalIds`).
- Trailing action cluster on the right of the tab strip: `Split` / `New` /
  `Close active`, matching the current sidebar header buttons (same icons,
  shortcut labels, disabled states).
- Horizontal scroll when tabs overflow.

Out of scope:

- Tab overflow dropdown / chevron menu.
- Label truncation rules (revisit if real usage shows long labels are a
  problem).
- New unit-level coverage beyond pure helpers (the existing
  `ThreadTerminalDrawer.test.ts` is logic-only — match that scope).

## Architecture

### Data flow

No store schema change. `useTerminalStateStore` already provides:

- `terminalIds: string[]` — open terminal IDs for the thread.
- `runningTerminalIds: string[]` — IDs whose subprocess is running.
- `terminalGroups: ThreadTerminalGroup[]` — group → terminal mapping.
- `activeTerminalGroupId: string` — currently-active group.
- `activeTerminalId: string` — currently-active terminal.

`ChatView.tsx`:

- Reads `terminalState.terminalIds.length` and passes it to `BranchToolbar`
  as `terminalCount`. (No new selector — the existing terminal-state read
  in the chat view already covers this.)

`BranchToolbar.tsx`:

- New optional prop `terminalCount: number`.
- Renders `· {terminalCount}` after the existing label inside the toggle
  button when `terminalCount >= 2`. The badge uses
  `text-muted-foreground/70 tabular-nums` so it reads as a soft separator,
  not a notification badge.

`ThreadTerminalDrawer.tsx`:

- Existing `<aside className="flex w-36 ...">` block (the right sidebar) is
  removed entirely.
- Existing floating top-right action overlay (the
  `<div className="pointer-events-none absolute right-2 top-2 ...">` block
  and its `!hasTerminalSidebar` guard) is removed.
- A new `<div>` tab strip is added above the terminal viewport
  (`role="tablist"`), inside the `aside.thread-terminal-drawer` container.
- Tab strip renders one `<button role="tab">` per group from
  `resolvedTerminalGroups`. The active tab is determined by
  `resolvedActiveGroupIndex`, reusing the existing derivation.
- Tab strip's right edge contains the action cluster (`Split` / `New` /
  `Close active`), reusing `TerminalActionButton` and the existing
  shortcut-label / disabled logic verbatim.
- The `hasTerminalSidebar` boolean and its conditional layout (`flex
  gap-1.5`, `min-w-0 flex-1` left + sidebar right) are removed. The
  viewport always takes the full drawer width below the tab strip.

### Component layout

```
┌─ Tab strip ─────────────────────────────────────────────────────┐
│ [Terminal 1●] [Split 2] [Terminal 3]   [⊟ Split] [+ New] [✕ Close] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                Terminal viewport (full width)                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- Tab strip height stays small (~26px) to keep terminal viewport real
  estate maximal.
- Tab visual states:
  - Active: brighter background (`bg-accent`), bottom-border accent.
  - Inactive: muted foreground, hover lifts to `bg-accent/50`.
  - Running dot: 6px circle, `bg-emerald-500` (or theme-equivalent token),
    rendered before the close button.
- Close on hover only when `resolvedTerminalGroups.length > 1` (mirrors the
  current sidebar's `normalizedTerminalIds.length > 1` guard).

### Single-group split behavior

When there is exactly one group and that group has 2-4 terminals (a split):

- Tab strip shows one `Split 1` tab plus the action cluster.
- The terminal viewport renders all terminals in the split side-by-side via
  the existing `isSplitView` grid path.
- Closing one terminal inside the split: click to focus, then trigger
  `Close active` (button or keybind). This matches the pre-sidebar single-
  group flow.

## Logic helpers

Two new pure helpers, exported from `ThreadTerminalDrawer.tsx` alongside
the existing `selectTerminalEventEntriesAfterSnapshot` /
`selectPendingTerminalEventEntries` /
`resolveTerminalSelectionActionPosition` helpers (matches the file's
current style — `ThreadTerminalDrawer.test.ts` already imports helpers
from the `.tsx`):

- `resolveTabLabel(group: ThreadTerminalGroup, groupIndex: number): string`
  — `"Terminal N"` for single-terminal groups, `"Split N"` for multi-
  terminal groups. `groupIndex` is 1-based for display.
- `groupHasRunningTerminal(group: ThreadTerminalGroup, runningTerminalIds:
  readonly string[]): boolean` — true if any terminal in the group appears
  in `runningTerminalIds`.

## Testing

- Extend the existing `apps/web/src/components/ThreadTerminalDrawer.test.ts`
  with cases for the new helpers:
  - `resolveTabLabel`: single-terminal group → `"Terminal N"`; multi-
    terminal group → `"Split N"`; `groupIndex` is 1-based.
  - `groupHasRunningTerminal`: empty running list → false; group whose
    member is running → true; group whose member is not running → false.
- No new component / browser tests.
- Verification commands per `AGENTS.md`: `bun fmt`, `bun lint`,
  `bun typecheck`, `bun run test`.

## Risks

- **Visual regression on existing single-terminal flow.** The floating
  action overlay (split / new / close in the top-right corner) goes away.
  Users get the same buttons in the new tab strip. Same icons, same
  tooltips, same shortcuts — the visual mapping is direct.
- **Persistence compatibility.** No store-shape change, so persisted
  terminal state from before this change continues to load. The migration
  function in `terminalStateStore.ts` is unaffected.
- **Tab overflow with many groups.** Horizontal scroll handles it without
  introducing an overflow menu. If real usage hits dozens of groups, we
  can add a dropdown later — out of scope here.
