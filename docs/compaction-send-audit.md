# Compaction and send audit — 2026-09-12

## Verified upstream references

Reviewed the public release range from [v0.0.37](https://github.com/pingdotgg/t3code/releases/tag/v0.0.37) through [v0.0.41-nightly.20260912.1576](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260912.1576). The relevant compaction fixes shipped in [v0.0.41-nightly.20260911.1533](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260911.1533):

- [#11103](https://github.com/pingdotgg/t3code/pull/11103) replaces draft injection with a standalone compaction action. Ryco has no equivalent compaction button or server manual-compaction command, so this patch is not directly applicable.
- [#11107](https://github.com/pingdotgg/t3code/pull/11107) queues server turn requests during upstream's standalone compaction recovery, including stop/replay races. Ryco's provider-driven compaction uses its existing turn/session lifecycle; importing that separate recovery queue would introduce an owner Ryco does not currently need.
- [#7941](https://github.com/pingdotgg/t3code/pull/7941), released in v0.0.39, defers attachment cleanup until the outer command transaction commits. Ryco already runs projection attachment effects after transaction commit. This is distinct from the upload-token reservation bug fixed here.

Inspected the patches, not just their release titles. The upstream tag's [LICENSE](https://github.com/pingdotgg/t3code/blob/v0.0.41-nightly.20260911.1533/LICENSE) is MIT, copyright T3 Tools Inc. These changes were independently implemented against Ryco's existing infrastructure; no upstream source was copied.

## Reproduced and fixed

1. Draining a queued send cleared the next live draft. Regression tests against the original send implementation observed the draft becoming empty on both success and rejection. Queued dispatch now preserves composer content and token settings, and direct dispatch preserves prompt and attachment edits made during asynchronous preparation. After acceptance it removes sent attachment references from a preserved draft, retaining newly added or renewed attachments so the next command does not reuse consumed tokens.
2. The send function swallowed dispatch failures and the queue caller reported success regardless. It now returns acceptance explicitly. The shared queue store claims an item before asynchronous preparation, retains its full snapshot on failure, blocks automatic retry loops, and supports explicit Retry. Retry controls are excluded from the frozen web phone tier.
3. Removing the head after an asynchronous dispatch could remove another message if the queue was reordered. Completion now removes the claimed ID. Claims also prevent duplicate concurrent drain attempts and conflict with steering ownership.
4. Optimistic previews shared queue-owned blob URLs. Optimistic messages now get independent previews; failure cleanup leaves the queued attachment available. Successful delivery releases the queue's previews.
5. Attachment encoding or pre-send scrolling could reject outside send cleanup. Both now run inside error handling that releases send ownership. Expired upload-only files remain queued and produce an error without consuming the next draft.
6. Normalization adopted a streamed-file token before dispatch accepted the command. With the original command application, a reproduced busy-thread rejection made the next attempt fail with an unusable-upload error. Normalization and dispatch now share reservation cleanup through both WebSocket/shared command application and HTTP dispatch. Definite failures release only claims acquired by that individual attempt; every overlapping same-command attempt holds its own reservation, and a successful attempt commits ownership so a later failure cannot release its accepted claim. Accepted claims remain consumed; the identical command can replay its claim before receipt deduplication. Interrupted callers retain claims because their queued server command may still commit. Dispatch remains interruptible for shutdown.
7. A failed queue item whose message appears in the live projection after a lost reply is reconciled without another send. The existing mutation-readiness gate still precedes draining and reconciliation.

## Existing behavior retained

- Shared client-runtime remains the queue/state owner. No duplicate native runtime or server outbox was introduced.
- Native outbox tests confirm transient failure retention, delivery reconciliation, cached-shell gating, environment-specific readiness, and draining on turn settlement.
- Provider compaction remains within the existing lifecycle. Claude compaction policy tests cover the canonical boundary and interruption/rearming. Runtime ingestion tests cover compaction markers, waiting/session transitions and interruption recovery.
- Projection cleanup remains after command transaction commit. Existing media rendering, downloads, persisted draft serialization, native outbox storage, hosted recovery, authorization and device/boot ownership were not replaced.

## Validation

- Bun 1.4.0; `bun install --frozen-lockfile` completed without lockfile changes.
- 145 focused tests passed in total: 46 web unit, 21 shared-runtime, 27 server upload/command, 29 native outbox/send, 7 compaction, 4 runtime-ingestion, 8 projection-attachment and 3 Chromium tests.
- Focused existing provider compaction, runtime-ingestion and projection-attachment tests.
- Chromium ChatView regressions also cover cached reconnect visibility and direct provider-target sends. Queue regression: fail a queued send, preserve the next draft, click Retry, accept exactly one retry, retain the draft. The test passed; the harness logged a WebSocket subscription warning and a ResizeObserver notification error, despite the passing exit status.
- Web, server and client-runtime TS7 typechecks; formatting and lint scoped to changed files; `git diff --check`.
- Confirmed the draft-loss and consumed-token regressions fail with the original implementations, then restored the fixes and reran focused checks.

Follow-up PR-blocker validation: both reported regressions failed before their fixes. The overlapping-replay regression now commits attempt B before attempt A fails normalization and confirms command C remains blocked. Another test confirms all failed overlapping attempts release their reservations. Direct-send tests cover a prompt edit with an uploaded file followed by a successful next send, attachment additions/renewals, and rejection retention. The final focused run passed 29 server and 49 web unit tests, plus web/server typechecks and scoped formatting/lint. Two focused Chromium send regressions also passed, with the same WebSocket subscription and ResizeObserver harness warnings noted above.

No full repository build/test suite, desktop packaging or live provider run was needed for these bounded send/reservation changes.

## Limits and integration risks

- Web queued messages remain intentionally memory-only. Thread switches and reconnects preserve the queue; a full page/process reload does not. Native outbox persistence is unchanged.
- Upload leases still expire and do not survive a server restart. An expired token with no local file bytes requires reattachment; Retry does not recreate missing bytes.
- Reconciliation uses messages present in the live client projection. This is not a new end-to-end exactly-once protocol for an indefinitely ambiguous reply or messages outside the loaded history window. Interrupted server reservations deliberately remain unavailable to a different command until resolved or expired.
- Failed items pause FIFO draining until retried, moved or removed. Explicit retry still passes through current mutation readiness and provider eligibility.
- Coordinate integration with other threads touching `ChatView.tsx`, `executeChatSendTurn.ts`, the shared message-queue store, attachment uploads, `Normalizer.ts`, command application or HTTP dispatch. Preserve the acceptance return value, command-bound claim cleanup and Retry state together. New upload-service test doubles must implement both `commitAdoption` and `releaseAdoption`; integrate the wrapper and upload registry together.
- No merges, deployments, edits to other worktrees, hosted lifecycle changes or extensions/removals of the frozen web phone tier.
