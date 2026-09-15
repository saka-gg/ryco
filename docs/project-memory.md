# Opt-in project memory

Project memory is user-curated reference material for one project on one Ryco node.
It starts disabled. Ryco does not extract memories, select recalls automatically,
read raw tool output into memory, or make extra provider calls for this feature.

## Bounds and curation

- At most 200 entries per project; list/search returns at most 50 entries per page.
- Each entry has a type (fact, convention, decision, preference), text, revision,
  creation/update/affirmation times, pin state and server-issued user provenance.
- Text is limited to 500 Unicode code points and 2 KiB of UTF-8. Optional source
  thread/message references must belong to the project. Provenance identifies a
  hashed authenticated session, not a verified person's identity.
- Unpinned entries become ineligible for recall 90 days after affirmation.
  Reading does not reinforce them. Pinning or explicitly affirming them is a
  revisioned mutation. Editing also requires the displayed revision.
- Users can edit, pin/unpin, affirm, forget, export JSON, or delete all and disable.
  Disabling preserves entries; deleting all removes entries and disables memory.
- Do not store credentials or private information. Admission rejects recognized
  sensitive patterns, including detected credential forms and URLs, but cannot
  guarantee detection of every credential or private fact. Rejected text is not
  included in diagnostics.

## Explicit recall and delivery

Users select at most eight entries and review their text and provenance before
sending. The rendered envelope is bounded to 16 KiB. The shared client controller
invalidates review on mutation, reconnect, loss of mutation readiness or scope
change. Pending responses are fenced synchronously against the existing hosted
generation, role, connection lifetime and shell readiness, even before React
commits a changed store snapshot. Native and web presentation consume that controller; neither owns a new
connection or security policy.

Commands, the native outbox, orchestration events and handoff artifacts carry
only project/entry IDs, revisions and content-free status markers. They do not
contain a feature-owned rendered memory copy. The node checks project/path
access, thread ownership, enablement, entry revisions and review expiry again
at dispatch. The transient RPC authorization grant must still be live; restart
or loss of its connection scope fails closed. Queued memory is never silently
converted into steering an active turn.

A short SQLite claim excludes edits, disablement and deletion while final
validation and provider submission are in progress. The claim records only
process ownership and the exact provider instance/runtime identity. Memory text
is resolved under this claim, immediately for dispatch, and never persisted in
the claim. The provider service rechecks the expected runtime while holding its
existing session-start lock; guarded submissions cannot recover a missing
runtime. Session start, recovery and binding restoration share that exclusion.
Authorization is rechecked after acquiring the runtime lock and before invoking
the adapter. The lock ends at submission acceptance, not turn completion.

If deletion obtains the claim boundary first, later delivery fails. If provider
submission has already begun, delivery may have occurred or may still occur;
cancellation is not retraction. A 30-second submission deadline requests
cancellation. It is **not** a lease expiry and never authorizes clock-based
mutation takeover. An uninterruptible submission retains exclusion until its
Effect finalizes. Providers may have already accepted context when cancellation
or an error is observed; Ryco reports delivery as failed or uncertain and does
not automatically retry memory submission.

## Cleanup and deletion limits

A successful submission finalizer clears only its exact claim. If SQL cleanup
fails, content-free local finalized-attempt evidence permits the next mutation,
submission or recovery pass to retry cleanup. An acquired claim that has not yet
registered its active submission is not classified as finalized.

Startup recovery runs after the authoritative orphan-runtime reconciliation and
before command readiness. It must establish that the prior process owner is
gone and stop the exact recorded runtime before clearing a crash claim. A newer
runtime is not stopped. Unknown/live ownership and failed runtime cleanup retain
the claim rather than assume non-delivery. Operational recovery is to stop the
old node/runtime and restart the node; there is no time-based takeover.

Forget removes the saved entry and invalidates its old revision. A content-free,
monotonically increasing project revision survives delete-all so stale requests
cannot resurrect deleted entries. Project soft/hard deletion also removes saved
entries. This is logical deletion, not secure erasure of SQLite/WAL pages or
backups. Ryco cannot retract already-delivered provider context, replies derived
from it, provider history, downloaded exports, or backups. Export is an explicit
user action and creates a user-controlled copy.

## Implementation seams

- `packages/contracts`: schema-only memory/RPC/command reference definitions.
- `packages/shared/projectMemory`: common bounds, admission, expiry and rendering.
- `packages/client-runtime/state/project-memory`: transient scoped controller;
  existing transport and send engine carry references.
- `apps/server/src/projectMemory`: storage, revision/dispatch claims, recovery.
  Migration 058 and separate memory RPC handlers are additive.
- `ProviderService.sendTurn(input, expectedRuntime?)`: optional guarded submission;
  callers without a fence retain ordinary recovery behavior. No callback claim
  or question-response logic is changed.
- Native thread screen mounts curation/review beside the existing composer;
  native send/outbox forwarding carries references. The composer itself is unchanged.
- Web project settings mounts independent curation. ChatHeader opens a pane-local
  curation panel; ChatView scopes explicit review to project/thread/draft and carries
  references through direct and queued sends. Inactive panes cannot invoke the
  memory action, and the frozen web phone tier is unchanged.

The upstream reference was [Synara PR 1148](https://github.com/Emanuele-web04/synara/pull/1148),
open and unmerged when rechecked on 2026-09-15. Ryco's implementation is independent;
no upstream code was copied.
