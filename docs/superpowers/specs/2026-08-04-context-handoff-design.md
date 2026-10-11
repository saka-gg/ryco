# Context handoff design

## Summary

Allow a user to continue one visible Ryco thread with a different provider or model. A switch is
staged in the composer and takes effect only when the user sends the next message while the thread
is idle. The server starts a fresh provider-native session, supplies a deterministic portable
context package with that first target message, and persists a timeline breaker showing the source
provider/model set and the target provider/model.

The operation is repeatable in one app thread: `Codex -> Claude -> Grok -> Codex` remains one Ryco
conversation with three durable handoff boundaries. Provider-native sessions remain implementation
details; the Ryco thread, its messages, activities, plans, checkpoints, and handoff records are the
canonical history.

This first version deliberately favors predictable fresh sessions over resuming older
provider-native threads. The data model keeps handoff coverage and runtime-epoch identity explicit
so a later version can resume a previously used provider and inject only the off-provider delta.

## Decisions

- The feature is desktop/web-tablet only. The frozen `apps/web` phone tier remains constrained to
  its current provider; native mobile support is separate work.
- A provider/model choice is staged locally. Selection alone creates no session, event, or marker.
- The first message after the selection is the handoff trigger.
- Handoffs are allowed only while the app thread is idle and has no pending approval, user-input
  request, queued turn, local dispatch, reconnect/start transition, worktree preparation, or other
  actionable handoff.
- A handoff occurs when a started thread's model slug or provider instance changes. Options-only
  changes such as reasoning effort do not create a handoff.
- Every V1 handoff creates a fresh target provider runtime and forbids explicit and persisted resume
  cursor reuse.
- The outgoing provider is not asked to summarize or compact. Handoff construction must still work
  when that provider is unavailable or rate-limited.
- The context artifact is deterministic, server-built, structured, size-bounded, and persisted
  outside the event stream. Events and activities contain metadata only.
- The visible user message remains unchanged in canonical history. The provider receives a rendered
  handoff preamble followed by the exact current user message.
- Runtime events are accepted only from the currently projected `(providerInstanceId,
  runtimeSessionId)` pair. A provider-instance check alone is insufficient for `A -> B -> A`.
- Old-session cleanup is bounded and best-effort. It may not block target dispatch indefinitely.
- A successful or failed handoff is auditable in the timeline. Pending internal state is not shown
  as a completed breaker.
- Cross-process exactly-once delivery is not claimed. When provider acceptance cannot be determined
  after a crash, the system chooses at-most-once safety and records `delivery-uncertain` instead of
  automatically resending.

## Goals

- Continue the same visible thread with any ready provider/model while idle.
- Support unlimited repeated handoffs without stale provider events corrupting the active epoch.
- Give the target sufficient canonical context to continue work, including tool-only histories.
- Make the boundary obvious and persistent in the timeline, including after reload/reconnect.
- Preserve the current provider path when no handoff is requested.
- Keep startup failure, cleanup timeout, retry, and crash ambiguity explicit rather than silently
  starting a blank target conversation.

## Non-goals

- Switching during an active provider turn.
- Queueing a cross-provider switch behind a running turn.
- Resuming a previous provider-native thread or producing delta-only handoffs in V1.
- Provider-native compaction as a required dependency.
- Copying hidden reasoning or chain-of-thought.
- Moving checkpoints or rollback state across provider-native histories. V1 must reject or safely
  constrain provider-native rollback across a handoff boundary.
- Fork, merge-back, subagent, or manual context-transfer UX.
- Adding handoff UX to `apps/mobile` or the frozen web phone tier.
- Building a general durable provider-effect outbox beyond the handoff operation.

## User experience

### Selecting a target

On a started idle thread, the model picker exposes all ready provider instances and models. Choosing
a target updates only the composer draft and its provider/model trigger. The route and visible
thread do not change. Choosing the current model again cancels the staged change naturally.

While the thread is busy, the picker remains restricted to the active continuation group. The
eligibility policy is rechecked when the user clicks a model and again when the server handles the
turn command, preventing a picker-open race.

### Sending the first target message

The next send carries the target `ModelSelection` on the existing `thread.turn.start` command. The
server captures the source selection/session epoch before any target projection, validates the idle
invariant, and records a handoff request anchored to the new message.

The target does not see a synthetic message in Ryco history. Its provider input is conceptually:

```text
<context_handoff version="1" mode="full_context_fresh_session">
...deterministic portable context...
</context_handoff>

<current_user_message>
...exact current user message...
</current_user_message>
```

Attachments remain provider attachments rather than being encoded into the text capsule.

### Timeline breaker

After the target accepts the first turn, a persisted row is rendered immediately before the
triggering user message:

```text
────────  ↔ Context handoff  [source logo] Source Model  →  [target logo] Target Model  ────────
```

If the full context incorporates multiple earlier provider/model epochs, the source side may show
multiple de-duplicated endpoints, for example `GPT-5.6 Sol, Grok 4.5 -> Claude Fable 5`.

