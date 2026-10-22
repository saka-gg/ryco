# Inbox Hover Details and Thread Settlement

## Goal

Complete the new unified Inbox with two related capabilities:

1. Desktop and web thread rows expose a stable detail card to the right of the sidebar, matching the
   information hierarchy of the T3 Code reference: full title, project, environment or device,
   branch or worktree, and provider/model.
2. A reversible, server-backed Settle lifecycle lets completed work leave the active queue without
   being archived, deleted, or otherwise made difficult to resume.

Settlement is shared by web, desktop, and native mobile. The hover card is a pointer/keyboard
enhancement for desktop-width web presentation only; it does not extend the frozen web-phone
surface.

## Approved product behavior

The user approved the following behavior:

- Settle is a reversible Inbox completion state, not archive or delete.
- Settling does not terminate provider sessions, remove worktrees, delete files, or discard history.
- A settled thread remains accessible in a collapsible **Settled** section and can be moved back to
  **Active**.
- New work automatically returns a settled thread to Active.
- A pull request becoming merged or closed automatically settles an otherwise eligible thread.
- A manual **Keep active** override suppresses automatic settlement until new activity resets the
  override.
- The state and transitions are consistent across web, desktop, and mobile.

## References and prior work

The interaction and state model are informed by:

- T3 Code at `c034f51bb727de3d4888c74497b13e878ee65187`: its sidebar exposes Settle as
  a row action, keeps settled work in a reversible section, and rejects settlement while work or
  user requests are live.
- Synara at `a93c47e275870f34ec7aa8cd72f2a0ff6246db7c`: its durable `settledAt`
  projection, optimistic command-sequence reconciliation, sidebar hover actions, and virtual
  sidebar-edge hover-card anchors.
- Ryco PR #268 at `a352c2eb3`: an earlier implementation of rich settlement and hover details.
  That branch is hundreds of commits behind current `main`, so this work selectively ports its
  proven domain behavior and tests instead of merging or rebasing it wholesale.

The current unified Inbox, environment vocabulary, provider presentation, status copies, routing,
and readiness model remain authoritative. This feature must reuse them rather than create a parallel
thread list or a new connection path.

## Settlement domain model

### Durable state

An orchestration thread gains:

- `settledOverride`: `"settled"`, `"active"`, or `null`;
- `settledAt`: the authoritative timestamp for explicit settlement, otherwise `null`.

The override encodes user intent:

- `"settled"` means the user explicitly settled the thread;
- `"active"` means the user explicitly chose Keep active and auto-settlement is suppressed;
- `null` means the lifecycle follows normal automatic classification.

The server clock stamps settlement timestamps. Clients never author authoritative timestamps.
SQLite projection storage receives nullable columns through an idempotent migration. Snapshot,
event, and RPC schemas remain backward-compatible so mixed-version or temporarily disconnected
environments continue to render as Active and disable unsupported settlement mutations.

### Commands and events

The orchestration API exposes explicit commands:

- `thread.settle`
- `thread.unsettle`, with reason `user` or `activity`

These project to durable settlement events. Commands are idempotent at the reached state: repeated
requests preserve the original settlement time where appropriate while still producing a valid
orchestration result.

The server decider is the final authority for all invariants. Client-side eligibility exists for
immediate presentation only and must not weaken server validation.

### Classification

Every non-archived, non-deleted, non-worktree-archived thread is classified as Active or Settled.

A thread is Settled when:

- it has an explicit `"settled"` override and an authoritative settlement timestamp; or
- it has no `"active"` override, its pull request is merged or closed, and it is otherwise eligible.

An automatically settled pull-request thread uses the newest relevant durable timestamp from the
worktree, latest completed turn, latest user message, thread update, or creation time for stable
sorting. An explicit settlement uses its server-authored `settledAt`.

Active entries sort pinned threads first and otherwise preserve the current Inbox recency order.
Settled entries sort by effective settlement time, newest first. Archived or deleted threads remain
excluded from both sections.

### Eligibility and safety

Settlement is disabled and rejected when any of the following is true:

- the environment does not support settlement;
- the thread or worktree is archived or deleted;
- a provider session is starting or running;
- an approval or user-input request is unresolved;
- a local message is queued;
- a recently sent user message has not yet produced a provider turn;
- delivery state is unknown.

The queued-turn grace check is bounded against client/server clock skew so a malformed or future
timestamp cannot block settlement forever. Error or stopped sessions are eligible once no other
blocker remains.

Settlement does not itself stop a provider session. Live work is protected by refusing settlement
until the session is no longer active.

### Reactivation and automatic settlement

Real activity clears either settlement override back to the automatic state before applying the
activity. This includes starting a new turn, a live session update, and actionable provider activity.
The thread therefore returns to Active before new work is displayed.

When a pull request transitions to merged or closed, classification automatically places an eligible
thread in Settled unless its override is `"active"`. **Keep active** sets that override. Subsequent
real work clears it: the thread is Active while work is live or queued and may classify automatically
again after that work becomes idle.

## Shared Inbox projection

Settlement classification and eligibility belong in shared pure runtime modules consumed by web,
desktop, and mobile. The unified Inbox projection enriches each scoped thread entry with:

- Active, Settled, or Excluded classification;
- effective settlement timestamp;
- capability and blocker information;
- mutation readiness for its owning environment.

