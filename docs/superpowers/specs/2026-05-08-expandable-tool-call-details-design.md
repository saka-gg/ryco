# Expandable Tool Call & Terminal Command Details

GitHub: [#23](https://github.com/sak0a/ryco/issues/23)

## Goal

Make every tool-call / terminal-command row inside the chat timeline's work
group individually expandable, so users can inspect the full command and
output of any single agent action without leaving the conversation view.

The collapsed timeline stays visually identical to today; expansion is opt-in
per row, with errored rows opening by default so failure details are visible
on first paint.

## Non-goals

- **Group-level collapse.** The outer "Tool calls (N)" group panel keeps its
  current always-visible behavior. We are not turning the whole bubble into
  a click-to-expand surface (Q1, option B).
- **Type-aware expanded panels.** A bash row, an MCP tool call, and a file
  read all share one uniform panel template (Q2, option A). No separate
  stdout/stderr split, no JSON pretty-printing of structured tool input, no
  inline diffs.
- **Bash-only scoping.** Every entry kind that currently appears in the work
  group becomes expandable, not just bash.
- **ANSI color rendering.** Output is rendered as plain monospace text. ANSI
  escape sequences are stripped before display.
- **Cross-reload persistence.** Expand state is session-only via the existing
  Zustand `uiStateStore`. We do not write through to `clientPersistenceStorage`
  (Q5, option B).
- **Streaming auto-scroll inside the expanded panel.** While output is
  streaming the panel re-renders normally, but the internal scroll container
  is not pinned to the bottom — a user reading mid-stream should not have
  the view yanked.
- **Reworking the existing "Show N more" overflow control** on the work group
  header. Out of scope.

## Scope

In scope:

- New `WorkLogEntry` fields `output?: string` and `exitCode?: number`,
  populated in `toDerivedWorkLogEntry` from the activity payload.
- New component `ExpandableWorkEntryRow` that wraps the existing
  `SimpleWorkEntryRow` as its compact header and conditionally mounts a new
  `WorkEntryExpandedPanel` below it.
- New leaf `WorkEntryExpandedPanel` that renders the input line, output
  block (max-height scroll), copy button, and exit-code chip when relevant.
- New `uiStateStore` slice `threadWorkEntryExpandedById` plus action
  `setThreadWorkEntryExpanded`, mirroring `threadChangedFilesExpandedById`.
- Update `WorkGroupSection` in `MessagesTimeline.tsx` to render
  `ExpandableWorkEntryRow` in place of `SimpleWorkEntryRow`.
- Tiny addition to `MessageCopyButton`: an optional `ariaLabel?: string`
  prop (default keeps the current `"Copy link"` value) so the copy button
  inside the expanded panel can announce `"Copy output"` instead.
- Tests for the new entry derivation (output / exitCode population), the
  store slice, and the auto-expand-on-error resolution helper.

Out of scope:

- Any change to server-side activity payload shape — we use what is already
  on the wire today.
- Persisting expand state to localStorage.
- Group-level collapse / changes to the existing overflow ("Show N more")
  control.

## Architecture

### Data: extending `WorkLogEntry`

`apps/web/src/session-logic.ts`:

```ts
export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  output?: string; // NEW — full untruncated output text
  exitCode?: number; // NEW — present when activity reported one
}
```

Population happens inside `toDerivedWorkLogEntry`:

- **`output`** is resolved with this precedence:
  1. `payload.data.rawOutput.stdout` (string)
  2. `payload.data.rawOutput.content` (string)
  3. The raw, un-stripped `payload.detail` (string) — i.e. before
     `stripTrailingExitCode` runs. If `stripTrailingExitCode` matched, this
     is the `output` group from that match (so the trailing
     `<exited with exit code N>` marker does not appear in `output`).

  If none of these yield a non-empty string, `output` stays `undefined`.

- **`exitCode`** is the value `stripTrailingExitCode` already extracts
  internally. We surface it on the entry instead of discarding it. Only
  populated when the regex matched.

The existing `detail` field keeps its current meaning (summarized preview
for the inline row). No call sites change.

### Component: `ExpandableWorkEntryRow`

New file: `apps/web/src/components/chat/ExpandableWorkEntryRow.tsx`.

Wraps the existing `SimpleWorkEntryRow`. The wrapper:

1. Reads `routeThreadKey` from `TimelineRowCtx` (already provided to the
   work group via `WorkGroupSection`'s `use(TimelineRowCtx)`).
2. Subscribes to `uiStateStore` for the stored expand state of this entry:
   `state.threadWorkEntryExpandedById[routeThreadKey]?.[workEntry.id]`.
3. Computes `isOpen = stored ?? isErroredEntry(workEntry)`.
4. Renders a click-affordant container around `SimpleWorkEntryRow`:
   - leading `ChevronRight` glyph that rotates 90° when `isOpen`,
   - `cursor-pointer` and a hover background tint on the whole header,
   - keyboard accessible (`role="button"`, `tabIndex=0`, Enter / Space toggle).
5. When `isOpen`, mounts `WorkEntryExpandedPanel` directly below.

The header's click handler calls
`setThreadWorkEntryExpanded(routeThreadKey, workEntry.id, !isOpen)`.

`isErroredEntry` is a small pure helper:

```ts
export function isErroredWorkEntry(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") return true;
  return entry.exitCode !== undefined && entry.exitCode !== 0;
}
```

It lives next to the existing helpers in `MessagesTimeline.logic.ts` so
unit tests can hit it directly.

### Component: `WorkEntryExpandedPanel`

New file: `apps/web/src/components/chat/WorkEntryExpandedPanel.tsx`.

Pure, memoized. Props: `{ workEntry: WorkLogEntry }`. Layout:

```
┌──────────────────────────────────────────────┐
│ >_ <input line, monospace, single line>      │
│                                              │
│ Output:                                      │
│ ┌────────────────────────────────────────┐   │
│ │ <pre>full output, max-h-[400px], scroll│   │
│ └────────────────────────────────────────┘   │
│                                              │
│ [exit 1 chip if non-zero]        [Copy btn]  │
└──────────────────────────────────────────────┘
```

Concretely:

- **Input line.** Rendered only when `workEntry.rawCommand ?? workEntry.command`
  is non-empty. Prefixed by a `>_` glyph (matches the screenshot reference
  in the issue). Single line, `whitespace-nowrap overflow-x-auto`,
  `font-mono text-[11px]`. For non-bash entries with no command, the line
  is omitted entirely.
- **Output block.** Always rendered. Label `Output:` in
  `text-muted-foreground/60 text-[10px] uppercase tracking-wide`, then
  the body. When `workEntry.output` (after ANSI stripping) is non-empty,
  the body is a `<pre>` with `font-mono text-[11px] leading-4
  whitespace-pre max-h-[400px] overflow-auto`. When empty/undefined, the
  body is a faint `(no output)` placeholder (`text-muted-foreground/40
  italic`).
- **Footer.** Flex row, `justify-between items-center mt-1`.
  - Leading: `exit N` chip when `exitCode !== undefined && exitCode !== 0`.
    Uses `bg-rose-500/10 text-rose-300 border-rose-500/30` for error tone.
  - Trailing: small Copy icon button. Reuses the existing
    `MessageCopyButton` directly (it already wraps the shared
    `useCopyToClipboard` hook). Copies `workEntry.output ?? ""`. The only
    tweak required to `MessageCopyButton` is making its hardcoded
    `aria-label="Copy link"` overridable via an optional `ariaLabel` prop
    (default: current value), so we can pass `aria-label="Copy output"`
    here without changing existing call sites.

Container: `border-t border-border/40 mt-1 pt-1.5 pl-7` — `pl-7` indents
the panel to align with the row's text (past the leading icon column),
visually marking the panel as belonging to its parent row.

ANSI stripping uses a small inline helper that runs
`output.replace(ANSI_SGR_RE, "")`, where `ANSI_SGR_RE` is the
regex `/\u001b\[[0-9;]*m/g` (ESC byte followed by CSI SGR sequences).
No dependency. Stripping is done
once per render of the panel; for the giant-output case the panel is only
mounted when open so the cost is paid only when needed.

### Store: `uiStateStore` extension

`apps/web/src/uiStateStore.ts`:

```ts
// state shape
threadWorkEntryExpandedById: Record<string, Record<string, boolean>>;

// action
setThreadWorkEntryExpanded: (
  routeThreadKey: string,
  entryId: string,
  expanded: boolean,
) => void;
```

The action shape and immutable-update style mirror the existing
`setThreadChangedFilesExpanded` action — copy that pattern. Initial state
is `{}`.

We do **not** clear stale entries when threads close. The store is in-memory
only and the keys cost essentially nothing; cleanup would add complexity
for no observable benefit.

### Wiring `WorkGroupSection`

`apps/web/src/components/chat/MessagesTimeline.tsx`:

`WorkGroupSection` currently renders:

```tsx
{visibleEntries.map((workEntry) => (
  <SimpleWorkEntryRow ... />
))}
```

becomes:

```tsx
{
  visibleEntries.map((workEntry) => (
    <ExpandableWorkEntryRow
      key={`work-row:${workEntry.id}`}
      workEntry={workEntry}
      workspaceRoot={workspaceRoot}
    />
  ));
}
```

`SimpleWorkEntryRow` itself stays unchanged — it remains the compact-header
component, now consumed only via `ExpandableWorkEntryRow`. It stays
file-scoped (no new exports needed); `ExpandableWorkEntryRow` lives in
the same file or imports from it depending on whether the new component
ends up co-located with the existing leaf or carved out into a sibling
file. Implementation may pick either; the spec is indifferent.

## Behavior

### Default state

On first render of a row with no entry in
`threadWorkEntryExpandedById[threadKey]`:

- `isErroredWorkEntry(entry) === true` → row renders **expanded**.
- Otherwise → row renders **collapsed**.

No store writes happen on first render. The default is computed at render
time so that errors stay open after fresh reloads (when the store is empty)
without requiring a one-time write per entry.

### User toggle

- Clicking a collapsed row → store gets `true` for `(threadKey, entryId)`,
  panel opens.
- Clicking an expanded row → store gets `false`, panel closes. This applies
  even to errored rows: an explicit `false` overrides the default.

### Streaming

While an activity is still streaming (the underlying server payload
updates), the row's `WorkLogEntry` re-derives via the existing data flow.
If the row is open, `WorkEntryExpandedPanel` re-renders with the new
`output`. The internal scroll container is **not** pinned to the bottom.

### Errors during streaming

A row's tone can transition from `info`/`tool` to `error` mid-stream, or
its `exitCode` can land non-zero on completion. If the user has not
manually toggled the row, the default-resolution logic re-evaluates on
each render and the row will pop open when the entry becomes errored.

This is acceptable because: (a) the user wanted to know about failures
(issue's stated goal), and (b) we're not auto-scrolling, so a row opening
below the current viewport doesn't visually disrupt the active read.

### Virtualization & memo

`LegendList` virtualizes rows; an expanded row that scrolls far enough out
of view will unmount. Because `isOpen` is derived from the store, the
state survives unmount/remount: when the row scrolls back into view,
`ExpandableWorkEntryRow` re-reads the same store value and renders open.

`ExpandableWorkEntryRow` is wrapped in `memo`. The memo boundary is stable
because:

- `workEntry` reference is preserved across re-renders by
  `computeStableMessagesTimelineRows` whenever its content is unchanged.
- `workspaceRoot` comes from `TimelineRowCtx` and only changes on context
  transitions, which the existing system already handles efficiently.

`WorkEntryExpandedPanel` is also `memo`'d on `workEntry`. Streaming updates
that change `workEntry.output` will trigger its re-render — that's the
expected behavior.

## Accessibility

- Header is `role="button"`, `tabIndex={0}`, `aria-expanded={isOpen}`,
  `aria-controls={panelId}` where `panelId` is derived from the entry id.
- Enter and Space toggle expansion (preventDefault on Space to avoid page
  scroll).
- Chevron glyph is `aria-hidden`; the visible row text already conveys the
  control's purpose.
- Expanded panel `id={panelId}` and `role="region"` with
  `aria-label="<entry heading> details"`.
- Copy button has `aria-label="Copy output"` and announces success via
  the existing `MessageCopyButton`'s toast behavior.
- Focus stays on the header when the panel opens — we do not move focus
  into the panel automatically.

## Testing

New unit tests:

- `apps/web/src/session-logic.test.ts` (extend existing file): cases
  covering `output` and `exitCode` population for
  - command_execution with rawOutput.stdout
  - command_execution with rawOutput.content
  - command_execution with detail-only (and trailing exit code)
  - command_execution with no output
  - non-bash tool call with rawOutput.content
  - error-toned activity with no exit code
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` (extend):
  `isErroredWorkEntry` cases — error tone, non-zero exit code, zero exit
  code, undefined exit code.
- `apps/web/src/uiStateStore.test.ts` (extend): `setThreadWorkEntryExpanded`
  toggles a key, multiple keys per thread, multiple threads.

No new component-level tests beyond what already exists for the timeline.
The expansion behavior is exercised end-to-end via the existing
`MessagesTimeline.test.tsx` + the new logic tests.

## Performance considerations

- Expanded panel only mounts when open → giant outputs do not sit hidden
  in the DOM.
- Default-resolution is a pure function call — no store writes on first
  render of error rows, so no cascade of updates when a long history loads.
- Internal scroll on the output `<pre>` keeps row outer height bounded,
  which is critical for `LegendList`'s `estimatedItemSize` /
  `maintainVisibleContentPosition`. Variable-height growth would fight
  the virtualizer's scroll-anchoring.
- ANSI strip is a single regex pass per render of an open panel; for the
  closed panel it's never run.

## Migration / rollout

No data migration. The new `output` / `exitCode` fields on `WorkLogEntry`
are optional and re-derived from the same activity payloads we already
have on the wire, so existing thread snapshots populate the new fields
naturally on next derive — no backfill needed.

One observable behavior change on first render of historical threads:
errored rows that previously displayed only their compact summary will
now render with their expanded panel open by default (per Q3 / Default
state). This is the intended behavior, not a regression — but worth
calling out so it isn't mistaken for one.

The store slice starts empty and populates as users toggle.