The row uses normal title case, provider icons/custom-instance fallbacks, muted source labels, a
slightly stronger target label, and plain divider lines. Long labels truncate visually while the
full transition remains available to assistive technology and a tooltip. Multiple sources wrap
without horizontal page overflow.

A failed handoff uses the same boundary with danger tone and a concise failure state. Internal
`requested`, `preparing`, and `dispatching` states are not presented as successful breakers.

## Architecture

### 1. Server-authoritative turn boundary

The client must stop persisting a changed `modelSelection` through `thread.meta.update` before
`thread.turn.start`. That ordering currently destroys the authoritative source selection before the
server can decide whether a handoff is required.

For a normal turn, existing behavior remains. For a handoff turn, the decider atomically emits small
events in this order:

1. `thread.context-handoff-requested` with handoff id, source/target selections, target message id,
   and source runtime epoch metadata.
2. A pending `thread.activity-appended` record using one stable activity id.
3. Existing `thread.message-sent` for the unchanged user message.
4. Existing `thread.turn-start-requested` carrying an optional typed handoff reference.

The target selection becomes the thread's canonical model only after the target provider accepts
the first turn. On failure, the previous canonical selection remains available for a clean retry;
the target stays staged in the composer.

Historic `thread.turn-start-requested` events must continue decoding, so new reference fields are
optional.

### 2. Durable handoff operation

Large context must not live in orchestration events or activity payloads because those are replayed
to clients. Add a server-side handoff repository with a state machine:

```text
requested -> preparing -> dispatching -> consumed
                 |              |
                 v              v
               failed     delivery-uncertain
```

The row stores identifiers, source/target selections and runtime epochs, the structured context
document, a deterministic digest/version, the first message id, the accepted provider turn id when
known, timestamps, and a bounded error. State transitions use compare-and-set so duplicate event
handling cannot start or dispatch the same handoff twice within one runtime.

Build and persist the artifact before target startup. A retry from `preparing` reuses the existing
artifact/digest rather than rebuilding it from a history that may have changed.

If a server restarts with a `dispatching` operation, reconcile against projected provider state. If
acceptance is provable, mark it consumed; otherwise mark `delivery-uncertain` and require explicit
retry. Do not blindly resend.

### 3. Runtime session epochs

Reuse the existing branded `RuntimeSessionId` as the provider-session epoch. Add it to provider
start/session/runtime-event contracts, the orchestration session projection, provider directory
binding, runtime persistence, and thread-session projection.

The orchestrator reserves and projects the target runtime id before starting the adapter. Every
adapter returns it on the session and stamps it onto every canonical runtime event. ProviderService
rejects an adapter session/event that reports a different id from the requested epoch.

`ProviderRuntimeIngestion` checks the event instance and runtime id before flushing assistant
buffers or mutating any lifecycle, message, activity, request, plan, subagent, or tool state.
Mismatches are dropped and counted. This guard covers late source `session.exited`, `runtime.error`,
assistant deltas, and the earlier same-provider epoch in `A -> B -> A`.

### 4. Fresh target replacement

Add an explicit fresh-start policy to `ProviderSessionStartInput`; omission preserves current
compatible-resume behavior for existing callers. Fresh mode disables both request-supplied and
persisted resume cursors and clears incompatible persisted runtime payload.

ProviderService must route the current session through the exact persisted instance/runtime pair,
not the first adapter session sharing an app `ThreadId`. Temporarily coexisting source and target
sessions are allowed during replacement and stale sessions are excluded from routing.

For different instances, bind/fence the target epoch without waiting indefinitely for source
cleanup. Stop the source with a short deadline, log and metric a timeout, and let the session reaper
retry. For a fresh restart on the same instance, stop the old runtime first because existing
adapters key sessions by app thread id; fail explicitly on timeout rather than creating two
ambiguous same-instance runtimes.

### 5. Context package builder

Create a pure builder and renderer behind a small server service. The builder consumes the
canonical thread snapshot as it existed before the target message and produces allow-listed JSON.
It must not copy arbitrary unknown activity payloads wholesale.

Include:

- source/target provider and model provenance;
- canonical user and assistant messages before the target message;
- current proposed plan and unresolved steps;
- terminal tool/command activity, coalesced by turn/item identity;
- command text, exit status, and relevant bounded output when available;
- file reads/changes and affected paths;
- checkpoint file summaries and additions/deletions;
- relevant runtime failures and pending questions;
- prior handoff boundaries as metadata, never recursively embedded context packages;
- relevant completed subagent summaries.

Exclude hidden reasoning, provider protocol noise, superseded tool lifecycle events, context-window
telemetry, duplicated handoff bodies, target startup events, and the current target message.

Use stable `(createdAt, sequence, id)` ordering and deterministic key ordering. Section-aware
budgeting keeps the most recent/high-value entries and renders selected entries chronologically.
Never truncate the current user message. Calculate the available capsule budget from
`PROVIDER_SEND_TURN_MAX_INPUT_CHARS` after reserving the envelope and exact message; reject only if
the message leaves no room for the minimum valid handoff header.