Scoped environment identity remains part of every entry and command. A Settle action always
dispatches through the API for the row's owning environment, never through whichever environment is
currently selected or connected most recently.

Optimistic UI state is keyed by scoped thread identity. It reconciles against the durable command
sequence as well as the projected boolean state, preventing a fast Settle then Move to Active from
mistaking an older snapshot for acknowledgement. Failure restores the projected state and reports
the existing environment-aware error copy.

## Desktop and web presentation

### Active rows

The existing Inbox row layout and motion remain authoritative. Its top-right status/time slot swaps
to a **Settle** action on pointer hover or keyboard focus without moving the project, title, provider,
or other metadata. The action is also available in the row context menu.

Disabled actions expose the existing readable blocker vocabulary, including Running, Approval,
Input, Queued, and Delivery unknown. No new status vocabulary is introduced.

### Settled section

Settled entries appear below Active in a collapsible **Settled** section. They use a slimmer, muted
row while retaining project and provider identity. Hover or keyboard focus replaces settlement time
with **Move to Active** without reflow. The same action is available through the context menu.

Settling the currently routed thread preserves its route and open detail view. Only its position in
the Inbox changes. A failed mutation restores its projected section without changing navigation.

### Right-side hover card

After a short hover or focus delay, a supplementary card opens to the right of the sidebar, anchored
to the sidebar edge and aligned with the row's top. It contains, when available:

- full thread title;
- project favicon and full project name;
- environment/device label, including **This Device** for the local desktop backend;
- worktree or workspace label when it adds information;
- branch;
- provider icon, provider display name, and friendly model label;
- pull-request state;
- current approval, input, failure, or degraded state.

The card uses existing semantic surfaces, tokens, icons, and provider vocabulary. Long content wraps
or truncates safely. It remains inside the viewport through the existing popup collision handling
and layers above content without covering the row action.

The card is supplementary: navigation, Settle, Move to Active, provider identity, and all essential
state remain visible or keyboard reachable without hover. Pointer movement from the row into the
card does not cause flicker. Reduced-motion users receive the same state without transforms.

## Mobile presentation

The native mobile Inbox consumes the same projection and displays Active and collapsible Settled
sections. Active rows expose Settle through the established touch action surface; settled rows expose
Move to Active. Mobile does not imitate hover or introduce a second settlement implementation.

Because React component tests are not available for the native package, classification, action
availability, grouping, labels, and command selection live in pure model modules with focused tests.
Native modules remain dynamically imported inside functions when required.

## Failure and mixed-version behavior

- An unsupported or older environment renders its threads as Active and disables settlement with a
  clear capability reason.
- An environment whose capability the client has not learned yet (cold, cached, or still
  connecting) is not treated as unsupported: its threads keep the classification its recorded state
  gives them, and settlement changes stay disabled until it answers.
- The inactivity rule is node-owned where the node advertises `nodeAutoSettlement`: each
  environment's threads are classified by its own node's rule (live config, else its shell
  snapshot's `settlementPolicy`, else its last known rule). An older node's threads follow the
  client's own rule.
- A disconnected environment retains its last known classification but cannot mutate until current
  readiness is restored.
- A command rejected by the server leaves the thread in its projected section and reports the
  reason without silently moving or hiding it.
- Stale connection generations cannot publish settlement acknowledgement or mutation authority.
- Drafts remain Active and cannot be settled until they become server-owned threads.
- Settlement never changes hosted connection acquisition, leases, routing ownership, or provenance.

## Accessibility

- Row navigation and settlement are separate controls with distinct accessible names.
- Hover-card content is also reachable from keyboard focus but does not trap focus.
- Current thread and expanded Settled-section state are represented semantically, not only visually.
- Status and blocker meaning are not conveyed by color alone.
- Touch targets retain platform sizing while desktop controls remain visually compact.

## Validation

Focused automated coverage must include:

- contract schema round trips for new commands, events, and snapshot fields;
- server decider invariants, idempotency, reactivation, pull-request auto-settlement, and Keep active;
- projector and SQLite migration persistence/replay;
- shared classification, sorting, clock-skew bounds, blocker precedence, and mixed-version fallback;
- optimistic Settle/Move-to-Active reconciliation across fast consecutive commands;
- scoped multi-environment dispatch so one node's thread cannot mutate another node;
- web Inbox Active/Settled rendering, stable hover action slots, keyboard access, and hover-card
  content/placement;
- the mobile pure presentation model and action selection.

Live validation covers:

- Settle and Move to Active on web and desktop;
- a right-side hover card at normal and narrow desktop sidebar widths;
- light/dark appearance and reduced motion;
- state propagation between two concurrently connected clients;
- mobile settlement and restoration in the iOS simulator;
- offline, unsupported, running, approval, input, queued, and delivery-unknown behavior;
- no console errors or connection regressions while switching environments.

Validation follows `AGENTS.md`: use the Bun version pinned in `package.json`, never invoke
`bun test`, and scale focused checks up to the full repository, web build/browser suite, desktop
build, and mobile checks because this feature crosses contracts, persistence, shared runtime, web,
desktop, and mobile boundaries.

## Non-goals

- Replacing archive, delete, pin, or snooze semantics.
- Terminating provider sessions or deleting worktrees when settling.
- Extending the frozen web-phone presentation tier.
- Changing connection concurrency, lease ownership, hosted lifecycle, or deployment configuration.
- Importing the obsolete PR #268 branch wholesale.
