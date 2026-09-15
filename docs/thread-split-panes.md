# Thread split panes

Desktop and web can keep one layout of up to four thread views. Open a thread's
sidebar menu and choose **Open in split view**, or drag its row to an edge of the
chat. Drag a pane's numbered title to rearrange it. Each branch can split once
horizontally and once vertically, so layouts never exceed two rows or columns.
All threads in a layout belong to the same environment. Existing connection,
subscription and mutation-readiness policies remain authoritative.

Click into a pane or choose its title to activate it. The route identifies the
focused thread. Only that pane installs global interaction listeners; other
views continue rendering through the existing conversation/runtime stores.
A first click activates an inactive pane and restores focus to the intended
control after navigation succeeds; it does not replay a button action. Keyboard
focus follows the same rule. A blocked file save preserves the source focus and
releases the activation lock. Further requests cannot race an in-flight activation.

Drag a divider to resize, or focus it and use the arrow keys, Home or End.
Ratios are bounded and persisted only after a completed drag. Cancelling the
pointer operation leaves the saved layout unchanged. Narrow desktop windows
show one pane and a thread switcher, preserving the wider layout. The frozen
phone presentation has no split controls.

Closing a pane only changes the layout; it never deletes a thread or stops an
agent. Closing either an active or inactive pane checks the existing file-save
barrier. An unfinished selection mini-composer also keeps its pane open until
finished or explicitly discarded. Ordinary composer drafts remain in their
existing store. Missing server data is **not** treated as proof of deletion:
closed/unavailable threads stay represented until explicitly closed. Local and
detached drafts remain available even when absent from a server snapshot.

The versioned layout stores only scoped thread references, split axes and
ratios. It rejects duplicate references, cross-environment trees, excessive
nesting, oversized documents and unknown versions. Storage failure does not
interrupt chat. Desktop/direct-browser layouts survive reload using the
existing local UI-storage adapter. Browser tabs do not live-sync layouts; the
last completed write is restored. Hosted mode deliberately uses that adapter's
memory-only policy: its layout does **not** survive reload. There is no service
worker, authentication or hosted lifecycle change.

## Integration boundaries

`components/chat/PaneFocus.tsx` exports:

- `usePaneFocus()`: current input ownership, including through React portals.
- `usePaneEffect(effect, dependencies)`: attach interaction effects only while
  focused, with cleanup on focus loss. This is a wrapper around a layout effect;
  callers must list their effect dependencies.
- `usePaneFocusRef()`: check current ownership inside deferred focus callbacks.
- `usePaneThreadRef()`: scoped thread identity in a split; null outside a split.
- `usePaneCloseGuard(guard)`: retain presentation drafts while preventing an
  unsafe pane unmount. This does not grant mutation authority.

Gallery, explicit memory selection and voice integrations should consume this
same boundary. Mount a modal within its pane's React subtree (portals retain
context); use `open={paneFocused && requestedOpen}` and the existing accessible
dialog primitive for focus trapping and Escape arbitration. Do not register a
second global handler in a hidden/inactive modal. Existing dialog checks remain
responsible for suppressing chat shortcuts while a modal owns input. Deferred
focus restoration must check the current owner; never refocus an inactive pane.
`ChatHeader.onOpenThreadImages` is an optional action only; gallery code is not
imported here. Memory/voice feature state and dispatch semantics are unchanged.

`previewNavigation.ts` supplies an additive rejection receipt from the existing
file navigation guard. TanStack's navigation promise can remain pending when
history rejects navigation; the receipt settles pane activation for that exact
destination without bypassing the guard. Other navigation consumers are unchanged.

Pending-input controls, composer stash/deferred-focus handlers, selection actions
and image dialogs all use the same focus boundary. Requalify these interactions
when integrating additional pane-scoped features.

Reference behavior: [t3code PR #10783](https://github.com/pingdotgg/t3code/pull/10783),
reviewed while open at head `46c52a5ad7f3a5339ee33713de717614c5a74d63`.
Implemented in Ryco's architecture; no upstream code copied.