### 6. Activity and timeline projection

The handoff activity carries only presentation and correlation metadata:

- handoff id and schema version;
- status and mode;
- target message/turn correlation;
- source endpoint snapshots as an array;
- target endpoint snapshot;
- source/target runtime ids when known;
- context digest and bounded error, never the context body.

Endpoint snapshots contain provider instance id, driver kind, configured display name/accent where
available, model slug, and a model display label when available. This keeps old markers readable
after settings change; consumers still fall back to raw model/instance identifiers.

The client runtime validates the otherwise-unknown activity payload with the contract schema. It
anchors the marker before `targetMessageId`, not merely by timestamp, because messages and
activities may share the same timestamp. Malformed payloads degrade to a generic marker or are
skipped safely.

Completed/failed handoff activities are milestones and survive the existing recent-activity cap,
like context compaction. They never enter work groups, turn folds, or minimap items.

## Failure behavior

- **Thread became busy:** reject before side effects. No target session starts.
- **Context build failed:** mark the operation/activity failed; keep source canonical selection.
- **Target unavailable/start failed:** mark failed, stop any partial target runtime, and do not claim
  the target has context.
- **Old source stop timed out:** target remains authoritative for different-instance switches;
  stale cleanup is retried and old events are fenced.
- **Target turn rejected:** mark failed, clean up the unused target epoch, preserve source canonical
  selection, and leave the staged target retryable.
- **Crash after possible provider acceptance:** reconcile; otherwise mark `delivery-uncertain` and
  never auto-resend.
- **Malformed/removed provider metadata:** runtime routing fails explicitly; existing timeline
  markers remain renderable from snapshots/fallback ids.
- **Rollback across a handoff:** V1 must not apply a provider-native `numTurns` rollback to a native
  thread that did not execute those app turns. Reject across the boundary until epoch-aware rollback
  is implemented, while keeping filesystem checkpoint behavior explicit.

## Test strategy

### Contracts and persistence

- New payload/reference schemas decode and historical events without them still decode.
- Handoff repository state transitions are compare-and-set and idempotent.
- Migration adds nullable runtime ids and the handoff table/index without damaging legacy rows.
- Runtime/session rows round-trip exact instance/runtime identity.

### Context builder

- Deterministic bytes/digest for identical input.
- Current message, target startup events, and handoff bodies are excluded.
- Tool-only history produces a useful capsule.
- Commands retain exit code and bounded relevant output.
- Lifecycle activity is coalesced to terminal state.
- Section budgeting stays below the provider limit, handles Unicode safely, and never truncates the
  current message.
- Multiple prior handoffs produce de-duplicated source endpoint metadata without recursive context.

### Provider lifecycle

- Fresh mode never forwards explicit or persisted resume state.
- Late lifecycle, error, text, tool, request, and subagent events from an old epoch are ignored.
- An event from the first `A` epoch is ignored after `A -> B -> A`.
- A hanging old stop cannot indefinitely block a different target instance.
- Timed-out stale sessions are not routable and are retried by the reaper.
- Same-instance fresh replacement fails safely on stop timeout.
- Duplicate handoff/event handling cannot start or dispatch twice in-process.
- `dispatching` crash recovery never blindly resends.

### Orchestration

- First turn and unchanged selection retain the normal event path.
- A handoff captures source selection/runtime before target projection.
- Options-only changes do not hand off.
- Handoffs are rejected for running/starting/waiting/queued states.
- `A -> B -> C -> A` produces independent ids, fresh runtime epochs, and ordered markers in one
  thread.
- Target model is committed only after first-turn acceptance.
- Failure leaves no silently blank active continuation.

### Web and browser

- Idle desktop threads expose all ready providers; busy threads remain constrained.
- Selecting a target creates no RPC/activity/session until send.
- Picker eligibility is rechecked at selection and send.
- Repeated breakers remain ordered and survive reload without duplication.
- Breakers render known logos, custom-instance fallbacks, long labels, multiple sources, and full
  accessible text without horizontal overflow.
- Marker insertion preserves bottom pinning and does not steal scroll position when scrolled up.
- Context compaction behavior is unchanged.
- The frozen web phone tier does not gain cross-provider handoff UI.

## Acceptance criteria

- A user can switch provider/model repeatedly in one visible idle thread.
- Merely selecting a target has no server-side effect.
- The first target message receives one deterministic full-context preamble and remains unchanged in
  canonical Ryco history.
- Every successful handoff uses a fresh runtime session id and no resume cursor.
- Stale events from any prior epoch cannot mutate the active thread.
- Old-session shutdown cannot hang a different-instance handoff forever.
- A durable screenshot-style breaker appears directly before the first target message and survives
  reload/reconnect.
- Failures are explicit and never masquerade as a context-aware continuation.
- Required repository, web build, and browser backstops pass.
